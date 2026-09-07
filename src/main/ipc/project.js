/**
 * IPC domain: project root / path resolution.
 *
 * Registered from main.js via registerProjectIpc(ipcMain, { projectContext }).
 */
module.exports = function registerProjectIpc(ipcMain, deps) {
    const { projectContext } = deps;

    ipcMain.handle('project-get-root', async () => ({ projectRoot: projectContext.getRootOrNull() || projectContext.getRoot() }));

    ipcMain.handle('project-set-root', async (event, rootPath) => {
        const result = projectContext.setRoot(rootPath);
        return result;
    });

    ipcMain.handle('project-resolve-path', async (event, inputPath) => projectContext.resolvePath(inputPath));
};
