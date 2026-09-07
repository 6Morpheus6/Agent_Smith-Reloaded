const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clampCodeNumCtx, resolveCodeNumCtx } = require('../src/code/loop/contextWindow.js');

test('uses the loaded window when the model has room (8k -> loaded 24k)', () => {
    assert.equal(clampCodeNumCtx(8192, 24576), 24576);
});

test('never requests more than the model has loaded (loaded 8k stays 8k)', () => {
    assert.equal(clampCodeNumCtx(8192, 8192), 8192);
    assert.equal(clampCodeNumCtx(16384, 8192), 8192);
});

test('caps very large windows for inference speed (loaded 128k -> 96k)', () => {
    assert.equal(clampCodeNumCtx(8192, 131072), 98304);
});

// v51.5: below the 96k cap Code Mode uses the model's FULL loaded window (the app-wide send-time
// gate already blocks models loaded under 64K, so anything that reaches here has room to spare).
test('uses the full loaded window when it is between floor and cap (loaded 80k -> 80k)', () => {
    assert.equal(clampCodeNumCtx(8192, 81920), 81920);
});

test('a loaded window below the floor stays at itself — never request more than loaded', () => {
    // (the send-time gate normally blocks <64K models; Code Mode still must not over-request)
    assert.equal(clampCodeNumCtx(8192, 32768), 32768);
});

test('honors a higher requested slider, within the loaded window', () => {
    assert.equal(clampCodeNumCtx(20000, 24576), 24576);
});

test('floors small loaded windows to themselves (loaded 12k -> 12k, never above loaded)', () => {
    assert.equal(clampCodeNumCtx(8192, 12288), 12288);
});

test('unknown loaded window -> respect the request (no over-packing)', () => {
    assert.equal(clampCodeNumCtx(8192, null), 8192);
    assert.equal(clampCodeNumCtx(8192, 0), 8192);
    assert.equal(clampCodeNumCtx(undefined, null), 8192);
});

test('resolveCodeNumCtx falls back to the request when the backend is unreachable', async () => {
    const { numCtx, loadedContext } = await resolveCodeNumCtx(8192, 'http://127.0.0.1:59999', 'nope');
    assert.equal(loadedContext, null);
    assert.equal(numCtx, 8192);
});

test('fetchLoadedContext never borrows a DIFFERENT model\'s window', async () => {
    const { fetchLoadedContext } = require('../src/code/loop/contextWindow.js');
    const realFetch = global.fetch;
    // two models loaded; the in-use model reports no window -> must NOT borrow the other's 4096
    global.fetch = async () => ({
        ok: true,
        json: async () => ({ data: [
            { id: 'in-use-model', state: 'loaded' },
            { id: 'other-model', state: 'loaded', loaded_context_length: 4096 }
        ] })
    });
    try {
        assert.equal(await fetchLoadedContext('http://x/v1', 'in-use-model'), null,
            'ambiguous: must not borrow the other model window');
        // exact id match is used when present
        global.fetch = async () => ({ ok: true, json: async () => ({ data: [
            { id: 'in-use-model', state: 'loaded', loaded_context_length: 24576 }
        ] }) });
        assert.equal(await fetchLoadedContext('http://x/v1', 'in-use-model'), 24576);
        // a single unambiguously-loaded model is used even if the id differs slightly
        global.fetch = async () => ({ ok: true, json: async () => ({ data: [
            { id: 'sole-model', state: 'loaded', loaded_context_length: 16384 }
        ] }) });
        assert.equal(await fetchLoadedContext('http://x/v1', 'requested-id'), 16384);
    } finally {
        global.fetch = realFetch;
    }
});
