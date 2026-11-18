'use strict';

/**
 * Puppeteer-backed headless browser for Code Mode verification.
 *
 * Why this exists: services/browserVerify.js (the browser_verify tool) and
 * services/runtimeBrowserCheck.js (the completion gate's runtime check) drive a HIDDEN
 * Electron BrowserWindow. Under the Pinokio host the app runs on a MOCKED Electron
 * (pinokio-server.js): that window object exists but has no engine — no navigation, no
 * JS context, no console — so every page-level check silently degraded to "skipped" and
 * the model was left guessing whether its page actually runs.
 *
 * Puppeteer gives exactly the same capabilities with a real Chromium: load the page,
 * capture console errors / uncaught exceptions / failed requests, and evaluate DOM
 * expressions. Engine selection stays "Electron first" (no extra process in the desktop
 * app); this module is the fallback.
 */

const fs = require('fs');
const path = require('path');

// Errors that are never the app's fault (same list the Electron path uses).
const IGNORE = [
    /favicon\.ico/i,
    /DevTools/i,
    /Autofill\./i
];

const LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--allow-file-access-from-files',
    '--disable-background-timer-throttling'
];

const CHECK_TIMEOUT_MS = 5000;
const MAX_CHECKS = 20;
const DEFAULT_TIMEOUT_MS = 15000;

const CHROME_INSTALL_HINT = 'Install a browser once with: npx puppeteer browsers install chrome';

function systemChromeCandidates() {
    if (process.platform === 'win32') {
        const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
        const rels = [
            path.join('Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join('Google', 'Chrome Beta', 'Application', 'chrome.exe'),
            path.join('Chromium', 'Application', 'chrome.exe'),
            path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')
        ];
        const out = [];
        for (const r of roots.filter(Boolean)) for (const rel of rels) out.push(path.join(r, rel));
        return out;
    }
    if (process.platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        ];
    }
    return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge'
    ];
}

/** First existing system Chrome/Chromium (used only when puppeteer's own build is absent). */
function resolveSystemChrome() {
    for (const candidate of systemChromeCandidates()) {
        try {
            if (candidate && fs.existsSync(candidate)) return candidate;
        } catch (e) { /* ignore */ }
    }
    return null;
}

function isIgnored(text) {
    return IGNORE.some(re => re.test(String(text || '')));
}

function dedupe(errs) {
    const seen = new Set();
    const out = [];
    for (const e of errs) {
        const s = String(e || '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s.length > 300 ? s.slice(0, 300) + '…' : s);
    }
    return out.slice(0, 8);
}

function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message || `timed out after ${ms}ms`)), ms);
        if (timer.unref) timer.unref();
        promise.then(
            v => { clearTimeout(timer); resolve(v); },
            e => { clearTimeout(timer); reject(e); }
        );
    });
}

/**
 * Launch a headless Chromium. Tries puppeteer's downloaded build first, then puppeteer-core
 * with a system Chrome/Chromium/Edge. Throws a model-facing message when neither works.
 */
async function launchBrowser() {
    const opts = { headless: true, args: LAUNCH_ARGS };
    let lastError = null;

    try {
        const puppeteer = require('puppeteer');
        const exe = (() => { try { return puppeteer.executablePath(); } catch (e) { return null; } })();
        if (exe && fs.existsSync(exe)) return await puppeteer.launch(opts);
        lastError = new Error('puppeteer is installed but its Chrome build is missing');
    } catch (e) {
        lastError = e;
    }

    try {
        const core = require('puppeteer-core');
        const exe = resolveSystemChrome();
        if (exe) return await core.launch(Object.assign({}, opts, { executablePath: exe }));
        lastError = lastError || new Error('no system Chrome/Chromium found');
    } catch (e) {
        lastError = e;
    }

    const err = new Error(`${(lastError && lastError.message) || 'no headless browser available'}. ${CHROME_INSTALL_HINT}`);
    err.code = 'NO_HEADLESS_BROWSER';
    throw err;
}

/**
 * Load `url` in headless Chromium and report what the page did.
 *
 * @param {object} opts
 * @param {string} opts.url              http(s):// or file:// URL to load
 * @param {string[]} [opts.checks]       JS expressions that must evaluate truthy
 * @param {number} [opts.timeoutMs]      page load timeout
 * @param {Function} [opts._launch]      test hook: async () => browser-like object
 * @returns {Promise<{available:boolean, skipped:boolean, errors:string[],
 *                    checks:{expression:string,pass:boolean,error?:string}[],
 *                    reason?:string, engine?:string, ms?:number}>}
 */
async function inspectPage(opts = {}) {
    if (process.env.XK_CODE_NO_RUNTIME_VERIFY === '1') {
        return { available: true, skipped: true, errors: [], checks: [], reason: 'disabled by XK_CODE_NO_RUNTIME_VERIFY' };
    }
    const url = String(opts.url || '');
    if (!url) return { available: false, skipped: true, errors: [], checks: [], reason: 'no url' };

    const checks = (Array.isArray(opts.checks) ? opts.checks : [])
        .filter(c => typeof c === 'string' && c.trim())
        .slice(0, MAX_CHECKS);
    const timeoutMs = Math.min(60000, Math.max(1000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const started = Date.now();

    let browser = null;
    try {
        browser = await (opts._launch || launchBrowser)();
        const page = await browser.newPage();
        if (typeof page.setDefaultTimeout === 'function') page.setDefaultTimeout(timeoutMs);

        const errors = [];
        page.on('console', (msg) => {
            try {
                // Puppeteer console message types: 'error' only — warnings are noise.
                if (!msg || msg.type() !== 'error') return;
                const text = msg.text();
                if (!isIgnored(text)) errors.push(text);
            } catch (e) { /* ignore */ }
        });
        page.on('pageerror', (err) => {
            const text = `Uncaught: ${(err && err.message) || String(err)}`;
            if (!isIgnored(text)) errors.push(text);
        });
        page.on('requestfailed', (req) => {
            try {
                const reqUrl = req.url();
                if (isIgnored(reqUrl)) return;
                const failure = typeof req.failure === 'function' ? req.failure() : null;
                errors.push(`Request failed: ${reqUrl}${failure && failure.errorText ? ` (${failure.errorText})` : ''}`);
            } catch (e) { /* ignore */ }
        });

        await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
        // Give late console errors / async init a moment to surface (same as the Electron path).
        await new Promise(r => setTimeout(r, 400));

        const checkResults = [];
        for (const expression of checks) {
            try {
                const pass = await withTimeout(
                    page.evaluate(`(function(){ try { return Boolean(${expression}); } catch (e) { return false; } })()`),
                    CHECK_TIMEOUT_MS,
                    `Check timed out (${CHECK_TIMEOUT_MS}ms): ${expression}`
                );
                checkResults.push({ expression, pass: !!pass });
            } catch (e) {
                checkResults.push({ expression, pass: false, error: (e && e.message) || String(e) });
            }
        }

        return {
            available: true,
            skipped: false,
            engine: 'puppeteer',
            errors: dedupe(errors),
            checks: checkResults,
            ms: Date.now() - started
        };
    } catch (e) {
        const raw = (e && e.message) || String(e);
        // Every missing-browser path must tell the user how to fix it exactly once.
        const missingBrowser = (e && e.code === 'NO_HEADLESS_BROWSER') || /chrome|chromium|browser/i.test(raw);
        const hinted = /puppeteer browsers install chrome/i.test(raw);
        const reason = missingBrowser && !hinted ? `${raw}. ${CHROME_INSTALL_HINT}` : raw;
        return {
            available: false,
            skipped: true,
            errors: [],
            checks: [],
            reason
        };
    } finally {
        try { if (browser && typeof browser.close === 'function') await browser.close(); } catch (e) { /* ignore */ }
    }
}

module.exports = {
    inspectPage,
    launchBrowser,
    resolveSystemChrome,
    isIgnored,
    CHROME_INSTALL_HINT,
    IGNORE,
    LAUNCH_ARGS,
    CHECK_TIMEOUT_MS,
    MAX_CHECKS
};
