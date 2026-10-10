'use strict';
/**
 * v55.3 — Electron Depot auto-provisioning: detect missing build assets and download them.
 *
 * Why this exists
 * ---------------
 * The Electron Depot (v54.8) ships ~635 MB of pre-provisioned runtimes/toolsets inside the app
 * (vendor/) so Code Mode packaging builds never pull from GitHub. That made the AppImage/.deb
 * too big for GitHub's free-tier upload limit, so v55.3 STOPS bundling vendor/ and instead:
 *
 *   1. AUTO-DETECT on first launch — check the local cache for every asset in
 *      src/shared/electronAssetsManifest.js (exact URL + sizeBytes + sha256).
 *   2. DOWNLOAD whatever is missing, with live progress events to the UI ("downloading…").
 *   3. Place each file EXACTLY where @electron/get / app-builder-lib already look — a downloaded
 *      depot and a seeded (vendor) depot are indistinguishable to the build tools.
 *
 * Destination layout (mirrors electronDepot.seedDepot() byte-for-byte, plus the two extra roots
 * that consumers resolve at runtime):
 *
 *   Electron runtime zip  <userData>/electron-cache/<sha256(url-dir)>/<zip>
 *       — explicit cacheRoot: electron/install.js (npm install) via electron_config_cache.
 *     + mirror (symlink, zero disk) <userData>/electron/<sha>/<zip>
 *       — @electron/get's envPaths('electron').cache default under XDG_CACHE_HOME=<userData>,
 *         which is where app-builder-lib's `npm run dist` path looks for the runtime zip.
 *     + mirror (symlink, zero disk) ~/.cache/electron/<sha>/<zip>
 *       — same default WITHOUT the env override: manual terminal builds outside the app.
 *
 *   Builder toolset archive  <userData>/electron-builder/<release>/<file>
 *       — app-builder-lib resolveFromArchiveCache() short-circuit (checked BEFORE any network).
 *     + <userData>/electron-builder/downloads/<sha256(fullUrl)>/<file>
 *       — @electron/get fallback layout (seedDepot writes both; we do too).
 *     + mirrors under ~/.cache/electron-builder/ for manual builds.
 *
 * app-builder-lib then extracts the archive itself on first use and writes its own .state file —
 * so shipping archives only is sufficient (the pre-extracted dirs vendor used to carry are
 * derived, not required).
 *
 * Integrity: a present file is trusted only if size AND sha256 match the manifest; anything else
 * is re-downloaded. Downloads go through imageGenManager.downloadFile (redirects, .part temp
 * files, idle watchdog) and are verified against sha256 before being moved into place.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { ELECTRON_ASSETS_MANIFEST } = require('../../shared/electronAssetsManifest.js');
const { cacheDirForUrl, builderToolsetPaths } = require('./electronDepot.js');
const { downloadFile } = require('./imageGenManager.js');

// ── Pure helpers (exported for tests) ────────────────────────────────────────────

/**
 * All destination paths for one manifest entry. `userDataPath` is app.getPath('userData').
 * Mirrors seedDepot's layout exactly, plus the envPaths-default mirrors.
 */
function assetDestinations(entry, userDataPath, homeDir = os.homedir()) {
    const shaDir = cacheDirForUrl(entry.url);
    if (entry.kind === 'electron-runtime') {
        const primary = path.join(userDataPath, 'electron-cache', shaDir, entry.name);
        return {
            // explicit cacheRoot (install.js) — the authoritative copy
            primary,
            // envPaths default under XDG_CACHE_HOME=<userData> (app-builder-lib dist path in Code Mode)
            mirrorUserData: path.join(userDataPath, 'electron', shaDir, entry.name),
            // envPaths default without override (manual terminal builds)
            mirrorHome: path.join(homeDir, '.cache', 'electron', shaDir, entry.name)
        };
    }
    // builder-toolset
    const builderCacheRoot = path.join(userDataPath, 'electron-builder');
    const ts = builderToolsetPaths(builderCacheRoot, entry.releaseName, entry.name);
    return {
        primary: ts.archivePath, // <userData>/electron-builder/<release>/<file>
        downloadsFallback: path.join(builderCacheRoot, 'downloads', cacheDirForUrl(ts.fullUrl), entry.name),
        mirrorHomeReleaseDir: path.join(homeDir, '.cache', 'electron-builder', entry.releaseName),
        mirrorHomeDownloadsFile: path.join(homeDir, '.cache', 'electron-builder', 'downloads', cacheDirForUrl(ts.fullUrl), entry.name)
    };
}

/** sha256 of a file (streaming — 100 MB files take ~0.3 s). */
function sha256OfFile(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(file);
        s.on('error', reject);
        s.on('data', (c) => h.update(c));
        s.on('end', () => resolve(h.digest('hex')));
    });
}

/**
 * Is a destination "good" for this entry? present + size matches. (sha256 is verified lazily by
 * ensureInstalled — it's the expensive check, done once per launch in the background.)
 */
async function destMatches(entry, file) {
    try {
        const st = await fsp.stat(file);
        return st.isFile() && st.size === entry.sizeBytes;
    } catch (_) { return false; }
}

/** Create a symlink mirror → target if the link is missing/broken. Never clobbers real files. */
async function ensureSymlink(linkPath, target) {
    try {
        const lst = await fsp.lstat(linkPath);
        if (lst.isSymbolicLink()) {
            // broken or pointing elsewhere → replace; valid link to the right place → keep
            let ok = false;
            try { ok = (await fsp.realpath(linkPath)) === (await fsp.realpath(target)); } catch (_) {}
            if (ok) return 'exists';
            await fsp.unlink(linkPath);
        } else if (lst.isFile()) {
            return 'real-file'; // a real file already lives here — leave it alone
        } else {
            return 'exists'; // dir or other — don't fight it
        }
    } catch (_) { /* missing → create below */ }
    await fsp.mkdir(path.dirname(linkPath), { recursive: true });
    try {
        await fsp.symlink(target, linkPath);
        return 'linked';
    } catch (e) {
        // cross-device / unsupported fs — fall back to a real copy so the mirror still works
        await fsp.copyFile(target, linkPath);
        return 'copied';
    }
}

// ── Factory ────────────────────────────────────────────────────────────────────────

/**
 * Create the provisioner.
 * @param {object} opts
 *   userDataPath — app.getPath('userData')
 *   pushEvent    — (channel, payload) => void; UI progress sink ('electron-assets-event')
 *   manifest     — override for tests (defaults to ELECTRON_ASSETS_MANIFEST)
 *   downloadFn   — override for tests (defaults to imageGenManager.downloadFile)
 */
function createElectronAssets({ userDataPath, pushEvent, manifest = ELECTRON_ASSETS_MANIFEST, downloadFn = downloadFile } = {}) {
    const homeDir = os.homedir();
    let runningPromise = null;
    let status = {
        phase: 'idle', // idle | scanning | downloading | verifying | complete | error
        total: manifest.length,
        present: 0,
        missing: [],
        failed: [],
        current: null,   // { name, received, totalBytes, pct } while a download is in flight
        startedAt: null,
        finishedAt: null
    };

    function emit(payload) {
        try { pushEvent && pushEvent('electron-assets-event', Object.assign({ phase: status.phase }, payload)); } catch (_) {}
    }

    /**
     * Detect + install. Idempotent and safe to call every launch (memoized per process).
     * Resolves with the final status; never throws — a failed download degrades to the old
     * behavior (build tools fetch from GitHub on demand) and is surfaced in `status.failed`.
     */
    function ensureInstalled() {
        if (!runningPromise) runningPromise = run().catch((e) => {
            status.phase = 'error';
            emit({ error: e.message });
            return Object.assign({}, status);
        });
        return runningPromise;
    }

    async function run() {
        status.startedAt = Date.now();
        status.finishedAt = null;
        status.failed = [];
        status.missing = [];
        status.present = 0;
        status.current = null;

        // ── 1) SCAN: which assets are already good? (size check first — cheap) ──
        status.phase = 'scanning';
        emit({ phase: 'scanning', total: manifest.length });
        const plan = []; // { entry, dests, needDownload }
        for (const entry of manifest) {
            const dests = assetDestinations(entry, userDataPath, homeDir);
            if (!(await destMatches(entry, dests.primary))) {
                status.missing.push(entry.name);
                plan.push({ entry, dests, needDownload: true });
            } else {
                status.present++;
                plan.push({ entry, dests, needDownload: false });
            }
        }
        const totalBytesMissing = plan.filter((p) => p.needDownload).reduce((n, p) => n + p.entry.sizeBytes, 0);
        emit({ phase: 'scanning', present: status.present, missing: status.missing.length, totalBytesMissing });

        // ── 2) DOWNLOAD the missing ones (sequential — one big transfer at a time is
        //    friendlier to the network and to the progress UI than parallel hogs). ──
        let installed = 0;
        for (const { entry, dests, needDownload } of plan) {
            if (!needDownload) continue;
            status.phase = 'downloading';
            // Announce the file BEFORE its first progress tick so the UI shows "Downloading X"
            // immediately (a slow/stalled connection may not produce a data event for seconds).
            emit({ phase: 'downloading', name: entry.name, received: 0, totalBytes: entry.sizeBytes, pct: null });
            try {
                const tmpPath = `${dests.primary}.dl`;
                let lastPct = -1;
                let lastEmit = 0;
                await downloadFn(entry.url, tmpPath, {
                    timeoutMs: 60000,
                    idleTimeoutMs: 120000, // big files on slow links — be patient but never hang forever
                    onProgress: (p) => {
                        status.current = { name: entry.name, received: p.received, totalBytes: p.total || entry.sizeBytes, pct: p.pct };
                        const now = Date.now();
                        if ((p.pct != null && p.pct !== lastPct) || now - lastEmit > 500) {
                            lastPct = p.pct == null ? lastPct : p.pct;
                            lastEmit = now;
                            emit({ phase: 'downloading', name: entry.name, received: p.received, totalBytes: p.total || entry.sizeBytes, pct: p.pct });
                        }
                    }
                });

                // ── 3) VERIFY sha256 before trusting the bytes. ──
                status.phase = 'verifying';
                emit({ phase: 'verifying', name: entry.name });
                const actual = await sha256OfFile(tmpPath);
                if (actual !== entry.sha256) {
                    try { await fsp.unlink(tmpPath); } catch (_) {}
                    throw new Error(`sha256 mismatch for ${entry.name} (expected ${entry.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
                }

                // ── 4) MOVE into place + repair mirrors. ──
                await fsp.mkdir(path.dirname(dests.primary), { recursive: true });
                try { await fsp.unlink(dests.primary); } catch (_) {}
                await fsp.rename(tmpPath, dests.primary);

                if (entry.kind === 'electron-runtime') {
                    await ensureSymlink(dests.mirrorUserData, dests.primary);
                    await ensureSymlink(dests.mirrorHome, dests.primary);
                } else {
                    // @electron/get fallback layout + manual-build mirrors
                    await fsp.mkdir(path.dirname(dests.downloadsFallback), { recursive: true });
                    try { await fsp.unlink(dests.downloadsFallback); } catch (_) {}
                    await ensureSymlink(dests.downloadsFallback, dests.primary);
                    // ~/.cache/electron-builder/<release> → the whole release dir (archive + future .state/extracted)
                    const realReleaseDir = path.dirname(dests.primary);
                    if (!(await exists(dests.mirrorHomeReleaseDir))) {
                        await fsp.mkdir(path.dirname(dests.mirrorHomeReleaseDir), { recursive: true });
                        try { await fsp.symlink(realReleaseDir, dests.mirrorHomeReleaseDir); } catch (_) {}
                    }
                }

                installed++;
                status.current = null;
                emit({ phase: 'done', name: entry.name });
            } catch (e) {
                try { await fsp.unlink(`${dests.primary}.dl`); } catch (_) {}
                status.failed.push(entry.name);
                status.current = null;
                emit({ phase: 'error', name: entry.name, error: e.message });
            }
        }

        // ── 5) VERIFY the pre-existing ones (size already matched; confirm sha256 in background). ──
        for (const { entry, dests } of plan) {
            if (status.missing.includes(entry.name)) continue;
            try {
                const actual = await sha256OfFile(dests.primary);
                if (actual !== entry.sha256) {
                    // corrupt on disk — mark for re-download on the NEXT launch (don't block this one)
                    status.failed.push(`${entry.name} (corrupt)`);
                    emit({ phase: 'error', name: entry.name, error: 'cached copy failed sha256 verification — will re-download' });
                }
            } catch (_) { /* unreadable → treat as missing next launch */ }
        }

        status.installed = installed;
        status.phase = status.failed.length ? 'complete-with-errors' : 'complete';
        status.finishedAt = Date.now();
        emit({ phase: status.phase, installed, present: status.present, failed: status.failed });
        return Object.assign({}, status);
    }

    async function exists(p) { try { await fsp.access(p); return true; } catch (_) { return false; } }

    /** Re-run detection + download for whatever is missing/failed (the UI RETRY button). */
    function retry() {
        runningPromise = null; // allow a fresh run even if the previous one finished
        status.phase = 'idle';
        return ensureInstalled();
    }

    return {
        ensureInstalled,
        retry,
        status: () => Object.assign({}, status),
        _internal: { assetDestinations, sha256OfFile, ensureSymlink }
    };
}

module.exports = { createElectronAssets, assetDestinations, sha256OfFile, ensureSymlink };
