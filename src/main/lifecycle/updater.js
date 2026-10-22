'use strict';
/**
 * APP UPDATE — in-app update checker/installer (main process). v56.2.0.
 *
 * Why this exists: the AppImage already carries a gh-releases-zsync header, but
 * that only helps users who know to run `--appimage-upgrade` from a terminal.
 * This module puts the same update channel behind an in-app button:
 *
 *   1. CHECK FOR UPDATES — GET https://api.github.com/repos/<owner>/<repo>/releases/latest,
 *      compare its tag against app.getVersion(), report what's new (name + notes).
 *   2. DOWNLOAD UPDATE — fetch the matching asset for this platform/arch
 *      (AppImage on linux x64, .deb as fallback) into userData/updates/, with
 *      live progress events, then verify SHA-256 against the digest GitHub
 *      publishes for the asset (asset.digest = "sha256:<hex>").
 *   3. INSTALL UPDATE —
 *        AppImage install: atomic rename-swap of process.execPath (old image is
 *        kept as <exe>.old-<ts>, previous backups are pruned), then
 *        app.relaunch() + app.exit(0) so the NEW binary starts.
 *        .deb install: hand off to apt-get (sudo -S when a password is supplied
 *        from the SUDO OVERRIDE field; plain apt-get when already root).
 *        dev checkout (npm start): no-op with an honest error — there is no
 *        installed image to swap.
 *
 * IPC surface (all invoke, registered by registerUpdaterIpc):
 *   updater-status    → { ok:true, currentVersion, installKind, lastCheck, latest }
 *                       | { ok:false, reason }
 *   updater-check     → { ok:true, updateAvailable, currentVersion, latestVersion, release, asset }
 *                       | { ok:false, error }
 *   updater-download  → { ok:true, file, size, verified } | { ok:false, error }
 *   updater-install   → { ok:true, relaunched|handedOff } | { ok:false, error }
 * Push events (opts.pushEvent → renderer 'update-event'):
 *   { phase:'checking'|'checked'|'downloading'|'verifying'|'downloaded'|'installing'|'installed'|'handed-off'|'error', ... }
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// --- update channel (must match scripts/build-updatable-appimage.sh) ---------
const GH_OWNER = '6Morpheus6';
const GH_REPO = 'Agent_Smith-Reloaded';
const LATEST_URL = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`;

const API_TIMEOUT_MS = 20000;      // GitHub releases API — fast when healthy
const DL_IDLE_TIMEOUT_MS = 60000;  // big assets on slow links: only SILENCE aborts (same as TTS)
const STAGE_DIRNAME = 'updates';   // under userData

// --- pure helpers (unit-tested without Electron) ------------------------------

/** Parse "v56.2.0" / "56.2.0" → {major,minor,patch}; null when not semver-ish. */
function parseSemver(v) {
    const m = String(v == null ? '' : v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/** Numeric semver compare: -1 (a<b), 0, 1 (a>b). Both must parse or throws. */
function compareVersions(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) throw new Error(`unrecognized version: ${!pa ? a : b}`);
    for (const k of ['major', 'minor', 'patch']) {
        if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
    }
    return 0;
}

/**
 * Normalize the /releases/latest JSON into a compact shape.
 * Returns null when the payload is not a release object (e.g. an API error body).
 */
function latestReleaseFromJson(json) {
    if (!json || typeof json !== 'object' || !json.tag_name) return null;
    const assets = Array.isArray(json.assets) ? json.assets : [];
    return {
        tag: String(json.tag_name),
        version: parseSemver(json.tag_name), // may be null — caller decides
        name: json.name || '',
        htmlUrl: json.html_url || `https://github.com/${GH_OWNER}/${GH_REPO}/releases/tag/${json.tag_name}`,
        publishedAt: json.published_at || null,
        body: typeof json.body === 'string' ? json.body.slice(0, 4000) : '',
        assets: assets.map((a) => ({
            name: String(a.name || ''),
            url: String(a.browser_download_url || a.url || ''),
            size: Number(a.size) || 0,
            digest: typeof a.digest === 'string' ? a.digest : null // "sha256:<hex>" or null
        }))
    };
}

/**
 * Pick the asset to install for this platform/arch.
 *   linux x64 → Agent.Smith.Reloaded-<ver>.AppImage (the updatable image), .deb fallback
 *   other     → first .deb, else first .AppImage, else null
 */
function pickAsset(assets, { platform = 'linux', arch = 'x64' } = {}) {
    const list = Array.isArray(assets) ? assets : [];
    if (!list.length) return null;
    if (platform === 'linux' && arch === 'x64') {
        const appimage = list.find((a) => /\.AppImage$/i.test(a.name));
        if (appimage) return appimage;
    }
    return list.find((a) => /\.deb$/i.test(a.name)) || list.find((a) => /\.AppImage$/i.test(a.name)) || null;
}

/** "sha256:<hex>" → hex, or null when the digest is absent/not sha256. */
function digestHex(digest) {
    const m = String(digest == null ? '' : digest).match(/^sha256:([0-9a-fA-F]{64})$/);
    return m ? m[1].toLowerCase() : null;
}

/** SHA-256 of a file, lowercase hex. */
function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(file);
        stream.on('data', (d) => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/**
 * What kind of install is THIS process?
 *   'appimage' — running from an .AppImage file (process.execPath ends in .AppImage)
 *   'deb'      — installed via the .deb (execPath under /usr or /opt, not a dev checkout)
 *   'dev'      — npm start from a source checkout (electron binary from node_modules)
 */
function detectInstallKind(execPath = process.execPath) {
    const p = String(execPath || '');
    if (/\.AppImage$/i.test(p)) return 'appimage';
    if (/node_modules[\\/]/.test(p)) return 'dev';
    if (p.startsWith('/usr/') || p.startsWith('/opt/')) return 'deb';
    // Anything else (macOS .app, Windows exe, unknown) — treat as dev-like: no swap logic.
    return 'dev';
}

/**
 * Atomic AppImage swap via rename (never rewrites the running binary in place):
 *   1. prune old backups + orphaned staged files from crashed swaps
 *   2. copy newFile → <exe>.new-<ts>        (full file written before any rename)
 *   3. rename exe → <exe>.old-<ts>          (previous version kept as backup)
 *   4. rename <exe>.new-<ts> → exe          (atomic — the path now points at the new image)
 * Returns { swappedTo, backup } or throws with a diagnostic.
 */
function swapAppImage(exePath, newFile, ts = Date.now()) {
    const dir = path.dirname(exePath);
    try { fs.accessSync(dir, fs.constants.W_OK); } catch (_) { throw new Error(`install directory not writable: ${dir}`); }

    // Prune BEFORE staging: at most one old backup is kept, and any orphaned
    // <exe>.new-<ts> from a previously crashed swap is removed. (Pruning after the
    // copy would match our own staged file — its name also ends in .new-<digits>.)
    try {
        for (const entry of fs.readdirSync(dir)) {
            if (/\.old-\d+$/.test(entry) || /\.new-\d+$/.test(entry)) {
                fs.rmSync(path.join(dir, entry), { force: true });
            }
        }
    } catch (_) { /* pruning is best-effort */ }

    const staged = `${exePath}.new-${ts}`;
    const backup = `${exePath}.old-${ts}`;
    fs.copyFileSync(newFile, staged);
    fs.chmodSync(staged, 0o755);

    if (fs.existsSync(exePath)) fs.renameSync(exePath, backup);
    fs.renameSync(staged, exePath);
    return { swappedTo: exePath, backup };
}

/** Run a command with an optional password on stdin; resolves {code, stdout, stderr}. */
function runCommand(cmd, args, { input = null, timeoutMs = 30000 } = {}) {
    return new Promise((resolve) => {
        let child;
        try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch (err) { resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) }); return; }
        let out = '';
        let errOut = '';
        child.stdout.on('data', (d) => { out += d; if (out.length > 8000) out = out.slice(-8000); });
        child.stderr.on('data', (d) => { errOut += d; if (errOut.length > 8000) errOut = errOut.slice(-8000); });
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(err && err.message || err) }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout: out, stderr: errOut }); });
        if (input != null) { try { child.stdin.write(input); } catch (_) {} }
        try { child.stdin.end(); } catch (_) {}
    });
}

// --- IPC registration ---------------------------------------------------------

module.exports = function registerUpdaterIpc(ipcMain, opts = {}) {
    const app = opts.app || (typeof require === 'function' ? safeRequireElectron() : null);
    const pushEvent = typeof opts.pushEvent === 'function' ? opts.pushEvent : () => {};
    // Injectable for tests: downloadFile(url, destPath, {onProgress, timeoutMs, idleTimeoutMs})
    let downloadFileImpl = opts.downloadFile || null;
    if (!downloadFileImpl) {
        try { downloadFileImpl = require('../services/imageGenManager.js').downloadFile; } catch (_) { downloadFileImpl = null; }
    }

    const emit = (payload) => { try { pushEvent('update-event', payload); } catch (_) {} };

    const currentVersion = () => {
        if (app && typeof app.getVersion === 'function') { try { return app.getVersion(); } catch (_) {} }
        try { return require(path.join(__dirname, '..', '..', '..', 'package.json')).version; } catch (_) { return '0.0.0'; }
    };

    const stageDir = () => {
        let base;
        if (app && typeof app.getPath === 'function') base = app.getPath('userData');
        else base = path.join(require('os').homedir(), '.config', 'agent-smith');
        return path.join(base, STAGE_DIRNAME);
    };

    const installKind = () => detectInstallKind(opts.execPath || process.execPath);

    // Last successful check (so download/install can reuse it without re-hitting the API).
    let lastCheck = null;
    let busy = false; // one update operation at a time

    /** Fetch + normalize the latest release. Throws on network/API failure. */
    async function fetchLatestRelease() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        try {
            const res = await fetch(LATEST_URL, {
                signal: controller.signal,
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': `agent-smith-updater/${currentVersion()}` }
            });
            if (!res.ok) throw new Error(`GitHub API responded ${res.status} ${res.statusText || ''}`.trim());
            return latestReleaseFromJson(await res.json());
        } finally {
            clearTimeout(timer);
        }
    }

    /** The check logic, shared by the updater-check handler and updater-download's catch-up path. */
    async function doCheck() {
        emit({ phase: 'checking' });
        try {
            const release = await fetchLatestRelease();
            if (!release) throw new Error('GitHub API returned no release data');
            const current = currentVersion();
            let cmp;
            try { cmp = compareVersions(current, release.tag); } catch (err) { throw new Error(`version mismatch: ${err.message}`); }
            const updateAvailable = cmp < 0;
            const asset = pickAsset(release.assets, { platform: process.platform, arch: process.arch });
            lastCheck = { at: Date.now(), release, currentVersion: current, latestVersion: release.tag, updateAvailable, asset };
            emit({ phase: 'checked', updateAvailable, latestVersion: release.tag, currentVersion: current });
            return { ok: true, ...lastCheck };
        } catch (err) {
            const error = (err && err.message) || String(err);
            emit({ phase: 'error', error });
            return { ok: false, error };
        }
    }

    ipcMain.handle('updater-status', () => ({
        ok: true,
        currentVersion: currentVersion(),
        installKind: installKind(),
        lastCheck, // null until the first check this session
        latest: lastCheck && lastCheck.release ? lastCheck.release : null
    }));

    ipcMain.handle('updater-check', async () => {
        if (busy) return { ok: false, error: 'an update operation is already running' };
        busy = true;
        try {
            return await doCheck();
        } finally {
            busy = false;
        }
    });

    ipcMain.handle('updater-download', async () => {
        if (busy) return { ok: false, error: 'an update operation is already running' };
        // No check yet this session → run one first so we know what to fetch.
        if (!lastCheck || !lastCheck.asset) {
            busy = true;
            const chk = await doCheck();
            busy = false;
            if (!chk.ok) return chk;
        }
        const asset = lastCheck.asset;
        if (!asset.url) return { ok: false, error: 'no downloadable asset found on the latest release' };
        busy = true;
        try {
            if (!downloadFileImpl) throw new Error('download engine unavailable (imageGenManager missing)');
            const dir = stageDir();
            fs.mkdirSync(dir, { recursive: true });
            const dest = path.join(dir, asset.name);
            emit({ phase: 'downloading', name: asset.name });
            await downloadFileImpl(asset.url, dest, {
                timeoutMs: API_TIMEOUT_MS,
                idleTimeoutMs: DL_IDLE_TIMEOUT_MS,
                onProgress: (p) => {
                    const pct = p && p.pct != null ? Math.round(p.pct) : null;
                    emit({ phase: 'downloading', name: asset.name, received: p.received || 0, totalBytes: p.total || asset.size || 0, pct });
                }
            });
            // Verify against the published digest when one exists.
            let verified = false;
            const expected = digestHex(asset.digest);
            if (expected) {
                emit({ phase: 'verifying', name: asset.name });
                const actual = await sha256File(dest);
                if (actual !== expected) throw new Error(`checksum mismatch — downloaded ${asset.name} does not match the published SHA-256`);
                verified = true;
            }
            emit({ phase: 'downloaded', file: dest, size: fs.statSync(dest).size, verified });
            return { ok: true, file: dest, size: fs.statSync(dest).size, verified };
        } catch (err) {
            const error = (err && err.message) || String(err);
            emit({ phase: 'error', error });
            return { ok: false, error };
        } finally {
            busy = false;
        }
    });

    ipcMain.handle('updater-install', async (_event, payload) => {
        if (busy) return { ok: false, error: 'an update operation is already running' };
        const kind = installKind();
        // Find the staged asset: explicit path in payload, else newest file in stageDir.
        let file = typeof payload === 'string' ? payload : (payload && payload.file);
        if (!file) {
            try {
                const dir = stageDir();
                const entries = fs.readdirSync(dir).filter((n) => /\.(AppImage|deb)$/i.test(n)).sort();
                file = entries.length ? path.join(dir, entries[entries.length - 1]) : null;
            } catch (_) { file = null; }
        }
        if (!file || !fs.existsSync(file)) return { ok: false, error: 'no downloaded update found — run DOWNLOAD UPDATE first' };

        busy = true;
        try {
            if (kind === 'appimage') {
                const exePath = opts.execPath || process.execPath;
                emit({ phase: 'installing', kind });
                swapAppImage(exePath, file);
                // The swapped-in image is now at the old path — relaunch into it.
                if (app && typeof app.relaunch === 'function') {
                    try { app.relaunch(); } catch (_) {}
                    emit({ phase: 'installed', relaunched: true });
                    setTimeout(() => { try { app.exit(0); } catch (_) { process.exit(0); } }, 250);
                    return { ok: true, relaunched: true };
                }
                // Non-Electron host (tests / pinokio fake): report the swap without exiting.
                emit({ phase: 'installed', relaunched: false });
                return { ok: true, swapped: true };
            }

            if (kind === 'deb') {
                const sudoPass = typeof payload === 'object' && payload ? String(payload.sudoPass || '') : '';
                emit({ phase: 'installing', kind });
                const args = ['install', '-y', file];
                let res;
                if (sudoPass) {
                    res = await runCommand('sudo', ['-S'].concat(args), { input: sudoPass + '\n', timeoutMs: 120000 });
                } else {
                    res = await runCommand('apt-get', args, { timeoutMs: 120000 });
                    if (res.code !== 0 && /permission|root/i.test(res.stderr)) {
                        // Not root and no password supplied — tell the UI to use SUDO OVERRIDE.
                        return { ok: false, error: 'installation needs root — enter your password in SUDO OVERRIDE and press INSTALL again' };
                    }
                }
                if (res.code !== 0) throw new Error(`package manager failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(-400)}`);
                emit({ phase: 'handed-off', method: sudoPass ? 'sudo apt-get' : 'apt-get' });
                return { ok: true, handedOff: sudoPass ? 'sudo apt-get' : 'apt-get' };
            }

            // dev / unknown — nothing installed to swap.
            const error = `this build runs from a source checkout (${kind}) — there is no installed image to update; re-run the app after pulling the new version`;
            emit({ phase: 'error', error });
            return { ok: false, error };
        } catch (err) {
            const error = (err && err.message) || String(err);
            emit({ phase: 'error', error });
            return { ok: false, error };
        } finally {
            busy = false;
        }
    });
};

function safeRequireElectron() {
    try { return require('electron'); } catch (_) { return null; }
}

module.exports.GH_OWNER = GH_OWNER;
module.exports.GH_REPO = GH_REPO;
module.exports.LATEST_URL = LATEST_URL;
module.exports.parseSemver = parseSemver;
module.exports.compareVersions = compareVersions;
module.exports.latestReleaseFromJson = latestReleaseFromJson;
module.exports.pickAsset = pickAsset;
module.exports.digestHex = digestHex;
module.exports.sha256File = sha256File;
module.exports.detectInstallKind = detectInstallKind;
module.exports.swapAppImage = swapAppImage;
module.exports.runCommand = runCommand;
