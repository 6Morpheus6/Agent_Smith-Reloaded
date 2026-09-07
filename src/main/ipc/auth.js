/**
 * IPC domain: authentication.
 *
 * Registered from main.js via registerAuthIpc(ipcMain, { authManager }). The
 * handler bodies are unchanged from the original inline main.js definitions;
 * only the surrounding registration wrapper is new.
 */
module.exports = function registerAuthIpc(ipcMain, deps) {
    const { authManager } = deps;

    ipcMain.handle('auth-login', async (event, { username, password }) => {
        try {
            const token = await authManager.login(username, password);
            return { success: true, token };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('auth-register', async (event, { username, password }) => {
        try {
            await authManager.register(username, password);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('auth-check', async (event, token) => {
        const user = authManager.verifyToken(token);
        if (!user) return { authenticated: false };
        return { authenticated: true, user };
    });

    ipcMain.handle('auth-get-users', async (event, token) => {
        const user = authManager.verifyToken(token);
        if (!user || user.role !== 'admin') return { error: 'Unauthorized' };
        try {
            return { success: true, users: authManager.getAllUsers(user.username) };
        } catch (e) {
            return { error: e.message };
        }
    });

    ipcMain.handle('auth-update-user', async (event, { token, targetUsername, permissions }) => {
        const user = authManager.verifyToken(token);
        if (!user || user.role !== 'admin') return { error: 'Unauthorized' };
        try {
            authManager.updateUserPermissions(user.username, targetUsername, permissions);
            return { success: true };
        } catch (e) {
            return { error: e.message };
        }
    });

    ipcMain.handle('auth-logout', async (event, token) => {
        authManager.logout(token);
        return { success: true };
    });

    ipcMain.handle('auth-has-users', async () => {
        return { hasUsers: authManager.hasUsers() };
    });
};
