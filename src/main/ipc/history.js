/**
 * IPC domain: session history, import/export, and file/dir dialogs.
 *
 * Registered via registerHistoryIpc(ipcMain, deps) where deps provides:
 *   dialog, fs, fsPromises, path, historyFile, legacyFiles, userDataPath.
 *
 * Handler bodies are unchanged from the original inline main.js definitions.
 */
module.exports = function registerHistoryIpc(ipcMain, deps) {
    const { dialog, fs, fsPromises, path, historyFile, legacyFiles, userDataPath } = deps;
    let saveQueue = Promise.resolve();

    ipcMain.handle('open-file-dialog', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            title: 'Select File to Attach'
        });

        if (!result.canceled && result.filePaths.length > 0) {
            const filePath = result.filePaths[0];
            try {
                const stats = await fsPromises.stat(filePath);
                const fileName = path.basename(filePath);
                const ext = path.extname(filePath).toLowerCase();
                const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
                const isImage = imageExts.includes(ext);

                if (isImage) {
                    if (stats.size > 50 * 1024 * 1024) {
                        return { error: 'Image file is too large (over 50MB limit).' };
                    }
                    const fileBuffer = await fsPromises.readFile(filePath);
                    const base64 = fileBuffer.toString('base64');
                    return { filePath, fileName, isImage: true, base64, size: stats.size };
                } else {
                    let content;
                    if (stats.size < 1024 * 1024) {
                        content = await fsPromises.readFile(filePath, 'utf-8');
                    } else {
                        content = `[FILE TOO LARGE TO AUTO-READ: ${stats.size} bytes. Use read_file tool to access specific parts.]`;
                    }
                    return { filePath, fileName, isImage: false, content, size: stats.size };
                }
            } catch (err) {
                return { error: err.message };
            }
        }
        return null;
    });

    ipcMain.handle('load-history', async () => {
        try {
            if (fs.existsSync(historyFile)) {
                const data = await fsPromises.readFile(historyFile, 'utf-8');
                return JSON.parse(data);
            } else {
                // Find the largest/most viable legacy history file to migrate
                // since v34 may have been wiped by the Task Isolation bug
                let bestLegacyFile = null;
                let maxSize = 0;

                for (const lf of legacyFiles) {
                    const lfPath = path.join(userDataPath, lf);
                    if (fs.existsSync(lfPath)) {
                        const stats = await fsPromises.stat(lfPath);
                        // If it's over 1KB, it's likely a real history file, not a wiped one
                        if (stats.size > maxSize && stats.size > 1024) {
                            maxSize = stats.size;
                            bestLegacyFile = lfPath;
                        }
                    }
                }

                if (bestLegacyFile) {
                console.log(`Migrating history from ${bestLegacyFile} to v40.7...`);
                const data = await fsPromises.readFile(bestLegacyFile, 'utf-8');
                 const history = JSON.parse(data);
                 await fsPromises.writeFile(historyFile, JSON.stringify(history), 'utf-8');
                 return history;
                }        }
        } catch (e) {
            console.error('Failed to load history', e);
        }
        return [];
    });

    ipcMain.handle('save-history', async (event, history) => {
        const save = async () => {
            const tempFile = `${historyFile}.${process.pid}.${Date.now()}.tmp`;
            try {
                await fsPromises.writeFile(tempFile, JSON.stringify(history), 'utf-8');
                await fsPromises.rename(tempFile, historyFile);
                return true;
            } catch (e) {
                try { await fsPromises.unlink(tempFile); } catch (_cleanupError) { /* best-effort */ }
                console.error('Failed to save history', e);
                return false;
            }
        };
        const next = saveQueue.then(save, save);
        saveQueue = next.then(() => undefined, () => undefined);
        return next;
    });

    ipcMain.handle('clear-history', async () => {
        try {
            if (fs.existsSync(historyFile)) {
                await fsPromises.unlink(historyFile);
            }
            return true;
        } catch (e) {
            return false;
        }
    });

    ipcMain.handle('export-session', async (event, data) => {
        const result = await dialog.showSaveDialog({
            title: 'Export Session',
            defaultPath: `agent-smith-session-${Date.now()}.json`,
            filters: [
                { name: 'JSON', extensions: ['json'] },
                { name: 'Markdown', extensions: ['md'] }
            ]
        });
        if (result.canceled || !result.filePath) return null;

        const ext = path.extname(result.filePath).toLowerCase();
        if (ext === '.md') {
            let md = `# Agent Smith Session\n\nExported: ${new Date().toISOString()}\n\n---\n\n`;
            for (const msg of data) {
                if (msg.role === 'user') md += `## User\n\n${msg.content}\n\n`;
                else if (msg.role === 'assistant' && msg.content) md += `## Assistant\n\n${msg.content}\n\n`;
                else if (msg.role === 'system') md += `> **System:** ${msg.content}\n\n`;
            }
            await fsPromises.writeFile(result.filePath, md, 'utf-8');
        } else {
            await fsPromises.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
        }
        return { success: true, filePath: result.filePath };
    });

    ipcMain.handle('import-session', async () => {
        const result = await dialog.showOpenDialog({
            title: 'Import Session',
            filters: [{ name: 'JSON', extensions: ['json'] }],
            properties: ['openFile']
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        try {
            const data = await fsPromises.readFile(result.filePaths[0], 'utf-8');
            return JSON.parse(data);
        } catch (e) {
            return { error: e.message };
        }
    });

    ipcMain.handle('select-directory', async () => {
        const result = await dialog.showOpenDialog({
            title: 'Select Workspace Directory',
            properties: ['openDirectory']
        });
        if (!result.canceled && result.filePaths.length > 0) {
            return { path: result.filePaths[0] };
        }
        return null;
    });
};
