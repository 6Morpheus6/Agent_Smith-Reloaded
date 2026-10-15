'use strict';
/**
 * TTS — Piper speech engine (main process). v55.5 → multi-language.
 *
 * Why this exists: the SPEAK RESPONSES toggle used to call window.speechSynthesis
 * (Web Speech API) in the renderer, but Electron on Linux ships NO speech
 * synthesis backend — utterances are silently dropped, so enabling the toggle
 * and prompting produced zero audio. This module drives the bundled Piper
 * runtime in the main process instead.
 *
 * Multi-language support:
 *   - VOICES below is the single source of truth for the language dropdown
 *     (index.html <select id="tts-lang-select"> mirrors the keys/labels).
 *     All voices are MALE, non-emotional, from the user's clone of
 *     rhasspy/piper-voices: https://huggingface.co/6Morpheus6/piper-voices
 *   - Only "medium" quality models are used, except Italian (it_IT-riccardo
 *     exists only as x_low — there is no male medium Italian voice).
 *   - A missing model is downloaded on demand (tts-ensure-voice / before
 *     synthesis) into the first WRITABLE voices/ dir, so a fresh GitHub
 *     checkout (voices/ empty) works for both the Pinokio launcher mode
 *     (pinokio-server.js fakes Electron) and a manual install.
 *
 * Runtime layout:  resources/piper/{piper|piper.exe, espeak-ng-data/, voices/}
 *
 * IPC surface (all invoke):
 *   tts-status        → { ok:true, engine:'piper', voice, lang, modelPresent }
 *                     | { ok:false, reason }
 *   tts-ensure-voice  → { ok:true, lang, voice, modelPath, downloaded } | { ok:false, error }
 *   tts-speak         → { success:true } | { error }   (payload: string | { text, lang })
 * Push events (opts.pushEvent → renderer 'tts-event'):
 *   { phase:'start'|'progress'|'done'|'error', lang, voice, file?, pct?, ... }
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VOICE_NAME = 'en_US-joe-medium'; // default (English) voice — the shipped model
const MAX_SPEAK_CHARS = 32768; // soft cap — keep synthesis/playback bounded on huge replies
const SYNTH_TIMEOUT_MS = 90000;

// --- voices / languages ------------------------------------------------------
// Keep in sync with the <select id="tts-lang-select"> options in index.html.
const VOICE_REPO_BASE = 'https://huggingface.co/6Morpheus6/piper-voices/resolve/main/';
const VOICES = {
    en: { label: 'English', voice: 'en_US-joe-medium', file: 'en/en_US/joe/medium/en_US-joe-medium.onnx',
        test: 'Agent Smith audio is operational.' },
    de: { label: 'Deutsch', voice: 'de_DE-karlsson-low', file: 'de/de_DE/karlsson/low/de_DE-karlsson-low.onnx',
        test: 'Die Sprachausgabe von Agent Smith ist betriebsbereit.' },
    fr: { label: 'Français', voice: 'fr_FR-tom-medium', file: 'fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx',
        test: "La synthèse vocale d'Agent Smith est opérationnelle." },
    es: { label: 'Español', voice: 'es_ES-davefx-medium', file: 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx',
        test: 'El sistema de voz del Agente Smith está operativo.' },
    it: { label: 'Italiano', voice: 'it_IT-riccardo-x_low', file: 'it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx',
        test: 'Il sistema vocale di Agent Smith è operativo.' },
    pl: { label: 'Polski', voice: 'pl_PL-darkman-medium', file: 'pl/pl_PL/darkman/medium/pl_PL-darkman-medium.onnx',
        test: 'System mowy Agenta Smitha jest gotowy do pracy.' },
    ru: { label: 'Русский', voice: 'ru_RU-denis-medium', file: 'ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx',
        test: 'Голосовая система Агента Смита готова к работе.' }
};
const DEFAULT_LANG = 'en';

/** Unknown/absent lang codes fall back to the default (English) voice. */
function normalizeLang(lang) {
    const l = String(lang == null ? '' : lang).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(VOICES, l) ? l : DEFAULT_LANG;
}

/**
 * Resolve the text for a tts-speak payload:
 *   string payload      → the string itself (legacy callers; empty → skip)
 *   { test:true, lang } → the localized TEST sentence for that language
 *   { text, lang }      → the text
 *   no payload          → skip (legacy contract)
 */
function resolveSpeakText(payload) {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
        const lang = normalizeLang(payload.lang);
        if (payload.test) return VOICES[lang].test;
        return String(payload.text || '');
    }
    return ''; // legacy: nothing to say
}

// --- runtime resolution ------------------------------------------------------

/**
 * Candidate dirs that may hold the Piper engine (piper binary + espeak data):
 *   opts.resourcesDir/piper → dev <repo>/resources/piper → packaged <resourcesPath>/piper
 */
function engineDirCandidates(opts = {}) {
    const dirs = [];
    if (opts.resourcesDir) dirs.push(path.join(opts.resourcesDir, 'piper'));
    // src/main/lifecycle/tts.js → repo root in dev.
    dirs.push(path.join(__dirname, '..', '..', '..', 'resources', 'piper'));
    try { if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'piper')); } catch (_) { /* non-electron */ }
    return dirs;
}

/** First dir in `dirs` that contains the piper binary → { dir, piperBin }. */
function findEngineIn(dirs) {
    for (const dir of dirs || []) {
        const piperBin = path.join(dir, process.platform === 'win32' ? 'piper.exe' : 'piper');
        try {
            if (fs.existsSync(piperBin)) return { dir, piperBin };
        } catch (_) { /* keep looking */ }
    }
    return null;
}

/** Engine-only resolution (model may still be missing / downloading). */
function resolveEngine(opts = {}) {
    return findEngineIn(engineDirCandidates(opts));
}

/** First candidate dir that contains both the piper binary and the default voice model. */
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
 * Locate the bundled Piper runtime (engine + default English model).
 *   dev:        <repo>/resources/piper            (main.js at repo root)
 *   packaged:   <electron resourcesPath>/piper    (electron-builder extraResources)
 * Returns { piperBin, modelPath } or null when the runtime is absent.
 */
function resolvePiperRuntime(opts = {}) {
    return findRuntimeIn(engineDirCandidates(opts));
}

/** All possible voices/ dirs (lookup order). Includes the writable userData fallback. */
function voiceDirCandidates(opts = {}) {
    const dirs = engineDirCandidates(opts).map((d) => path.join(d, 'voices'));
    try {
        const { app } = require('electron'); // faked by pinokio-server.js; absent in plain-node tests
        if (app && typeof app.getPath === 'function') {
            dirs.push(path.join(app.getPath('userData'), 'piper', 'voices'));
        }
    } catch (_) { /* plain node (unit tests) — no userData fallback */ }
    return [...new Set(dirs)];
}

/** A voice counts as installed when model + config JSON are both present. */
function isModelComplete(dir, voice) {
    try {
        return fs.statSync(path.join(dir, `${voice}.onnx`)).isFile() &&
            fs.statSync(path.join(dir, `${voice}.onnx.json`)).isFile();
    } catch (_) {
        return false;
    }
}

/** Locate an installed model for `lang` across all candidate dirs, or null. */
function findModelFor(lang, opts = {}) {
    const l = normalizeLang(lang);
    const voice = VOICES[l].voice;
    for (const dir of voiceDirCandidates(opts)) {
        if (isModelComplete(dir, voice)) return { lang: l, voice, modelPath: path.join(dir, `${voice}.onnx`) };
    }
    return null;
}

/** First voices/ dir we can actually write to (AppImage resources are read-only). */
function pickWritableVoiceDir(opts = {}) {
    for (const dir of voiceDirCandidates(opts)) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const probe = path.join(dir, `.writetest-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
            fs.writeFileSync(probe, 'x');
            fs.unlinkSync(probe);
            return dir;
        } catch (_) { /* not writable — try the next candidate */ }
    }
    return null;
}

// --- voice download ----------------------------------------------------------

const inFlightEnsures = new Map(); // lang → Promise<ensure result> (dedupe concurrent requests)

/**
 * Download `<voice>.onnx.json` + `<voice>.onnx` from the HuggingFace repo into
 * the first writable voices dir. The small config is fetched FIRST so a finished
 * .onnx always has its config beside it (partial state self-heals on retry).
 * Returns the found { lang, voice, modelPath } or throws.
 */
async function downloadVoice(lang, opts, onProgress) {
    const l = normalizeLang(lang);
    const spec = VOICES[l];
    const dir = pickWritableVoiceDir(opts);
    if (!dir) throw new Error('no writable directory for TTS voice models');

    const download = opts.downloadFile || require('../services/imageGenManager.js').downloadFile;
    const dlOpts = {
        // Big models on slow links: only a 60s *silence* aborts the transfer.
        timeoutMs: 60000,
        idleTimeoutMs: 60000,
        onProgress: (p) => { if (onProgress) onProgress(Object.assign({ lang: l, voice: spec.voice }, p)); }
    };
    await download(VOICE_REPO_BASE + spec.file + '.json', path.join(dir, `${spec.voice}.onnx.json`), dlOpts);
    await download(VOICE_REPO_BASE + spec.file, path.join(dir, `${spec.voice}.onnx`), dlOpts);

    const found = findModelFor(l, opts);
    if (!found) throw new Error('download finished but the model is still missing');
    return found;
}

/**
 * Guarantee the model for `lang` exists — downloads it when missing.
 * Concurrent calls for the same language share one download.
 * Returns { ok:true, lang, voice, modelPath, downloaded } | { ok:false, error }.
 */
async function ensureVoice(lang, opts = {}, onProgress) {
    const l = normalizeLang(lang);
    const present = findModelFor(l, opts);
    if (present) return { ok: true, lang: l, voice: present.voice, modelPath: present.modelPath, downloaded: false };

    const running = inFlightEnsures.get(l);
    if (running) return running;

    const job = (async () => {
        try {
            const found = await downloadVoice(l, opts, onProgress);
            return { ok: true, lang: l, voice: found.voice, modelPath: found.modelPath, downloaded: true };
        } catch (err) {
            return { ok: false, lang: l, voice: VOICES[l].voice, error: (err && err.message) || String(err) };
        }
    })();
    inFlightEnsures.set(l, job);
    try {
        return await job;
    } finally {
        inFlightEnsures.delete(l);
    }
}

// --- minimal which(1) --------------------------------------------------------

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
    // Progress fan-out: Electron webContents.send + SSE (web/Pinokio mode) in one call.
    const emit = (payload) => {
        if (typeof opts.pushEvent !== 'function') return;
        try { opts.pushEvent('tts-event', payload); } catch (_) { /* non-fatal */ }
    };

    let engineCache; // undefined = not probed yet
    const getEngine = () => {
        if (!engineCache) engineCache = resolveEngine(opts);
        return engineCache;
    };

    /** Throttled progress emitter: percent changes and ≤ 4 Hz. */
    const progressEmitter = (lang) => {
        let lastPct = null;
        let lastAt = 0;
        return (p) => {
            const now = Date.now();
            const pct = p && p.pct != null ? p.pct : null;
            if (pct !== lastPct || now - lastAt > 250) {
                lastPct = pct;
                lastAt = now;
                emit({ phase: 'progress', lang, voice: p.voice, file: p.file, pct, received: p.received, total: p.total });
            }
        };
    };

    let generation = 0;      // bumped per request — stale work bails out
    let activePlayback = null;

    const stopPlayback = () => {
        if (activePlayback) {
            try { activePlayback.kill(); } catch (_) { /* ignore */ }
            activePlayback = null;
        }
    };

    ipcMain.handle('tts-status', (_event, payload) => {
        const lang = normalizeLang(typeof payload === 'string' ? payload : (payload && payload.lang));
        const engine = getEngine();
        if (!engine) return { ok: false, reason: 'bundled Piper runtime not found (resources/piper)' };
        if (!findPlayer()) return { ok: false, reason: 'no audio player available on this system' };
        return {
            ok: true,
            engine: 'piper',
            voice: VOICES[lang].voice,
            lang,
            modelPresent: !!findModelFor(lang, opts)
        };
    });

    // Check-and-download: used by the TEST button, the toggle, and the dropdown.
    ipcMain.handle('tts-ensure-voice', async (_event, payload) => {
        const lang = normalizeLang(typeof payload === 'string' ? payload : (payload && payload.lang));
        emit({ phase: 'start', lang, voice: VOICES[lang].voice });
        const res = await ensureVoice(lang, opts, progressEmitter(lang));
        if (res.ok) emit({ phase: 'done', lang, voice: res.voice, downloaded: !!res.downloaded });
        else emit({ phase: 'error', lang, voice: VOICES[lang].voice, error: res.error });
        return res;
    });

    ipcMain.handle('tts-speak', async (_event, payload) => {
        const lang = normalizeLang(typeof payload === 'string' ? null : (payload && payload.lang));
        const text = resolveSpeakText(payload);
        if (!text.trim()) return { success: true, skipped: 'empty' };

        const engine = getEngine();
        if (!engine) return { error: 'bundled Piper runtime not found (resources/piper)' };
        const player = findPlayer();
        if (!player) return { error: 'no audio player available on this system' };

        // Missing voice model → download it now (same path as the dropdown/TEST flow).
        let model = findModelFor(lang, opts);
        if (!model) {
            emit({ phase: 'start', lang, voice: VOICES[lang].voice });
            const ensured = await ensureVoice(lang, opts, progressEmitter(lang));
            if (!ensured.ok) return { error: `voice download failed: ${ensured.error}` };
            emit({ phase: 'done', lang, voice: ensured.voice, downloaded: !!ensured.downloaded });
            model = { modelPath: ensured.modelPath };
        }

        generation += 1;
        const gen = generation;
        stopPlayback(); // newest response wins — interrupt any in-flight audio

        const runtime = { piperBin: engine.piperBin, modelPath: model.modelPath };
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
module.exports.resolveEngine = resolveEngine;
module.exports.findRuntimeIn = findRuntimeIn;
module.exports.findModelFor = findModelFor;
module.exports.ensureVoice = ensureVoice;
module.exports.findPlayer = findPlayer;
module.exports.which = which;
module.exports.synthesize = synthesize;
module.exports.playWav = playWav;
module.exports.VOICE_NAME = VOICE_NAME;
module.exports.VOICES = VOICES;
module.exports.DEFAULT_LANG = DEFAULT_LANG;
module.exports.normalizeLang = normalizeLang;
module.exports.resolveSpeakText = resolveSpeakText;
module.exports.MAX_SPEAK_CHARS = MAX_SPEAK_CHARS;
