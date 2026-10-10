// Proves memory can store + query through the EMBEDDED transformer model (all-MiniLM-L6-v2)
// WITHOUT LM Studio or Ollama. The embedded model is now primary; LM Studio/Ollama are
// optional fallbacks only used if the embedded model fails to load.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const memory = require('../src/main/services/memory.js');

// Deterministic 8-dim embedding for fallback tests.
function fakeEmbed(text) {
    const v = new Array(8).fill(0);
    const s = String(text);
    for (let i = 0; i < s.length; i++) v[i % 8] += s.charCodeAt(i);
    return v;
}

const LMS = 'http://127.0.0.1:1234';
let calls;
let mode;
const realFetch = global.fetch;

before(() => {
    memory.vectorDBPath = path.join(os.tmpdir(), `mem-embed-test-${process.pid}.json`);
});

after(() => {
    try { fs.unlinkSync(memory.vectorDBPath); } catch (e) { /* ignore */ }
});

beforeEach(() => {
    calls = [];
    mode = 'ok';
    memory.vectors = [];
    memory.embeddingModel = null;
    memory.setLlmBase(LMS);
});

test('stores and recalls a memory through the embedded transformer model', async () => {
    // The embedded model (all-MiniLM-L6-v2) is now primary. It downloads on first use
    // (~90MB from HuggingFace), then runs locally in-process on CPU. No LM Studio needed.
    const stored = await memory.storeVector('The maze grid is 19 by 21 cells', { kind: 'note' });
    assert.equal(stored.success, true);

    const q = await memory.queryVectors('The maze grid is 19 by 21 cells', 3);
    assert.equal(q.success, true);
    assert.ok(q.data.length >= 1);
    assert.match(q.data[0].text, /maze grid/i);
});

test('embedded model produces consistent embeddings for identical text', async () => {
    const e1 = await memory.getEmbedding('hello world');
    const e2 = await memory.getEmbedding('hello world');
    assert.ok(e1 && e2, 'embeddings should be non-null');
    assert.equal(e1.length, 384, 'all-MiniLM-L6-v2 produces 384-dim vectors');
    
    // Identical text should produce identical embeddings (deterministic model)
    let diff = 0;
    for (let i = 0; i < e1.length; i++) {
        diff += Math.abs(e1[i] - e2[i]);
    }
    assert.ok(diff < 0.001, 'identical text should produce identical embeddings');
});

test('similar texts have higher cosine similarity than dissimilar', async () => {
    const similar = await memory.getEmbedding('The cat sat on the mat');
    const sameTopic = await memory.getEmbedding('A feline rested on a rug');
    const different = await memory.getEmbedding('Quantum physics explains subatomic particles');
    
    const sim1 = memory.cosineSimilarity(similar, sameTopic);
    const sim2 = memory.cosineSimilarity(similar, different);
    
    // Semantic similarity should be higher for related texts
    assert.ok(sim1 > sim2, `similar (${sim1.toFixed(3)}) should score higher than dissimilar (${sim2.toFixed(3)})`);
});

test('LM Studio fallback is used when embedded model fails', async () => {
    // Force the embedded model to fail by stubbing getTransformerPipeline
    const origGetPipeline = memory.getTransformerPipeline.bind(memory);
    memory.getTransformerPipeline = async () => { throw new Error('forced failure'); };
    
    global.fetch = async (url, opts) => {
        const u = String(url);
        calls.push(u);
        if (u.includes(':11434')) {
            throw new Error('ECONNREFUSED');
        }
        if (u.endsWith('/v1/models')) {
            return { ok: true, json: async () => ({ data: [{ id: 'gemma-2-9b-it' }, { id: 'second-state/All-MiniLM-L6-v2-Embedding-GGUF' }] }) };
        }
        if (u.endsWith('/v1/embeddings')) {
            const body = JSON.parse(opts.body);
            const input = Array.isArray(body.input) ? body.input[0] : body.input;
            return { ok: true, json: async () => ({ data: [{ embedding: fakeEmbed(input) }] }) };
        }
        throw new Error('unexpected url ' + u);
    };
    
    const stored = await memory.storeVector('fallback test', { kind: 'note' });
    assert.equal(stored.success, true);
    assert.ok(calls.some(u => u.endsWith('/v1/embeddings')), 'LM Studio /v1/embeddings must be used as fallback');
    
    // Restore
    memory.getTransformerPipeline = origGetPipeline;
});

test('shows appropriate error when all embedding paths fail', async () => {
    const origGetPipeline = memory.getTransformerPipeline.bind(memory);
    memory.getTransformerPipeline = async () => { throw new Error('forced failure'); };
    
    global.fetch = async (url) => {
        if (String(url).includes(':11434')) throw new Error('ECONNREFUSED');
        return { ok: false, status: 500, text: async () => 'error' };
    };
    
    const r = await memory.storeVector('anything');
    assert.equal(r.success, false);
    // New error message mentions network connectivity for first-time download
    assert.match(r.error, /network connectivity|LM Studio|Ollama/i);
    
    // Restore
    memory.getTransformerPipeline = origGetPipeline;
});
