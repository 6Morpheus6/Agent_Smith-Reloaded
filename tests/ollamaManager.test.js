/**
 * Ollama unload manager (v56.5) — the UNLOAD ALL Ollama path and the dropdown-swap
 * "stop every other resident model" contract, against injected fake HTTP deps.
 *
 * Ollama's documented unload contract: POST /api/chat with an EMPTY messages array and
 * keep_alive: 0 frees the model from memory immediately (same as `ollama stop`).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createOllamaManager, normalizeModelName, sameModel } = require('../src/main/services/ollamaManager.js');
const registerOllamaIpc = require('../src/main/ipc/ollama.js');
const { INVOKE_CHANNELS } = require('../src/shared/ipcChannels.js');

const BASE = 'http://127.0.0.1:11434';

function psPayload(names) {
    return { models: names.map(n => ({ name: n, model: n, size: 1024 })) };
}

test('normalizeModelName/sameModel treat gemma4 and gemma4:latest as one model', () => {
    assert.equal(normalizeModelName('gemma4'), 'gemma4:latest');
    assert.equal(normalizeModelName('gemma4:latest'), 'gemma4:latest');
    assert.equal(normalizeModelName('  llama3.2:8b-q4 '), 'llama3.2:8b-q4');
    assert.equal(sameModel('gemma4', 'gemma4:latest'), true);
    assert.equal(sameModel('gemma4:latest', 'gemma4'), true);
    assert.equal(sameModel('gemma4', 'llama3.2'), false);
});

test('unloadAll stops every running model via empty-messages keep_alive:0 chat (v56.5)', async () => {
    const posts = [];
    let listReads = 0;
    const manager = createOllamaManager({
        requestJson: async (url) => {
            listReads++;
            assert.equal(url, `${BASE}/api/ps`);
            return psPayload(['gemma4:latest', 'llama3.2:8b-q4']);
        },
        postJson: async (url, body) => { posts.push({ url, body }); return {}; }
    });
    const result = await manager.unloadAll({ baseUrl: BASE });
    assert.equal(result.ok, true);
    assert.deepEqual(result.unloaded, ['gemma4:latest', 'llama3.2:8b-q4']);
    // One unload per resident model, all against /api/chat on the same host.
    assert.ok(posts.every(p => p.url === `${BASE}/api/chat`));
    assert.deepEqual(posts.map(p => p.body), [
        { model: 'gemma4:latest', messages: [], keep_alive: 0 },
        { model: 'llama3.2:8b-q4', messages: [], keep_alive: 0 }
    ]);
    assert.equal(listReads, 1); // one /api/ps read, then unloads — no polling loop
});

test('unloadAll protects embedding models — all-minilm stays resident (v56.5)', async () => {
    const posts = [];
    const manager = createOllamaManager({
        requestJson: async () => psPayload(['gemma4:latest', 'all-minilm:latest']),
        postJson: async (_url, body) => { posts.push(body.model); return {}; }
    });
    const result = await manager.unloadAll({ baseUrl: BASE });
    assert.equal(result.ok, true);
    assert.deepEqual(result.unloaded, ['gemma4:latest']);
    assert.deepEqual(result.protected, ['all-minilm:latest']);
    assert.deepEqual(posts, ['gemma4:latest']); // the embedding model is never posted
});

test('unloadAll keeps the selected model when keepModel is passed (v56.5)', async () => {
    const posts = [];
    const manager = createOllamaManager({
        requestJson: async () => psPayload(['gemma4:latest', 'llama3.2:8b-q4']),
        postJson: async (_url, body) => { posts.push(body.model); return {}; }
    });
    const result = await manager.unloadAll({ baseUrl: BASE, keepModel: 'llama3.2:8b-q4' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.unloaded, ['gemma4:latest']);
    assert.deepEqual(posts, ['gemma4:latest']); // the pick itself is never stopped
});

test('unloadAll matches keepModel with or without the :latest tag (v56.5)', async () => {
    const posts = [];
    const manager = createOllamaManager({
        requestJson: async () => psPayload(['gemma4:latest']),
        postJson: async (_url, body) => { posts.push(body.model); return {}; }
    });
    const result = await manager.unloadAll({ baseUrl: BASE, keepModel: 'gemma4' });
    assert.deepEqual(result.unloaded, []);
    assert.equal(posts.length, 0);
});

test('unloadAll with nothing loaded is a success that unloads nothing (v56.5)', async () => {
    let posts = 0;
    const manager = createOllamaManager({
        requestJson: async () => psPayload([]),
        postJson: async () => { posts++; return {}; }
    });
    const result = await manager.unloadAll({ baseUrl: BASE });
    assert.equal(result.ok, true);
    assert.deepEqual(result.unloaded, []);
    assert.deepEqual(result.protected, []);
    assert.deepEqual(result.errors, []);
    assert.equal(posts, 0);
});

test('unloadAll refuses remote endpoints without any network call (v56.5)', async () => {
    let touched = false;
    const manager = createOllamaManager({
        requestJson: async () => { touched = true; return psPayload(['gemma4:latest']); },
        postJson: async () => { touched = true; return {}; }
    });
    const result = await manager.unloadAll({ baseUrl: 'https://api.example.com' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'remote_endpoint');
    assert.deepEqual(result.unloaded, []);
    assert.equal(touched, false);
});

test('unloadAll degrades to a warning when Ollama is unreachable (v56.5)', async () => {
    const manager = createOllamaManager({
        requestJson: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); },
        postJson: async () => ({})
    });
    const result = await manager.unloadAll({ baseUrl: BASE });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ollama_unavailable');
    assert.match(result.warning, /ECONNREFUSED/);
});

test('unloadAll keeps going when one unload fails and reports it (v56.5)', async () => {
    const posts = [];
    const manager = createOllamaManager({
        requestJson: async () => psPayload(['gemma4:latest', 'broken:latest', 'llama3.2:8b-q4']),
        postJson: async (_url, body) => {
            posts.push(body.model);
            if (body.model === 'broken:latest') {
                const e = new Error('Ollama API returned 500');
                e.body = '{"error":"model runner has unexpectedly terminated"}';
                throw e;
            }
            return {};
        }
    });
    const result = await manager.unloadAll({ baseUrl: BASE });
    // All three were attempted — the failure did not abort the rest.
    assert.deepEqual(posts, ['gemma4:latest', 'broken:latest', 'llama3.2:8b-q4']);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unloaded, ['gemma4:latest', 'llama3.2:8b-q4']);
    assert.deepEqual(result.errors, [{ model: 'broken:latest', error: 'Ollama API returned 500' }]);
});

test('"not found" between the list read and the unload counts as success (v56.5)', async () => {
    const manager = createOllamaManager({
        requestJson: async () => psPayload(['gone:latest']),
        postJson: async () => {
            const e = new Error('Ollama API returned 404');
            e.body = '{"error":"model \\"gone:latest\\" not found"}';
            throw e;
        }
    });
    const result = await manager.unloadAll({ baseUrl: BASE });
    assert.equal(result.ok, true);
    assert.deepEqual(result.unloaded, ['gone:latest']);
    assert.deepEqual(result.errors, []);
});

// --- IPC domain -----------------------------------------------------------------

test('ollama channels are whitelisted for the preload bridge and web /api/invoke (v56.5)', () => {
    assert.ok(INVOKE_CHANNELS.includes('ollama-unload-all'));
    assert.ok(INVOKE_CHANNELS.includes('ollama-unload-others'));
});

test('ollama-unload-all forwards only the base URL (v56.5)', async () => {
    const calls = [];
    const handlers = new Map();
    registerOllamaIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
        ollamaManager: { async unloadAll(opts) { calls.push(opts); return { ok: true, unloaded: [], protected: [], errors: [] }; } }
    });
    const res = await handlers.get('ollama-unload-all')(null, { baseUrl: BASE, keepModel: 'ignored-by-this-channel' });
    assert.equal(res.ok, true);
    assert.deepEqual(calls, [{ baseUrl: BASE }]);
});

test('ollama-unload-others forwards baseUrl + keepModel (v56.5)', async () => {
    const calls = [];
    const handlers = new Map();
    registerOllamaIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
        ollamaManager: { async unloadAll(opts) { calls.push(opts); return { ok: true, unloaded: ['a:latest'], protected: [], errors: [] }; } }
    });
    const res = await handlers.get('ollama-unload-others')(null, { baseUrl: BASE, keepModel: 'b:latest' });
    assert.deepEqual(calls, [{ baseUrl: BASE, keepModel: 'b:latest' }]);
    assert.deepEqual(res.unloaded, ['a:latest']);
});

test('a throwing manager degrades to an honest error shape (v56.5)', async () => {
    const handlers = new Map();
    registerOllamaIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
        ollamaManager: { async unloadAll() { throw new Error('boom'); } }
    });
    const res = await handlers.get('ollama-unload-all')(null, { baseUrl: BASE });
    assert.equal(res.ok, false);
    assert.match(res.error, /boom/);
    assert.deepEqual(res.unloaded, []);
    assert.deepEqual(res.errors, []);
});

test('registration is a no-op without the ollamaManager service (v56.5)', () => {
    const handlers = new Map();
    registerOllamaIpc({ handle: (name, fn) => handlers.set(name, fn) }, {});
    assert.equal(handlers.size, 0);
});
