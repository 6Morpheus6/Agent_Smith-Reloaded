/**
 * APP UPDATE — v56.2 regression tests for src/main/lifecycle/updater.js.
 *
 * The feature: an in-app CHECK FOR UPDATES button that queries the GitHub Releases API
 * (6Morpheus6/Agent_Smith-Reloaded), downloads + SHA-256-verifies the matching AppImage/.deb,
 * and installs it — atomic rename-swap for AppImage installs (old version kept as backup),
 * apt hand-off for .deb. These tests drive the module's real code paths with a fake ipcMain,
 * stubbed fetch/downloadFile/app, so no network or Electron is needed:
 *   - semver parsing/comparison + release JSON normalization
 *   - asset picking per platform/arch (AppImage preferred on linux x64)
 *   - digest handling + sha256File
 *   - install-kind detection (appimage / deb / dev checkout)
 *   - swapAppImage: real rename-swap in a temp dir, backup creation, old-backup pruning
 *   - IPC handlers: status/check/download (verified + mismatched checksum)/install (swap+relaunch, dev no-op)
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const updater = require('../src/main/lifecycle/updater.js'); // main export = register function; helpers hang off it
const {
    parseSemver, compareVersions, latestReleaseFromJson, pickAsset, digestHex,
    sha256File, detectInstallKind, swapAppImage
} = updater;

// --- fakes -------------------------------------------------------------------

/** Minimal ipcMain stand-in: records handlers so tests can invoke them directly. */
function makeFakeIpc() {
    const handlers = new Map();
    return {
        handle(channel, fn) { handlers.set(channel, fn); },
        invoke(channel, ...args) {
            if (!handlers.has(channel)) throw new Error(`no handler for ${channel}`);
            return Promise.resolve(handlers.get(channel)({ sender: {} }, ...args));
        }
    };
}

/** Stub global.fetch returning a fixed /releases/latest payload. */
function stubFetch(payload, { status = 200 } = {}) {
    const realFetch = global.fetch;
    let lastUrl = null;
    global.fetch = async (url) => {
        lastUrl = url;
        if (!payload) throw new Error('network down');
        return { ok: status >= 200 && status < 300, status, statusText: 'OK', json: async () => payload };
    };
    return { restore: () => { global.fetch = realFetch; }, lastUrl: () => lastUrl };
}

function releasePayload(tag, assets) {
    return {
        tag_name: tag, name: `Agent Smith - Reloaded ${tag}`, html_url: 'https://github.com/x/y/releases/tag/' + tag,
        published_at: '2026-10-20T00:00:00Z', body: 'New stuff in this release.', assets
    };
}

function asset(name, { size = 1000, digest = null } = {}) {
    return { name, browser_download_url: `https://github.com/x/y/releases/download/v99/${name}`, size, digest };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pure helpers --------------------------------------------------------------

test('parseSemver handles v-prefix and rejects garbage', () => {
    assert.deepEqual(parseSemver('v56.2.0'), { major: 56, minor: 2, patch: 0 });
    assert.deepEqual(parseSemver('56.1.9'), { major: 56, minor: 1, patch: 9 });
    assert.equal(parseSemver('not-a-version'), null);
    assert.equal(parseSemver(undefined), null);
});

test('compareVersions orders semver numerically (not lexicographically)', () => {
    assert.equal(compareVersions('56.2.0', 'v56.10.0'), -1, 'minor 2 < minor 10');
    assert.equal(compareVersions('v57.0.0', '56.9.9'), 1);
    assert.equal(compareVersions('56.1.0', 'v56.1.0'), 0);
});

test('latestReleaseFromJson normalizes assets and rejects non-release bodies', () => {
    const rel = latestReleaseFromJson(releasePayload('v57.0.0', [asset('Agent.Smith.Reloaded-57.0.0.AppImage', { digest: 'sha256:' + 'a'.repeat(64) })]));
    assert.equal(rel.tag, 'v57.0.0');
    assert.deepEqual(rel.version, { major: 57, minor: 0, patch: 0 });
    assert.equal(rel.assets.length, 1);
    assert.match(rel.assets[0].url, /releases\/download/);
    // GitHub API error body (e.g. rate limit) has no tag_name → null, not a crash.
    assert.equal(latestReleaseFromJson({ message: 'API rate limit exceeded' }), null);
    assert.equal(latestReleaseFromJson(null), null);
});

test('pickAsset prefers AppImage on linux x64, falls back to .deb elsewhere', () => {
    const assets = [asset('agent-smith_57.0.0_amd64.deb'), asset('Agent.Smith.Reloaded-57.0.0.AppImage')];
    assert.match(pickAsset(assets, { platform: 'linux', arch: 'x64' }).name, /\.AppImage$/);
    assert.match(pickAsset(assets, { platform: 'darwin', arch: 'arm64' }).name, /\.deb$/);
    const onlyDeb = [asset('agent-smith_57.0.0_amd64.deb')];
    assert.match(pickAsset(onlyDeb, { platform: 'linux', arch: 'x64' }).name, /\.deb$/, '.deb fallback on linux');
    assert.equal(pickAsset([], { platform: 'linux', arch: 'x64' }), null);
});

test('digestHex accepts only sha256:<64 hex>', () => {
    const hex = 'b'.repeat(64);
    assert.equal(digestHex(`sha256:${hex}`), hex);
    assert.equal(digestHex(`SHA256:${hex.toUpperCase()}`), null, 'scheme is lowercase per GitHub');
    assert.equal(digestHex('md5:xyz'), null);
    assert.equal(digestHex(null), null);
});

test('sha256File hashes real file content', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-sha-'));
    try {
        const f = path.join(dir, 'x.bin');
        fs.writeFileSync(f, 'hello smith');
        assert.equal(await sha256File(f), crypto.createHash('sha256').update('hello smith').digest('hex'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('detectInstallKind classifies appimage / deb / dev checkouts', () => {
    assert.equal(detectInstallKind('/home/u/Agent.Smith.Reloaded-56.1.0.AppImage'), 'appimage');
    assert.equal(detectInstallKind('/usr/lib/agent-smith/agent-smith'), 'deb');
    assert.equal(detectInstallKind('/opt/agentsmith/bin/app'), 'deb');
    assert.equal(detectInstallKind('/repo/node_modules/electron/dist/electron'), 'dev');
});

test('swapAppImage swaps atomically, keeps one backup, prunes older ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-swap-'));
    try {
        const exe = path.join(dir, 'Agent.Smith.Reloaded-56.1.0.AppImage');
        fs.writeFileSync(exe, 'old-image', { mode: 0o755 });
        // A stale backup from a previous update (swapAppImage's <exe>.old-<ts> shape) must be pruned by the swap.
        fs.writeFileSync(`${exe}.old-1234`, 'ancient');

        const fresh = path.join(dir, 'Agent.Smith.Reloaded-56.2.0.AppImage');
        fs.writeFileSync(fresh, 'new-image-bytes');

        const res = swapAppImage(exe, fresh);
        assert.equal(fs.readFileSync(exe, 'utf8'), 'new-image-bytes', 'exe path now serves the new image');
        assert.ok(fs.existsSync(res.backup), 'old version kept as backup');
        assert.equal(fs.readFileSync(res.backup, 'utf8'), 'old-image');
        // Backup names are <exe>.old-<ts> — the timestamp is last. Exactly one must remain.
        const leftovers = fs.readdirSync(dir).filter((n) => /\.old-\d+$/.test(n));
        assert.deepEqual(leftovers, [path.basename(res.backup)], 'older backups pruned to exactly one');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('swapAppImage refuses a non-writable install directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-swap-ro-'));
    try {
        const exe = path.join(dir, 'app.AppImage');
        fs.writeFileSync(exe, 'old');
        fs.chmodSync(dir, 0o555); // read-only dir (best effort — root can still write)
        if (process.getuid && process.getuid() === 0) { fs.chmodSync(dir, 0o755); return; } // skip under root: EACCES won't fire
        const fresh = path.join(os.tmpdir(), 'fresh.AppImage');
        fs.writeFileSync(fresh, 'new');
        assert.throws(() => swapAppImage(exe, fresh), /not writable/);
    } finally {
        try { fs.chmodSync(dir, 0o755); } catch (_) {}
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- IPC handlers ---------------------------------------------------------------

function registerWith(opts = {}) {
    const ipc = makeFakeIpc();
    const events = [];
    const userData = opts.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'updater-ud-'));
    // Pin execPath to a dev-checkout electron by default: in CI/dev the real
    // process.execPath may live under /usr (plain node) and would classify as 'deb'.
    const execPath = opts.execPath || '/repo/node_modules/electron/dist/electron';
    const app = opts.app !== undefined ? opts.app : {
        getVersion: () => '56.1.0',
        getPath: (n) => n === 'userData' ? userData : '',
        relaunch() { app.relaunched = true; },
        exit(code) { app.exitCode = code; }
    };
    updater(ipc, Object.assign({ app, pushEvent: (ch, payload) => events.push([ch, payload]), execPath }, opts));
    return { ipc, events, app };
}

test('updater-status reports current version + install kind before any check', async () => {
    const { ipc } = registerWith();
    const st = await ipc.invoke('updater-status');
    assert.equal(st.ok, true);
    assert.equal(st.currentVersion, '56.1.0');
    assert.equal(st.installKind, 'dev'); // tests run from a node_modules electron in CI? no — plain node: execPath is /usr/bin/node → dev-like
    assert.equal(st.lastCheck, null);
});

test('updater-check reports an available update with the picked asset', async () => {
    const stub = stubFetch(releasePayload('v57.0.0', [asset('agent-smith_57.0.0_amd64.deb'), asset('Agent.Smith.Reloaded-57.0.0.AppImage')]));
    try {
        const { ipc, events } = registerWith();
        const res = await ipc.invoke('updater-check');
        assert.equal(res.ok, true);
        assert.equal(res.updateAvailable, true);
        assert.equal(res.latestVersion, 'v57.0.0');
        assert.match(res.asset.name, /\.AppImage$/); // linux x64 in tests → AppImage preferred
        assert.match(stub.lastUrl(), /api\.github\.com\/repos\/6Morpheus6\/Agent_Smith-Reloaded\/releases\/latest/);
        const phases = events.map(([ch, p]) => `${ch}:${p.phase}`);
        assert.ok(phases.includes('update-event:checking') && phases.includes('update-event:checked'));
    } finally { stub.restore(); }
});

test('updater-check says up-to-date when current >= latest', async () => {
    const stub = stubFetch(releasePayload('v56.1.0', [asset('Agent.Smith.Reloaded-56.1.0.AppImage')]));
    try {
        const { ipc } = registerWith();
        const res = await ipc.invoke('updater-check');
        assert.equal(res.ok, true);
        assert.equal(res.updateAvailable, false);
    } finally { stub.restore(); }
});

test('updater-check surfaces API failures as ok:false (no throw)', async () => {
    const stub = stubFetch(null); // network down
    try {
        const { ipc } = registerWith();
        const res = await ipc.invoke('updater-check');
        assert.equal(res.ok, false);
        assert.match(res.error, /network|fetch/i);
    } finally { stub.restore(); }
});

test('updater-download fetches the asset and verifies its SHA-256', async () => {
    const bytes = 'the-new-appimage-bytes';
    const hex = crypto.createHash('sha256').update(bytes).digest('hex');
    const stub = stubFetch(releasePayload('v57.0.0', [asset('Agent.Smith.Reloaded-57.0.0.AppImage', { digest: `sha256:${hex}` })]));
    try {
        const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-dl-'));
        let progressEvents = 0;
        const { ipc, events } = registerWith({
            userData,
            downloadFile: async (url, dest) => { fs.writeFileSync(dest, bytes); progressEvents++; }
        });
        // The handler runs its own catch-up check first.
        const res = await ipc.invoke('updater-download');
        assert.equal(res.ok, true, JSON.stringify(res));
        assert.match(res.file, /updates\/Agent\.Smith\.Reloaded-57\.0\.0\.AppImage$/);
        assert.equal(res.verified, true);
        assert.equal(fs.readFileSync(res.file, 'utf8'), bytes);
        const phases = events.map(([ch, p]) => p.phase);
        assert.ok(phases.includes('downloading') && phases.includes('verifying') && phases.includes('downloaded'));
    } finally { stub.restore(); }
});

test('updater-download rejects a checksum mismatch', async () => {
    const goodHex = crypto.createHash('sha256').update('expected-bytes').digest('hex');
    const stub = stubFetch(releasePayload('v57.0.0', [asset('Agent.Smith.Reloaded-57.0.0.AppImage', { digest: `sha256:${goodHex}` })]));
    try {
        const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-dl-bad-'));
        const { ipc } = registerWith({
            userData,
            downloadFile: async (url, dest) => { fs.writeFileSync(dest, 'CORRUPTED-bytes'); } // server sent the wrong file
        });
        const res = await ipc.invoke('updater-download');
        assert.equal(res.ok, false);
        assert.match(res.error, /checksum mismatch/);
    } finally { stub.restore(); }
});

test('updater-install (appimage) swaps the image in place and relaunches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-inst-'));
    try {
        const exe = path.join(dir, 'Agent.Smith.Reloaded-56.1.0.AppImage');
        fs.writeFileSync(exe, 'running-image', { mode: 0o755 });
        const staged = path.join(dir, 'updates', 'Agent.Smith.Reloaded-57.0.0.AppImage');
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.writeFileSync(staged, 'new-image-bytes');

        let relaunched = false;
        const app = {
            getVersion: () => '56.1.0',
            getPath: (n) => path.join(dir, 'userData'),
            relaunch() { relaunched = true; },
            exit(code) {} // don't actually exit in this test — the dedicated exit test covers it
        };
        const ipc = makeFakeIpc();
        updater(ipc, { app, pushEvent: () => {}, execPath: exe });
        const res = await ipc.invoke('updater-install', { file: staged });
        assert.equal(res.ok, true);
        assert.equal(fs.readFileSync(exe, 'utf8'), 'new-image-bytes', 'exe path now serves the new image');
        assert.equal(relaunched, true, 'app.relaunch() was called');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('updater-install (appimage) emits installed+relaunched and exits the old process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-inst2-'));
    try {
        const exe = path.join(dir, 'Agent.Smith.Reloaded-56.1.0.AppImage');
        fs.writeFileSync(exe, 'running-image', { mode: 0o755 });
        const staged = path.join(dir, 'updates', 'Agent.Smith.Reloaded-57.0.0.AppImage');
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.writeFileSync(staged, 'new-image-bytes');

        let relaunched = false;
        let exitCode = null;
        const app = {
            getVersion: () => '56.1.0',
            getPath: (n) => path.join(dir, 'userData'),
            relaunch() { relaunched = true; },
            exit(code) { exitCode = code; }
        };
        const ipc = makeFakeIpc();
        updater(ipc, { app, pushEvent: () => {}, execPath: exe });
        const res = await ipc.invoke('updater-install', { file: staged });
        assert.equal(res.ok, true);
        assert.equal(res.relaunched, true);
        assert.equal(relaunched, true, 'app.relaunch() was called');
        await sleep(400); // the module exits 250ms after relaunching
        assert.equal(exitCode, 0, 'old process exited so the new image starts');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('updater-install (dev checkout) is an honest no-op error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-dev-'));
    try {
        const staged = path.join(dir, 'updates', 'Agent.Smith.Reloaded-57.0.0.AppImage');
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.writeFileSync(staged, 'new-image-bytes');
        // registerWith pins execPath to a dev-checkout electron by default → kind 'dev'.
        const { ipc } = registerWith({ userData: dir });
        const res = await ipc.invoke('updater-install', { file: staged });
        assert.equal(res.ok, false);
        assert.match(res.error, /source checkout/);

        // The "nothing downloaded yet" guard fires before the kind check.
        const missing = await ipc.invoke('updater-install', { file: path.join(dir, 'nope.AppImage') });
        assert.equal(missing.ok, false);
        assert.match(missing.error, /no downloaded update found/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('updater-install (deb) hands off to apt-get and reports the method', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-deb-'));
    try {
        // Fake apt-get: records its argv, exits 0.
        const binDir = path.join(dir, 'bin');
        fs.mkdirSync(binDir);
        const fakeApt = path.join(binDir, 'apt-get');
        fs.writeFileSync(fakeApt, `#!/bin/sh\necho "fake-apt $@" >> "${dir}/apt-calls.log"\nexit 0\n`, { mode: 0o755 });

        const staged = path.join(dir, 'updates', 'agent-smith_57.0.0_amd64.deb');
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.writeFileSync(staged, 'deb-bytes');

        // execPath under /usr → install kind 'deb'.
        const { ipc } = registerWith({ userData: dir, execPath: '/usr/lib/agent-smith/agent-smith' });
        process.env.PATH = `${binDir}:${process.env.PATH}`;
        try {
            const res = await ipc.invoke('updater-install', { file: staged });
            assert.equal(res.ok, true, JSON.stringify(res));
            assert.equal(res.handedOff, 'apt-get');
            const log = fs.readFileSync(path.join(dir, 'apt-calls.log'), 'utf8').trim();
            assert.match(log, /fake-apt install -y .*agent-smith_57\.0\.0_amd64\.deb$/);
        } finally {
            process.env.PATH = process.env.PATH.split(path.delimiter).filter((p) => p !== binDir).join(path.delimiter);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('updater-install (deb) asks for SUDO OVERRIDE when apt-get lacks permission', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-deb-sudo-'));
    try {
        // Fake apt-get that fails with a permission error.
        const binDir = path.join(dir, 'bin');
        fs.mkdirSync(binDir);
        const fakeApt = path.join(binDir, 'apt-get');
        fs.writeFileSync(fakeApt, '#!/bin/sh\necho "E: Could not open /var/lib/dpkg/lock-frontend - Permission denied" >&2\nexit 100\n', { mode: 0o755 });

        const staged = path.join(dir, 'updates', 'agent-smith_57.0.0_amd64.deb');
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.writeFileSync(staged, 'deb-bytes');

        const { ipc } = registerWith({ userData: dir, execPath: '/usr/lib/agent-smith/agent-smith' });
        process.env.PATH = `${binDir}:${process.env.PATH}`;
        try {
            // No sudoPass → plain apt-get → permission error → UI is told to use SUDO OVERRIDE.
            const res = await ipc.invoke('updater-install', { file: staged });
            assert.equal(res.ok, false);
            assert.match(res.error, /needs root.*SUDO OVERRIDE/s);
        } finally {
            process.env.PATH = process.env.PATH.split(path.delimiter).filter((p) => p !== binDir).join(path.delimiter);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent operations are rejected while one is busy', async () => {
    const stub = stubFetch(releasePayload('v57.0.0', [asset('Agent.Smith.Reloaded-57.0.0.AppImage')]));
    try {
        const { ipc } = registerWith();
        // Hold the check open with a slow fetch, then race a second operation against it.
        let releaseFetch;
        global.fetch = () => new Promise((r) => { releaseFetch = r; });
        const first = ipc.invoke('updater-check');
        await sleep(20);
        const second = await ipc.invoke('updater-download'); // must be rejected as busy, not hang
        assert.equal(second.ok, false);
        assert.match(second.error, /already running/);
        releaseFetch({ ok: true, status: 200, json: async () => releasePayload('v57.0.0', [asset('Agent.Smith.Reloaded-57.0.0.AppImage')]) });
        const firstRes = await first;
        assert.equal(firstRes.ok, true);
    } finally { stub.restore(); }
});
