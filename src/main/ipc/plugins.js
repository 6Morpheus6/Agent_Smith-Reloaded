/**
 * IPC domain: plugin system.
 *
 * Registered via registerPluginsIpc(ipcMain, { pluginManager, pluginInstaller }).
 */
module.exports = function registerPluginsIpc(ipcMain, deps) {
    const { pluginManager, pluginInstaller } = deps;

    ipcMain.handle('plugins-list', async () => pluginManager.list());
    ipcMain.handle('plugins-get-contributions', async () => ({
        tools: pluginManager.getEnabledToolSchemas(),
        commands: pluginManager.getEnabledCommands(),
    }));
    ipcMain.handle('plugin-invoke-tool', async (event, { tool, args }) => {
        const result = await pluginManager.invokeTool(tool, args);
        return { result };
    });
    ipcMain.handle('plugin-run-command', async (event, { name, argText }) => {
        const text = await pluginManager.runCommandText(name, argText);
        return { text };
    });
    ipcMain.handle('plugin-fire-hook', async (event, { hookEvent, payload }) =>
        pluginManager.fireHook(hookEvent, payload || {}));
    ipcMain.handle('plugin-set-enabled', async (event, { id, enabled, grantedCaps }) =>
        pluginManager.setEnabled(id, enabled, grantedCaps));
    ipcMain.handle('plugin-uninstall', async (event, { id }) => pluginManager.uninstall(id));
    ipcMain.handle('plugin-install', async (event, { url, allowMutable }) => {
        const res = await pluginInstaller.install(url, { allowMutable: !!allowMutable });
        if (res.success) pluginManager.discover();
        return res;
    });
};
