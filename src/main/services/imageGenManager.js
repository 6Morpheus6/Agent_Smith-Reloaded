/**
 * imageGenManager — local image generation for Agent Smith (v51.7).
 *
 * Wraps stable-diffusion.cpp (`sd-cli`) with a Vulkan backend so AMD GPUs work
 * without ROCm. The engine binary + the default SDXL GGUF model are downloaded
 * on first use into <userData>/imagegen/ and reused afterwards. Users can import
 * their own .gguf models (sidebar) — any complete SD/SDXL GGUF (UNet+CLIP+VAE in
 * one file, the common single-file layout) works; the selected model is used for
 * every generate_image tool call.
 *
 * Everything network- and process-related is injectable via deps so unit tests
 * run hermetically (no downloads, no spawns).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { spawn } = require('child_process');

// Pinned stable-diffusion.cpp release (Vulkan-capable builds for every platform).
const ENGINE_RELEASE_TAG = 'master-820-de298c2';
const ENGINE_BASE_URL = `https://github.com/leejet/stable-diffusion.cpp/releases/download/${ENGINE_RELEASE_TAG}`;

function pickEngineAsset(platform, arch) {
    if (platform === 'win32') return `${ENGINE_BASE_URL}/sd-master-de298c2-bin-win-vulkan-x64.zip`;
    if (platform === 'darwin') return `${ENGINE_BASE_URL}/sd-master-de298c2-bin-Darwin-macOS-26.5.2-arm64.zip`;
    // Linux: the vulkan build auto-detects AMD/Intel/NVIDIA via Vulkan; CPU fallback is built in.
    if (arch === 'arm64') return `${ENGINE_BASE_URL}/sd-master-de298c2-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`; // best available linux asset
    return `${ENGINE_BASE_URL}/sd-master-de298c2-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`;
}

// Default model: a COMPLETE single-file SDXL GGUF (UNet + CLIP-L + CLIP-G + VAE) in the
// Juggernaut XL family — renders standalone with no extra components. (The hum-ma
// juggernautXL_juggXIByRundiffusion-Q5_K_M.gguf file is UNet-only with bare Comfy tensor
// names and cannot render without separate CLIP/VAE files, so it is not usable as a
// standalone default.)
const DEFAULT_MODEL = {
    name: 'juggernaut-xl-v9-Q8_0.gguf',
    url: 'https://huggingface.co/offgrid-ai/juggernaut-xl-v9-GGUF/resolve/main/juggernaut-xl-v9-Q8_0.gguf'
};

const DEFAULT_SETTINGS = {
    width: 1024,
    height: 1024,
    steps: 25,
    cfgScale: 7.0,
    sampler: 'euler',
    negativePrompt: 'blurry, low quality, deformed, watermark, text'
};

const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // cap on base64 payload returned to the renderer

/** Build sd-cli argv for an image generation run (pure — unit tested). */
function buildSdCliArgs({ modelPath, prompt, negativePrompt, width, height, steps, cfgScale, sampler, seed, outputPath }) {
    const args = [
        '-M', 'img_gen',
        '-m', String(modelPath),
        '-p', String(prompt || ''),
        '-W', String(Math.max(64, Math.min(2048, parseInt(width, 10) || DEFAULT_SETTINGS.width))),
        '-H', String(Math.max(64, Math.min(2048, parseInt(height, 10) || DEFAULT_SETTINGS.height))),
        '--steps', String(Math.max(1, Math.min(150, parseInt(steps, 10) || DEFAULT_SETTINGS.steps))),
        '--cfg-scale', String(Number(cfgScale) > 0 ? Number(cfgScale) : DEFAULT_SETTINGS.cfgScale),
        '--sampling-method', String(sampler || DEFAULT_SETTINGS.sampler),
        '-o', String(outputPath)
    ];
    if (negativePrompt) args.push('--negative-prompt', String(negativePrompt));
    // seed < 0 => random per run; explicit non-negative seeds are reproducible.
    const s = parseInt(seed, 10);
    args.push('-s', Number.isFinite(s) ? String(s) : '-1');
    return args;
}

/** Minimal ZIP extractor (stored + deflate entries) — no native deps, cross-platform. */
function extractZip(zipBuffer, destDir) {
    const buf = zipBuffer;
    // Locate End Of Central Directory record (scan backwards for the signature).
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Invalid zip: end-of-central-directory not found');
    const entryCount = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);

    const written = [];
    for (let n = 0; n < entryCount; n++) {
        if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid zip: bad central directory entry');
        const method = buf.readUInt16LE(offset + 10);
        const compSize = buf.readUInt32LE(offset + 20);
        // Central directory entry: nameLen/extraLen/commentLen are 16-bit fields.
        const nameLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        const localOffset = buf.readUInt32LE(offset + 42);
        const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen).replace(/\\/g, '/');

        // Local file header gives the real data start (its extra field may differ in size).
        if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid zip: bad local header');
        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;

        if (!name.endsWith('/')) {
            const target = path.join(destDir, name);
            // Contain within destDir (zip-slip guard).
            if (!target.startsWith(path.resolve(destDir) + path.sep)) throw new Error(`Zip entry escapes destination: ${name}`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const raw = buf.subarray(dataStart, dataStart + compSize);
            const out = method === 8 ? zlib.inflateRawSync(raw) : (method === 0 ? raw : (() => { throw new Error(`Unsupported zip compression method ${method}`); })());
            fs.writeFileSync(target, out);
            written.push(name);
        } else {
            fs.mkdirSync(path.join(destDir, name), { recursive: true });
        }

        offset += 46 + nameLen + extraLen + commentLen;
    }
    return written;
}

/**
 * HTTP(S) GET with redirect following, streaming to a .part file (pure-ish — injectable).
 *
 * Robustness guarantees (v51.8):
 *   - Progress is reported on EVERY data chunk, even when the server omits
 *     `content-length` (chunked transfer). Callers get `{ received, total: 0, pct: null }`
 *     so a UI can show real bytes-moved proof instead of silence. This was the v51.7 bug:
 *     the old `if (onProgress && total > 0)` guard meant a chunked download produced ZERO
 *     feedback — "no proof the model ever downloaded."
 *   - An idle watchdog fails the download loudly if no bytes arrive for `idleTimeoutMs`,
 *     instead of hanging forever on a stalled large-file transfer. A hang is exactly what
 *     made first-run look dead and let the agent claim success over nothing.
 */
function downloadFile(url, destPath, { onProgress, timeoutMs = 30000, idleTimeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
        const partPath = `${destPath}.part`;
        let settled = false;
        let idleTimer = null;

        const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
        const armIdle = () => {
            if (!idleTimeoutMs || idleTimeoutMs <= 0) return;
            clearIdle();
            idleTimer = setTimeout(() => {
                req.destroy(new Error(`Download stalled: no data for ${Math.round(idleTimeoutMs / 1000)}s`));
            }, idleTimeoutMs);
        };
        const fail = (err) => {
            if (settled) return;
            settled = true;
            clearIdle();
            try { fs.unlinkSync(partPath); } catch (_) { /* best effort */ }
            reject(err);
        };

        let req; // assigned inside doGet so the idle handlers can destroy it.
        const doGet = (currentUrl, depth) => {
            if (depth > 8) return fail(new Error('Too many redirects'));
            let parsed;
            try { parsed = new URL(currentUrl); } catch (e) { return fail(new Error(`Bad URL: ${currentUrl}`)); }
            const lib = parsed.protocol === 'https:' ? https : http;
            req = lib.get(parsed, { timeout: timeoutMs }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    clearIdle();
                    res.resume();
                    return doGet(new URL(res.headers.location, parsed).toString(), depth + 1);
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    clearIdle();
                    res.resume();
                    return fail(new Error(`Download failed: HTTP ${res.statusCode} for ${currentUrl}`));
                }
                const total = parseInt(res.headers['content-length'] || '0', 10);
                let received = 0;
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                const out = fs.createWriteStream(partPath);
                armIdle(); // start the watchdog as soon as the body is expected to flow
                res.on('data', (chunk) => {
                    received += chunk.length;
                    if (onProgress) onProgress({ received, total, pct: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null });
                    armIdle(); // any movement resets the stall clock
                });
                res.pipe(out);
                out.on('finish', () => {
                    clearIdle();
                    try { fs.renameSync(partPath, destPath); } catch (e) { return fail(e); }
                    if (!settled) { settled = true; resolve(destPath); }
                });
                out.on('error', (e) => fail(e));
            });
            req.on('timeout', () => req.destroy(new Error(`Download timed out: ${currentUrl}`)));
            req.on('error', (e) => fail(e));
        };
        doGet(url, 0);
    });
}

/** Read width/height from a PNG's IHDR chunk (bytes 16..24). Returns {width,height} or null. */
function pngDimensions(buffer) {
    try {
        if (!buffer || buffer.length < 24) return null;
        // PNG signature: 89 50 4E 47 0D 0A 1A 0A, then IHDR length(4) + "IHDR"(4).
        const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        for (let i = 0; i < 8; i++) if (buffer[i] !== sig[i]) return null;
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        if (!width || !height) return null;
        return { width, height };
    } catch (_) { return null; }
}

function createImageGenManager(deps = {}) {
    const fsRef = deps.fs || fs;
    const pathRef = deps.path || path;
    const spawnFn = deps.spawn || spawn;
    const downloadFn = deps.downloadFile || downloadFile;
    const extractFn = deps.extractZip || extractZip;
    const pushEvent = deps.pushEvent || (() => {});
    const registerDownload = deps.registerDownload || (() => {});
    const platform = deps.platform || process.platform;
    const arch = deps.arch || process.arch;

    const baseDir = pathRef.join(deps.userDataPath, 'imagegen');
    const engineDir = pathRef.join(baseDir, 'engine');
    const modelsDir = pathRef.join(baseDir, 'models');
    const outputsDir = pathRef.join(deps.userDataPath, 'images');
    const stateFile = pathRef.join(baseDir, 'state.json');

    function emit(phase, detail) {
        try { pushEvent('imagegen-event', Object.assign({ phase }, detail || {})); } catch (_) { /* non-fatal */ }
    }

    // --- state ---------------------------------------------------------------
    function loadState() {
        const defaults = { enabled: false, selectedModel: null, settings: { ...DEFAULT_SETTINGS } };
        try {
            if (fsRef.existsSync(stateFile)) {
                const raw = JSON.parse(fsRef.readFileSync(stateFile, 'utf8'));
                return {
                    enabled: !!raw.enabled,
                    selectedModel: typeof raw.selectedModel === 'string' ? raw.selectedModel : null,
                    settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings || {})
                };
            }
        } catch (e) { console.warn('[imagegen] state read failed:', e.message); }
        return defaults;
    }

    function saveState(patch) {
        const next = Object.assign(loadState(), patch || {});
        fsRef.mkdirSync(baseDir, { recursive: true });
        fsRef.writeFileSync(stateFile, JSON.stringify(next, null, 2));
        return next;
    }

    // --- model discovery -----------------------------------------------------
    function listModels() {
        try {
            if (!fsRef.existsSync(modelsDir)) return [];
            return fsRef.readdirSync(modelsDir)
                .filter(f => f.toLowerCase().endsWith('.gguf'))
                .map(f => ({ name: f, path: pathRef.join(modelsDir, f), size: fsRef.statSync(pathRef.join(modelsDir, f)).size }));
        } catch (e) { return []; }
    }

    /** Resolve which model file a generation should use. */
    function resolveModelPath(state) {
        if (state.selectedModel) {
            const p = pathRef.isAbsolute(state.selectedModel) ? state.selectedModel : pathRef.join(modelsDir, state.selectedModel);
            if (fsRef.existsSync(p)) return p;
        }
        const models = listModels();
        if (models.length > 0) return models[0].path;
        return null; // nothing detected — caller auto-downloads the default
    }

    // --- engine + model provisioning ----------------------------------------
    // In-flight markers so status() can report "downloading" to a client that polls
    // while the sidebar is collapsed (the chat banner also listens for live events).
    let engineBusy = null;   // 'download' | 'extract' | null
    let modelBusy = null;    // { name, received, total } | null

    async function ensureEngine() {
        const cliName = platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
        if (fsRef.existsSync(pathRef.join(engineDir, cliName))) return pathRef.join(engineDir, cliName);

        emit('engine', { status: 'downloading' });
        engineBusy = 'download';
        fsRef.mkdirSync(baseDir, { recursive: true });
        const zipPath = pathRef.join(baseDir, `sd-engine-${ENGINE_RELEASE_TAG}.zip`);
        try {
            if (!fsRef.existsSync(zipPath)) {
                await downloadFn(pickEngineAsset(platform, arch), zipPath, {
                    onProgress: (p) => emit('engine', { status: 'downloading', ...p })
                });
            }
            engineBusy = 'extract';
            emit('engine', { status: 'extracting' });
            const buf = fsRef.readFileSync(zipPath);
            extractFn(buf, engineDir);
            if (!fsRef.existsSync(pathRef.join(engineDir, cliName))) throw new Error(`Engine extraction missing ${cliName}`);
            try { fsRef.chmodSync(pathRef.join(engineDir, cliName), 0o755); } catch (_) { /* win32 */ }
        } catch (e) {
            engineBusy = null;
            emit('engine', { status: 'error', error: e.message });
            throw e;
        }
        engineBusy = null;
        emit('engine', { status: 'ready' });
        return pathRef.join(engineDir, cliName);
    }

    async function ensureModel(state) {
        const existing = resolveModelPath(state);
        if (existing) return existing;
        // No model detected anywhere — auto-download the default.
        fsRef.mkdirSync(modelsDir, { recursive: true });
        const dest = pathRef.join(modelsDir, DEFAULT_MODEL.name);
        emit('model', { status: 'downloading', name: DEFAULT_MODEL.name, pct: 0 });
        modelBusy = { name: DEFAULT_MODEL.name, received: 0, total: 0 };
        try {
            await downloadFn(DEFAULT_MODEL.url, dest, {
                onProgress: (p) => {
                    if (modelBusy) { modelBusy.received = p.received; modelBusy.total = p.total || 0; }
                    emit('model', { status: 'downloading', name: DEFAULT_MODEL.name, ...p });
                }
            });
        } catch (e) {
            modelBusy = null;
            emit('model', { status: 'error', name: DEFAULT_MODEL.name, error: e.message });
            throw e;
        }
        modelBusy = null;
        emit('model', { status: 'ready', name: DEFAULT_MODEL.name });
        return dest;
    }

    async function ensureReady() {
        const state = loadState();
        const [cliPath, modelPath] = await Promise.all([ensureEngine(), ensureModel(state)]);
        return { cliPath, modelPath };
    }

    // --- generation ----------------------------------------------------------
    let activeRun = null;

    function parseProgressLine(line) {
        // sd-cli progress: "  |####...| 12/25 - 1.84it/s"
        const m = /\|\s*(\d+)\/(\d+)\s*-/.exec(line);
        if (m) return { step: parseInt(m[1], 10), total: parseInt(m[2], 10) };
        return null;
    }

    /** Normalize snake_case keys from the generate_image tool / IPC callers to camelCase. */
    function normalizeOpts(opts) {
        const o = Object.assign({}, opts || {});
        if (o.negative_prompt != null && o.negativePrompt == null) o.negativePrompt = o.negative_prompt;
        if (o.cfg_scale != null && o.cfgScale == null) o.cfgScale = o.cfg_scale;
        return o;
    }

    function generate(opts = {}) {
        if (activeRun) return Promise.reject(new Error('An image generation is already running.'));
        const state = loadState();
        const settings = Object.assign({}, DEFAULT_SETTINGS, state.settings, normalizeOpts(opts));
        const runPromise = (async () => {
            emit('generate', { status: 'starting' });
            // First-run provisioning (engine + model download) can take minutes — tell the UI
            // explicitly so it shows a real "downloading" indicator instead of a silent wait.
            const stateForProvision = loadState();
            if (!fsRef.existsSync(pathRef.join(engineDir, platform === 'win32' ? 'sd-cli.exe' : 'sd-cli')) || !resolveModelPath(stateForProvision)) {
                emit('generate', { status: 'provisioning' });
            }
            let cliPath, modelPath;
            try {
                ({ cliPath, modelPath } = await ensureReady());
            } catch (e) {
                // Provisioning failed (engine/model download). The engine/model error events
                // already fired above — mirror it on the generate phase so every UI surface
                // (chat banner + sidebar) shows one consistent failure instead of a silent hang.
                emit('generate', { status: 'error', error: e.message });
                return { success: false, error: `Image generation could not start: ${e.message}` };
            }
            fsRef.mkdirSync(outputsDir, { recursive: true });
            const outputPath = pathRef.join(outputsDir, `image-${Date.now()}.png`);

            const args = buildSdCliArgs({
                modelPath,
                prompt: opts.prompt || settings.prompt || '',
                negativePrompt: opts.negativePrompt != null ? opts.negativePrompt : settings.negativePrompt,
                width: opts.width != null ? opts.width : settings.width,
                height: opts.height != null ? opts.height : settings.height,
                steps: opts.steps != null ? opts.steps : settings.steps,
                cfgScale: opts.cfgScale != null ? opts.cfgScale : settings.cfgScale,
                sampler: opts.sampler || settings.sampler,
                seed: opts.seed != null ? opts.seed : -1,
                outputPath
            });

            const result = await new Promise((resolve) => {
                let stderrTail = '';
                const child = spawnFn(cliPath, args, { cwd: engineDir, windowsHide: true });
                const onChunk = (data) => {
                    const text = data.toString();
                    stderrTail = (stderrTail + text).slice(-8000);
                    for (const line of text.split('\n')) {
                        const p = parseProgressLine(line);
                        if (p && p.total >= 5) emit('generate', { status: 'sampling', ...p });
                    }
                };
                child.stderr.on('data', onChunk);
                child.stdout.on('data', onChunk);
                child.on('error', (e) => resolve({ ok: false, error: `Failed to start sd-cli: ${e.message}` }));
                child.on('close', (code) => {
                    if (!fsRef.existsSync(outputPath)) {
                        const tail = stderrTail.split('\n').filter(l => /error|fail/i.test(l)).slice(-5).join(' | ');
                        return resolve({ ok: false, error: `Generation failed (exit ${code}).${tail ? ' ' + tail : ''}` });
                    }
                    // HONEST SUCCESS GATE (v51.8): a file existing is not proof an image was
                    // rendered — sd-cli can exit 0 after writing nothing or a truncated/corrupt
                    // PNG on OOM/Vulkan failure. Verify it's a real, non-empty PNG before we
                    // ever report success; otherwise the agent would claim "done" over no image.
                    let size = 0;
                    let dims = null;
                    try {
                        const buf = fsRef.readFileSync(outputPath);
                        size = buf.length;
                        if (size < 8) return resolve({ ok: false, error: `Generation produced an empty file (exit ${code}).` });
                        dims = pngDimensions(buf);
                        if (!dims) return resolve({ ok: false, error: `Output is not a valid PNG image (exit ${code}) — the render likely failed before writing pixels.` });
                    } catch (e) {
                        return resolve({ ok: false, error: `Could not read generated output: ${e.message}` });
                    }
                    let dataUrl = null;
                    if (size <= MAX_IMAGE_BYTES) dataUrl = `data:image/png;base64,${fsRef.readFileSync(outputPath).toString('base64')}`;
                    resolve({ ok: true, outputPath, dataUrl, size, width: dims.width, height: dims.height });
                });
            });

            if (result.ok) {
                try { registerDownload(result.outputPath); } catch (_) { /* non-fatal */ }
                emit('generate', { status: 'done', path: result.outputPath });
                return Object.assign({ success: true, model: pathRef.basename(modelPath), prompt: settings.prompt || opts.prompt || '' }, result);
            }
            emit('generate', { status: 'error', error: result.error });
            return { success: false, error: result.error };
        })();
        const settled = runPromise.finally(() => { if (activeRun === settled) activeRun = null; });
        settled.catch(() => {}); // the caller consumes runPromise; swallow this mirror's rejection path
        activeRun = settled; // single-flight guard while a generation is in progress
        return runPromise;
    }

    // --- import / select -----------------------------------------------------
    function importModel(srcPath) {
        if (!srcPath || !fsRef.existsSync(srcPath)) throw new Error(`File not found: ${srcPath}`);
        const name = pathRef.basename(srcPath).toLowerCase().endsWith('.gguf') ? pathRef.basename(srcPath) : `${pathRef.basename(srcPath)}.gguf`;
        fsRef.mkdirSync(modelsDir, { recursive: true });
        const dest = pathRef.join(modelsDir, name);
        if (dest !== srcPath) fsRef.copyFileSync(srcPath, dest);
        return saveState({ selectedModel: name });
    }

    async function importFromUrl(url) {
        const name = decodeURIComponent(String(url).split('/').pop() || 'model.gguf');
        const finalName = name.toLowerCase().endsWith('.gguf') ? name : `${name}.gguf`;
        fsRef.mkdirSync(modelsDir, { recursive: true });
        const dest = pathRef.join(modelsDir, finalName);
        emit('import', { status: 'downloading', name: finalName, pct: 0 });
        try {
            await downloadFn(url, dest, { onProgress: (p) => emit('import', { status: 'downloading', name: finalName, ...p }) });
        } catch (e) {
            emit('import', { status: 'error', name: finalName, error: e.message });
            throw e;
        }
        const state = saveState({ selectedModel: finalName });
        emit('import', { status: 'done', name: finalName });
        return state;
    }

    function selectModel(nameOrPath) {
        const p = pathRef.isAbsolute(nameOrPath) ? nameOrPath : pathRef.join(modelsDir, nameOrPath);
        if (!fsRef.existsSync(p)) throw new Error(`Model not found: ${nameOrPath}`);
        return saveState({ selectedModel: pathRef.basename(p) });
    }

    function removeModel(name) {
        const p = pathRef.isAbsolute(name) ? name : pathRef.join(modelsDir, name);
        if (!p.startsWith(pathRef.resolve(modelsDir) + path.sep)) throw new Error('Refusing to delete outside the models directory');
        if (fsRef.existsSync(p)) fsRef.unlinkSync(p);
        const state = loadState();
        return saveState({ selectedModel: state.selectedModel === name ? null : state.selectedModel });
    }

    function status() {
        const state = loadState();
        const models = listModels();
        const cliName = platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
        return {
            enabled: state.enabled,
            settings: state.settings,
            engineReady: fsRef.existsSync(pathRef.join(engineDir, cliName)),
            models,
            selectedModel: state.selectedModel,
            resolvedModelPath: resolveModelPath(state),
            defaultModel: DEFAULT_MODEL.name,
            outputsDir,
            // v51.8 live-provisioning snapshot — lets a client that missed the push events
            // (or is polling while the sidebar section is collapsed) still see real progress.
            engineBusy,
            modelBusy,
            generating: !!activeRun
        };
    }

    return {
        status, loadState, saveState, listModels, ensureReady, generate,
        importModel, importFromUrl, selectModel, removeModel,
        paths: { baseDir, engineDir, modelsDir, outputsDir, stateFile }
    };
}

module.exports = {
    ENGINE_RELEASE_TAG,
    DEFAULT_MODEL,
    DEFAULT_SETTINGS,
    pickEngineAsset,
    buildSdCliArgs,
    extractZip,
    downloadFile,
    pngDimensions,
    createImageGenManager
};
