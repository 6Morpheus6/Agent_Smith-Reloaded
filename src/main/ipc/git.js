/**
 * IPC domain: git integration.
 *
 * Registered via registerGitIpc(ipcMain, { gitIntegration, projectContext }).
 */
module.exports = function registerGitIpc(ipcMain, deps) {
    const { gitIntegration, projectContext } = deps;

    ipcMain.handle('git-init', async (event, planId) => {
        const root = projectContext.getRoot();
        return gitIntegration.init(root);
    });

    ipcMain.handle('git-status', async () => gitIntegration.status(projectContext.getRoot()));

    ipcMain.handle('git-diff', async () => gitIntegration.diff(projectContext.getRoot()));

    ipcMain.handle('git-commit', async (event, { message, planId }) => {
        const root = projectContext.getRoot();
        return gitIntegration.commit(root, message || 'Agent Smith checkpoint');
    });

    ipcMain.handle('git-undo', async () => gitIntegration.undoLast(projectContext.getRoot()));

    ipcMain.handle('git-log', async (event, n) => gitIntegration.logOneline(projectContext.getRoot(), n || 10));
};
