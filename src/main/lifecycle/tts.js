'use strict';
/**
 * TTS — Piper speech engine (main process). v55.5.
 *
 * Why this exists: the SPEAK RESPONSES toggle used to call window.speechSynthesis
 * (Web Speech API) in the renderer, but Electron on Linux ships NO speech
 * synthesis backend — utterances are silently dropped, so enabling the toggle
 * and prompting produced zero audio. Piper was removed from the app in v44.2
 * ("Browser Web Speech API TTS remains") and that "remaining" path never worked
 * here. This module restores real desktop TTS:
 *
 *   - Bundled Piper runtime (resources/piper/: piper binary + onnxruntime +
 *     espeak-ng phonemizer data) with the en_US-joe-medium voice, so it works
 *     out of the box in the AppImage/.deb with no system packages.
 *   - Synthesis: `piper --model <voice> --output_file <tmp.wav>` (stdin text).
 *   - Playback: paplay/aplay on Linux, afplay on macOS, PowerShell SoundPlayer
 *     on Windows. The newest response wins — a new request kills in-flight audio.
 *
 * IPC surface (both invoke):
 *   tts-status  → { ok:true, engine:'piper', voice } | { ok:false, reason }
 *   tts-speak   → { success:true } | { error }        (resolves when done playing)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VOICE_NAME = 'en_US-joe-medium';
const MAX_SPEAK_CHARS = 32768; // soft cap — keep synthesis/playback bounded on huge replies
const SYNTH_TIMEOUT_MS = 90000;

// --- runtime resolution ------------------------------------------------------

/**
 * First candidate dir that contains both the piper binary and the voice model.
 */
function findRuntimeIn(dirs) {
    for (const dir of dirs || []) {
        const piperBin = path.join(dir, process.platform === 'win32' ? 'piper.exe' : 'piper');
        const modelPath = path.join(dir, 'voices', `${VOICE_NAME}.onnx`);
        try {
            if (fs.existsSync(piperBin) && fs.existsSync(modelPath)) return { piperBin, modelPath };
        } catch (_) { /* keep looking */ }
    }
    return null;
}

/**
 * Locate the bundled Piper runtime.
 *   dev:        <repo>/resources/piper            (main.js at repo root)
 *   packaged:   <electron resourcesPath>/piper    (electron-builder extraResources)
 * Returns { piperBin, modelPath } or null when the runtime is absent.
 */
function resolvePiperRuntime(opts = {}) {
    const candidates = [];
    if (opts.resourcesDir) candidates.push(path.join(opts.resourcesDir, 'piper'));
    // src/main/lifecycle/tts.js → repo root in dev.
    candidates.push(path.join(__dirname, '..', '..', '..', 'resources', 'piper'));
    try { if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'piper')); } catch (_) { /* non-electron */ }
    return findRuntimeIn(candidates);
}

/**
 * Minimal which(1): first executable match on PATH.
 * Windows executables are never extension-less (powershell → powershell.exe),
 * so on win32 the PATHEXT suffixes are tried too — without that, findPlayer()
 * finds no player on Windows and TTS reports "no audio player available".
 */
function which(name) {
    const isWin = process.platform === 'win32';
    const exts = isWin
        ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
        : [''];
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        for (const ext of exts) {
            const suffix = (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) ? ext : '';
            try {
                const candidate = path.join(dir, name + suffix);
                fs.accessSync(candidate, fs.constants.X_OK);
                return candidate;
            } catch (_) { /* not here — try next suffix / PATH entry */ }
        }
    }
    return null;
}

/**
 * Pick a WAV player for the host. Returns { cmd, argsFor(wav) } or null.
 * Linux: paplay (PulseAudio/PipeWire) preferred, aplay (ALSA) as fallback.
 */
function findPlayer() {
    if (process.platform === 'linux') {
        const paplay = which('paplay');
        if (paplay) return { cmd: paplay, argsFor: wav => [wav] };
        const aplay = which('aplay');
        if (aplay) return { cmd: aplay, argsFor: wav => [wav] };
        return null;
    }
    if (process.platform === 'darwin') {
        return { cmd: '/usr/bin/afplay', argsFor: wav => [wav] };
    }
    if (process.platform === 'win32') {
        // 16-bit PCM WAV — exactly what Piper emits.
        const ps = which('powershell');
        if (!ps) return null;
        return { cmd: ps, argsFor: wav => ['-NoProfile', '-NonInteractive', '-Command',
            `(New-Object System.Media.SoundPlayer '${wav.replace(/'/g, "''")}').PlaySync()`] };
    }
    return null;
}

// --- synthesis + playback ----------------------------------------------------

/**
 * Run Piper over `text` (stdin) into wavOut. Resolves on exit 0 with the file
 * present; rejects with a diagnostic-carrying Error otherwise.
 */
function synthesize(runtime, text, wavOut, timeoutMs = SYNTH_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            // ESPEAK_DATA_PATH: the phonemizer's espeak-ng data ships inside the
            // runtime dir — required on machines without a system espeak-ng-data.
            const env = Object.assign({}, process.env);
            env.ESPEAK_DATA_PATH = path.join(path.dirname(runtime.piperBin), 'espeak-ng-data');
            child = spawn(runtime.piperBin, ['--model', runtime.modelPath, '--output_file', wavOut], {
                stdio: ['pipe', 'ignore', 'pipe'],
                env
            });
        } catch (err) {
            reject(err);
            return;
        }

        let stderr = '';
        child.stderr.on('data', d => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-8000); });

        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
            reject(new Error(`Piper synthesis timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);

        child.on('error', err => { clearTimeout(timer); reject(err); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(wavOut)) resolve();
            else reject(new Error(`Piper exited with code ${code}${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`));
        });

        child.stdin.on('error', () => { /* EPIPE if piper died early — close handler reports it */ });
        child.stdin.write(text);
        child.stdin.end();
    });
}

/**
 * Play wavPath with the given player. Returns { promise, kill } so a newer
 * request can interrupt in-flight audio (newest response wins).
 */
function playWav(player, wavPath) {
    let killed = false;
    let child = null;
    const promise = new Promise((resolve, reject) => {
        try {
            child = spawn(player.cmd, player.argsFor(wavPath), { stdio: 'ignore' });
        } catch (err) {
            reject(err);
            return;
        }
        child.on('error', err => reject(new Error(`Audio playback failed to start (${player.cmd}): ${err.message}`)));
        child.on('close', code => resolve(code === 0 || killed));
    });
    const handle = {
        kill() {
            if (killed) return;
            killed = true;
            if (!child) return;
            try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* give up */ } }, 1500).unref();
        }
    };
    return { promise, kill: handle.kill };
}

// --- IPC registration --------------------------------------------------------

module.exports = function registerTtsIpc(ipcMain, opts = {}) {
    let runtimeCache; // undefined = not probed yet
    const getRuntime = () => {
        if (!runtimeCache) runtimeCache = resolvePiperRuntime(opts);
        return runtimeCache;
    };

    let generation = 0;      // bumped per request — stale work bails out
    let activePlayback = null;

    const stopPlayback = () => {
        if (activePlayback) {
            try { activePlayback.kill(); } catch (_) { /* ignore */ }
            activePlayback = null;
        }
    };

    ipcMain.handle('tts-status', () => {
        const runtime = getRuntime();
        if (!runtime) return { ok: false, reason: 'bundled Piper runtime not found (resources/piper)' };
        if (!findPlayer()) return { ok: false, reason: 'no audio player available on this system' };
        return { ok: true, engine: 'piper', voice: VOICE_NAME };
    });

    ipcMain.handle('tts-speak', async (_event, payload) => {
        const text = typeof payload === 'string' ? payload : (payload && String(payload.text || ''));
        if (!text.trim()) return { success: true, skipped: 'empty' };

        const runtime = getRuntime();
        if (!runtime) return { error: 'bundled Piper runtime not found (resources/piper)' };
        const player = findPlayer();
        if (!player) return { error: 'no audio player available on this system' };

        generation += 1;
        const gen = generation;
        stopPlayback(); // newest response wins — interrupt any in-flight audio

        const wavOut = path.join(os.tmpdir(), `agent-smith-tts-${process.pid}-${crypto.randomBytes(4).toString('hex')}.wav`);
        try {
            await synthesize(runtime, text.slice(0, MAX_SPEAK_CHARS), wavOut);
            if (gen !== generation) return { success: true, superseded: true }; // a newer reply arrived mid-synthesis

            const playback = playWav(player, wavOut);
            activePlayback = playback;
            await playback.promise;
            if (activePlayback === playback) activePlayback = null;
            return { success: true };
        } catch (err) {
            return { error: err.message || String(err) };
        } finally {
            try { fs.unlinkSync(wavOut); } catch (_) { /* temp file — best effort */ }
        }
    });
};

module.exports.resolvePiperRuntime = resolvePiperRuntime;
module.exports.findRuntimeIn = findRuntimeIn;
module.exports.findPlayer = findPlayer;
module.exports.which = which;
module.exports.synthesize = synthesize;
module.exports.playWav = playWav;
module.exports.VOICE_NAME = VOICE_NAME;
module.exports.MAX_SPEAK_CHARS = MAX_SPEAK_CHARS;
