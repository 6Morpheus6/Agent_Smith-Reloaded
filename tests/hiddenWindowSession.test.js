/**
 * v53.8 — hidden-window session isolation (src/main/services/hiddenWindowSession.js).
 *
 * The main window registers a strict Content-Security-Policy header injection on
 * session.defaultSession (main.js) to lock down the LLM/markdown renderer. Hidden windows that load
 * user-built pages or arbitrary URLs must NOT inherit it — otherwise valid external resources
 * (Google Fonts, CDN scripts/fonts) become phantom console errors and a complete, working app fails
 * its OWN harness check ("built but blocked": the completion gate reports [RUNTIME] CSP violations
 * that only exist inside our verification window).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { VERIFY_PARTITION, hiddenWindowWebPreferences, stripCspOnSession } = require('../src/main/services/hiddenWindowSession.js');

test('VERIFY_PARTITION is an in-memory partition (no persist:) and not the default session', () => {
    assert.ok(VERIFY_PARTITION.length > 0);
    assert.doesNotMatch(VERIFY_PARTITION, /^persist:/, 'must be in-memory — never touch the user profile');
});

test('hiddenWindowWebPreferences isolates from defaultSession and keeps the sandboxed shape', () => {
    const prefs = hiddenWindowWebPreferences();
    assert.equal(prefs.partition, VERIFY_PARTITION);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.sandbox, true);
});

test('hiddenWindowWebPreferences merges caller extras without losing the partition', () => {
    const prefs = hiddenWindowWebPreferences({ backgroundThrottling: false });
    assert.equal(prefs.partition, VERIFY_PARTITION);
    assert.equal(prefs.backgroundThrottling, false);
});

function fakeSession() {
    let handler = null;
    return {
        webRequest: {
            onHeadersReceived(h) { handler = h; },
            _handler: () => handler
        }
    };
}

test('stripCspOnSession registers a header filter that removes CSP (any case)', async () => {
    const ses = fakeSession();
    const win = { webContents: { session: ses } };
    stripCspOnSession(win);
    assert.ok(typeof ses.webRequest._handler() === 'function', 'a handler must be registered');

    let out;
    await new Promise((resolve) => ses.webRequest._handler()(
        { responseHeaders: { 'Content-Security-Policy': ["default-src 'self'"], 'X-Other': ['keep'] } },
        (r) => { out = r; resolve(); }
    ));
    assert.ok(!('Content-Security-Policy' in out.responseHeaders), 'CSP header must be stripped');
    assert.deepEqual(out.responseHeaders['X-Other'], ['keep'], 'other headers untouched');

    // lowercase variant (servers may send it lowercased)
    await new Promise((resolve) => ses.webRequest._handler()(
        { responseHeaders: { 'content-security-policy': ["script-src 'none'"] } },
        (r) => { out = r; resolve(); }
    ));
    assert.deepEqual(out.responseHeaders, {}, 'lowercase CSP stripped too');

    // no headers at all must not throw
    await new Promise((resolve) => ses.webRequest._handler()(
        { responseHeaders: undefined },
        (r) => { out = r; resolve(); }
    ));
    assert.deepEqual(out.responseHeaders, {});
});

test('stripCspOnSession is idempotent per session (no stacked handlers)', () => {
    const ses = fakeSession();
    const win = { webContents: { session: ses } };
    stripCspOnSession(win);
    stripCspOnSession(win); // second call must not re-register / throw
    assert.ok(typeof ses.webRequest._handler() === 'function');
});

test('stripCspOnSession survives a broken session (fail-open)', () => {
    const win = { webContents: {} }; // no .session at all
    assert.doesNotThrow(() => stripCspOnSession(win));
});

// ── Wiring: every hidden-window service must build its window with the isolated prefs ─────────────

test('runtimeBrowserCheck builds its window with hiddenWindowWebPreferences (isolated partition)', async () => {
    const created = [];
    class FakeBW {
        constructor(opts) {
            created.push(opts);
            this.webContents = { session: fakeSession(), on() {}, once() {} };
            this.loadURL = () => new Promise(() => {}); // never resolves; timeout path ends the check
            this.isDestroyed = () => false;
            this.destroy = () => {};
        }
    }
    const { electronBrowserCheck } = require('../src/main/services/runtimeBrowserCheck.js');
    await electronBrowserCheck('http://127.0.0.1:9/x', { BrowserWindow: FakeBW, timeoutMs: 5 });
    assert.equal(created.length, 1);
    assert.equal(created[0].webPreferences.partition, VERIFY_PARTITION, 'verification window must not use defaultSession');
});

test('browserVerify builds its window with hiddenWindowWebPreferences (isolated partition)', async () => {
    const created = [];
    class FakeBW {
        constructor(opts) {
            created.push(opts);
            this.webContents = { session: fakeSession(), on() {}, once(ev, cb) {} };
            this.loadURL = () => Promise.reject(new Error('nope')); // fail fast -> run() reports it
            this.isDestroyed = () => false;
            this.destroy = () => {};
        }
    }
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-bv-'));
    const htmlPath = path.join(dir, 'index.html');
    fs.writeFileSync(htmlPath, '<!doctype html><html><body>ok</body></html>');
    // resolveProjectFile contract: projectContext.resolvePath(rel) -> { path } | { error }.
    const projectContext = { resolvePath: (rel) => ({ path: path.join(dir, rel) }) };
    const { createBrowserVerify } = require('../src/main/services/browserVerify.js');
    const verify = createBrowserVerify({ projectContext, BrowserWindow: FakeBW });
    await verify.run({ target: 'index.html' }); // loadURL rejects -> pass:false, but window WAS created
    assert.equal(created.length, 1);
    assert.equal(created[0].webPreferences.partition, VERIFY_PARTITION, 'verify window must not use defaultSession');
});

test('previewService.captureWebUrl builds its window with hiddenWindowWebPreferences (isolated partition)', async () => {
    const created = [];
    class FakeBW {
        constructor(opts) {
            created.push(opts);
            this.webContents = { session: fakeSession(), on() {}, once(ev, cb) {} };
            this.loadURL = () => Promise.reject(new Error('nope')); // fail fast -> capture error path
            this.isDestroyed = () => false;
            this.destroy = () => {};
        }
    }
    const { captureWebUrl } = require('../src/main/services/previewService.js');
    await captureWebUrl('http://127.0.0.1:9/', { width: 800, height: 600 }, { BrowserWindow: FakeBW });
    assert.equal(created.length, 1);
    assert.equal(created[0].webPreferences.partition, VERIFY_PARTITION, 'capture window must not use defaultSession');
});
