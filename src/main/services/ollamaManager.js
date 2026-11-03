/**
 * Local Ollama model unloading (v56.5).
 *
 * Ollama has no management API like LM Studio's, but it does expose two things we need:
 *   - GET  /api/ps                 → every model currently resident in memory (ollama ps)
 *   - POST /api/chat with an EMPTY messages array and keep_alive: 0
 *     → the documented "unload a model" contract (docs.ollama.com API reference); this is
 *       exactly what `ollama stop <model>` does, without needing the CLI on PATH.
 *
 * Loopback only — the same philosophy as lmStudioManager: a remote Ollama server is not
 * ours to free. Embedding models (all-minilm & friends, matched by the shared
 * EMBED_NAME_HINT) are protected: they are memory infrastructure, not chat models.
 */
'use strict';

const http = require('http');
const https = require('https');
const { isLoopbackApiBase, EMBED_NAME_HINT } = require('./lmStudioManager.js');

function psUrl(baseUrl) {
    const url = new URL(baseUrl);
    url.pathname = '/api/ps';
    url.search = '';
    url.hash = '';
    return url.toString();
}

function chatUrl(baseUrl) {
    const url = new URL(baseUrl);
    url.pathname = '/api/chat';
    url.search = '';
    url.hash = '';
    return url.toString();
}

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
                    return reject(new Error(`Ollama API returned ${res.statusCode}`));
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Invalid Ollama API response: ${e.message}`));
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Ollama API request timed out')));
        req.on('error', reject);
    });
}

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
                    const err = new Error(`Ollama API returned ${res.statusCode}`);
                    err.status = res.statusCode;
                    err.body = data;
                    reject(err);
                    return;
                }
                try {
                    resolve(data ? JSON.parse(data) : {});
                } catch (e) {
                    resolve({ raw: data });
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Ollama API request timed out')));
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// Ollama tag normalization: "gemma4" and "gemma4:latest" are the same model.
function normalizeModelName(name) {
    const n = String(name || '').trim();
    return n && !n.includes(':') ? `${n}:latest` : n;
}

function sameModel(a, b) {
    return normalizeModelName(a) === normalizeModelName(b);
}

function createOllamaManager(deps = {}) {
    const requestJson = deps.requestJson || defaultRequestJson;
    const postJson = deps.postJson || defaultPostJson;

    // Names of every model currently resident in Ollama's memory (GET /api/ps).
    async function listRunningModels({ baseUrl }) {
        const payload = await requestJson(psUrl(baseUrl));
        return (Array.isArray(payload?.models) ? payload.models : [])
            .map(m => m?.name || m?.model)
            .filter(Boolean);
    }

    // UNLOAD (or swap-unload when keepModel is set): free every running model except the
    // embedding models and — for swaps — the model the user just picked. One unload per
    // model; a single failure never aborts the rest. Returns
    // { ok, unloaded: [name], protected: [name], errors: [{model, error}] }.
    async function unloadAll({ baseUrl, keepModel }) {
        if (!isLoopbackApiBase(baseUrl)) {
            return { ok: false, reason: 'remote_endpoint', unloaded: [], protected: [], errors: [] };
        }
        let running;
        try {
            running = await listRunningModels({ baseUrl });
        } catch (e) {
            return { ok: false, reason: 'ollama_unavailable', warning: e.message, unloaded: [], protected: [], errors: [] };
        }
        const keep = keepModel ? String(keepModel) : '';
        const unloaded = [];
        const protectedModels = [];
        const errors = [];
        for (const name of running) {
            // The selection stays resident — that is the point of a swap.
            if (keep && sameModel(name, keep)) continue;
            // Embedding models are memory infrastructure — never freed here.
            if (EMBED_NAME_HINT.test(name)) { protectedModels.push(name); continue; }
            try {
                // Official unload contract: empty messages + keep_alive 0 frees it NOW.
                await postJson(chatUrl(baseUrl), { model: name, messages: [], keep_alive: 0 });
                unloaded.push(name);
            } catch (e) {
                // "not found/not loaded" means it went away between the /api/ps read and
                // this call — treat as success, not an error.
                const msg = String(e?.body || e?.message || '');
                if (/not found|not loaded/i.test(msg)) unloaded.push(name);
                else errors.push({ model: name, error: e.message });
            }
        }
        return { ok: errors.length === 0, unloaded, protected: protectedModels, errors };
    }

    return { listRunningModels, unloadAll };
}

module.exports = {
    createOllamaManager,
    normalizeModelName,
    sameModel
};
