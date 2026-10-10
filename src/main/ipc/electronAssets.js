/**
 * IPC domain: Electron Depot auto-provisioning (v55.3).
 *
 * Registered via registerElectronAssetsIpc(ipcMain, deps) where deps provides:
 *   electronAssets (createElectronAssets result).
 *
 * Progress reaches the UI over the 'electron-assets-event' push channel (see
 * src/shared/ipcChannels.js RECEIVE_CHANNELS); these handlers are for status + retry.
 */
'use strict';

module.exports = function registerElectronAssetsIpc(ipcMain, deps) {
    const { electronAssets } = deps;
    if (!electronAssets) return;

    ipcMain.handle('electron-assets-status', async () => {
        try { return electronAssets.status(); } catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('electron-assets-retry', async () => {
        try { await electronAssets.retry(); return electronAssets.status(); } catch (e) { return { error: e.message }; }
    });
};
