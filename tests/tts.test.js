/**
 * TTS (Piper) — v55.5 regression tests for src/main/lifecycle/tts.js.
 *
 * The bug: SPEAK RESPONSES drove window.speechSynthesis, which Electron on Linux
 * has no backend for — utterances were silently dropped (toggle on + prompt =
 * zero audio). The fix moves TTS to the main process with a bundled Piper
 * runtime. These tests drive the module's real code paths with FAKE piper and
 * player binaries (shell scripts), so no 130MB runtime or audio device is needed:
 *   - runtime resolution (bundled dir layout, first-match-wins)
 *   - which()/findPlayer() PATH probing
 *   - synthesize(): success, non-zero exit with stderr, timeout kill
 *   - playWav(): completion + interrupt (newest response wins)
 *   - IPC handlers: tts-status / tts-speak incl. supersede + temp-file cleanup
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tts = require('../src/main/lifecycle/tts.js'); // main export = register function; helpers hang off it
const registerTtsIpc = tts.registerTtsIpc || tts;

// --- fakes -------------------------------------------------------------------

/** A fake Piper: reads stdin to EOF, writes a stub WAV at --output_file. */
function makeFakePiper(dir, { sleepSec = 0 } = {}) {
    const lines = [
        '#!/bin/sh',
        'cat > /dev/null',
        'prev=""',
        'out=""',
        'for a in "$@"; do',
        '  if [ "$prev" = "--output_file" ]; then out="$a"; fi',
        '  prev="$a"',
        'done',
        sleepSec ? `sleep ${sleepSec}` : '',
        "printf 'RIFF-fake-wav' > \"$out\"",
        'exit 0'
    ].filter(Boolean);
    fs.writeFileSync(path.join(dir, 'piper'), lines.join('\n') + '\n');
    fs.chmodSync(path.join(dir, 'piper'), 0o755);
}

/** A fake Piper that fails with a diagnostic on stderr. */
function makeBrokenPiper(dir) {
    const lines = [
        '#!/bin/sh',
        'cat > /dev/null',
        'echo "onnxruntime: model file not found" >&2',
        'exit 3'
    ];
    fs.writeFileSync(path.join(dir, 'piper'), lines.join('\n') + '\n');
    fs.chmodSync(path.join(dir, 'piper'), 0o755);
}

/** A fake player: stays alive `sleepSec`, then exits with code. */
function makeFakePlayer(dir, name, { sleepSec = 0.3, exitCode = 0 } = {}) {
    const lines = [
        '#!/bin/sh',
        'cat > /dev/null', // consume the wav path arg (players take it as $1)
        `sleep ${sleepSec}`,
        `exit ${exitCode}`
    ];
    fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n');
    fs.chmodSync(path.join(dir, name), 0o755);
}

/**
 * A complete fake Piper runtime in the shipped layout: <root>/piper/{piper, voices/<voice>.onnx}.
 * Returns { root, dir } — `root` is what registerTtsIpc/resolvePiperRuntime take as resourcesDir.
 */
function makeFakeRuntime({ sleepSec = 0 } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-res-'));
    const dir = path.join(root, 'piper');
    fs.mkdirSync(dir);
    makeFakePiper(dir, { sleepSec });
    fs.mkdirSync(path.join(dir, 'voices'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'voices', `${tts.VOICE_NAME}.onnx`), 'fake-model');
    return { root, dir };
}

/**
 * Run fn with extraDir prepended to PATH. Async-aware: PATH stays prefixed until
 * the (possibly awaited) callback fully settles — handlers spawn players lazily.
 */
async function withPathPrefix(extraDir, fn) {
    const original = process.env.PATH;
    process.env.PATH = extraDir + path.delimiter + (original || '');
    try {
        return await fn();
    } finally {
        process.env.PATH = original;
    }
}

function fakeIpcMain() {
    const handlers = {};
    return {
        handlers,
        handle(channel, handler) { handlers[channel] = handler; },
        invoke(channel, ...args) {
            assert.ok(handlers[channel], `no handler registered for ${channel}`);
            return Promise.resolve(handlers[channel]({ sender: {} }, ...args));
        }
    };
}

// --- runtime resolution --------------------------------------------------------

test('findRuntimeIn locates the bundled layout (piper binary + voices/<voice>.onnx)', () => {
    const { root, dir } = makeFakeRuntime();
    try {
        const found = tts.findRuntimeIn([dir]);
        assert.ok(found, 'runtime should be found');
        assert.equal(found.piperBin, path.join(dir, 'piper'));
        assert.equal(found.modelPath, path.join(dir, 'voices', `${tts.VOICE_NAME}.onnx`));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('findRuntimeIn returns null when the voice model is missing (binary alone is not a runtime)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-nomodel-'));
    try {
        makeFakePiper(dir); // binary present, no voices/
        assert.equal(tts.findRuntimeIn([dir]), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('findRuntimeIn returns null for an empty dir list / nonexistent dirs', () => {
    assert.equal(tts.findRuntimeIn([]), null);
    assert.equal(tts.findRuntimeIn([path.join(os.tmpdir(), 'definitely-not-here-xyz')]), null);
});

test('resolvePiperRuntime prefers the explicit resourcesDir (packaged layout) over later candidates', () => {
    const { root } = makeFakeRuntime();
    try {
        const found = tts.resolvePiperRuntime({ resourcesDir: root });
        assert.ok(found, 'runtime should resolve from resourcesDir');
        assert.equal(found.piperBin, path.join(root, 'piper', 'piper'));
        assert.equal(found.modelPath, path.join(root, 'piper', 'voices', `${tts.VOICE_NAME}.onnx`));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resolvePiperRuntime never returns a dangling path (found ⇒ files exist)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-empty-'));
    try {
        // resourcesDir first; in plain node process.resourcesPath is unset, so the dev
        // checkout's resources/piper may still be found. Contract: if found, it must point
        // at real files — never a path that does not exist.
        const found = tts.resolvePiperRuntime({ resourcesDir: empty });
        if (found) {
            assert.ok(fs.existsSync(found.piperBin), 'piper binary exists');
            assert.ok(fs.existsSync(found.modelPath), 'voice model exists');
        } else {
            assert.equal(found, null);
        }
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

// --- which / findPlayer ---------------------------------------------------------

test('which() finds an executable on PATH and returns null for missing names', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-which-'));
    try {
        fs.writeFileSync(path.join(dir, 'mytool'), '#!/bin/sh\nexit 0');
        fs.chmodSync(path.join(dir, 'mytool'), 0o755);
        await withPathPrefix(dir, () => {
            assert.equal(tts.which('mytool'), path.join(dir, 'mytool'));
            assert.equal(tts.which('no-such-tool-xyz-123'), null);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('findPlayer() picks paplay over aplay on Linux (PulseAudio/PipeWire first)', async () => {
    if (process.platform !== 'linux') return; // host-specific: player layout differs per OS
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-player-'));
    try {
        makeFakePlayer(dir, 'paplay');
        makeFakePlayer(dir, 'aplay');
        await withPathPrefix(dir, () => {
            const player = tts.findPlayer();
            assert.ok(player);
            assert.equal(path.basename(player.cmd), 'paplay', 'paplay must win over aplay');
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('findPlayer() falls back to aplay when paplay is absent (host without paplay)', async () => {
    if (process.platform !== 'linux') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-player2-'));
    try {
        makeFakePlayer(dir, 'aplay'); // no paplay in this dir
        await withPathPrefix(dir, () => {
            const player = tts.findPlayer();
            assert.ok(player);
            if (!fs.existsSync('/usr/bin/paplay')) assert.equal(path.basename(player.cmd), 'aplay');
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- synthesize ------------------------------------------------------------------

test('synthesize() resolves when the piper binary exits 0 and wrote the wav', async () => {
    const { root, dir } = makeFakeRuntime();
    const wavOut = path.join(os.tmpdir(), `xk-tts-out-${Date.now()}.wav`);
    try {
        await tts.synthesize({ piperBin: path.join(dir, 'piper'), modelPath: path.join(dir, 'voices', `${tts.VOICE_NAME}.onnx`) }, 'hello world', wavOut);
        assert.ok(fs.existsSync(wavOut), 'wav file must exist');
        assert.match(fs.readFileSync(wavOut, 'utf8'), /^RIFF/);
    } finally {
        try { fs.unlinkSync(wavOut); } catch (_) { /* ignore */ }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('synthesize() rejects with stderr context when piper exits non-zero', async () => {
    const { root, dir } = makeFakeRuntime();
    makeBrokenPiper(dir); // overwrite the working fake with a failing one
    try {
        await assert.rejects(
            tts.synthesize({ piperBin: path.join(dir, 'piper'), modelPath: path.join(dir, 'voices', `${tts.VOICE_NAME}.onnx`) }, 'hello', path.join(os.tmpdir(), `xk-tts-out-${Date.now()}b.wav`)),
            (err) => /exited with code 3/.test(err.message) && /model file not found/.test(err.message)
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('synthesize() rejects and kills the child on timeout', async () => {
    const { root, dir } = makeFakeRuntime({ sleepSec: 5 }); // slower than the test timeout
    try {
        await assert.rejects(
            tts.synthesize({ piperBin: path.join(dir, 'piper'), modelPath: path.join(dir, 'voices', `${tts.VOICE_NAME}.onnx`) }, 'hello', path.join(os.tmpdir(), `xk-tts-out-${Date.now()}c.wav`), 400),
            /timed out after/
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// --- playWav -----------------------------------------------------------------------

test('playWav() resolves when the player exits cleanly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-play-'));
    try {
        makeFakePlayer(dir, 'paplay', { sleepSec: 0.2 });
        const wav = path.join(dir, 'a.wav');
        fs.writeFileSync(wav, 'RIFF-fake');
        const { promise } = tts.playWav({ cmd: path.join(dir, 'paplay'), argsFor: w => [w] }, wav);
        assert.equal(await promise, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('playWav() kill() interrupts in-flight playback and the promise still settles', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-play2-'));
    try {
        makeFakePlayer(dir, 'paplay', { sleepSec: 5 }); // long "speech"
        const wav = path.join(dir, 'a.wav');
        fs.writeFileSync(wav, 'RIFF-fake');
        const handle = tts.playWav({ cmd: path.join(dir, 'paplay'), argsFor: w => [w] }, wav);
        setTimeout(() => handle.kill(), 150); // interrupt mid-playback (newest response wins)
        const t0 = Date.now();
        await handle.promise; // must settle promptly after the kill — not wait out 5s
        assert.ok(Date.now() - t0 < 3000, 'killed playback settles well before its natural end');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- IPC handlers --------------------------------------------------------------------

test('tts-status reports the Piper engine when runtime + player are present', async () => {
    const { root } = makeFakeRuntime();
    const players = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-ipcp-'));
    try {
        makeFakePlayer(players, 'paplay');
        await withPathPrefix(players, async () => {
            const ipc = fakeIpcMain();
            registerTtsIpc(ipc, { resourcesDir: root });
            const status = await ipc.invoke('tts-status');
            assert.equal(status.ok, true);
            assert.equal(status.engine, 'piper');
            assert.equal(status.voice, tts.VOICE_NAME);
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(players, { recursive: true, force: true });
    }
});

test('tts-status reports a reason when the runtime is missing', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-ipce-'));
    try {
        // resourcesDir first + no process.resourcesPath in plain node → only the dev
        // checkout's resources/piper can still hit. Contract: if not ok, it says why.
        const ipc = fakeIpcMain();
        registerTtsIpc(ipc, { resourcesDir: empty });
        const status = await ipc.invoke('tts-status');
        assert.ok(typeof status.ok === 'boolean');
        if (!status.ok) assert.match(status.reason, /Piper runtime not found|audio player/);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

test('tts-speak synthesizes + plays and cleans up its temp wav', async () => {
    const { root } = makeFakeRuntime();
    const players = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-ipcs-'));
    try {
        makeFakePlayer(players, 'paplay', { sleepSec: 0.1 });
        await withPathPrefix(players, async () => {
            const ipc = fakeIpcMain();
            registerTtsIpc(ipc, { resourcesDir: root });

            const before = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('agent-smith-tts-'));
            const res = await ipc.invoke('tts-speak', 'Agent Smith audio is operational.');
            assert.equal(res.success, true);

            // Temp wav must be gone (finally-block cleanup).
            await new Promise(r => setTimeout(r, 50));
            const after = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('agent-smith-tts-'));
            assert.deepEqual(after.filter(f => !before.includes(f)), [], 'no leaked temp wav files');
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(players, { recursive: true, force: true });
    }
});

test('tts-speak with empty text is a no-op success (nothing to say)', async () => {
    const ipc = fakeIpcMain();
    registerTtsIpc(ipc, {});
    assert.deepEqual(await ipc.invoke('tts-speak', '   '), { success: true, skipped: 'empty' });
});

test('tts-speak returns an error object (never throws) when the runtime is missing', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-ipcm-'));
    try {
        const ipc = fakeIpcMain();
        registerTtsIpc(ipc, { resourcesDir: empty });
        // If the dev checkout ships resources/piper this resolves success — assert the
        // contract either way: a result object, never an exception.
        const res = await ipc.invoke('tts-speak', 'hello');
        assert.ok(res && typeof res === 'object');
        if (!res.success) assert.match(res.error, /Piper runtime not found|audio player/);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

test('a newer tts-speak supersedes an in-flight one (newest response wins)', async () => {
    const { root } = makeFakeRuntime({ sleepSec: 0.6 }); // slow synthesis → overlap window
    const players = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-tts-ipcx-'));
    try {
        makeFakePlayer(players, 'paplay', { sleepSec: 0.1 });
        await withPathPrefix(players, async () => {
            const ipc = fakeIpcMain();
            registerTtsIpc(ipc, { resourcesDir: root });

            const first = ipc.invoke('tts-speak', 'first response');
            await new Promise(r => setTimeout(r, 80)); // inside the first synthesis window
            const second = ipc.invoke('tts-speak', 'second response');

            const r1 = await first;
            const r2 = await second;
            assert.equal(r2.success, true);
            // The first request must NOT have played: it was superseded mid-flight.
            if (r1.success) assert.equal(r1.superseded, true, 'late-arriving first reply is marked superseded');
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(players, { recursive: true, force: true });
    }
});
