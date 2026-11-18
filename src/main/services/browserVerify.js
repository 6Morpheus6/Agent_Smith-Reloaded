/**
 * Browser verify — headless load of project HTML with console error capture.
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { resolveProjectFile } = require('./previewService.js');
const { hiddenWindowWebPreferences, stripCspOnSession } = require('./hiddenWindowSession.js');

const LOAD_TIMEOUT_MS = 20000;
// Per-check timeout. A model-supplied check is arbitrary JavaScript; without a
// timeout, `while(true){}` or a never-resolving promise would leave run() awaiting
// forever and the hidden BrowserWindow would never be destroyed by the finally.
const CHECK_TIMEOUT_MS = 5000;

function getElectron() {
    try {
        return require('electron');
    } catch (e) {
        return null;
    }
}

function createBrowserVerify(deps) {
    const { projectContext } = deps;

    async function run(opts) {
        const relPath = opts?.target || opts?.path || 'index.html';
        const resolved = resolveProjectFile(projectContext, relPath);
        if (resolved.error) return { pass: false, error: resolved.error, steps: [] };

        const electron = getElectron();
        // BrowserWindow is injectable (deps.BrowserWindow) for tests; defaults to Electron's.
        const BrowserWindow = deps?.BrowserWindow || electron?.BrowserWindow;
        if (!BrowserWindow) {
            return { pass: false, error: 'Browser verify requires Electron.', steps: [] };
        }

        const fileUrl = pathToFileURL(resolved.absPath).href;
        // A window injected by a caller/test is authoritative — never swap engines there.
        const allowFallback = !!(deps?.headless || !deps?.BrowserWindow);
        const steps = [];
        const consoleErrors = [];
        let win;

        try {
            // Dedicated in-memory partition: verified pages must load as-is, without the app's strict
            // CSP from session.defaultSession (external fonts/styles/CDNs are valid on built apps).
            win = new BrowserWindow({
                width: 1280,
                height: 720,
                show: false,
                webPreferences: hiddenWindowWebPreferences()
            });
            stripCspOnSession(win);

            // The Pinokio host runs this app on a MOCKED Electron (pinokio-server.js): a
            // BrowserWindow object exists there, but without a real engine (no once /
            // executeJavaScript, loadURL is a stub). Fall back to real headless Chromium so the
            // checks still run in that build, instead of reporting a phantom failure the model
            // would chase with node -e / check.js workarounds.
            if (typeof win.webContents?.once !== 'function'
                || typeof win.webContents?.executeJavaScript !== 'function'
                || typeof win?.loadURL !== 'function') {
                if (!allowFallback) {
                    return {
                        pass: true,
                        skipped: true,
                        steps,
                        consoleErrors: [],
                        note: 'Headless browser is unavailable in this build — page verification skipped.'
                    };
                }
                const headless = deps.headless || require('./puppeteerBrowser.js');
                const result = await headless.inspectPage({
                    url: fileUrl,
                    checks: Array.isArray(opts?.checks) ? opts.checks : [],
                    timeoutMs: LOAD_TIMEOUT_MS
                });
                if (!result.available) {
                    steps.push({ step: 'skip', reason: result.reason });
                    return {
                        pass: true,
                        skipped: true,
                        steps,
                        consoleErrors: [],
                        note: `Headless browser unavailable (${result.reason}). ${headless.CHROME_INSTALL_HINT || ''}`.trim()
                    };
                }
                steps.push({ step: 'engine', engine: result.engine || 'puppeteer' });
                for (const check of (result.checks || [])) {
                    steps.push({
                        step: 'check',
                        expression: check.expression,
                        pass: check.pass,
                        ...(check.error ? { error: check.error } : {})
                    });
                }
                const failedCheck = (result.checks || []).find(c => !c.pass);
                if (failedCheck) {
                    return {
                        pass: false,
                        steps,
                        consoleErrors: [],
                        error: `Check failed: ${failedCheck.expression}${failedCheck.error ? ` (${failedCheck.error})` : ''}`
                    };
                }
                if ((result.errors || []).length) {
                    const seenErrors = result.errors.map(message => ({ level: 3, message }));
                    return {
                        pass: false,
                        steps,
                        consoleErrors: seenErrors,
                        error: `Console errors: ${result.errors.slice(0, 3).join('; ')}`
                    };
                }
                steps.push({ step: 'complete', pass: true });
                return { pass: true, steps, consoleErrors: [], engine: result.engine || 'puppeteer' };
            }

            win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
                if (level >= 2) {
                    consoleErrors.push({ level, message, line, sourceId });
                }
            });

            steps.push({ step: 'load', target: relPath, url: fileUrl });

            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Page load timed out (20s).')), LOAD_TIMEOUT_MS);
                win.webContents.once('did-finish-load', () => {
                    clearTimeout(timer);
                    resolve();
                });
                win.webContents.once('did-fail-load', (_ev, _code, desc) => {
                    clearTimeout(timer);
                    reject(new Error(desc || 'Page failed to load'));
                });
                win.loadURL(fileUrl).catch(reject);
            });

            await new Promise(r => setTimeout(r, 300));

            const checks = Array.isArray(opts?.checks) ? opts.checks : [];
            for (const check of checks) {
                if (typeof check !== 'string' || !check.trim()) continue;
                try {
                    // Race the model-supplied check against a timeout so a hostile or
                    // buggy expression (infinite loop, never-resolving promise) cannot
                    // hang the run and leak the hidden BrowserWindow.
                    const ok = await Promise.race([
                        win.webContents.executeJavaScript(
                            `(function(){ try { return Boolean(${check}); } catch(e) { return false; } })()`,
                            true
                        ),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error(`Check timed out (${CHECK_TIMEOUT_MS}ms): ${check}`)), CHECK_TIMEOUT_MS)
                        )
                    ]);
                    steps.push({ step: 'check', expression: check, pass: !!ok });
                    if (!ok) {
                        return {
                            pass: false,
                            steps,
                            consoleErrors,
                            error: `Check failed: ${check}`
                        };
                    }
                } catch (e) {
                    steps.push({ step: 'check', expression: check, pass: false, error: e.message });
                    return { pass: false, steps, consoleErrors, error: e.message };
                }
            }

            if (consoleErrors.length) {
                return {
                    pass: false,
                    steps,
                    consoleErrors,
                    error: `Console errors: ${consoleErrors.map(e => e.message).slice(0, 3).join('; ')}`
                };
            }

            steps.push({ step: 'complete', pass: true });
            return { pass: true, steps, consoleErrors: [] };
        } catch (e) {
            return { pass: false, steps, consoleErrors, error: e.message || String(e) };
        } finally {
            // Never let cleanup mask a check result: the mocked host BrowserWindow has no
            // destroy(), and an unguarded call there threw "win.destroy is not a function"
            // out of a run that had actually loaded fine.
            try {
                if (win && !win.isDestroyed()) {
                    if (typeof win.destroy === 'function') win.destroy();
                    else if (typeof win.close === 'function') win.close();
                }
            } catch (e) { /* ignore */ }
        }
    }

    return { run };
}

module.exports = { createBrowserVerify };
