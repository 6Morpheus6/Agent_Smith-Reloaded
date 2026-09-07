/**
 * IPC domain: agent execution surface — shell processes, file read/write/delete,
 * directory/project listing, grep/glob/repo-map, verify, doctor, and URL fetch.
 *
 * Registered via registerAgentIpc(ipcMain, deps) where deps provides:
 *   fs, fsPromises, path, spawn, exec, projectContext, editEngine, changeLedger,
 *   planStore, verificationHarness, grepProject, hasRipgrep, globFiles,
 *   buildRepoMap, invalidateRepoMap, netGuard, relPathFromRoot,
 *   state (shared mutable { currentPlanId }).
 *
 * Background-process bookkeeping (activeProcesses, nextJobId) and the
 * spawnShell helper are owned here because no other domain touches them.
 * Handler bodies are unchanged from the original inline main.js definitions;
 * the only edit is `currentPlanId` -> `state.currentPlanId`.
 */
const { assessCommand, blockedResult } = require('../../shared/commandPolicy.js');
const { assessPathMutation, blockedPathResult } = require('../../shared/pathPolicy.js');

module.exports = function registerAgentIpc(ipcMain, deps) {
    const {
        fs, fsPromises, path, spawn, exec,
        projectContext, editEngine, changeLedger, verificationHarness,
        grepProject, hasRipgrep, globFiles, buildRepoMap, invalidateRepoMap,
        netGuard, relPathFromRoot, state, actionLog, downloadRegistry
    } = deps;
    const logAction = (e) => { try { actionLog && actionLog.record(e); } catch {} };
    const registerDownload = (absPath) => { try { downloadRegistry && downloadRegistry.register(absPath); } catch {} };

    const activeProcesses = new Map();
    let nextJobId = 1;

    function spawnShell(command, cwd, isBackground) {
        const cfg = projectContext.getShellConfig();
        if (projectContext.isWindows()) {
            const args = [cfg.flag, cfg.commandFlag, command];
            return spawn(cfg.shell, args, { cwd, shell: false });
        }
        if (isBackground) {
            return spawn(cfg.shell, [cfg.flag, command], { cwd });
        }
        return null;
    }

    ipcMain.handle('agent-run-command', async (event, command, isBackground, planId) => {
        const pid = planId || state.currentPlanId;
        const cwd = projectContext.getRoot();

        const verdict = assessCommand(command);
        if (!verdict.allowed) {
            return { error: blockedResult(command, verdict.reason).error };
        }
        logAction({ type: 'shell', summary: String(command).slice(0, 200), detail: cwd });

        if (isBackground) {
            const jobId = nextJobId++;
            const child = spawnShell(command, cwd, true);
            if (!child) {
                return { error: 'Failed to spawn background process' };
            }
            const procInfo = { process: child, log: [], command, exitCode: null, running: true, startedAt: Date.now() };
            activeProcesses.set(jobId, procInfo);

            const appendLog = (data) => {
                const text = data.toString();
                const lines = text.split('\n');
                if (lines[lines.length - 1] === '') lines.pop();
                procInfo.log.push(...lines);
                if (procInfo.log.length > 2000) procInfo.log = procInfo.log.slice(-2000);
            };

            child.stdout.on('data', appendLog);
            child.stderr.on('data', appendLog);
            child.on('close', (code) => {
                procInfo.log.push(`[Process exited with code ${code}]`);
                procInfo.exitCode = code;
                procInfo.running = false;
            });
            // Without this, a spawn failure (e.g. shell missing) is an UNHANDLED 'error'
            // event that can crash the main process. Record it on the job instead.
            child.on('error', (err) => {
                procInfo.log.push(`[Process failed to start: ${err.message}]`);
                procInfo.exitCode = -1;
                procInfo.running = false;
            });

            return { stdout: `Process started in background. Job ID: ${jobId}. Use read_process_log to check status, stop_process to kill it.` };
        }

        return new Promise((resolve) => {
            // Foreground timeout so a command the model forgot to background (e.g. a dev
            // server) fails fast instead of hanging the whole turn. Long builds should use
            // is_background:true.
            // 90s, not 5min: a foreground command that blocks (GUI app, server, watcher)
            // should fail fast instead of freezing the whole turn for minutes. GUI launches
            // and long tasks belong in is_background:true (returns instantly with a job id).
            const FG_TIMEOUT_MS = 90000;
            const onDone = (error, stdout, stderr) => {
                if (error && error.killed) {
                    resolve({ error: `Command timed out after ${FG_TIMEOUT_MS / 1000}s and was killed. To open a GUI app (browser/editor) or run a long task (server/build/watcher), call run_shell_command with is_background:true.`, stdout, stderr });
                } else {
                    resolve({ error: error ? error.message : null, stdout, stderr });
                }
            };
            const execOpts = { cwd, maxBuffer: 1024 * 1024 * 50, timeout: FG_TIMEOUT_MS, killSignal: 'SIGKILL' };
            if (projectContext.isWindows()) {
                exec(`powershell.exe -NoProfile -Command ${JSON.stringify(command)}`, execOpts, onDone);
            } else {
                exec(command, execOpts, onDone);
            }
        });
    });

    ipcMain.handle('agent-stop-process', async (event, jobId) => {
        const procInfo = activeProcesses.get(parseInt(jobId, 10));
        if (!procInfo) return { error: `No active job found with ID: ${jobId}` };
        try {
            procInfo.process.kill('SIGKILL');
            procInfo.running = false;
            return { success: true, stdout: `Job ${jobId} killed.` };
        } catch (e) {
            return { error: e.message };
        }
    });

    ipcMain.handle('agent-list-processes', async () => {
        const jobs = [];
        for (const [jobId, info] of activeProcesses) {
            jobs.push({
                jobId,
                running: info.running !== false && info.exitCode === null,
                exitCode: info.exitCode,
                command: info.command || '',
                lastLine: info.log.length ? info.log[info.log.length - 1] : ''
            });
        }
        return { jobs };
    });

    ipcMain.handle('agent-read-process-log', async (event, jobId, lines = 50) => {
        const procInfo = activeProcesses.get(parseInt(jobId, 10));
        if (!procInfo) return { error: `No active job found with ID: ${jobId}` };
        const logSlice = procInfo.log.slice(-lines).join('\n');
        return {
            log: logSlice || "(No output yet)",
            running: procInfo.running !== false && procInfo.exitCode === null,
            exitCode: procInfo.exitCode
        };
    });

    ipcMain.handle('agent-send-input', async (event, jobId, input) => {
        const procInfo = activeProcesses.get(parseInt(jobId, 10));
        if (!procInfo) return { error: `No active job found with ID: ${jobId}` };
        if (procInfo.process.exitCode !== null) return { error: `Process already exited.` };
        try {
            procInfo.process.stdin.write(input + (input.endsWith('\n') ? '' : '\n'));
            return { success: true };
        } catch (e) {
            return { error: e.message };
        }
    });

    ipcMain.handle('agent-read-file', async (event, filepath, startLine, endLine) => {
        try {
            // Agent Mode manages the whole host: file tools reach outside the project
            // root (matching their "host system" descriptions). Code Mode keeps its own
            // root containment via its separate executor; this only affects agent-* tools.
            const resolved = projectContext.resolvePath(filepath, { allowOutsideRoot: true, allowOutsideBeforeRoot: true });
            if (resolved.error) return { error: resolved.error };
            projectContext.establishFromFilePath(resolved.path);
            let content = await fsPromises.readFile(resolved.path, 'utf-8');
            if (startLine != null || endLine != null) {
                const lines = content.split('\n');
                const start = Math.max(1, parseInt(startLine, 10) || 1) - 1;
                const end = endLine != null ? Math.min(lines.length, parseInt(endLine, 10)) : lines.length;
                content = lines.slice(start, end).join('\n');
                return { content, lineRange: [start + 1, end] };
            }
            return { content };
        } catch (error) {
            return { error: error.message };
        }
    });

    ipcMain.handle('agent-write-file', async (event, filepath, content, planId) => {
        try {
            const pid = planId || state.currentPlanId;
            const sizeCheck = editEngine.validateWriteSize(content);
            if (sizeCheck.error) return sizeCheck;

            const resolved = projectContext.resolvePath(filepath, { allowOutsideRoot: true, allowOutsideBeforeRoot: true });
            if (resolved.error) return { error: resolved.error };

            const absPath = resolved.path;
            const guard = assessPathMutation(absPath, 'write');
            if (!guard.allowed) return blockedPathResult(absPath, guard.reason);
            const existed = fs.existsSync(absPath);
            // Capture prior content (small files only) so the write is undoable via the action log.
            let prevContent = null;
            if (existed && actionLog) {
                try { const st = await fsPromises.stat(absPath); if (st.isFile() && st.size <= actionLog.MAX_UNDO_BYTES) prevContent = await fsPromises.readFile(absPath, 'utf-8'); } catch {}
            }
            if (pid) {
                if (existed) {
                    const snap = await changeLedger.snapshotBefore(pid, absPath, 'write');
                    if (snap && snap.error) return { error: `Refusing to write — could not snapshot the existing file for Revert All: ${snap.error}` };
                } else await changeLedger.recordCreate(pid, absPath);
            }
            await fsPromises.mkdir(path.dirname(absPath), { recursive: true });
            await fsPromises.writeFile(absPath, content, 'utf-8');
            projectContext.establishFromFilePath(absPath);
            invalidateRepoMap(); // the tree/symbols changed — drop the cached repo map
            logAction({ type: existed ? 'write_file' : 'create_file', summary: `${existed ? 'Overwrote' : 'Created'} ${relPathFromRoot(absPath)}`, detail: absPath, undo: actionLog ? actionLog.captureWriteUndo(absPath, existed, prevContent) : null });
            registerDownload(absPath); // agent-produced → servable by /download_remote
            return { success: true, path: relPathFromRoot(absPath), created: !existed };
        } catch (error) {
            return { error: error.message };
        }
    });

    ipcMain.handle('agent-register-download', async (event, filepath) => {
        // Verify + register a file so /download_remote will serve it. Resolves the
        // path exactly like agent-write-file (relative → project root), so links to
        // agent-created files outside the default download roots work — while the
        // registry (not wider roots) keeps the arbitrary-file-read hole closed.
        try {
            const resolved = projectContext.resolvePath(String(filepath || ''), { allowOutsideRoot: true, allowOutsideBeforeRoot: true });
            if (resolved.error) return { error: resolved.error };
            const absPath = resolved.path;
            const st = await fsPromises.stat(absPath).catch(() => null);
            if (!st || !st.isFile()) return { error: `File not found: ${filepath}` };
            if (!downloadRegistry) return { error: 'Download registry unavailable' };
            const r = downloadRegistry.register(absPath);
            if (r.error) return { error: r.error };
            return { success: true, path: r.path, name: path.basename(r.path) };
        } catch (error) {
            return { error: error.message };
        }
    });

    ipcMain.handle('agent-delete-file', async (event, filepath, planId) => {
        try {
            const pid = planId || state.currentPlanId;
            const resolved = projectContext.resolvePath(filepath, { allowOutsideRoot: true, allowOutsideBeforeRoot: true });
            if (resolved.error) return { error: resolved.error };
            const absPath = resolved.path;
            const guard = assessPathMutation(absPath, 'delete');
            if (!guard.allowed) return blockedPathResult(absPath, guard.reason);
            const stats = await fsPromises.stat(absPath);
            if (pid && stats.isFile()) {
                const snap = await changeLedger.snapshotBefore(pid, absPath, 'delete');
                if (snap && snap.error) return { error: `Refusing to delete — could not snapshot the existing file for Revert All: ${snap.error}` };
            }
            // Capture content (small files) so a delete is undoable via the action log.
            let undo = null;
            if (stats.isDirectory()) {
                undo = { op: 'delete', path: absPath, isDir: true };
                await fsPromises.rm(absPath, { recursive: true, force: true });
            } else {
                if (actionLog && stats.size <= actionLog.MAX_UNDO_BYTES) {
                    try { undo = { op: 'delete', path: absPath, isDir: false, content: await fsPromises.readFile(absPath, 'utf-8') }; } catch {}
                }
                await fsPromises.unlink(absPath);
            }
            invalidateRepoMap();
            logAction({ type: 'delete_file', summary: `Deleted ${relPathFromRoot(absPath)}`, detail: absPath, undo });
            return { success: true };
        } catch (error) {
            return { error: error.message };
        }
    });

    ipcMain.handle('agent-list-directory', async (event, dirpath) => {
        try {
            const target = dirpath || '.';
            const resolved = projectContext.resolvePath(target, { allowOutsideRoot: true, allowOutsideBeforeRoot: true });
            if (resolved.error) return { error: resolved.error };
            const files = await fsPromises.readdir(resolved.path, { withFileTypes: true });
            const list = files.map(f => `${f.isDirectory() ? '[DIR] ' : '[FILE]'} ${f.name}`);
            // Return an ARRAY (like agent-glob/agent-grep) — the renderer's list_directory
            // dispatcher does `(res.files || []).join('\n')`, which throws on a pre-joined
            // string ("res.files.join is not a function"), killing the tool in Agent Mode.
            return { files: list };
        } catch (error) {
            return { error: error.message };
        }
    });

    ipcMain.handle('agent-list-project', async () => {
        try {
            const listing = await projectContext.listProjectTree(2);
            return { listing, projectRoot: projectContext.getRoot() };
        } catch (e) {
            return { error: e.message };
        }
    });

    ipcMain.handle('agent-fetch-url', async (event, url) => {
        const u = netGuard.validatePublicFetchTarget(url);
        if (!u) return { error: 'URL rejected (must be http(s) to a non-internal host).' };
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 20000);
            const resp = await fetch(u.toString(), { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'AgentSmith/1.0' } });
            clearTimeout(t);
            if (!resp.ok) return { error: `HTTP ${resp.status}`, status: resp.status };
            const ctype = resp.headers.get('content-type') || '';
            let body = await resp.text();
            if (/html/i.test(ctype) || /^\s*</.test(body)) {
                body = body
                    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                    .replace(/[ \t]+/g, ' ')
                    .replace(/\n\s*\n\s*\n+/g, '\n\n')
                    .trim();
            }
            const MAX = 8000;
            const truncated = body.length > MAX;
            return { content: truncated ? body.slice(0, MAX) + '\n...[truncated — fetch a more specific URL for the rest]' : body, url: u.toString(), status: resp.status, truncated };
        } catch (e) {
            return { error: (e && e.name === 'AbortError') ? 'Fetch timed out (20s).' : (e.message || String(e)) };
        }
    });

    ipcMain.handle('agent-grep', async (event, { pattern, path: subpath, glob, case_insensitive }) => {
        try {
            const root = projectContext.getRoot();
            return await grepProject(root, pattern, { subpath, glob, caseInsensitive: case_insensitive });
        } catch (e) {
            return { error: e.message, hits: [] };
        }
    });

    ipcMain.handle('agent-glob', async (event, { pattern, path: subpath }) => {
        try {
            const root = projectContext.getRoot();
            return await globFiles(root, pattern || '**/*', { subpath });
        } catch (e) {
            return { error: e.message, files: [] };
        }
    });

    ipcMain.handle('agent-get-repo-map', async (event, { boostTerms, maxTokens }) => {
        try {
            const root = projectContext.getRoot();
            const map = buildRepoMap(root, { boostTerms: boostTerms || [], maxTokens: maxTokens || 1500 });
            return { map, projectRoot: root };
        } catch (e) {
            return { error: e.message, map: '' };
        }
    });

    ipcMain.handle('agent-verify', async (event, sessionId, opts = {}) => {
        const pid = sessionId || state.currentPlanId;
        const root = projectContext.getRoot();
        const plan = {
            projectRoot: root,
            verifyPolicy: 'block',
            testCmd: opts.testCmd || null,
            lintCmd: opts.lintCmd || null,
            filesLedger: opts.filesLedger || {},
            steps: [{ id: 1, verifiedAt: null }]
        };
        const result = await verificationHarness.runVerification(root, plan, opts || {});
        return { ...result, sessionId: pid };
    });

    ipcMain.handle('agent-doctor', async () => ({
        hasRipgrep: hasRipgrep(),
        projectRoot: projectContext.getRootOrNull(),
        planId: state.currentPlanId
    }));
};
