/**
 * Local LM Studio model configuration.
 *
 * Context length is fixed when a model is loaded. This manager keeps Agent Smith's
 * context setting aligned with the real loaded instance for loopback LM Studio only.
 */
'use strict';

const http = require('http');
const https = require('https');
const { execFile: nodeExecFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FALLBACK_CONTEXTS = [
    131072, 98304, 65536, 49152, 32768, 24576, 16384, 12288, 8192, 4096
];

function isLoopbackApiBase(apiBaseUrl) {
    try {
        const hostname = new URL(apiBaseUrl).hostname.toLowerCase();
        return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
    } catch (e) {
        return false;
    }
}

function buildContextCandidates(requested, maxContext) {
    const max = Math.max(4096, Math.floor(Number(maxContext) || 4096));
    const wanted = Math.min(max, Math.max(4096, Math.floor(Number(requested) || 4096)));
    return [...new Set([wanted, ...FALLBACK_CONTEXTS])]
        .filter(n => n <= wanted && n <= max && n >= 4096)
        .sort((a, b) => b - a);
}

function managementUrl(apiBaseUrl) {
    const url = new URL(apiBaseUrl);
    url.pathname = '/api/v1/models';
    url.search = '';
    url.hash = '';
    return url.toString();
}

// v52.3: LM Studio's unload endpoint (management API, loopback only). Takes the
// instance id — one POST per loaded instance frees it from VRAM.
function unloadUrl(apiBaseUrl) {
    const url = new URL(apiBaseUrl);
    url.pathname = '/api/v1/models/unload';
    url.search = '';
    url.hash = '';
    return url.toString();
}

// v52.5: every loaded instance across all models, tagged with its model type so
// callers can protect embedding instances (memory infrastructure) from LLM swaps.
// Carries the instance's own context/parallel config so a failed swap can restore
// exactly what was running before.
function collectLoadedInstances(payload) {
    const out = [];
    for (const item of Array.isArray(payload?.models) ? payload.models : []) {
        const instances = Array.isArray(item?.loaded_instances) ? item.loaded_instances : [];
        for (const inst of instances) {
            if (!inst?.id) continue;
            out.push({
                model: item?.key || inst.id,
                instanceId: inst.id,
                type: item?.type || 'llm',
                contextLength: inst?.config?.context_length ?? null,
                parallel: inst?.config?.parallel ?? null
            });
        }
    }
    return out;
}

// v52.5: name heuristic for embedding models — kept in sync with the auto-detect
// regex in src/main/services/memory.js so "which model serves /v1/embeddings" has
// one answer across the app.
const EMBED_NAME_HINT = /embed|minilm|bge|nomic|gte|e5|sentence/i;

function defaultRequestJson(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get(parsed, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`LM Studio API returned ${res.statusCode}`));
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Invalid LM Studio API response: ${e.message}`));
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('LM Studio API request timed out')));
        req.on('error', reject);
    });
}

function defaultExecFile(file, args) {
    return new Promise((resolve, reject) => {
        nodeExecFile(file, args, { windowsHide: true, timeout: 180000 }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout || '';
                error.stderr = stderr || '';
                reject(error);
                return;
            }
            resolve({ stdout: stdout || '', stderr: stderr || '' });
        });
    });
}

// v52.3: POST a JSON body (the unload endpoint). Same timeout/error contract as
// defaultRequestJson so tests can inject a fake the same way.
function defaultPostJson(url, body, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const payload = JSON.stringify(body || {});
        const req = lib.request(parsed, {
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    const err = new Error(`LM Studio API returned ${res.statusCode}`);
                    err.status = res.statusCode;
                    err.body = data;
                    reject(err);
                    return;
                }
                try {
                    resolve(data ? JSON.parse(data) : {});
                } catch (e) {
                    // 2xx with a non-JSON body is still success for our purposes.
                    resolve({ raw: data });
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('LM Studio API request timed out')));
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function defaultLmsPath() {
    const exe = process.platform === 'win32' ? 'lms.exe' : 'lms';
    const bundled = path.join(os.homedir(), '.lmstudio', 'bin', exe);
    return fs.existsSync(bundled) ? bundled : 'lms';
}

function findModel(payload, model) {
    const models = Array.isArray(payload?.models) ? payload.models : [];
    return models.find(item =>
        item?.key === model ||
        (item?.loaded_instances || []).some(instance => instance?.id === model)
    ) || null;
}

function statusFromModel(item, model) {
    const instances = Array.isArray(item?.loaded_instances) ? item.loaded_instances : [];
    const loaded = instances.find(instance => instance?.id === model) || instances[0] || null;
    return {
        managed: true,
        model,
        loadedContext: loaded?.config?.context_length || null,
        maxContext: item?.max_context_length || loaded?.config?.context_length || 4096,
        parallel: loaded?.config?.parallel || null
    };
}

function createLmStudioManager(deps = {}) {
    const requestJson = deps.requestJson || defaultRequestJson;
    const postJson = deps.postJson || defaultPostJson;
    const execFile = deps.execFile || defaultExecFile;
    const lmsPath = deps.lmsPath || defaultLmsPath();
    let operation = Promise.resolve();

    async function getStatus({ apiBaseUrl, model }) {
        if (!isLoopbackApiBase(apiBaseUrl)) {
            return { managed: false, reason: 'remote_endpoint' };
        }
        let payload;
        try {
            payload = await requestJson(managementUrl(apiBaseUrl));
        } catch (e) {
            return { managed: false, reason: 'lmstudio_unavailable', warning: e.message };
        }
        const item = findModel(payload, model);
        if (!item) {
            return { managed: false, reason: 'model_not_found', model };
        }
        return statusFromModel(item, model);
    }

    async function ensureNow({ apiBaseUrl, model, contextLength }) {
        const before = await getStatus({ apiBaseUrl, model });
        if (!before.managed) return before;

        const requestedContext = Math.min(
            before.maxContext,
            Math.max(4096, Math.floor(Number(contextLength) || 4096))
        );
        if (before.loadedContext === requestedContext && before.parallel === 1) {
            return {
                ...before,
                requestedContext,
                fallbackUsed: false,
                reloaded: false,
                warning: null
            };
        }

        const candidates = buildContextCandidates(requestedContext, before.maxContext);
        let selected = null;
        let lastError = null;
        for (const candidate of candidates) {
            const estimateArgs = [
                'load', model,
                '--context-length', String(candidate),
                '--parallel', '1',
                '--gpu', 'max',
                '--estimate-only',
                '-y'
            ];
            try {
                await execFile(lmsPath, estimateArgs);
                selected = candidate;
                break;
            } catch (e) {
                lastError = e;
            }
        }
        if (!selected) {
            return {
                ...before,
                requestedContext,
                error: lastError?.stderr || lastError?.message || 'No context size could be loaded'
            };
        }

        if (before.loadedContext != null) {
            try {
                await execFile(lmsPath, ['unload', model]);
            } catch (e) {
                const msg = String(e?.stderr || e?.message || '');
                if (!/not loaded|not found/i.test(msg)) throw e;
            }
        }
        // Load the replacement, and on failure attempt to restore the previously
        // loaded instance so the user is not left with no working model. Previously
        // an error here propagated after the unload, leaving nothing loaded.
        try {
            await execFile(lmsPath, [
                'load', model,
                '--context-length', String(selected),
                '--parallel', '1',
                '--gpu', 'max',
                '--identifier', model,
                '-y'
            ]);
        } catch (e) {
            if (before.loadedContext != null) {
                try {
                    await execFile(lmsPath, [
                        'load', model,
                        '--context-length', String(before.loadedContext),
                        '--parallel', String(before.parallel || 1),
                        '--gpu', 'max',
                        '--identifier', model,
                        '-y'
                    ]);
                } catch (e2) { /* best-effort rollback; report the original failure */ }
            }
            return {
                ...before,
                requestedContext,
                error: `LM Studio load failed: ${e?.stderr || e?.message || 'unknown error'}${before.loadedContext != null ? ' (restored previous context)' : ''}`
            };
        }

        const after = await getStatus({ apiBaseUrl, model });
        if (!after.managed || after.loadedContext !== selected) {
            return {
                ...after,
                requestedContext,
                error: `LM Studio did not confirm context ${selected}`
            };
        }
        const fallbackUsed = selected !== requestedContext;
        return {
            ...after,
            requestedContext,
            fallbackUsed,
            reloaded: true,
            warning: fallbackUsed
                ? `Requested context ${requestedContext} could not load; using ${selected}.`
                : null
        };
    }

    // v52.3: UNLOAD ALL — free every model instance currently loaded in LM Studio.
    // Loopback only (the management API is not exposed by remote backends). Reads the
    // live /api/v1/models list, then POSTs one unload per loaded instance id. A single
    // failed unload never aborts the rest; failures are reported per model so the UI can
    // say exactly what happened. Returns { ok, unloaded: [{model, instanceId}], errors }.
    async function unloadAll({ apiBaseUrl }) {
        if (!isLoopbackApiBase(apiBaseUrl)) {
            return { ok: false, reason: 'remote_endpoint', unloaded: [], errors: [] };
        }
        let payload;
        try {
            payload = await requestJson(managementUrl(apiBaseUrl));
        } catch (e) {
            return { ok: false, reason: 'lmstudio_unavailable', warning: e.message, unloaded: [], errors: [] };
        }
        const models = Array.isArray(payload?.models) ? payload.models : [];
        // Collect every loaded instance across all models. An instance id is unique per
        // load (LM Studio suffixes duplicates), so unloading by instance id never hits a
        // model that was not in the list we just read.
        const targets = collectLoadedInstances(payload)
            .map(({ model, instanceId }) => ({ model, instanceId }));
        if (targets.length === 0) {
            return { ok: true, unloaded: [], errors: [] };
        }
        const unloaded = [];
        const errors = [];
        for (const t of targets) {
            try {
                await postJson(unloadUrl(apiBaseUrl), { instance_id: t.instanceId });
                unloaded.push(t);
            } catch (e) {
                // "not loaded" means it went away between the list read and this call —
                // treat as success, not an error.
                const msg = String(e?.body || e?.message || '');
                if (/not loaded|not found/i.test(msg)) unloaded.push(t);
                else errors.push({ model: t.model, instanceId: t.instanceId, error: e.message });
            }
        }
        return { ok: errors.length === 0, unloaded, errors };
    }

    // v52.5: MODEL SWAP — the user picked a new model from the dropdown, so free every
    // OTHER loaded LLM instance (embedding models are memory infrastructure and stay
    // resident), then load the selection with the requested context. Runs through the
    // same serialized `operation` queue as ensureModel so two swaps can never interleave
    // their unloads/loads. If the new model fails to load AFTER we freed VRAM, the
    // previously loaded models are restored best-effort — a bad pick must never leave
    // the user with nothing running (same contract as ensureNow's rollback).
    async function swapNow({ apiBaseUrl, model, contextLength }) {
        if (!isLoopbackApiBase(apiBaseUrl)) {
            return { ok: false, reason: 'remote_endpoint', unloaded: [], errors: [] };
        }
        const wanted = String(model || '');
        if (!wanted) return { ok: false, error: 'No model selected', unloaded: [], errors: [] };

        let payload;
        try {
            payload = await requestJson(managementUrl(apiBaseUrl));
        } catch (e) {
            return { ok: false, reason: 'lmstudio_unavailable', warning: e.message, unloaded: [], errors: [] };
        }

        const beforeInstances = collectLoadedInstances(payload);
        // Fast path: the selection is already what LM Studio has loaded — just free the rest.
        const wantedLoaded = beforeInstances.find(i => i.model === wanted || i.instanceId === wanted);

        // 1. Free every other loaded LLM instance. Embedding instances (type or name)
        //    are protected: memory recall must survive chat-model swaps, and they run
        //    on CPU anyway so they cost no VRAM.
        const unloaded = [];
        const errors = [];
        for (const inst of beforeInstances) {
            if (inst.model === wanted || inst.instanceId === wanted) continue;
            if (inst.type === 'embedding' || EMBED_NAME_HINT.test(inst.model)) continue;
            try {
                await postJson(unloadUrl(apiBaseUrl), { instance_id: inst.instanceId });
                unloaded.push({ model: inst.model, instanceId: inst.instanceId, contextLength: inst.contextLength, parallel: inst.parallel });
            } catch (e) {
                // "not loaded" means it went away between the list read and this call —
                // treat as success, not an error.
                const msg = String(e?.body || e?.message || '');
                if (/not loaded|not found/i.test(msg)) unloaded.push({ model: inst.model, instanceId: inst.instanceId, contextLength: null, parallel: null });
                else errors.push({ model: inst.model, instanceId: inst.instanceId, error: e.message });
            }
        }

        // 2. Load the selection if it isn't already resident (ensureNow is a no-op when
        //    context + parallel already match — that's the "already running" fast path).
        let load = null;
        if (!wantedLoaded) {
            load = await ensureNow({ apiBaseUrl, model: wanted, contextLength });
            if (load.error && unloaded.length > 0) {
                // Don't leave the user with nothing: restore what we freed, best-effort.
                const restored = [];
                for (const u of [...unloaded].reverse()) {
                    try {
                        const args = ['load', u.model];
                        if (u.contextLength) args.push('--context-length', String(u.contextLength));
                        if (u.parallel) args.push('--parallel', String(u.parallel));
                        args.push('--gpu', 'max', '-y');
                        await execFile(lmsPath, args);
                        restored.push(u.model);
                    } catch (e) { /* best-effort restore; report the original failure */ }
                }
                if (restored.length > 0) load = { ...load, error: `${load.error} (restored ${restored.join(', ')})` };
            }
        }

        return {
            ok: !load?.error && errors.length === 0,
            unloaded: unloaded.map(({ model: m, instanceId }) => ({ model: m, instanceId })),
            errors,
            ...(load || {})
        };
    }

    // v52.5: EMBED ON STARTUP — make sure an embedding model is loaded in LM Studio so
    // memory recall works from the first message of every session. Prefers whatever is
    // already resident (no-op), otherwise loads the best available embedding model with
    // --gpu off: embeddings are tiny and CPU-only, they must not eat VRAM from the chat
    // model (same philosophy as the Ollama fallback in memory.js). Preference order for
    // what to load: an already-loaded instance > XK_EMBED_MODEL override > smallest
    // embedding model on disk (fastest to start). Returns { ok, model, loaded, ... }.
    async function ensureEmbeddingNow({ apiBaseUrl }) {
        if (!isLoopbackApiBase(apiBaseUrl)) {
            return { ok: false, reason: 'remote_endpoint', loaded: null };
        }
        let payload;
        try {
            payload = await requestJson(managementUrl(apiBaseUrl));
        } catch (e) {
            return { ok: false, reason: 'lmstudio_unavailable', warning: e.message, loaded: null };
        }

        // Already resident? Nothing to do.
        for (const inst of collectLoadedInstances(payload)) {
            if (inst.type === 'embedding' || EMBED_NAME_HINT.test(inst.model)) {
                return { ok: true, model: inst.model, loaded: inst.instanceId, alreadyLoaded: true };
            }
        }

        const models = Array.isArray(payload?.models) ? payload.models : [];
        const candidates = models.filter(m => m?.type === 'embedding' || EMBED_NAME_HINT.test(String(m?.key || '')));
        if (candidates.length === 0) {
            return {
                ok: false,
                reason: 'no_embedding_model',
                warning: 'No embedding model found in LM Studio — memory recall is disabled until one is downloaded.',
                loaded: null
            };
        }

        // XK_EMBED_MODEL (the same override memory.js uses for /v1/embeddings) wins when
        // it exists on disk; otherwise the smallest candidate starts fastest.
        const override = process.env.XK_EMBED_MODEL || '';
        let target = candidates.find(m => String(m?.key || '') === override);
        if (!target) {
            target = [...candidates].sort((a, b) => (Number(a?.size_bytes) || 0) - (Number(b?.size_bytes) || 0))[0];
        }

        try {
            await execFile(lmsPath, ['load', String(target.key), '--gpu', 'off', '-y']);
        } catch (e) {
            return { ok: false, model: target.key, loaded: null, error: e?.stderr || e?.message || 'lms load failed' };
        }

        // Confirm it actually came up.
        try {
            const after = await requestJson(managementUrl(apiBaseUrl));
            for (const inst of collectLoadedInstances(after)) {
                if (inst.model === target.key) return { ok: true, model: target.key, loaded: inst.instanceId };
            }
        } catch (e) { /* fall through — report issued-but-unconfirmed */ }
        return { ok: true, model: target.key, loaded: null, warning: 'Load issued but not confirmed by /api/v1/models' };
    }

    function ensureModel(opts) {
        const next = operation.then(() => ensureNow(opts), () => ensureNow(opts));
        operation = next.catch(() => {});
        return next;
    }

    // v52.5: serialized wrappers — swap/ensure-embedding share the same queue as
    // ensureModel so concurrent context syncs and model swaps can't race each other.
    function swapModel(opts) {
        const next = operation.then(() => swapNow(opts), () => swapNow(opts));
        operation = next.catch(() => {});
        return next;
    }

    function ensureEmbeddingModel(opts) {
        const next = operation.then(() => ensureEmbeddingNow(opts), () => ensureEmbeddingNow(opts));
        operation = next.catch(() => {});
        return next;
    }

    return { getStatus, ensureModel, unloadAll, swapModel, ensureEmbeddingModel };
}

module.exports = {
    FALLBACK_CONTEXTS,
    isLoopbackApiBase,
    buildContextCandidates,
    defaultLmsPath,
    createLmStudioManager
};
