/**
 * IPC domain: Action Log (trust/audit layer) — review what the agent did and undo it.
 */
'use strict';

module.exports = function registerActionsIpc(ipcMain, deps) {
    const log = deps.actionLog;
    const ok = (fn) => async (...a) => {
        if (!log) return { error: 'Action log unavailable.' };
        try { return await fn(...a); } catch (e) { return { error: (e && e.message) || String(e) }; }
    };
    ipcMain.handle('actions-list', ok((_e, opts) => ({ actions: log.list(opts || {}) })));
    ipcMain.handle('actions-undo', ok((_e, id) => log.undo(id)));
    ipcMain.handle('actions-clear', ok(() => log.clear()));
};
