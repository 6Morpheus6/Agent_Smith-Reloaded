const { test } = require('node:test');
const assert = require('node:assert/strict');

const { inspectPage } = require('../src/main/services/puppeteerBrowser.js');
const { browserCheck } = require('../src/main/services/runtimeBrowserCheck.js');

/** Minimal puppeteer-shaped fake: one page, scripted events, scripted evaluate. */
function fakeBrowser(script = {}) {
    const calls = { closed: 0, evaluate: [] };
    const handlers = {};
    const page = {
        setDefaultTimeout() {},
        on(ev, cb) { handlers[ev] = cb; },
        async goto() {
            for (const emit of script.events || []) emit(handlers);
        },
        async evaluate(expr) {
            calls.evaluate.push(expr);
            return script.evaluate ? script.evaluate(expr) : true;
        }
    };
    return {
        calls,
        async newPage() { return page; },
        async close() { calls.closed++; }
    };
}

test('inspectPage collects console/page/request errors and runs DOM checks', async () => {
    const browser = fakeBrowser({
        events: [(h) => {
            h.console({ type: () => 'error', text: () => 'Uncaught ReferenceError: lives is not defined' });
            h.console({ type: () => 'warning', text: () => 'warning noise' });
            h.pageerror({ message: 'boom' });
            h.requestfailed({ url: () => 'file:///x/missing.js', failure: () => ({ errorText: 'net::ERR_FILE_NOT_FOUND' }) });
            h.requestfailed({ url: () => 'file:///x/favicon.ico', failure: () => ({ errorText: 'nope' }) });
        }],
        evaluate: (expr) => expr.includes('game')
    });

    const r = await inspectPage({
        url: 'file:///x/index.html',
        checks: ['document.getElementById("game")', 'window.nope'],
        _launch: async () => browser
    });

    assert.equal(r.available, true);
    assert.equal(r.skipped, false);
    assert.equal(r.engine, 'puppeteer');
    assert.deepEqual(r.checks.map(c => c.pass), [true, false], 'pass/fail follows the page expressions');
    assert.ok(r.errors.some(e => /ReferenceError/.test(e)), 'console error captured');
    assert.ok(r.errors.some(e => /boom/.test(e)), 'uncaught exception captured');
    assert.ok(r.errors.some(e => /missing\.js/.test(e)), 'failed request captured');
    assert.ok(!r.errors.some(e => /favicon/.test(e)), 'favicon noise ignored');
    assert.ok(!r.errors.some(e => /warning noise/.test(e)), 'warnings are not errors');
    assert.equal(browser.calls.closed, 1, 'browser is always closed');
});

test('a throwing check is a failed check, not a crash', async () => {
    const browser = fakeBrowser({
        evaluate: () => { throw new Error('Evaluation failed: ReferenceError: nope is not defined'); }
    });
    const r = await inspectPage({
        url: 'http://127.0.0.1:1/x',
        checks: ['nope()'],
        _launch: async () => browser
    });
    assert.equal(r.available, true);
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0].pass, false);
    assert.match(r.checks[0].error, /Evaluation failed/);
});

test('missing browser degrades to skipped with the install hint', async () => {
    const r = await inspectPage({
        url: 'http://127.0.0.1:1/x',
        _launch: async () => {
            const e = new Error('Could not find Chrome (ver. 146)');
            e.code = 'NO_HEADLESS_BROWSER';
            throw e;
        }
    });
    assert.equal(r.available, false);
    assert.equal(r.skipped, true);
    assert.match(r.reason, /npx puppeteer browsers install chrome/);
});

test('XK_CODE_NO_RUNTIME_VERIFY disables the headless check', async () => {
    process.env.XK_CODE_NO_RUNTIME_VERIFY = '1';
    try {
        const r = await inspectPage({
            url: 'http://127.0.0.1:1/x',
            _launch: async () => { throw new Error('must not launch'); }
        });
        assert.equal(r.skipped, true);
        assert.deepEqual(r.errors, []);
    } finally {
        delete process.env.XK_CODE_NO_RUNTIME_VERIFY;
    }
});

test('browserCheck falls back to headless Chromium when the host Electron is mocked', async () => {
    // Shaped like pinokio-server.js's BrowserWindow mock: no executeJavaScript, stub loadURL.
    class MockedBW {
        constructor() {
            this.webContents = {
                session: { webRequest: { onHeadersReceived() {} } },
                on() {},
                once() {},
                loadFile() {},
                loadURL() {},
                openDevTools() {}
            };
        }
        loadFile() {}
        loadURL() {}
        isDestroyed() { return false; }
        close() {}
    }

    let inspected = null;
    const headless = {
        inspectPage: async (o) => {
            inspected = o;
            return { available: true, skipped: false, engine: 'puppeteer', errors: ['Uncaught: x is not defined'], checks: [] };
        }
    };

    const r = await browserCheck('http://127.0.0.1:9/index.html', { BrowserWindow: MockedBW, headless });

    assert.equal(r.engine, 'puppeteer');
    assert.deepEqual(r.errors, ['Uncaught: x is not defined'], 'real page errors reach the completion gate');
    assert.equal(inspected.url, 'http://127.0.0.1:9/index.html');
});
