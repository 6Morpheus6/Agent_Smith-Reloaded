/**
 * IPC domain: vector memory (via memory.js manager).
 *
 * Registered via registerMemoryIpc(ipcMain, { memoryManager }).
 */
module.exports = function registerMemoryIpc(ipcMain, deps) {
    const { memoryManager } = deps;

    ipcMain.handle('mem-store', async (event, { text, metadata }) => {
        return await memoryManager.storeVector(text, metadata);
    });

    ipcMain.handle('mem-query', async (event, { query, limit }) => {
        return await memoryManager.queryVectors(query, limit);
    });

    ipcMain.handle('mem-count', async () => {
        return { count: memoryManager.getCount() };
    });

    ipcMain.handle('mem-clear', async () => {
        return memoryManager.clearMemory();
    });
};
