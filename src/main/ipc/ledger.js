/**
 * IPC domain: change ledger (diff / revert-all).
 *
 * Registered via registerLedgerIpc(ipcMain, { changeLedger, state }). `state`
 * is the shared mutable object owned by main.js; `state.currentPlanId` is the
 * fallback plan id when the renderer does not pass one explicitly.
 */
module.exports = function registerLedgerIpc(ipcMain, deps) {
    const { changeLedger, state } = deps;

    ipcMain.handle('ledger-diff', async (event, planId) => changeLedger.diff(planId || state.currentPlanId));

    ipcMain.handle('ledger-revert-all', async (event, planId) => changeLedger.revertAll(planId || state.currentPlanId));
};
