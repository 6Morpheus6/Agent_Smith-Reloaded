const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { maybeProactiveRuntimeCheck } = require('../src/code/governor/proactiveRuntime.js');

function mkproj(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return root;
}
function mkSession(root, files) {
    return { projectRoot: root, filesTouched: files, messages: [], turn: 3 };
}
const events = () => { const e = []; const fn = (ev) => e.push(ev); fn.list = e; return fn; };

test('injects a fix-it nudge when a complete web project throws at runtime', async () => {
    const root = mkproj({
        'index.html': '<!doctype html><body><div id="x"></div><script src="app.js"></script></body>',
        'app.js': 'doStuff();'
    });
    const session = mkSession(root, ['index.html', 'app.js']);
    const emit = events();
    const execDeps = { runtimeVerify: async () => ({ ok: false, errors: ['Uncaught ReferenceError: doStuff is not defined'] }) };
    await maybeProactiveRuntimeCheck(session, execDeps, emit);

    const nudge = session.messages.find(m => /BROWSER RUNTIME CHECK FAILED/.test(m.content));
    assert.ok(nudge, 'a runtime nudge is injected');
    assert.ok(nudge.content.includes('doStuff is not defined'), 'the exact error is included');
    assert.ok(emit.list.some(e => e.type === 'runtime_check' && e.ok === false));
    fs.rmSync(root, { recursive: true, force: true });
});

test('does NOT run while the project is structurally incomplete (missing script)', async () => {
    const root = mkproj({ 'index.html': '<body><script src="app.js"></script></body>' }); // app.js missing
    const session = mkSession(root, ['index.html']);
    let called = false;
    await maybeProactiveRuntimeCheck(session, { runtimeVerify: async () => { called = true; return { ok: false, errors: ['x'] }; } }, events());
    assert.equal(called, false);
    assert.equal(session.messages.length, 0);
    fs.rmSync(root, { recursive: true, force: true });
});

test('no nudge when the runtime check is clean; and does not re-check unchanged content', async () => {
    const root = mkproj({ 'index.html': '<body><script src="app.js"></script></body>', 'app.js': 'var ok=1;' });
    const session = mkSession(root, ['index.html', 'app.js']);
    let calls = 0;
    const execDeps = { runtimeVerify: async () => { calls++; return { ok: true, errors: [] }; } };
    await maybeProactiveRuntimeCheck(session, execDeps, events());
    await maybeProactiveRuntimeCheck(session, execDeps, events()); // unchanged signature -> skip
    assert.equal(calls, 1, 'runs once, skips the unchanged re-check');
    assert.equal(session.messages.length, 0);
    fs.rmSync(root, { recursive: true, force: true });
});

test('respects the check cap to avoid loops', async () => {
    const root = mkproj({ 'index.html': '<body><script src="app.js"></script></body>', 'app.js': 'a();' });
    const session = mkSession(root, ['index.html', 'app.js']);
    session._rtState = { lastSig: null, checks: 99 }; // already over the cap
    let called = false;
    await maybeProactiveRuntimeCheck(session, { runtimeVerify: async () => { called = true; return { ok: false, errors: ['x'] }; } }, events());
    assert.equal(called, false);
    fs.rmSync(root, { recursive: true, force: true });
});
