/**
 * IPC domain: project root / path resolution.
 *
 * Registered from main.js via registerProjectIpc(ipcMain, { projectContext, userDataPath }).
 *
 * The selected workspace survives a restart: it is persisted here, in the main process, and
 * restored synchronously at registration. It used to live in memory only, with the renderer's
 * localStorage restore as the single thing bringing it back — and `project-get-root` answered
 * with `process.cwd()` while it was unset. So a run that started before the renderer's async
 * restore, or after a restore failed because the saved folder was gone, got Agent Smith's own
 * install folder as its project root and built inside it with no warning at all. That is how a
 * "make me a Super Mario game" run ended up reading and writing `app/examples/pacman/*`.
 *
 * Rule: an unset workspace is reported as `null`. Never as the process cwd — the harness must
 * not grade or edit its own source tree because no folder was picked.
 */
const fs = require('fs');
const path = require('path');

const WORKSPACE_FILE = 'workspace.json';

function workspaceFile(userDataPath) {
    return userDataPath ? path.join(userDataPath, WORKSPACE_FILE) : null;
}

function readSavedRoot(userDataPath) {
    const file = workspaceFile(userDataPath);
    if (!file) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return typeof raw?.root === 'string' && raw.root ? raw.root : null;
    } catch (e) {
        return null; // absent / unreadable / malformed — same as "no workspace picked"
    }
}

function writeSavedRoot(userDataPath, root) {
    const file = workspaceFile(userDataPath);
    if (!file) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ root, savedAt: new Date().toISOString() }, null, 2));
    } catch (e) { /* non-fatal: the root still works for this session */ }
}

function forgetSavedRoot(userDataPath) {
    const file = workspaceFile(userDataPath);
    if (!file) return;
    try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
}

module.exports = function registerProjectIpc(ipcMain, deps) {
    const { projectContext, userDataPath } = deps;

    // Restore before any handler can answer, so no IPC call races ahead of it.
    let restoreError = null;
    const saved = readSavedRoot(userDataPath);
    if (saved && projectContext) {
        const res = projectContext.setRoot(saved);
        if (!res || !res.success) {
            restoreError = `The workspace from last session is no longer usable: ${saved}`
                + ` (${(res && res.error) || 'unknown error'}). Pick a folder again with "Here I am".`;
            forgetSavedRoot(userDataPath);
        }
    }

    ipcMain.handle('project-get-root', async () => ({
        projectRoot: projectContext.getRootOrNull(),
        // Informational only. Callers must NOT treat this as the workspace.
        cwd: process.cwd(),
        restoreError
    }));

    ipcMain.handle('project-set-root', async (event, rootPath) => {
        const result = projectContext.setRoot(rootPath);
        if (result && result.success) writeSavedRoot(userDataPath, result.projectRoot);
        return result;
    });

    ipcMain.handle('project-resolve-path', async (event, inputPath) => projectContext.resolvePath(inputPath));
};
