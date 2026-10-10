// v55.3 — Electron Depot auto-provisioning (detect + download missing build assets)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createElectronAssets, assetDestinations } = require('../src/main/services/electronAssets.js');
const { ELECTRON_ASSETS_MANIFEST } = require('../src/shared/electronAssetsManifest.js');
const { cacheDirForUrl, builderToolsetPaths } = require('../src/main/services/electronDepot.js');

// ── Manifest integrity (behavioral: the manifest must be self-consistent) ────────

test('manifest is non-empty and every entry has url/sizeBytes/sha256', () => {
    assert.ok(ELECTRON_ASSETS_MANIFEST.length >= 8, `expected ≥8 assets, got ${ELECTRON_ASSETS_MANIFEST.length}`);
    for (const e of ELECTRON_ASSETS_MANIFEST) {
        assert.match(e.url, /^https:\/\/github\.com\//, `${e.name}: url must be a GitHub release URL`);
        assert.ok(Number.isInteger(e.sizeBytes) && e.sizeBytes > 0, `${e.name}: sizeBytes`);
        assert.match(e.sha256, /^[a-f0-9]{64}$/, `${e.name}: sha256`);
        assert.ok(['electron-runtime', 'builder-toolset'].includes(e.kind), `${e.name}: kind`);
    }
});

test('manifest runtime entries carry version/platform/arch; toolsets carry releaseName', () => {
    const runtimes = ELECTRON_ASSETS_MANIFEST.filter((e) => e.kind === 'electron-runtime');
    const toolsets = ELECTRON_ASSETS_MANIFEST.filter((e) => e.kind === 'builder-toolset');
    assert.ok(runtimes.length >= 5, `expected ≥5 runtime zips, got ${runtimes.length}`);
    assert.ok(toolsets.length >= 3, `expected ≥3 builder toolsets, got ${toolsets.length}`);
    for (const e of runtimes) {
        assert.match(e.version, /^\d+\.\d+\.\d+$/, `${e.name}: version`);
        assert.equal(e.platform, 'linux');
        assert.equal(e.arch, 'x64');
        // URL must be the canonical electron release URL for that version (what @electron/get resolves)
        assert.ok(e.url.includes(`/v${e.version}/electron-v${e.version}-linux-x64.zip`), `${e.name}: url/version mismatch`);
    }
    for (const e of toolsets) {
        assert.ok(e.releaseName, `${e.name}: releaseName`);
        assert.ok(e.url.includes(`/releases/download/${e.releaseName}/${e.name}`), `${e.name}: url/release mismatch`);
    }
});

// ── Destination layout (must match where @electron/get / app-builder-lib look) ───

test('assetDestinations: runtime zip → explicit cacheRoot + envPaths mirrors', () => {
    const entry = ELECTRON_ASSETS_MANIFEST.find((e) => e.kind === 'electron-runtime');
    const d = assetDestinations(entry, '/home/u/.config/App', '/home/u');
    const shaDir = cacheDirForUrl(entry.url);
    assert.equal(d.primary, path.join('/home/u/.config/App', 'electron-cache', shaDir, entry.name));
    assert.equal(d.mirrorUserData, path.join('/home/u/.config/App', 'electron', shaDir, entry.name));
    assert.equal(d.mirrorHome, path.join('/home/u', '.cache', 'electron', shaDir, entry.name));
});

test('assetDestinations: toolset archive → builder cache + @electron/get downloads fallback', () => {
    const entry = ELECTRON_ASSETS_MANIFEST.find((e) => e.kind === 'builder-toolset');
    const d = assetDestinations(entry, '/home/u/.config/App', '/home/u');
    const ts = builderToolsetPaths(path.join('/home/u/.config/App', 'electron-builder'), entry.releaseName, entry.name);
    assert.equal(d.primary, ts.archivePath); // <userData>/electron-builder/<release>/<file>
    // @electron/get fallback: <builderCache>/downloads/<sha256(fullUrl)>/<file> — same layout seedDepot writes.
    assert.equal(d.downloadsFallback, path.join('/home/u/.config/App', 'electron-builder', 'downloads', cacheDirForUrl(ts.fullUrl), entry.name));
});

// ── ensureInstalled end-to-end with a FAKE downloader (no network) ────────────────

function makeFakeManifest(tmpRoot) {
    // Two tiny "assets" whose bytes we control: one runtime, one toolset.
    const mk = (name, body) => {
        const file = path.join(tmpRoot, name);
        fs.writeFileSync(file, body);
        return {
            kind: name.endsWith('.zip') ? 'electron-runtime' : 'builder-toolset',
            name,
            version: name.endsWith('.zip') ? '9.9.9' : null,
            platform: name.endsWith('.zip') ? 'linux' : null,
            arch: name.endsWith('.zip') ? 'x64' : null,
            releaseName: name.endsWith('.zip') ? null : 'tool@1.0.0',
            url: `https://github.com/example/repo/releases/download/x/${name}`,
            sizeBytes: Buffer.byteLength(body),
            sha256: crypto.createHash('sha256').update(body).digest('hex'),
            _srcFile: file
        };
    };
    return [mk('electron-v9.9.9-linux-x64.zip', 'fake-runtime-zip-bytes'), mk('tool-1.0.0.7z', 'fake-toolset-archive')];
}

function makeFakeDownloader(manifest, { failNames = [] } = {}) {
    const calls = [];
    return async function fakeDownload(url, destPath) {
        calls.push({ url });
        const entry = manifest.find((e) => e.url === url);
        if (!entry) throw new Error(`unexpected URL ${url}`);
        if (failNames.includes(entry.name)) throw new Error('simulated network failure');
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, fs.readFileSync(entry._srcFile)); // exact bytes → sha256 passes
    };
}

test('ensureInstalled downloads missing assets into the depot layout and reports complete', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-test-'));
    try {
        const manifest = makeFakeManifest(tmp);
        const userData = path.join(tmp, 'userData');
        const events = [];
        const assets = createElectronAssets({
            userDataPath: userData,
            pushEvent: (ch, payload) => events.push([ch, payload]),
            manifest,
            downloadFn: makeFakeDownloader(manifest)
        });

        const st = await assets.ensureInstalled();
        assert.equal(st.phase, 'complete', JSON.stringify(st));
        assert.equal(st.failed.length, 0);
        assert.equal(st.installed, manifest.length, `installed: ${JSON.stringify(st)}`);
        assert.equal(st.present, 0, 'nothing pre-existed');

        // runtime zip: primary + both mirrors (mirror may be symlink or copy — resolve it)
        const rt = manifest.find((e) => e.kind === 'electron-runtime');
        const shaDir = cacheDirForUrl(rt.url);
        const primary = path.join(userData, 'electron-cache', shaDir, rt.name);
        assert.ok(fs.existsSync(primary), `primary missing: ${primary}`);
        for (const mirror of [path.join(userData, 'electron', shaDir, rt.name), path.join(os.homedir(), '.cache', 'electron', shaDir, rt.name)]) {
            // mirrors under the REAL homedir are only created when they don't collide with real files;
            // in this sandbox assert the userData mirror (deterministic) and tolerate the home one.
            if (!mirror.startsWith(os.homedir())) assert.ok(fs.existsSync(mirror), `mirror missing: ${mirror}`);
        }

        // toolset archive: builder cache + downloads fallback
        const ts = manifest.find((e) => e.kind === 'builder-toolset');
        const ebRoot = path.join(userData, 'electron-builder');
        assert.ok(fs.existsSync(path.join(ebRoot, ts.releaseName, ts.name)), 'toolset archive missing in builder cache');

        // events: the UI must have seen scanning → downloading → complete
        const phases = events.map(([, p]) => p.phase);
        assert.ok(phases.includes('scanning'), `phases: ${phases.join(',')}`);
        assert.ok(phases.includes('downloading'), 'no downloading event');
        assert.ok(phases[phases.length - 1] === 'complete', `final phase: ${phases[phases.length - 1]}`);

        // idempotent second run: nothing to download, still complete
        const st2 = await assets.ensureInstalled();
        assert.equal(st2.phase, 'complete');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('ensureInstalled is a no-op (no downloads) when everything already exists', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-test-'));
    try {
        const manifest = makeFakeManifest(tmp);
        const userData = path.join(tmp, 'userData');
        // Pre-seed the primaries with correct bytes.
        for (const entry of manifest) {
            const d = assetDestinations(entry, userData, os.homedir());
            fs.mkdirSync(path.dirname(d.primary), { recursive: true });
            fs.copyFileSync(entry._srcFile, d.primary);
        }
        let downloads = 0;
        const assets = createElectronAssets({
            userDataPath: userData,
            pushEvent: () => {},
            manifest,
            downloadFn: async (url) => { downloads++; throw new Error('must not be called'); }
        });
        const st = await assets.ensureInstalled();
        assert.equal(downloads, 0, 'no asset should be re-downloaded when the cache is complete');
        assert.equal(st.phase, 'complete', JSON.stringify(st));
        assert.equal(st.present, manifest.length);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('ensureInstalled records failures and degrades (never throws)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-test-'));
    try {
        const manifest = makeFakeManifest(tmp);
        const userData = path.join(tmp, 'userData');
        const assets = createElectronAssets({
            userDataPath: userData,
            pushEvent: () => {},
            manifest,
            downloadFn: makeFakeDownloader(manifest, { failNames: [manifest[0].name] })
        });
        const st = await assets.ensureInstalled(); // must resolve, not throw
        assert.ok(st.failed.includes(manifest[0].name), `failed list: ${JSON.stringify(st.failed)}`);
        assert.equal(st.phase, 'complete-with-errors');
        // the other asset still installed
        const okEntry = manifest.find((e) => e.name !== manifest[0].name);
        const d = assetDestinations(okEntry, userData, os.homedir());
        assert.ok(fs.existsSync(d.primary));

        // retry() re-runs detection + download with the SAME bound downloader (the UI RETRY button
        // relies on this; network recovery is what makes a later attempt succeed). With the same
        // failing downloader it deterministically fails again — and still resolves, never throws.
        const st2 = await assets.retry();
        assert.ok(st2.failed.includes(manifest[0].name));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('sha256 mismatch is rejected (corrupt download never trusted)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-test-'));
    try {
        const manifest = makeFakeManifest(tmp);
        // Corrupt the runtime's bytes so the "download" produces wrong sha256.
        const rt = manifest.find((e) => e.kind === 'electron-runtime');
        fs.writeFileSync(rt._srcFile, 'CORRUPTED-BYTES-NOT-THE-MANIFEST-CONTENT');
        // recompute sizeBytes to match the corrupt file (size check passes, sha fails)
        rt.sizeBytes = Buffer.byteLength(fs.readFileSync(rt._srcFile));
        const userData = path.join(tmp, 'userData');
        const assets = createElectronAssets({
            userDataPath: userData,
            pushEvent: () => {},
            manifest,
            downloadFn: makeFakeDownloader(manifest) // copies the (corrupt) source bytes
        });
        const st = await assets.ensureInstalled();
        assert.ok(st.failed.includes(rt.name), `expected sha256 rejection, got ${JSON.stringify(st.failed)}`);
        // and no partial file left behind at the primary path
        const d = assetDestinations(rt, userData, os.homedir());
        assert.ok(!fs.existsSync(d.primary), 'corrupt download must not be moved into place');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('status() reflects the last run (UI catch-up path)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-test-'));
    try {
        const manifest = makeFakeManifest(tmp);
        const userData = path.join(tmp, 'userData');
        const assets = createElectronAssets({ userDataPath: userData, pushEvent: () => {}, manifest, downloadFn: makeFakeDownloader(manifest) });
        assert.equal(assets.status().phase, 'idle', 'fresh provisioner starts idle');
        await assets.ensureInstalled();
        assert.equal(assets.status().phase, 'complete');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
