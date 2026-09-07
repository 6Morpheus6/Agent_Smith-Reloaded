// The completion gate must surface real runtime errors (from the injected browser check) as
// [RUNTIME] feedback and block completion — so a built app that doesn't actually run is never
// passed as "done", and the model gets the exact error to fix.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkCompletion } = require('../src/code/governor/completionGate.js');

function mkproj() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtg-'));
    fs.writeFileSync(path.join(root, 'index.html'),
        '<!doctype html><html><body><div id="app"></div><script src="script.js"></script></body></html>');
    fs.writeFileSync(path.join(root, 'script.js'),
        'document.getElementById("app").textContent = "hi";\n');
    return root;
}

test('gate reports [RUNTIME] and blocks when the app throws at runtime', async () => {
    const root = mkproj();
    const err = "Uncaught TypeError: Cannot read properties of undefined (reading 'init')";
    const runtimeVerify = async () => ({ ok: false, errors: [err] });
    const gate = await checkCompletion(root, ['index.html', 'script.js'], 'build a web app', {
        runtimeVerify, grindMode: false
    });
    assert.equal(gate.allow, false, 'must not pass an app that throws at runtime');
    const runtimeMsgs = (gate.messages || []).filter(m => /^\[RUNTIME\]/.test(m));
    assert.equal(runtimeMsgs.length, 1);
    assert.ok(runtimeMsgs[0].includes("reading 'init'"), 'the exact error reaches the model');
    fs.rmSync(root, { recursive: true, force: true });
});

test('gate adds no [RUNTIME] feedback when the runtime check is clean', async () => {
    const root = mkproj();
    const runtimeVerify = async () => ({ ok: true, errors: [] });
    const gate = await checkCompletion(root, ['index.html', 'script.js'], 'build a web app', {
        runtimeVerify, grindMode: false
    });
    assert.ok(!(gate.messages || []).some(m => /^\[RUNTIME\]/.test(m)));
    fs.rmSync(root, { recursive: true, force: true });
});

test('gate never blocks when runtime check is skipped (infra unavailable)', async () => {
    const root = mkproj();
    const runtimeVerify = async () => ({ ok: true, skipped: true, errors: [] });
    const gate = await checkCompletion(root, ['index.html', 'script.js'], 'build a web app', {
        runtimeVerify, grindMode: false
    });
    assert.ok(!(gate.messages || []).some(m => /^\[RUNTIME\]/.test(m)));
    fs.rmSync(root, { recursive: true, force: true });
});
