'use strict';
// E2E (real Electron): reproduce the phantom-CSP [RUNTIME] bug and prove the fix.
//
// Setup mirrors main.js: a strict Content-Security-Policy is injected on session.defaultSession
// via webRequest.onHeadersReceived. A hidden verification window that loads user-built pages must
// NOT inherit it — otherwise cross-origin stylesheets (Google Fonts in the real case) become phantom
// console errors and block "done".
//
// A/B:
//   OLD  = BrowserWindow with plain webPreferences (defaultSession, inherits CSP)
//   NEW  = BrowserWindow with hiddenWindowWebPreferences() + stripCspOnSession(win)
// Pages:
//   /app.html    — links a stylesheet from a DIFFERENT origin (server B). Valid app; must be clean.
//   /broken.html — real JS error (undefinedFunc()). Must be caught by BOTH configs.

const http = require('http');
const { app, BrowserWindow, session } = require('electron');
const { hiddenWindowWebPreferences, stripCspOnSession } = require('/home/legend/Documents/testing/agent smith/hermes smith/agent smith v53.8/src/main/services/hiddenWindowSession.js');

const APP_HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="__EXT__/external.css">
<style>.x{color:red}</style></head>
<body><div id="app">ok</div><script>window.__loaded=true;</script></body></html>`;
const BROKEN_HTML = `<!doctype html><html><body><script>undefinedFunc();</script></body></html>`;

function serve(port, handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(port, '127.0.0.1', () => resolve(s));
    });
}

async function loadAndCollect(win, url, timeoutMs = 6000) {
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => {
        if (level >= 3 && message) errors.push(String(message));
    });
    await new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        win.webContents.once('did-finish-load', () => { clearTimeout(t); setTimeout(resolve, 400); });
        win.loadURL(url).catch(() => { clearTimeout(t); resolve(); });
    });
    await new Promise(r => setTimeout(r, 300));
    return errors;
}

process.on('uncaughtException', (e) => { console.log('UNCAUGHT:', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.log('UNHANDLED REJECTION:', e && e.stack || e); });
app.on('quit', () => console.log('APP QUIT EVENT'));

app.whenReady().then(async () => {
    console.log('APP READY');
    // ── Mirror main.js: strict CSP on defaultSession (the app's renderer lock-down) ──────────────
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: Object.assign({}, details.responseHeaders, {
                'Content-Security-Policy': [
                    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
                    "img-src 'self' data: blob:; font-src 'self' data:"
                ]
            })
        });
    });

    const PORT_A = 45101, PORT_B = 45102;
    await serve(PORT_A, (req, res) => {
        if ((req.url || '').startsWith('/broken')) {
            res.setHeader('Content-Type', 'text/html'); return res.end(BROKEN_HTML);
        }
        res.setHeader('Content-Type', 'text/html');
        res.end(APP_HTML.replace('__EXT__', `http://127.0.0.1:${PORT_B}`));
    });
    await serve(PORT_B, (_req, res) => {
        res.setHeader('Content-Type', 'text/css'); res.end('.ext{color:blue}');
    });

    const oldPrefs = () => ({ nodeIntegration: false, contextIsolation: true, sandbox: true });

    async function step(label, isNew, url) {
        let win;
        try {
            win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: isNew ? hiddenWindowWebPreferences() : oldPrefs() });
            if (isNew) stripCspOnSession(win);
            const r = await loadAndCollect(win, url);
            console.log(`STEP ${label}: ${r.length} error(s)`);
            return r;
        } catch (e) {
            console.log(`STEP ${label} ERROR:`, e && e.stack || e);
            return ['STEP-ERROR: ' + ((e && e.message) || String(e))];
        } finally {
            try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
        }
    }

    const results = {};
    results.old_app = await step('old_app', false, `http://127.0.0.1:${PORT_A}/app.html`);
    results.new_app = await step('new_app', true, `http://127.0.0.1:${PORT_A}/app.html`);
    results.new_broken = await step('new_broken', true, `http://127.0.0.1:${PORT_A}/broken.html`);
    results.old_broken = await step('old_broken', false, `http://127.0.0.1:${PORT_A}/broken.html`);

    const csp = (errs) => errs.filter(e => /Content Security Policy|CSP/i.test(e));
    const jsErr = (errs) => errs.filter(e => !/favicon/i.test(e));
    console.log('=== E2E RESULTS ===');
    console.log('OLD app page errors:', JSON.stringify(results.old_app));
    console.log('NEW app page errors:', JSON.stringify(results.new_app));
    console.log('OLD broken page errors:', JSON.stringify(jsErr(results.old_broken).slice(0, 2)));
    console.log('NEW broken page errors:', JSON.stringify(jsErr(results.new_broken).slice(0, 2)));

    const oldHadPhantom = csp(results.old_app).length > 0;
    const newClean = results.new_app.length === 0;
    const newStillCatchesJs = jsErr(results.new_broken).some(e => /undefinedFunc|is not defined/i.test(e));
    console.log('=== VERDICTS ===');
    console.log('BUG REPRODUCED (old config phantom CSP error):', oldHadPhantom);
    console.log('FIX WORKS (new config: zero errors on valid app):', newClean);
    console.log('REAL ERRORS STILL CAUGHT (new config, broken page):', newStillCatchesJs);

    const pass = oldHadPhantom && newClean && newStillCatchesJs;
    console.log(pass ? 'E2E PASS' : 'E2E FAIL');
    app.quit();
});

// Suppress Electron's default "quit when all windows close": every window here is a transient
// hidden verification window; the run must stay alive until every step completes (explicit app.quit()).
app.on('window-all-closed', () => {});
setTimeout(() => { console.log('E2E TIMEOUT'); process.exit(4); }, 90000);
