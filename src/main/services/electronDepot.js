'use strict';
/**
 * v54.8 — Electron Depot: pre-provisioned Electron runtimes for Code Mode builds.
 *
 * Why this exists
 * ---------------
 * When the agent is asked to "build X and package it as an AppImage/.deb", every
 * `npm install` / `electron-builder` step in a FRESH project downloads the full
 * Electron runtime zip (~120 MB) from GitHub before any real work starts. That is
 * minutes of pure network time per project, repeated forever — and on a slow or
 * flaky connection it fails outright (the classic "packaging tasks always fail"
 * class, v54.5 fixed the timeout side; this fixes the download side).
 *
 * The depot ships the Electron runtime zips INSIDE the app (vendor/electron/) plus
 * the electron-builder toolset archives (vendor/electron-builder/: appimage tools,
 * fpm for .deb, 7zip) and, on first use, seeds them into the exact cache layout
 * that `@electron/get` and `app-builder-lib` read:
 *
 *   <userData>/electron-cache/<sha256(url-dir)>/electron-vX.Y.Z-linux-x64.zip
 *       — @electron/get's Cache.getCacheDirectory() (dir = sha256 of the URL with
 *         path truncated to its dirname, query/hash stripped)
 *   <userData>/electron-builder/<release>/<file>          — builder archive cache
 *   <userData>/electron-builder/downloads/<sha256(url)>/  — @electron/get fallback
 *
 * and every Code Mode shell (run_command foreground + background) is spawned with:
 *
 *   electron_config_cache=<depot root>   → electron/install.js (npm install path;
 *                                          validates against the LOCAL checksums.json
 *                                          bundled in the user's project — 100% offline)
 *   XDG_CACHE_HOME=<depot root>/..       → @electron/get + app-builder-lib resolve
 *                                          their default caches INTO the depot
 *
 * so `npm install` and `npm run dist` in any project hit the seeded cache instead of
 * GitHub. The only remaining network touch is electron-builder's ~KB SHASUMS256.txt
 * fetch (its @electron/get call uses Bypass cache mode by design) — negligible next
 * to a 120 MB zip, and absent entirely on the npm-install path.
 *
 * The depot lives under userData (per-profile, survives app updates; re-seeding is a
 * no-op once files exist). If vendor/ is missing or unreadable (e.g. someone stripped
 * it), everything degrades to the old behavior: no env override, normal downloads.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

// ── Pure helpers (exported for unit tests — mirror the dependency code exactly) ──

/**
 * The exact URL @electron/get / electron-builder resolve for an Electron runtime zip.
 * `version` may or may not carry a leading "v"; the file name always does (electron-vX…).
 */
function electronArtifactUrl(version, platformName, arch) {
    const raw = String(version);
    const bare = raw.startsWith('v') ? raw.slice(1) : raw;
    return `https://github.com/electron/electron/releases/download/v${bare}/electron-v${bare}-${platformName}-${arch}.zip`;
}

/**
 * @electron/get Cache.getCacheDirectory(downloadUrl): sha256 of the URL with hash and
 * search stripped and pathname truncated to its dirname. (Verified against the real
 * cache dirs on disk — e.g. 42.5.0 → 59ea1574….)
 */
function cacheDirForUrl(url) {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = path.posix.dirname(parsed.pathname);
    return crypto.createHash('sha256').update(parsed.toString()).digest('hex');
}

/**
 * app-builder-lib hashUrlSafe(input, length): djb2 → base36, left-padded. Mirrors
 * out/util/electronGet.js so folder names match what the builder computes at runtime.
 */
function hashUrlSafe(input, length = 6) {
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    }
    hash >>>= 0;
    const out = hash.toString(36);
    return out.length >= length ? out.slice(0, length) : out.padStart(length, '0');
}

/**
 * app-builder-lib downloadBuilderToolset() layout: the extracted-dir name and the
 * archive-cache path (checked BEFORE any network access — the offline short-circuit).
 */
function builderToolsetPaths(builderCacheRoot, releaseName, filenameWithExt, githubOrgRepo = 'electron-userland/electron-builder-binaries') {
    const fullUrl = `https://github.com/${githubOrgRepo}/releases/download/${releaseName}/${filenameWithExt}`;
    const suffix = hashUrlSafe(fullUrl, 5);
    const folderName = `${filenameWithExt.replace(/\.(tar\.gz|tgz|tar\.xz|txz|zip|7z)$/, '')}-${suffix}`;
    return {
        fullUrl,
        extractDir: path.join(builderCacheRoot, releaseName, folderName),
        archivePath: path.join(builderCacheRoot, releaseName, filenameWithExt)
    };
}

/**
 * envPaths('electron', { suffix: '' }).cache — the exact expression @electron/get uses
 * for its default cache root (node_modules/@electron/get/node_modules/env-paths).
 * Reproduced here so tests can assert the layout without loading ESM.
 */
function defaultElectronCacheRoot(platform, env = {}, homedir = os.homedir()) {
    if (platform === 'darwin') return path.join(homedir, 'Library', 'Caches', 'electron');
    if (platform === 'win32') {
        const localAppData = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
        return path.join(localAppData, 'electron', 'Cache');
    }
    return path.join(env.XDG_CACHE_HOME || path.join(homedir, '.cache'), 'electron');
}

/**
 * Env for a Code Mode child process: point every Electron download cache at the depot.
 * `baseEnv` defaults to process.env; existing values are preserved except where the
 * depot must win (the three keys below).
 */
function buildChildEnv(baseEnv, depotRoot) {
    const env = Object.assign({}, baseEnv || process.env);
    // electron/install.js (runs on every `npm install` of a project that depends on
    // electron): cacheRoot param + local checksums.json → fully offline.
    env.electron_config_cache = depotRoot;
    // @electron/get's defaultCacheRoot and app-builder-lib's getCacheDirectory() both
    // derive from XDG_CACHE_HOME on Linux (…/electron and …/electron-builder under it).
    if (process.platform === 'linux') {
        env.XDG_CACHE_HOME = path.dirname(depotRoot);
    }
    return env;
}

/**
 * True when a command is likely to install or package Electron — used only for the
 * startup log line, never as a gate (the env override applies to ALL commands so a
 * build that `npm install`s mid-run still hits the depot).
 */
function looksLikeElectronWork(command) {
    return /electron/i.test(String(command || ''));
}

// ── Seeding ────────────────────────────────────────────────────────────────────────

/**
 * Copy one file if missing (or size-mismatched → re-copy). Returns 'seeded' | 'exists'.
 */
async function copyIfMissing(src, dest) {
    try {
        const st = await fsp.stat(dest);
        const ss = await fsp.stat(src);
        if (st.size === ss.size) return 'exists';
    } catch (_) { /* missing or unreadable → fall through and copy */ }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    return 'seeded';
}

/**
 * Seed the depot cache from vendor/. `vendorDir` is the app's vendor/ directory;
 * `depotRoot` is <userData>/electron-cache. Idempotent — safe to call every launch.
 */
async function seedDepot(vendorDir, depotRoot) {
    const result = { seeded: [], exists: [], errors: [] };
    if (!vendorDir || !fs.existsSync(vendorDir)) return result;

    // 1) Electron runtime zips → @electron/get layout.
    //    vendor/electron/<platform>-<arch>/electron-vX.Y.Z-<platform>-<arch>.zip
    const electronVendor = path.join(vendorDir, 'electron');
    if (fs.existsSync(electronVendor)) {
        for (const platArch of await fsp.readdir(electronVendor)) {
            const dir = path.join(electronVendor, platArch);
            let entries;
            try { entries = await fsp.readdir(dir); } catch (_) { continue; } // not a dir
            for (const file of entries) {
                const m = /^electron-v?(\d+\.\d+\.\d+)-([a-z0-9]+)-([a-z0-9]+)\.zip$/.exec(file);
                if (!m) continue;
                const [, version, platformName, arch] = m;
                try {
                    const url = electronArtifactUrl(version, platformName, arch);
                    const dest = path.join(depotRoot, cacheDirForUrl(url), file);
                    const outcome = await copyIfMissing(path.join(dir, file), dest);
                    (outcome === 'seeded' ? result.seeded : result.exists).push(file);
                } catch (e) { result.errors.push(`${file}: ${e.message}`); }
            }
        }
    }

    // 2) electron-builder toolsets → builder archive cache (+ @electron/get fallback).
    //    vendor/electron-builder/<releaseName>/<files…> where <files> are the archives
    //    and/or pre-extracted dirs + .state files exactly as the builder names them.
    const builderVendor = path.join(vendorDir, 'electron-builder');
    if (fs.existsSync(builderVendor)) {
        const builderCacheRoot = path.join(path.dirname(depotRoot), 'electron-builder');
        for (const releaseName of await fsp.readdir(builderVendor)) {
            const relSrc = path.join(builderVendor, releaseName);
            let entries;
            try { entries = await fsp.readdir(relSrc); } catch (_) { continue; }
            for (const entry of entries) {
                const srcPath = path.join(relSrc, entry);
                const destDir = path.join(builderCacheRoot, releaseName);
                try {
                    const st = await fsp.stat(srcPath);
                    if (st.isDirectory()) {
                        // Pre-extracted toolset dir (+ its .state file is copied below).
                        const outcome = await copyTreeIfMissing(srcPath, path.join(destDir, entry));
                        (outcome === 'seeded' ? result.seeded : result.exists).push(`${releaseName}/${entry}/`);
                    } else if (/\.state$/.test(entry)) {
                        const outcome = await copyIfMissing(srcPath, path.join(destDir, entry));
                        (outcome === 'seeded' ? result.seeded : result.exists).push(`${releaseName}/${entry}`);
                    } else if (/\.(7z|tar\.gz|tgz)$/.test(entry)) {
                        // Archive cache short-circuit path.
                        const p1 = await copyIfMissing(srcPath, path.join(destDir, entry));
                        // @electron/get fallback layout: <builderCache>/downloads/<sha256(fullUrl)>/<file>.
                        const ts = builderToolsetPaths(builderCacheRoot, releaseName, entry);
                        const p2 = await copyIfMissing(srcPath, path.join(builderCacheRoot, 'downloads', cacheDirForUrl(ts.fullUrl), entry));
                        (p1 === 'seeded' || p2 === 'seeded') ? result.seeded.push(`${releaseName}/${entry}`) : result.exists.push(`${releaseName}/${entry}`);
                    }
                } catch (e) { result.errors.push(`${releaseName}/${entry}: ${e.message}`); }
            }
        }
    }

    return result;
}

/** Recursively copy src→dest only for files that are missing or size-mismatched. */
async function copyTreeIfMissing(src, dest) {
    const entries = await fsp.readdir(src, { withFileTypes: true });
    await fsp.mkdir(dest, { recursive: true });
    let seededAny = false;
    for (const entry of entries) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            if ((await copyTreeIfMissing(s, d)) === 'seeded') seededAny = true;
        } else if ((await copyIfMissing(s, d)) === 'seeded') {
            seededAny = true;
        }
    }
    return seededAny ? 'seeded' : 'exists';
}

// ── Factory ────────────────────────────────────────────────────────────────────────

/**
 * Create the depot service.
 * @param {object} opts
 *   userDataPath — app.getPath('userData'); depot root = <userData>/electron-cache
 *   getAppPath   — () => string; asar/app root (vendor/ lives here). Injectable for tests.
 */
function createElectronDepot({ userDataPath, getAppPath } = {}) {
    const depotRoot = path.join(userDataPath || path.join(os.homedir(), '.config', 'Agent Smith Reloaded'), 'electron-cache');

    function resolveVendorDir() {
        const candidates = [];
        try { if (typeof getAppPath === 'function') candidates.push(path.join(getAppPath(), 'vendor')); } catch (_) {}
        try { if (typeof process.resourcesPath === 'string' && process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'vendor')); } catch (_) {}
        for (const c of candidates) {
            try { if (fs.existsSync(c)) return c; } catch (_) {}
        }
        return null;
    }

    let readyPromise = null;
    let status = { ready: false, depotRoot, vendorDir: resolveVendorDir(), versions: [], seeded: 0 };

    /**
     * Seed the cache (once) and report readiness. Awaited by every Code Mode shell
     * spawn so a build never starts before its runtime is in place. Resolves even on
     * partial failure — the env override still applies to whatever did seed.
     */
    function ensureReady() {
        if (!readyPromise) {
            readyPromise = (async () => {
                try {
                    await fsp.mkdir(depotRoot, { recursive: true });
                    const vendorDir = resolveVendorDir();
                    status.vendorDir = vendorDir;
                    if (!vendorDir) {
                        console.log('[electron-depot] no vendor/ found — Electron downloads will use the network (old behavior)');
                        return status;
                    }
                    const r = await seedDepot(vendorDir, depotRoot);
                    status.seeded = r.seeded.length;
                    status.cached = r.exists.length;
                    status.errors = r.errors;
                    // Report which runtime versions are now available offline.
                    const electronVendor = path.join(vendorDir, 'electron');
                    if (fs.existsSync(electronVendor)) {
                        for (const platArch of await fsp.readdir(electronVendor)) {
                            let entries; try { entries = await fsp.readdir(path.join(electronVendor, platArch)); } catch (_) { continue; }
                            for (const file of entries) {
                                const m = /^electron-v?(\d+\.\d+\.\d+)-/.exec(file);
                                if (m && !status.versions.includes(m[1])) status.versions.push(m[1]);
                            }
                        }
                    }
                    console.log(`[electron-depot] ready — ${status.versions.length} Electron runtime(s) [${status.versions.join(', ')}], ` +
                        `${r.seeded.length} file(s) seeded, ${r.exists.length} already cached → ${depotRoot}`);
                } catch (e) {
                    console.error('[electron-depot] seeding failed (non-fatal):', e.message);
                    status.errors = [...(status.errors || []), e.message];
                } finally {
                    status.ready = true;
                }
                return status;
            })();
        }
        return readyPromise;
    }

    /** Env for a Code Mode child process (depot-aware). */
    function envFor(baseEnv) {
        return buildChildEnv(baseEnv, depotRoot);
    }

    return { ensureReady, envFor, status: () => Object.assign({}, status), _internal: { depotRoot, resolveVendorDir } };
}

module.exports = {
    createElectronDepot,
    // pure helpers — unit-tested directly (no source-regex tests)
    electronArtifactUrl,
    cacheDirForUrl,
    hashUrlSafe,
    builderToolsetPaths,
    defaultElectronCacheRoot,
    buildChildEnv,
    looksLikeElectronWork,
    seedDepot
};
