// Proves memory can store + query through LM Studio /v1/embeddings WITHOUT Ollama,
// auto-detects the loaded embedding model, and surfaces the LM-Studio setup error
// when embeddings fail. fetch is mocked so the test is deterministic and offline.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const memory = require('../src/main/services/memory.js');

const LMS = 'http://127.0.0.1:1234';

// Deterministic 8-dim embedding: identical text -> identical vector (cosine 1.0).
function fakeEmbed(text) {
    const v = new Array(8).fill(0);
    const s = String(text);
    for (let i = 0; i < s.length; i++) v[i % 8] += s.charCodeAt(i);
    return v;
}

let calls;
let mode;
const realFetch = global.fetch;

before(() => {
    memory.vectorDBPath = path.join(os.tmpdir(), `mem-embed-test-${process.pid}.json`);
    global.fetch = async (url, opts) => {
        const u = String(url);
        calls.push(u);
        if (u.includes(':11434')) {
            // Ollama (optional legacy) — simulate "not running" so we prove it is not required.
            throw new Error('ECONNREFUSED');
        }
        if (u.endsWith('/v1/models')) {
            const data = mode === 'no-embed-model'
                ? [{ id: 'gemma-2-9b-it' }]
                : [{ id: 'gemma-2-9b-it' }, { id: 'second-state/All-MiniLM-L6-v2-Embedding-GGUF' }];
            return { ok: true, json: async () => ({ data }) };
        }
        if (u.endsWith('/v1/embeddings')) {
            if (mode === 'embed-fail') {
                return { ok: false, status: 404, text: async () => 'no embedding model loaded' };
            }
            const body = JSON.parse(opts.body);
            const input = Array.isArray(body.input) ? body.input[0] : body.input;
            return { ok: true, json: async () => ({ data: [{ embedding: fakeEmbed(input) }] }) };
        }
        throw new Error('unexpected url ' + u);
    };
});

after(() => {
    global.fetch = realFetch;
    try { fs.unlinkSync(memory.vectorDBPath); } catch (e) { /* ignore */ }
});

beforeEach(() => {
    calls = [];
    mode = 'ok';
    memory.vectors = [];
    memory.embeddingModel = null; // force fresh model auto-detection per test
    memory.setLlmBase(LMS);
});

test('stores and recalls a memory through LM Studio embeddings (Ollama not required)', async () => {
    const stored = await memory.storeVector('The maze grid is 19 by 21 cells', { kind: 'note' });
    assert.equal(stored.success, true);

    const q = await memory.queryVectors('The maze grid is 19 by 21 cells', 3);
    assert.equal(q.success, true);
    assert.ok(q.data.length >= 1);
    assert.match(q.data[0].text, /maze grid/i);

    assert.ok(!calls.some(u => u.includes(':11434')), 'Ollama endpoint must not be contacted when LM Studio works');
    assert.ok(calls.some(u => u.endsWith('/v1/embeddings')), 'LM Studio /v1/embeddings must be used');
});

test('auto-detects the loaded LM Studio embedding model (not the hardcoded ada-002)', async () => {
    await memory.storeVector('hello world');
    assert.match(memory.embeddingModel || '', /MiniLM/i);
});

test('shows the LM Studio setup error (no Ollama mention) when embeddings fail', async () => {
    mode = 'embed-fail';
    const r = await memory.storeVector('anything');
    assert.equal(r.success, false);
    assert.match(r.error, /In LM Studio, load an embedding model and keep the local server running/);
    assert.doesNotMatch(r.error, /Ollama|all-minilm/i);

    const q = await memory.queryVectors('anything');
    assert.equal(q.success, false);
    assert.match(q.error, /In LM Studio, load an embedding model/);
});
