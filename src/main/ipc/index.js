/**
 * IPC registrar — wires every extracted main-process IPC domain.
 *
 * main.js builds a single `deps` object (services, helpers, shared state) and
 * calls registerAllIpc(ipcMain, deps). Each domain module receives the same
 * ipcMain (the web-handler-wrapping version from main.js) and the deps it
 * destructures. OS/lifecycle handlers (whatsapp, tts, gpu telemetry, app-reset,
 * set-lms-url, web server, host/env/external-url) intentionally stay in main.js.
 */
const registerAuthIpc = require('./auth.js');
const registerHistoryIpc = require('./history.js');
const registerAgentIpc = require('./agent.js');
const registerEditIpc = require('./edit.js');
const registerProjectIpc = require('./project.js');
const registerLedgerIpc = require('./ledger.js');
const registerGitIpc = require('./git.js');
const registerMemoryIpc = require('./memory.js');
const registerPluginsIpc = require('./plugins.js');
const registerCodeIpc = require('./code.js');
const registerPreviewIpc = require('./preview.js');
const registerLmStudioIpc = require('./lmStudio.js');
const registerActionsIpc = require('./actions.js');
const registerImageGenIpc = require('./imageGen.js');

module.exports = function registerAllIpc(ipcMain, deps) {
    // Register each domain in isolation: a failure in one (e.g. a domain that touches an
    // optional service that didn't initialize on this machine) must not stop the others.
    // auth is first so sign-in/registration always works even if a later domain throws.
    const domains = [
        ['auth', registerAuthIpc],
        ['history', registerHistoryIpc],
        ['agent', registerAgentIpc],
        ['edit', registerEditIpc],
        ['project', registerProjectIpc],
        ['ledger', registerLedgerIpc],
        ['git', registerGitIpc],
        ['memory', registerMemoryIpc],
        ['plugins', registerPluginsIpc],
        ['code', registerCodeIpc],
        ['preview', registerPreviewIpc],
        ['lmStudio', registerLmStudioIpc],
        ['actions', registerActionsIpc],
        ['imageGen', registerImageGenIpc],
    ];
    for (const [name, register] of domains) {
        try {
            register(ipcMain, deps);
        } catch (e) {
            console.error(`[ipc] failed to register "${name}" domain:`, (e && e.message) || e);
        }
    }
};
