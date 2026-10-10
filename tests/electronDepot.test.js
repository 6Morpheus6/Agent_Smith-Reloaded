// v54.8 — Electron Depot: pre-provisioned Electron runtimes for Code Mode builds
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    createElectronDepot,
    electronArtifactUrl,
    cacheDirForUrl,
    hashUrlSafe,
    builderToolsetPaths,
    defaultElectronCacheRoot,
    buildChildEnv,
    looksLikeElectronWork,
    seedDepot
} = require('../src/main/services/electronDepot.js');

// ── Pure helpers ────────────────────────────────────────────────────────────────

test('electronArtifactUrl builds the exact GitHub release URL', () => {
    assert.strictEqual(
        electronArtifactUrl('42.5.0', 'linux', 'x64'),
        'https://github.com/electron/electron/releases/download/v42.5.0/electron-v42.5.0-linux-x64.zip'
    );
    // leading "v" is tolerated, never doubled
    assert.strictEqual(
        electronArtifactUrl('v31.7.7', 'linux', 'x64'),
        'https://github.com/electron/electron/releases/download/v31.7.7/electron-v31.7.7-linux-x64.zip'
    );
});

test('cacheDirForUrl matches @electron/get Cache.getCacheDirectory (known on-disk dirs)', () => {
    // These dir names were verified against real cache directories on this machine:
    assert.strictEqual(cacheDirForUrl(electronArtifactUrl('42.5.0', 'linux', 'x64')),
        '59ea157472003d1145e536a90686ae143ddd5bd99ef5b2bda2683be25aabe516');
    assert.strictEqual(cacheDirForUrl(electronArtifactUrl('42.9.3', 'linux', 'x64')),
        '27241c6b0b18dfc881a9f7c34c9420c190ac87a74e90519706f31138f660e258');
    assert.strictEqual(cacheDirForUrl(electronArtifactUrl('42.10.1', 'linux', 'x64')),
        'f4419331aaf853f181df841f1d40b58362a66e216d8f4ba583955b6ad64b4ae6');
});

test('hashUrlSafe matches app-builder-lib (known on-disk folder suffixes)', () => {
    // 7zip-linux-x64-16wjr / fpm…-1nk0v / appimage-12.0.1-qkv17 exist in the real builder cache
    assert.strictEqual(hashUrlSafe('https://github.com/electron-userland/electron-builder-binaries/releases/download/appimage-12.0.1/appimage-12.0.1.7z', 5), 'qkv17');
});

test('builderToolsetPaths reproduces the builder archive-cache layout', () => {
    const p = builderToolsetPaths('/cache/eb', 'appimage-12.0.1', 'appimage-12.0.1.7z');
    assert.strictEqual(p.extractDir, path.join('/cache/eb', 'appimage-12.0.1', 'appimage-12.0.1-qkv17'));
    assert.strictEqual(p.archivePath, path.join('/cache/eb', 'appimage-12.0.1', 'appimage-12.0.1.7z'));
});

test('defaultElectronCacheRoot mirrors envPaths("electron").cache per platform', () => {
    const home = '/home/u';
    assert.strictEqual(defaultElectronCacheRoot('linux', {}, home), path.join(home, '.cache', 'electron'));
    assert.strictEqual(defaultElectronCacheRoot('linux', { XDG_CACHE_HOME: '/xdg' }, home), path.join('/xdg', 'electron'));
    assert.strictEqual(defaultElectronCacheRoot('darwin', {}, home), path.join(home, 'Library', 'Caches', 'electron'));
    assert.strictEqual(defaultElectronCacheRoot('win32', { LOCALAPPDATA: 'C:\\LAD' }, home), path.join('C:\\LAD', 'electron', 'Cache'));
});

test('buildChildEnv points every Electron download cache at the depot (linux)', () => {
    const base = { PATH: '/usr/bin', XDG_CACHE_HOME: '/somewhere-else' };
    const env = buildChildEnv(base, '/data/user/electron-cache');
    assert.strictEqual(env.electron_config_cache, '/data/user/electron-cache'); // electron/install.js
    if (process.platform === 'linux') {
        assert.strictEqual(env.XDG_CACHE_HOME, '/data/user');                   // @electron/get + app-builder-lib
    }
    assert.strictEqual(env.PATH, '/usr/bin', 'unrelated vars preserved');
    assert.notStrictEqual(env, base);
    assert.strictEqual(base.XDG_CACHE_HOME, '/somewhere-else', 'base env not mutated');
});

test('looksLikeElectronWork flags electron installs/builds only for logging', () => {
    assert.ok(looksLikeElectronWork('npm install --save-dev electron'));
    assert.ok(looksLikeElectronWork('npx electron-builder --linux AppImage'));
    assert.ok(!looksLikeElectronWork('ls -la'));
});

// ── Seeding (real filesystem, temp dirs) ────────────────────────────────────────

function makeTempVendor() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-test-'));
    // vendor/electron/linux-x64/<zip> — content is irrelevant to layout tests
    const elDir = path.join(dir, 'electron', 'linux-x64');
    fs.mkdirSync(elDir, { recursive: true });
    fs.writeFileSync(path.join(elDir, 'electron-v9.9.9-linux-x64.zip'), 'fake-zip-bytes');
    // vendor/electron-builder/<release>/<archive> + pre-extracted dir + .state
    const rel = path.join(dir, 'electron-builder', 'appimage-12.0.1');
    fs.mkdirSync(rel, { recursive: true });
    fs.writeFileSync(path.join(rel, 'appimage-12.0.1.7z'), 'fake-archive');
    fs.mkdirSync(path.join(rel, 'appimage-12.0.1-qkv17', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(rel, 'appimage-12.0.1-qkv17', 'mksquashfs'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(rel, 'appimage-12.0.1-qkv17.state'), JSON.stringify({ version: 1, state: 'complete' }));
    return dir;
}

test('seedDepot lays files out exactly where @electron/get + app-builder-lib look', async () => {
    const vendor = makeTempVendor();
    const depotRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'depot-root-')), 'electron-cache');
    try {
        const r = await seedDepot(vendor, depotRoot);
        assert.deepStrictEqual(r.errors, []);

        // 1) @electron/get layout: <root>/<sha256(url-dir)>/<file>
        const url = electronArtifactUrl('9.9.9', 'linux', 'x64');
        const seededZip = path.join(depotRoot, cacheDirForUrl(url), 'electron-v9.9.9-linux-x64.zip');
        assert.ok(fs.existsSync(seededZip), `zip missing at ${seededZip}`);

        // 2) builder archive-cache layout: <root>/../electron-builder/<release>/<file>
        const ebRoot = path.join(path.dirname(depotRoot), 'electron-builder');
        assert.ok(fs.existsSync(path.join(ebRoot, 'appimage-12.0.1', 'appimage-12.0.1.7z')));
        // 3) pre-extracted dir + state copied verbatim (builder's fast path reads the .state)
        assert.ok(fs.existsSync(path.join(ebRoot, 'appimage-12.0.1', 'appimage-12.0.1-qkv17.state')));
        assert.ok(fs.existsSync(path.join(ebRoot, 'appimage-12.0.1', 'appimage-12.0.1-qkv17', 'mksquashfs')));

        // 4) idempotent: second seed changes nothing
        const r2 = await seedDepot(vendor, depotRoot);
        assert.deepStrictEqual(r2.seeded, [], `second seed must be a no-op: ${JSON.stringify(r2)}`);
        assert.ok(r2.exists.length >= 3);
    } finally {
        fs.rmSync(path.dirname(depotRoot), { recursive: true, force: true });
        fs.rmSync(vendor, { recursive: true, force: true });
    }
});

test('seedDepot is a no-op (no errors) when vendor/ is missing', async () => {
    const depotRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'depot-root-')), 'electron-cache');
    try {
        const r = await seedDepot('/nonexistent/vendor-dir-xyz', depotRoot);
        assert.deepStrictEqual(r.seeded, []);
        assert.deepStrictEqual(r.errors, []);
    } finally {
        fs.rmSync(path.dirname(depotRoot), { recursive: true, force: true });
    }
});

// ── Factory (end-to-end against the REAL @electron/get Cache class) ─────────────

test('createElectronDepot seeds a cache that @electron/get itself reports as a hit', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-userdata-'));
    // Fake app root: <appRoot>/vendor/… is what createElectronDepot resolves via getAppPath().
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-approot-'));
    try {
        fs.renameSync(makeTempVendor(), path.join(appRoot, 'vendor'));
        const depot = createElectronDepot({ userDataPath: userData, getAppPath: () => appRoot });
        const st = await depot.ensureReady();
        assert.strictEqual(st.ready, true);
        assert.ok(st.versions.includes('9.9.9'), `expected 9.9.9 in ${JSON.stringify(st)}`);

        // The real @electron/get Cache (ESM) must find the seeded zip for the exact URL it would download:
        const { Cache } = await import('../node_modules/@electron/get/dist/Cache.js');
        const cache = new Cache(path.join(userData, 'electron-cache'));
        const url = electronArtifactUrl('9.9.9', 'linux', 'x64');
        assert.strictEqual(cache.getPathForFileInCache(url, 'electron-v9.9.9-linux-x64.zip'),
            path.join(userData, 'electron-cache', cacheDirForUrl(url), 'electron-v9.9.9-linux-x64.zip'));

        // envFor() must point electron/install.js at the same root
        const env = depot.envFor({});
        assert.strictEqual(env.electron_config_cache, path.join(userData, 'electron-cache'));

        // second ensureReady is memoized (idempotent — no re-seeding, same status)
        const st2 = await depot.ensureReady();
        assert.strictEqual(st2.seeded, st.seeded);
        assert.ok(st.cached >= 1 || st.seeded >= 1, `expected seeded or cached files: ${JSON.stringify(st)}`);
    } finally {
        fs.rmSync(userData, { recursive: true, force: true });
        fs.rmSync(appRoot, { recursive: true, force: true });
    }
});

test('createElectronDepot degrades gracefully without vendor/', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-userdata-'));
    try {
        // getAppPath points nowhere; the source-tree fallback candidate is also absent in a
        // sandbox where this file's repo root has no vendor/ — but to be deterministic, assert
        // on behavior: ensureReady resolves and envFor still produces a usable override.
        const depot = createElectronDepot({ userDataPath: userData, getAppPath: () => '/nonexistent-app-root-xyz' });
        const st = await depot.ensureReady();
        assert.strictEqual(st.ready, true);
        const env = depot.envFor({});
        assert.ok(env.electron_config_cache.endsWith('electron-cache'));
    } finally {
        fs.rmSync(userData, { recursive: true, force: true });
    }
});
