'use strict';

// Electron browser engine for Code Mode's runtime verification (src/code/governor/runtimeVerify).
// Loads the served app URL in a hidden BrowserWindow and collects console errors / load
// failures, so the completion gate can surface real "the app doesn't run" failures. Modeled on
// services/browserVerify.js (same hidden-window pattern), but loads an HTTP URL (not file://) so
// ES modules resolve. Fail-open: any error here is swallowed and the run is never blocked on it.

let BrowserWindow = null;
try { ({ BrowserWindow } = require('electron')); } catch (e) { /* not in Electron */ }

const { serveAndCheck } = require('../../code/governor/runtimeVerify.js');
const { hiddenWindowWebPreferences, stripCspOnSession } = require('./hiddenWindowSession.js');

// console-message levels: 0 verbose, 1 info, 2 warning, 3 error. Block only on real errors.
const ERROR_LEVEL = 3;
const IGNORE = [
    /favicon\.ico/i,                 // missing favicon is not an app failure
    /DevTools/i,
    /Autofill\./i
];

async function electronBrowserCheck(url, opts = {}) {
    // BrowserWindow is injectable (opts.BrowserWindow) for tests; defaults to Electron's.
    const BW = (opts && opts.BrowserWindow) || BrowserWindow;
    if (!BW) return { errors: [], unavailable: true }; // no window at all -> let the caller pick an engine
    const errors = [];
    let win = null;
    try {
        // Dedicated in-memory partition (hiddenWindowWebPreferences) so this window does NOT inherit
        // the app's strict CSP from session.defaultSession — otherwise a valid external font/style
        // link becomes a phantom [RUNTIME] error that blocks "done" on an otherwise-working build.
        win = new BW({
            width: 1280, height: 800, show: false,
            webPreferences: hiddenWindowWebPreferences()
        });
        stripCspOnSession(win); // belt-and-suspenders: drop any injected CSP header on this session

        // A real Electron window exposes executeJavaScript; the Pinokio host's mock does not.
        // Report "unavailable" (instead of silently returning zero errors) so browserCheck()
        // can run the same page load in real headless Chromium.
        if (typeof win.webContents?.executeJavaScript !== 'function') {
            return { errors: [], unavailable: true };
        }
        win.webContents.on('console-message', (_e, level, message) => {
            if (level >= ERROR_LEVEL && message && !IGNORE.some(re => re.test(message))) {
                errors.push(String(message));
            }
        });
        win.webContents.on('did-fail-load', (_e, code, desc) => {
            // -3 is ERR_ABORTED (e.g. redirects) — not a real failure.
            if (code !== -3 && desc) errors.push('Page failed to load: ' + desc);
        });
        win.webContents.on('render-process-gone', (_e, details) => {
            errors.push('Renderer crashed: ' + (details && details.reason || 'unknown'));
        });

        await new Promise((resolve) => {
            const timer = setTimeout(resolve, opts.timeoutMs || 8000);
            win.webContents.once('did-finish-load', () => { clearTimeout(timer); setTimeout(resolve, 500); });
            win.loadURL(url).catch(() => { clearTimeout(timer); resolve(); });
        });
        await new Promise(r => setTimeout(r, 300)); // let late errors surface
    } catch (e) {
        return { errors: [] }; // fail-open
    } finally {
        try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) { /* ignore */ }
    }
    return { errors };
}

/**
 * Engine-selecting page check: a real Electron window when available, otherwise real headless
 * Chromium via puppeteer (the Pinokio host runs this app on a mocked Electron).
 * @returns {Promise<{errors:string[], engine?:string|null, unavailable?:boolean, skipped?:boolean}>}
 */
async function browserCheck(url, opts = {}) {
    const electronResult = await electronBrowserCheck(url, opts);
    if (!electronResult.unavailable) return electronResult;
    if (process.env.XK_CODE_NO_RUNTIME_VERIFY === '1') return { errors: [], skipped: true };
    const headless = opts.headless || require('./puppeteerBrowser.js');
    const result = await headless.inspectPage({ url, timeoutMs: opts.timeoutMs || 12000 });
    return {
        errors: result.errors || [],
        engine: result.available ? (result.engine || 'puppeteer') : null,
        unavailable: !result.available,
        skipped: !!result.skipped
    };
}

/** runtimeVerify(projectRoot, htmlRel) for the completion gate — serve + browser check. */
async function runtimeVerify(projectRoot, htmlRel) {
    if (process.env.XK_CODE_NO_RUNTIME_VERIFY === '1') {
        return { ok: true, skipped: true, errors: [] };
    }
    return serveAndCheck(projectRoot, htmlRel, browserCheck);
}

module.exports = { runtimeVerify, browserCheck, electronBrowserCheck };
