/**
 * IPC domain: local Ollama model unloading (v56.5).
 *
 * Two channels, one manager method:
 *   - ollama-unload-all      → frees EVERY running Ollama model (UNLOAD ALL button)
 *   - ollama-unload-others   → frees every running model EXCEPT the selection (dropdown swap)
 * The renderer passes only the server base URL (+ keepModel for swaps); everything else
 * happens against loopback in main, so it works from desktop and mobile web alike.
 */
'use strict';

module.exports = function registerOllamaIpc(ipcMain, deps) {
    const { ollamaManager } = deps;
    if (!ollamaManager) return;

    ipcMain.handle('ollama-unload-all', async (_event, opts) => {
        try {
            return await ollamaManager.unloadAll({ baseUrl: opts?.baseUrl });
        } catch (e) {
            return { ok: false, error: e.message || String(e), unloaded: [], protected: [], errors: [] };
        }
    });

    ipcMain.handle('ollama-unload-others', async (_event, opts) => {
        try {
            return await ollamaManager.unloadAll({
                baseUrl: opts?.baseUrl,
                keepModel: opts?.keepModel
            });
        } catch (e) {
            return { ok: false, error: e.message || String(e), unloaded: [], protected: [], errors: [] };
        }
    });
};
