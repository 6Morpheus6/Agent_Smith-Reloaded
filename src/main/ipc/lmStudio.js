/**
 * IPC domain: local LM Studio model/context management.
 */
'use strict';

module.exports = function registerLmStudioIpc(ipcMain, deps) {
    const { lmStudioManager } = deps;
    if (!lmStudioManager) return;

    ipcMain.handle('lmstudio-get-status', async (_event, opts) => {
        try {
            return await lmStudioManager.getStatus({
                apiBaseUrl: opts?.apiBaseUrl,
                model: opts?.model
            });
        } catch (e) {
            return { managed: false, error: e.message || String(e) };
        }
    });

    ipcMain.handle('lmstudio-ensure-model', async (_event, opts) => {
        try {
            return await lmStudioManager.ensureModel({
                apiBaseUrl: opts?.apiBaseUrl,
                model: opts?.model,
                contextLength: opts?.contextLength
            });
        } catch (e) {
            return { managed: false, error: e.message || String(e) };
        }
    });

    // v52.3: UNLOAD ALL — frees every loaded model instance in LM Studio. The renderer
    // passes only the backend URL; everything else happens against loopback in main.
    ipcMain.handle('lmstudio-unload-all', async (_event, opts) => {
        try {
            return await lmStudioManager.unloadAll({ apiBaseUrl: opts?.apiBaseUrl });
        } catch (e) {
            return { ok: false, error: e.message || String(e), unloaded: [], errors: [] };
        }
    });

    // v52.5: MODEL SWAP — user picked a new model from the dropdown: unload every other
    // loaded LLM (embeddings stay resident) and load the selection with its context.
    ipcMain.handle('lmstudio-swap-model', async (_event, opts) => {
        try {
            return await lmStudioManager.swapModel({
                apiBaseUrl: opts?.apiBaseUrl,
                model: opts?.model,
                contextLength: opts?.contextLength
            });
        } catch (e) {
            return { ok: false, error: e.message || String(e), unloaded: [], errors: [] };
        }
    });

    // v52.5: EMBED ON STARTUP — make sure an embedding model is loaded so memory recall
    // works from the first message of every session (CPU-only load, no VRAM cost).
    ipcMain.handle('lmstudio-ensure-embedding', async (_event, opts) => {
        try {
            return await lmStudioManager.ensureEmbeddingModel({ apiBaseUrl: opts?.apiBaseUrl });
        } catch (e) {
            return { ok: false, error: e.message || String(e), loaded: null };
        }
    });
};
