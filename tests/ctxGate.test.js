/**
 * v51.5 — app-wide min-ctx gate + loaded-context reflection (src/shared/ctxGate.js).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../src/shared/ctxGate.js');

test('min ctx defaults to 64000 and is env-overridable', () => {
    assert.equal(gate.minCtx(), 64000);
    process.env.XK_MIN_CTX = '96000';
    try { assert.equal(gate.minCtx(), 96000); } finally { delete process.env.XK_MIN_CTX; }
});

test('verified window at/above the minimum passes', () => {
    assert.deepEqual(
        gate.checkCtxGate({ managed: true, model: 'm', loadedContext: 262144 }),
        { ok: true, verified: true, loadedContext: 262144, minCtx: 64000 }
    );
});

test('verified window below the minimum blocks with an actionable message naming the model and the fix', () => {
    const v = gate.checkCtxGate({ managed: true, model: 'tiny-model', loadedContext: 32768 });
    assert.equal(v.ok, false);
    assert.match(v.message, /tiny-model/);
    assert.match(v.message, /32768/);
    assert.match(v.message, /64000/);
});

test('boundary: exactly 64000 passes (minimum is inclusive)', () => {
    assert.equal(gate.checkCtxGate({ managed: true, model: 'm', loadedContext: 64000 }).ok, true);
});

test('unmanaged / unreachable endpoints are NOT blocked (nothing verifiable)', () => {
    for (const status of [
        null,
        undefined,
        {},
        { managed: false, reason: 'remote_endpoint' },
        { managed: false, reason: 'lmstudio_unavailable', warning: 'down' },
        { managed: true, loadedContext: null }
    ]) {
        const v = gate.checkCtxGate(status);
        assert.equal(v.ok, true, JSON.stringify(status));
        assert.equal(v.verified, false, JSON.stringify(status));
    }
});

test('reflectLoadedContext lets the REAL loaded window win over a computed value', () => {
    // LM Studio has this model loaded at 262144 — even though auto-tune would compute less.
    assert.equal(gate.reflectLoadedContext(24576, { managed: true, loadedContext: 262144 }), 262144);
});

test('reflectLoadedContext falls back to the computed value when unmanaged', () => {
    assert.equal(gate.reflectLoadedContext(24576, null), 24576);
    assert.equal(gate.reflectLoadedContext(24576, { managed: false }), 24576);
});

test('reflectLoadedContext clamps into the slider displayable range', () => {
    assert.equal(gate.reflectLoadedContext(0, { managed: true, loadedContext: 1000 }), gate.CTX_SLIDER_MIN);
    assert.equal(gate.reflectLoadedContext(0, { managed: true, loadedContext: 999999 }), gate.CTX_SLIDER_MAX);
});

test('v51.6 regression: the gate works in a process-less renderer (nodeIntegration:false)', () => {
    // The Electron renderer has `window` but NO global `process`. v51.5's minCtx()
    // referenced process.env unguarded → ReferenceError on every send (the "send button
    // does nothing" bug). Simulate that environment exactly and re-run the module there.
    const vm = require('node:vm');
    const fs = require('node:fs');
    const pathMod = require('node:path');
    const sandboxWindow = {};
    sandboxWindow.window = sandboxWindow;
    const ctx = vm.createContext({ window: sandboxWindow });
    vm.runInContext(
        fs.readFileSync(pathMod.join(__dirname, '..', 'src', 'shared', 'ctxGate.js'), 'utf8'),
        ctx, { filename: 'ctxGate.renderer-sim.js' }
    );
    const rendererGate = ctx.window.XKCtxGate;
    assert.ok(rendererGate, 'module must attach to window in a process-less environment');
    // The call sendMessage() makes on every send — this is the exact line that threw.
    const pass = rendererGate.checkCtxGate({ managed: true, model: 'm', loadedContext: 262144 });
    // Field-by-field: the result object comes from a different realm (vm context), so
    // strict deep-equality fails on prototype identity even when values match.
    assert.equal(pass.ok, true);
    assert.equal(pass.verified, true);
    assert.equal(pass.loadedContext, 262144);
    assert.equal(pass.minCtx, 64000);
    const block = rendererGate.checkCtxGate({ managed: true, model: 'tiny', loadedContext: 32768 });
    assert.equal(block.ok, false);
    assert.match(block.message, /tiny/);
});
