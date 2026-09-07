/**
 * IPC domain: Preview panel — show_preview tool backend.
 */
'use strict';

module.exports = function registerPreviewIpc(ipcMain, deps) {
    const { previewRunner, isElectronDesktop, setAllowDesktopPreview } = deps;
    if (!previewRunner) return;

    ipcMain.handle('preview-sync-desktop', async (_event, opts) => {
        if (typeof setAllowDesktopPreview === 'function') {
            setAllowDesktopPreview(!!opts?.enabled);
        }
        return { success: true };
    });

    ipcMain.handle('preview-show', async (_event, opts) => {
        try {
            return await previewRunner.show(opts || {});
        } catch (e) {
            return { error: e.message || String(e) };
        }
    });

    ipcMain.handle('preview-close', async () => previewRunner.close());

    ipcMain.handle('preview-list-sources', async () => {
        if (!isElectronDesktop) {
            return { error: 'Desktop capture requires Electron desktop app.', sources: [] };
        }
        return previewRunner.listSources();
    });

    ipcMain.handle('preview-capture-source', async (_event, opts) => {
        if (!isElectronDesktop) {
            return { error: 'Desktop capture requires Electron desktop app.' };
        }
        try {
            return await previewRunner.captureSource(opts || {});
        } catch (e) {
            return { error: e.message || String(e) };
        }
    });
};
