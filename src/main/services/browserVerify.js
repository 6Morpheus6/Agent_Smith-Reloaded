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
            if (win && !win.isDestroyed()) win.destroy();
        }
    }

    return { run };
}

module.exports = { createBrowserVerify };
