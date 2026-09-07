/**
 * IPC domain: local image generation (stable-diffusion.cpp / Vulkan).
 *
 * Registered via registerImageGenIpc(ipcMain, deps) where deps provides:
 *   imageGenManager (createImageGenManager result), dialog.
 */
'use strict';

module.exports = function registerImageGenIpc(ipcMain, deps) {
    const { imageGenManager } = deps;
    if (!imageGenManager) return;

    ipcMain.handle('imagegen-status', async () => {
        try { return imageGenManager.status(); } catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('imagegen-set-enabled', async (_event, enabled) => {
        try { return imageGenManager.saveState({ enabled: !!enabled }); } catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('imagegen-update-settings', async (_event, settings) => {
        try { return imageGenManager.saveState({ settings: Object.assign({}, imageGenManager.loadState().settings, settings || {}) }); }
        catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('imagegen-list-models', async () => {
        try { return { models: imageGenManager.listModels() }; } catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('imagegen-import-model', async (_event, srcPath) => {
        try { return { success: true, state: imageGenManager.importModel(srcPath) }; }
        catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('imagegen-pick-file', async () => {
        const { dialog } = deps;
        if (!dialog) return { error: 'Dialog unavailable' };
        const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            title: 'Import Image Model (.gguf)',
            filters: [{ name: 'GGUF models', extensions: ['gguf'] }, { name: 'All files', extensions: ['*'] }]
        });
        if (result.canceled || !result.filePaths.length) return null;
        try { return { success: true, state: imageGenManager.importModel(result.filePaths[0]) }; }
        catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('imagegen-import-url', async (_event, url) => {
        try { return { success: true, state: await imageGenManager.importFromUrl(url) }; }
        catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('imagegen-select-model', async (_event, nameOrPath) => {
        try { return { success: true, state: imageGenManager.selectModel(nameOrPath) }; }
        catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('imagegen-remove-model', async (_event, name) => {
        try { return { success: true, state: imageGenManager.removeModel(name) }; }
        catch (e) { return { error: e.message }; }
    });

    ipcMain.handle('imagegen-generate', async (_event, opts) => {
        try { return await imageGenManager.generate(opts || {}); }
        catch (e) { return { success: false, error: e.message }; }
    });
};
