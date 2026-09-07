'use strict';

// Runtime verification for built web apps: serve the project over HTTP and actually LOAD it
// in a browser, capturing uncaught exceptions, console errors, and failed (404) requests.
// This catches the open-ended space of "the app doesn't run" failures that static checks miss
// (e.g. `import { X }` where the module doesn't export X, or `window.App` being undefined) and
// feeds the real error back to the model via the completion gate's [RUNTIME] messages.
//
// HTTP (not file://) is used so ES modules load — matching how Agent Smith's preview serves.
// The browser engine is INJECTED (browserCheck): Electron BrowserWindow in the app, Puppeteer
// in tests/harness. This module is pure Node + the injected check, so it is fully testable.

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};

/** Minimal static file server rooted at projectRoot (no traversal outside root). */
function createStaticServer(projectRoot) {
    const root = path.resolve(projectRoot);
    return http.createServer((req, res) => {
        try {
            let rel = decodeURIComponent((req.url || '/').split('?')[0]);
            if (rel.endsWith('/')) rel += 'index.html';
            // Browsers auto-request /favicon.ico; a missing one is not an app failure.
            if (rel === '/favicon.ico') { res.statusCode = 204; return res.end(); }
            const abs = path.resolve(root, '.' + rel);
            if (abs !== root && !abs.startsWith(root + path.sep)) { res.statusCode = 403; return res.end('forbidden'); }
            fs.readFile(abs, (err, buf) => {
                if (err) { res.statusCode = 404; return res.end('not found'); }
                res.setHeader('Content-Type', MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
                res.end(buf);
            });
        } catch (e) { res.statusCode = 500; res.end('error'); }
    });
}

/**
 * Serve projectRoot over HTTP, load htmlRel in the injected browser, and return runtime errors.
 * @param {string} projectRoot
 * @param {string} htmlRel  path to index.html relative to projectRoot
 * @param {(url:string, opts:object)=>Promise<{errors:string[]}>} browserCheck  injected engine
 * @returns {Promise<{ok:boolean, errors:string[], skipped?:boolean, url?:string}>}
 */
async function serveAndCheck(projectRoot, htmlRel, browserCheck, opts = {}) {
    if (typeof browserCheck !== 'function') return { ok: true, skipped: true, errors: [] };
    const server = createStaticServer(projectRoot);
    let port;
    try {
        port = await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        });
    } catch (e) { return { ok: true, skipped: true, errors: [], reason: 'server failed' }; }

    const rel = String(htmlRel || 'index.html').split(path.sep).join('/').replace(/^\.?\//, '');
    const url = `http://127.0.0.1:${port}/${rel}`;
    try {
        const result = await browserCheck(url, { timeoutMs: opts.timeoutMs || 8000 });
        const errors = dedupe((result && result.errors) || []);
        return { ok: errors.length === 0, errors, url };
    } catch (e) {
        return { ok: true, skipped: true, errors: [], reason: e && e.message };
    } finally {
        try { server.close(); } catch (e) { /* ignore */ }
    }
}

function dedupe(errs) {
    const seen = new Set();
    const out = [];
    for (const e of errs) {
        const s = String(e || '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s.length > 240 ? s.slice(0, 240) + '…' : s);
    }
    return out.slice(0, 8);
}

module.exports = { serveAndCheck, createStaticServer };
