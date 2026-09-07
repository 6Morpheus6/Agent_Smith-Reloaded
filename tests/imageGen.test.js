/**
 * v51.7 image generation — unit tests (hermetic: temp dirs, injected fakes).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const {
    buildSdCliArgs,
    extractZip,
    pickEngineAsset,
    pngDimensions,
    downloadFile,
    DEFAULT_MODEL,
    createImageGenManager
} = require('../src/main/services/imageGenManager.js');
const registerImageGenIpc = require('../src/main/ipc/imageGen.js');
const ipcChannels = require('../src/shared/ipcChannels.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmith-imggen-')); }

// --- PNG helpers (the v51.8 honest-success gate verifies real PNG output) --------
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
    return (crc ^ -1) >>> 0;
}
function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
/** Build a minimal valid PNG (IHDR + IDAT) of the given size — passes pngDimensions(). */
function makePng(width, height) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type RGBA
    const rawRow = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4)]);
    const idat = zlib.deflateSync(Buffer.concat(Array(height).fill(rawRow)));
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// --- buildSdCliArgs ----------------------------------------------------------
test('buildSdCliArgs applies defaults and clamps', () => {
    const args = buildSdCliArgs({ modelPath: '/m.gguf', prompt: 'a cat', outputPath: '/o.png' });
    const get = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(get('-M'), 'img_gen');
    assert.equal(get('-m'), '/m.gguf');
    assert.equal(get('-p'), 'a cat');
    assert.equal(get('-W'), '1024', 'default width');
    assert.equal(get('-H'), '1024', 'default height');
    assert.equal(get('--steps'), '25', 'default steps');
    assert.equal(get('--cfg-scale'), '7');
    assert.equal(get('--sampling-method'), 'euler');
    assert.equal(get('-o'), '/o.png');
    assert.equal(get('-s'), '-1', 'random seed by default');

    const clamped = buildSdCliArgs({ modelPath: '/m.gguf', prompt: 'x', width: 9999, height: 10, steps: 500, cfgScale: -3, outputPath: '/o.png' });
    assert.equal(clamped[clamped.indexOf('-W') + 1], '2048', 'width clamped to max');
    assert.equal(clamped[clamped.indexOf('-H') + 1], '64', 'height clamped to min');
    assert.equal(clamped[clamped.indexOf('--steps') + 1], '150', 'steps clamped to max');
    assert.equal(clamped[clamped.indexOf('--cfg-scale') + 1], '7', 'bad cfg falls back to default');

    const withNeg = buildSdCliArgs({ modelPath: '/m.gguf', prompt: 'x', negativePrompt: 'blurry', seed: 42, outputPath: '/o.png' });
    assert.equal(withNeg[withNeg.indexOf('--negative-prompt') + 1], 'blurry');
    assert.equal(withNeg[withNeg.indexOf('-s') + 1], '42', 'explicit seed honored');
});

test('pickEngineAsset picks vulkan builds per platform', () => {
    assert.match(pickEngineAsset('linux', 'x64'), /Linux.*vulkan/);
    assert.match(pickEngineAsset('win32', 'x64'), /win-vulkan-x64\.zip/);
    assert.match(pickEngineAsset('darwin', 'arm64'), /Darwin-macOS/);
});

// --- extractZip --------------------------------------------------------------
function makeStoredZip(entries, { escapeName } = {}) {
    // Build a minimal ZIP with STORED (method 0) entries.
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const [name, data] of Object.entries(entries)) {
        const nameBuf = Buffer.from(name);
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); // signature
        local.writeUInt16LE(20, 4);         // version needed
        local.writeUInt32LE(crc, 14);       // crc32
        local.writeUInt32LE(data.length, 18); // compressed size
        local.writeUInt32LE(data.length, 22); // uncompressed size
        local.writeUInt16LE(nameBuf.length, 26);
        chunks.push(local, nameBuf, data);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);    // signature
        cd.writeUInt16LE(20, 4);            // version made by
        cd.writeUInt16LE(20, 6);            // version needed
        cd.writeUInt16LE(0, 8);             // general purpose bit flag
        cd.writeUInt16LE(0, 10);            // method: stored
        cd.writeUInt32LE(crc, 16);          // crc32
        cd.writeUInt32LE(data.length, 20);  // compressed size
        cd.writeUInt32LE(data.length, 24);  // uncompressed size
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt16LE(0, 30);            // extra field length (kept 0; offsets are the bug class under test)
        cd.writeUInt16LE(0, 32);            // comment length
        cd.writeUInt32LE(0o755 << 16, 38);  // external attrs — non-zero on purpose: catches 16/32-bit field misreads
        cd.writeUInt32LE(offset, 42);       // local header offset
        central.push(cd, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const cdStart = offset;
    const cdSize = central.reduce((n, b) => n + b.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Object.keys(entries).length, 8);
    eocd.writeUInt16LE(Object.keys(entries).length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    return Buffer.concat([...chunks, ...central, eocd]);
}

test('extractZip extracts stored entries into the destination', () => {
    const dest = tmpDir();
    const zip = makeStoredZip({ 'sd-cli': Buffer.from('#!/bin/sh\necho hi\n'), 'lib/libggml-vulkan.so': Buffer.from('fake-so') });
    const written = extractZip(zip, dest);
    assert.ok(written.includes('sd-cli'));
    assert.equal(fs.readFileSync(path.join(dest, 'sd-cli'), 'utf8'), '#!/bin/sh\necho hi\n');
    assert.ok(fs.readFileSync(path.join(dest, 'lib/libggml-vulkan.so')).equals(Buffer.from('fake-so')));
});

test('extractZip rejects entries that escape the destination (zip-slip)', () => {
    const dest = tmpDir();
    const zip = makeStoredZip({ '../evil.txt': Buffer.from('pwned') });
    assert.throws(() => extractZip(zip, dest), /escapes destination/);
});

// Fake child process for spawn injection (stdout/stderr are event emitters).
function fakeChild(emit) {
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => emit(child));
    return child;
}

// --- manager (temp userDataPath) ---------------------------------------------
function makeManager(overrides = {}) {
    const dir = tmpDir();
    const events = [];
    const mgr = createImageGenManager({
        userDataPath: dir,
        pushEvent: (ch, ev) => events.push([ch, ev]),
        registerDownload: () => {},
        ...overrides
    });
    return { mgr, dir, events };
}

test('manager status reflects defaults and state persistence', () => {
    const { mgr } = makeManager();
    let st = mgr.status();
    assert.equal(st.enabled, false);
    assert.deepEqual(st.models, []);
    assert.equal(st.selectedModel, null);
    assert.ok(!st.resolvedModelPath, 'no model detected yet');

    mgr.saveState({ enabled: true });
    st = mgr.status();
    assert.equal(st.enabled, true, 'enabled persisted to state.json');
    assert.equal(mgr.loadState().enabled, true);
});

test('importModel copies the file into models/ and selects it', () => {
    const { mgr } = makeManager();
    const src = path.join(os.tmpdir(), `src-model-${Date.now()}.gguf`);
    fs.writeFileSync(src, 'fake-gguf-bytes');
    const state = mgr.importModel(src);
    assert.equal(state.selectedModel, path.basename(src));
    const models = mgr.listModels();
    assert.equal(models.length, 1);
    assert.ok(fs.existsSync(models[0].path));
    assert.equal(mgr.status().resolvedModelPath, models[0].path);
});

test('selectModel rejects unknown names; removeModel deletes and clears selection', () => {
    const { mgr } = makeManager();
    const src = path.join(os.tmpdir(), `sel-model-${Date.now()}.gguf`);
    fs.writeFileSync(src, 'x');
    mgr.importModel(src);
    assert.throws(() => mgr.selectModel('nope.gguf'), /not found/);

    const name = path.basename(src);
    mgr.removeModel(name);
    assert.equal(mgr.listModels().length, 0);
    assert.equal(mgr.loadState().selectedModel, null, 'selection cleared when model removed');
});

test('generate auto-downloads the default model when none detected (injected download)', async () => {
    const downloads = [];
    let spawnArgs;
    const fakeSpawn = (cliPath, args) => {
        spawnArgs = { cliPath, args };
        return fakeChild((child) => {
            const outIdx = args.indexOf('-o');
            fs.mkdirSync(path.dirname(args[outIdx + 1]), { recursive: true });
            fs.writeFileSync(args[outIdx + 1], makePng(512, 512)); // v51.8: real PNG — the honest gate verifies it
            child.stderr.emit('data', Buffer.from('|####| 5/20 - 1.9it/s\n'));
            child.emit('close', 0);
        });
    };
    const fakeDownload = async (url, dest) => { downloads.push(url); fs.writeFileSync(dest, 'model-bytes'); };

    const { mgr, events } = makeManager({ spawn: fakeSpawn, downloadFile: fakeDownload });
    // Pre-create the engine binary so only the model needs downloading.
    fs.mkdirSync(path.join(mgr.paths.engineDir), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.engineDir, 'sd-cli'), '#!/bin/sh');

    const res = await mgr.generate({ prompt: 'a red cube' });
    assert.equal(res.success, true);
    assert.ok(fs.existsSync(res.outputPath));
    // v51.8: success carries verifiable proof — size + dimensions read from the real PNG.
    assert.ok(res.size > 0, 'result reports byte size');
    assert.equal(res.width, 512, 'result reports width from IHDR');
    assert.equal(res.height, 512, 'result reports height from IHDR');
    assert.match(downloads[0], /juggernaut-xl-v9-Q8_0\.gguf/, 'default model URL downloaded');
    assert.ok(spawnArgs.args.includes('img_gen'));
    assert.ok(events.some(([ch]) => ch === 'imagegen-event'), 'progress events emitted');
});

test('generate uses the selected imported model and returns a dataUrl for small outputs', async () => {
    const fakeSpawn = (cliPath, args) => fakeChild((child) => {
        const outIdx = args.indexOf('-o');
        fs.mkdirSync(path.dirname(args[outIdx + 1]), { recursive: true });
        fs.writeFileSync(args[outIdx + 1], makePng(64, 64)); // v51.8: real PNG
        child.emit('close', 0);
    });
    const fakeDownload = async () => { throw new Error('should not download'); };
    const { mgr } = makeManager({ spawn: fakeSpawn, downloadFile: fakeDownload });
    fs.mkdirSync(mgr.paths.engineDir, { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.engineDir, 'sd-cli'), '#!/bin/sh');

    const src = path.join(os.tmpdir(), `gen-model-${Date.now()}.gguf`);
    fs.writeFileSync(src, 'my-model');
    mgr.importModel(src);

    const res = await mgr.generate({ prompt: 'hello' });
    assert.equal(res.success, true);
    assert.match(res.model, /gen-model-/, 'selected model used');
    assert.ok(res.dataUrl && res.dataUrl.startsWith('data:image/png;base64,'), 'small output inlined as data URL');
});

test('generate reports failure when sd-cli exits without producing an image', async () => {
    const fakeSpawn = (cliPath, args) => fakeChild((child) => {
        child.stderr.emit('data', Buffer.from('[ERROR] get sd version from file failed\n'));
        child.emit('close', 1);
    });
    const fakeDownload = async (url, dest) => fs.writeFileSync(dest, 'x');
    const { mgr } = makeManager({ spawn: fakeSpawn, downloadFile: fakeDownload });
    fs.mkdirSync(mgr.paths.engineDir, { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.engineDir, 'sd-cli'), '#!/bin/sh');

    const res = await mgr.generate({ prompt: 'x' });
    assert.equal(res.success, false);
    assert.match(res.error, /Generation failed/);
});

// --- v51.8 honest-success gate -------------------------------------------------
test('generate rejects a non-PNG output file as failure (no false success)', async () => {
    const fakeSpawn = (cliPath, args) => fakeChild((child) => {
        const outIdx = args.indexOf('-o');
        fs.mkdirSync(path.dirname(args[outIdx + 1]), { recursive: true });
        fs.writeFileSync(args[outIdx + 1], Buffer.from('this is not a png at all')); // corrupt/truncated output
        child.emit('close', 0); // exit 0 — the trap v51.7 fell into
    });
    const fakeDownload = async (url, dest) => fs.writeFileSync(dest, 'x');
    const { mgr } = makeManager({ spawn: fakeSpawn, downloadFile: fakeDownload });
    fs.mkdirSync(mgr.paths.engineDir, { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.engineDir, 'sd-cli'), '#!/bin/sh');

    const res = await mgr.generate({ prompt: 'x' });
    assert.equal(res.success, false, 'a non-PNG file must NOT be reported as success');
    assert.match(res.error, /not a valid PNG/i);
});

test('generate rejects an empty output file as failure', async () => {
    const fakeSpawn = (cliPath, args) => fakeChild((child) => {
        const outIdx = args.indexOf('-o');
        fs.mkdirSync(path.dirname(args[outIdx + 1]), { recursive: true });
        fs.writeFileSync(args[outIdx + 1], Buffer.alloc(0)); // sd-cli wrote nothing but exited 0
        child.emit('close', 0);
    });
    const fakeDownload = async (url, dest) => fs.writeFileSync(dest, 'x');
    const { mgr } = makeManager({ spawn: fakeSpawn, downloadFile: fakeDownload });
    fs.mkdirSync(mgr.paths.engineDir, { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.engineDir, 'sd-cli'), '#!/bin/sh');

    const res = await mgr.generate({ prompt: 'x' });
    assert.equal(res.success, false);
    assert.match(res.error, /empty file/i);
});

test('pngDimensions reads IHDR width/height and rejects non-PNG buffers', () => {
    const png = makePng(1024, 768);
    assert.deepEqual(pngDimensions(png), { width: 1024, height: 768 });
    assert.equal(pngDimensions(Buffer.from('nope')), null);
    assert.equal(pngDimensions(Buffer.alloc(4)), null); // too short for IHDR
});

// --- v51.8 robust download (real local HTTP server — hermetic) ------------------
function withServer(handler, fn) {
    return new Promise((resolve, reject) => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            Promise.resolve(fn(`http://127.0.0.1:${port}`)).then(
                (v) => { srv.close(() => resolve(v)); },
                (e) => { srv.close(() => reject(e)); }
            );
        });
    });
}

test('downloadFile reports progress on EVERY chunk even without content-length', async () => {
    const dir = tmpDir();
    await withServer((req, res) => {
        // No Content-Length header → chunked transfer (the v51.7 blind spot).
        res.writeHead(200);
        for (let i = 0; i < 4; i++) res.write(`chunk${i}-`);
        res.end();
    }, async (base) => {
        const dest = path.join(dir, 'out.bin');
        const progress = [];
        await downloadFile(base + '/x', dest, { onProgress: (p) => progress.push(p), idleTimeoutMs: 5000 });
        assert.ok(fs.existsSync(dest));
        assert.equal(fs.readFileSync(dest, 'utf8'), 'chunk0-chunk1-chunk2-chunk3-');
        // v51.7 emitted ZERO progress here; v51.8 must report every chunk with pct null.
        assert.ok(progress.length >= 4, `expected per-chunk progress, got ${progress.length}`);
        for (const p of progress) {
            assert.equal(p.total, 0, 'no content-length → total 0');
            assert.equal(p.pct, null, 'pct is null when size unknown');
            assert.ok(p.received > 0, 'received bytes always reported');
        }
    });
});

test('downloadFile reports pct with content-length and cleans up .part on failure', async () => {
    const dir = tmpDir();
    await withServer((req, res) => {
        if (req.url === '/ok') {
            res.writeHead(200, { 'content-length': '10' });
            res.end('0123456789');
        } else {
            // /stall: send a header + one chunk, then go silent → idle watchdog must fire.
            res.writeHead(200, { 'content-length': '1000' });
            res.write('abc');
            // never end — the client's idle timeout should destroy it.
        }
    }, async (base) => {
        const okDest = path.join(dir, 'ok.bin');
        let pctSeen = null;
        await downloadFile(base + '/ok', okDest, { onProgress: (p) => { if (p.pct != null) pctSeen = p.pct; }, idleTimeoutMs: 5000 });
        assert.equal(fs.readFileSync(okDest, 'utf8'), '0123456789');
        assert.ok(pctSeen != null && pctSeen > 0, 'pct reported when content-length present');

        const stallDest = path.join(dir, 'stall.bin');
        await assert.rejects(
            () => downloadFile(base + '/stall', stallDest, { idleTimeoutMs: 300 }),
            /stalled/i,
            'idle watchdog rejects a stalled transfer'
        );
        assert.ok(!fs.existsSync(stallDest), '.part not promoted to final on failure');
        assert.ok(!fs.existsSync(`${stallDest}.part`), '.part cleaned up after failure');
    });
});

test('downloadFile surfaces HTTP errors as rejections', async () => {
    const dir = tmpDir();
    await withServer((req, res) => { res.writeHead(404); res.end('nope'); }, async (base) => {
        await assert.rejects(() => downloadFile(base + '/missing', path.join(dir, 'm.bin')), /HTTP 404/);
    });
});

// --- v51.8 provisioning failure → visible error events --------------------------
test('generate emits generate:error when the model download fails (no silent hang)', async () => {
    const fakeSpawn = () => { throw new Error('should not spawn'); };
    const fakeDownload = async () => { throw new Error('network down: connection reset'); };
    const { mgr, events } = makeManager({ spawn: fakeSpawn, downloadFile: fakeDownload });
    fs.mkdirSync(mgr.paths.engineDir, { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.engineDir, 'sd-cli'), '#!/bin/sh');

    const res = await mgr.generate({ prompt: 'x' });
    assert.equal(res.success, false);
    assert.match(res.error, /could not start/i);
    // The failure must be visible on BOTH the model phase and the generate phase.
    assert.ok(events.some(([ch, ev]) => ch === 'imagegen-event' && ev.phase === 'model' && ev.status === 'error'), 'model error event emitted');
    assert.ok(events.some(([ch, ev]) => ch === 'imagegen-event' && ev.phase === 'generate' && ev.status === 'error'), 'generate error event emitted');
});

test('status() exposes in-flight download state (engineBusy/modelBusy/generating)', async () => {
    let releaseDownload;
    const gate = new Promise((r) => { releaseDownload = r; });
    const fakeDownload = async (url, dest, opts) => {
        if (opts && opts.onProgress) opts.onProgress({ received: 123456789, total: 4000000000, pct: 3 });
        await gate; // hold the download open so status() can observe it mid-flight
        fs.writeFileSync(dest, 'model-bytes');
    };
    const fakeSpawn = (cliPath, args) => fakeChild((child) => {
        const outIdx = args.indexOf('-o');
        fs.mkdirSync(path.dirname(args[outIdx + 1]), { recursive: true });
        fs.writeFileSync(args[outIdx + 1], makePng(32, 32));
        child.emit('close', 0);
    });
    const { mgr } = makeManager({ spawn: fakeSpawn, downloadFile: fakeDownload });
    fs.mkdirSync(mgr.paths.engineDir, { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.engineDir, 'sd-cli'), '#!/bin/sh');

    const genPromise = mgr.generate({ prompt: 'x' });
    // Wait a tick for the download to start and modelBusy to be set.
    await new Promise((r) => setTimeout(r, 20));
    const st = mgr.status();
    assert.ok(st.modelBusy, 'modelBusy present while downloading');
    assert.equal(st.modelBusy.received, 123456789);
    assert.equal(st.generating, true, 'generating flag set during a run');

    releaseDownload();
    const res = await genPromise;
    assert.equal(res.success, true, 'run completes once the download is released');
});

// --- IPC domain ---------------------------------------------------------------
test('imagegen IPC handlers forward to the manager', async () => {
    const handlers = new Map();
    const ipcMain = { handle: (n, fn) => handlers.set(n, fn) };
    const calls = [];
    const fakeManager = {
        status: () => ({ enabled: true }),
        loadState: () => ({ settings: {} }),
        saveState: (p) => { calls.push(['save', p]); return {}; },
        listModels: () => [],
        importModel: (s) => { calls.push(['import', s]); return {}; },
        importFromUrl: async (u) => { calls.push(['url', u]); return {}; },
        selectModel: (n) => { calls.push(['select', n]); return {}; },
        removeModel: (n) => { calls.push(['remove', n]); return {}; },
        generate: async (o) => { calls.push(['gen', o]); return { success: true }; }
    };
    registerImageGenIpc(ipcMain, { imageGenManager: fakeManager });

    assert.deepEqual(await handlers.get('imagegen-status')({}), { enabled: true });
    await handlers.get('imagegen-set-enabled')({}, true);
    assert.deepEqual(calls[0], ['save', { enabled: true }]);
    await handlers.get('imagegen-generate')({}, { prompt: 'cat' });
    assert.deepEqual(calls[calls.length - 1], ['gen', { prompt: 'cat' }]);

    // Every channel the domain registers must be whitelisted.
    for (const ch of [...handlers.keys()]) {
        assert.ok(ipcChannels.INVOKE_CHANNELS.includes(ch), `${ch} missing from INVOKE_CHANNELS`);
    }
});
