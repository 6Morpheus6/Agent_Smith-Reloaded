/**
 * IPC domain: Code Mode — run/stop/status + event streaming + resume.
 */
'use strict';

const os = require('os');
const { runCodeTask } = require('../../code/loop/runCodeTask.js');
const { executeTool } = require('../../code/tools/executor.js');
const { CodeSession } = require('../../code/session/state.js');
const { createPlan, markApproved } = require('../../code/plan/codePlan.js');

module.exports = function registerCodeIpc(ipcMain, deps) {
    const {
        spawn, projectContext, editEngine, changeLedger,
        grepProject, globFiles, relPathFromRoot, userDataPath,
        getLmsUrl, getMainWindow, pushEvent, pluginManager, memoryManager,
        previewRunner, actionLog, downloadRegistry, invalidateRepoMap
    } = deps;

    // Cross-session vector memory adapter for Code Mode (best-effort; degrades silently
    // when embeddings/Ollama are unavailable).
    const memory = memoryManager ? {
        recall: async (q) => {
            try {
                const r = await memoryManager.queryVectors(q, 3);
                return (r && r.success && Array.isArray(r.data)) ? r.data.map(d => d.text) : [];
            } catch (e) { return []; }
        },
        remember: async (text, meta) => {
            try { await memoryManager.storeVector(text, meta || {}); } catch (e) { /* ignore */ }
        }
    } : null;

    let activeRun = null;
    const bgProcesses = new Map();
    let nextJobId = 1;

    // v53.4 — fresh-start sweep: close Code sessions left open by a PREVIOUS app process
    // so they never resurface as "Resume" candidates (see CodeSession.sweepStale).
    try { CodeSession.sweepStale(userDataPath); } catch (e) { /* non-fatal */ }

    function spawnShell(command, cwd) {
        const cfg = projectContext.getShellConfig();
        if (projectContext.isWindows()) {
            return spawn(cfg.shell, [cfg.flag, cfg.commandFlag, command], { cwd, shell: false });
        }
        return spawn(cfg.shell, [cfg.flag, command], { cwd });
    }

    function buildExecDeps(sessionId) {
        const fireHook = async (event, payload) => {
            if (!pluginManager?.fireHook) return null;
            try {
                return await pluginManager.fireHook(event, payload);
            } catch (e) {
                return { error: e.message };
            }
        };

        const invokePluginTool = async (name, args) => {
            if (!pluginManager?.isPluginTool || !pluginManager.isPluginTool(name)) {
                return { __notFound: true };
            }
            // Bound the call so a misbehaving plugin tool can't hang the run forever.
            const TIMEOUT_MS = 120000;
            let timer;
            const timeout = new Promise((resolve) => {
                timer = setTimeout(
                    () => resolve({ error: `Plugin tool "${name}" timed out after ${TIMEOUT_MS}ms` }),
                    TIMEOUT_MS
                );
                // v53.2 — do NOT unref: plugin code is third-party; if invokeTool returns a
                // promise with no live handles, an unref'd timer would never fire in isolated
                // contexts and the 120s bound (the whole point of this race) would vanish.
            });
            try {
                return await Promise.race([pluginManager.invokeTool(name, args), timeout]);
            } finally {
                clearTimeout(timer);
            }
        };

        return {
            sessionId,
            projectContext,
            editEngine,
            changeLedger,
            grepProject,
            globFiles,
            relPathFromRoot,
            fireHook,
            invokePluginTool,
            showPreview: previewRunner
                ? (args) => previewRunner.show(args)
                : null,
            browserVerify: deps.browserVerify
                ? (args) => deps.browserVerify.run(args)
                : null,
            // Real-browser runtime verification of built web apps (completion gate uses this to
            // surface uncaught exceptions / module errors instead of passing a non-running app).
            runtimeVerify: (projectRoot, htmlRel) =>
                require('../services/runtimeBrowserCheck.js').runtimeVerify(projectRoot, htmlRel),
            // v52.6 (dsh defensive pattern "report orthogonal outcomes independently"):
            // a process can time out AND exit 0 because it trapped the signal — surface each
            // independent fact (`exit_code`, `timed_out`, `signal`) on its own instead of
            // nesting one flag's report inside another's branch. The legacy `error` string is
            // kept so the loop's ok-check and TEST-BEFORE-DONE tracking keep working, but it
            // now names WHICH fact failed (exit code N / timed out / run stopped).
            runForegroundCommand: (command, cwd) => new Promise((resolve) => {
                const FG_TIMEOUT_MS = 300000;
                const cfg = projectContext.getShellConfig();
                // Bind to the active run's abort signal so stopping the run also kills an
                // in-flight command instead of waiting out its timeout.
                const signal = activeRun?.controller?.signal;
                let child;
                try {
                    child = projectContext.isWindows()
                        ? spawn(cfg.shell, [cfg.flag, cfg.commandFlag, command], { cwd })
                        : spawn(cfg.shell, [cfg.flag, command], { cwd });
                } catch (e) {
                    resolve({ error: `Could not run command: ${e.message}` });
                    return;
                }
                let stdout = '';
                let stderr = '';
                let timedOut = false;
                const timer = setTimeout(() => {
                    timedOut = true;
                    try { child.kill('SIGTERM'); } catch (_) {}
                }, FG_TIMEOUT_MS);
                if (timer && typeof timer.unref === 'function') timer.unref();
                const onAbort = () => { try { child.kill('SIGTERM'); } catch (_) {} };
                if (signal && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true });
                child.stdout?.on('data', d => { stdout += String(d); });
                child.stderr?.on('data', d => { stderr += String(d); });
                const cleanup = () => {
                    clearTimeout(timer);
                    if (signal && !signal.aborted) signal.removeEventListener('abort', onAbort);
                };
                child.on('error', (e) => { cleanup(); resolve({ error: `Could not run command: ${e.message}` }); });
                child.on('close', (code, sig) => {
                    cleanup();
                    const out = { stdout: stdout || '', stderr: stderr || '', exit_code: code };
                    if (timedOut) out.timed_out = true;
                    if (sig) out.signal = sig;
                    if (signal && signal.aborted) out.aborted = true;
                    if (code !== 0 || timedOut || (signal && signal.aborted)) {
                        const parts = [];
                        if (timedOut) parts.push(`timed out after ${Math.round(FG_TIMEOUT_MS / 1000)}s`);
                        else if (signal && signal.aborted) parts.push('run stopped');
                        else parts.push(`exit code ${code}`);
                        out.error = `Command failed (${parts.join(', ')}): ${command}`;
                    }
                    resolve(out);
                });
            }),
            runBackgroundCommand: (command, cwd) => {
                const jobId = nextJobId++;
                const child = spawnShell(command, cwd);
                const procInfo = { log: [], running: true, child };
                bgProcesses.set(jobId, procInfo);
                const append = (data) => {
                    procInfo.log.push(...data.toString().split('\n').filter(Boolean));
                    if (procInfo.log.length > 500) procInfo.log = procInfo.log.slice(-500);
                };
                child.stdout?.on('data', append);
                child.stderr?.on('data', append);
                child.on('close', (code) => {
                    procInfo.log.push(`[exit ${code}]`);
                    procInfo.running = false;
                });
                return { stdout: `Background job ${jobId} started`, jobId };
            },
            // v50: host-control process tools share this run's background-job registry.
            jobApi: {
                listJobs() {
                    const jobs = [];
                    for (const [id, info] of bgProcesses) {
                        jobs.push({
                            job_id: String(id),
                            running: info.running !== false && info.child?.exitCode === null,
                            exit_code: info.child ? info.child.exitCode : null,
                            last_line: info.log.length ? info.log[info.log.length - 1] : ''
                        });
                    }
                    return jobs;
                },
                readLog(jobId, lines = 50) {
                    const info = bgProcesses.get(parseInt(jobId, 10));
                    if (!info) return null;
                    const n = Math.min(Math.max(1, parseInt(lines, 10) || 50), 200);
                    return {
                        job_id: String(jobId),
                        log: info.log.slice(-n).join('\n') || '(No output yet)',
                        running: info.running !== false && info.child?.exitCode === null,
                        exit_code: info.child ? info.child.exitCode : null
                    };
                },
                sendInput(jobId, input) {
                    const info = bgProcesses.get(parseInt(jobId, 10));
                    if (!info) return { error: `No active job found with ID: ${jobId}` };
                    if (info.child.exitCode !== null) return { error: 'Process already exited.' };
                    try {
                        info.child.stdin.write(String(input) + '\n');
                        return { success: true };
                    } catch (e) {
                        return { error: e.message };
                    }
                },
                kill(jobId) {
                    const info = bgProcesses.get(parseInt(jobId, 10));
                    if (!info) return { error: `No active job found with ID: ${jobId}` };
                    try {
                        info.child.kill('SIGKILL');
                        info.running = false;
                        return { success: true, stdout: `Job ${jobId} killed.` };
                    } catch (e) {
                        return { error: e.message };
                    }
                }
            },
            // v50 host-control audit + memory deps (all optional — degrade gracefully).
            actionLog,
            registerDownload: downloadRegistry ? (absPath) => { try { downloadRegistry.register(absPath); } catch (e) {} } : null,
            invalidateRepoMap: typeof invalidateRepoMap === 'function' ? () => { try { invalidateRepoMap(); } catch (e) {} } : null,
            recallMemory: memory && typeof memory.recall === 'function' ? (q) => memory.recall(q) : null,
            rememberMemory: memory && typeof memory.remember === 'function' ? (text, meta) => memory.remember(text, meta) : null
        };
    }

    function emit(event) {
        if (pushEvent) {
            pushEvent('code-event', event);
        } else {
            const win = getMainWindow?.();
            if (win && !win.isDestroyed()) {
                win.webContents.send('code-event', event);
            }
        }
    }

    function getPluginToolSchemas() {
        if (!pluginManager?.getEnabledToolSchemas) return [];
        try {
            return pluginManager.getEnabledToolSchemas();
        } catch (e) {
            return [];
        }
    }

    function isRunBlocking() {
        return activeRun && activeRun.status === 'running';
    }

    async function startCodeTask(opts, resumeSession) {
        // v53.1 — RE-CHECK the guard here, not only in each handler: code-resume and
        // code-plan-approve AWAIT (session load / hooks / save) between their isRunBlocking()
        // check and this call, so two invokes inside that window (double-tap on "Resume", or
        // desktop + phone at once) both pass the outer guard and would start TWO concurrent
        // runs of the same task. By the time a second caller reaches here, the first has
        // already set activeRun synchronously below — this check is what closes the race.
        if (isRunBlocking()) {
            return { error: 'A code run is already active. Stop it first.' };
        }
        const controller = new AbortController();
        activeRun = { status: 'running', controller, sessionId: resumeSession?.id || null };
        const pluginToolSchemas = getPluginToolSchemas();

        // v50 unified harness: a run works with or without a selected project folder.
        // Explicit root (user picked a workspace) > last persisted session's root > HOME.
        // With HOME as the default workspace the host tools are the primary surface and
        // the "Here I am" / file-picker establishes a real project root when one exists.
        const runRoot = opts.projectRoot || resumeSession?.projectRoot
            || (typeof os.homedir === 'function' ? os.homedir() : process.cwd());
        // Pin the containment boundary to THIS run's project root so the path clamp and the
        // run_command policy enforce it (otherwise they'd fall back to process.cwd()). The
        // isolated-worktree path re-points this to the worktree inside runCodeTask.
        if (runRoot) { try { projectContext.setRoot(runRoot); } catch (e) { /* non-fatal */ } }

        const base = {
            projectRoot: runRoot,
            model: opts.model || resumeSession?.model,
            numCtx: opts.numCtx || resumeSession?.numCtx || 8192,
            apiBaseUrl: opts.apiBaseUrl || getLmsUrl?.() || 'http://127.0.0.1:1234',
            // Hosted-provider key (Kimi K3 etc.). Passed per-run from the renderer;
            // never persisted into the CodeSession on disk.
            apiKey: opts.apiKey || null,
            userDataPath,
            projectContext,
            buildExecDeps,
            emit: (ev) => {
                if (ev.sessionId) activeRun.sessionId = ev.sessionId;
                emit(ev);
            },
            signal: controller.signal,
            // v52.7: pass through as-is — the renderer sends -1 for "infinite turns" (JSON can't
            // carry Infinity); EarlyStopDetector.normalizeMaxTurns maps 0/-1/null/undefined → ∞.
            maxTurns: opts.maxTurns,
            codeTemperature: opts.codeTemperature ?? 0.2,
            forcePlan: opts.forcePlan,
            requirePlanApproval: opts.requirePlanApproval,
            continueAfterApproval: opts.continueAfterApproval,
            grindMode: opts.grindMode !== false,
            pluginToolSchemas,
            memory,
            pluginManager
        };

        if (resumeSession) {
            base.resumeSession = resumeSession;
            base.sessionId = resumeSession.id;
        } else {
            base.prompt = opts.prompt;
        }

        return runCodeTask(base).then((session) => {
            activeRun = { status: session.status, sessionId: session.id, session };
            return {
                success: true,
                sessionId: session.id,
                status: session.status,
                awaitingApproval: session.status === 'awaiting_approval'
            };
        }).catch((e) => {
            activeRun = { status: 'error', error: e.message };
            return { error: e.message };
        });
    }

    ipcMain.handle('code-run', async (_event, opts) => {
        if (isRunBlocking()) {
            return { error: 'A code run is already active. Stop it first.' };
        }

        const prompt = opts?.prompt;
        // v50: only forward an implicit root if one was actually established (user picked a
        // folder this session). Otherwise leave it null so startCodeTask defaults to HOME.
        const projectRoot = opts?.projectRoot || (projectContext.getRootOrNull() ? projectContext.getRoot() : null);
        const model = opts?.model;
        const numCtx = opts?.numCtx || 8192;
        const apiBaseUrl = opts?.apiBaseUrl || getLmsUrl?.() || 'http://127.0.0.1:1234';

        if (!prompt) return { error: 'prompt is required' };
        if (!model) return { error: 'model is required' };

        return startCodeTask({
            prompt,
            projectRoot,
            model,
            numCtx,
            apiBaseUrl,
            apiKey: opts?.apiKey || null,
            maxTurns: opts?.maxTurns,
            codeTemperature: opts?.codeTemperature,
            forcePlan: opts?.forcePlan,
            requirePlanApproval: !!opts?.requirePlanApproval,
            grindMode: opts?.grindMode !== false,
            isolatedRun: !!opts?.isolatedRun,
            parallelMilestones: !!opts?.parallelMilestones,
            milestoneWorktrees: !!opts?.milestoneWorktrees,
            milestoneConcurrent: !!opts?.milestoneConcurrent
        });
    });

    ipcMain.handle('code-readiness', async (_event, opts) => {
        const root = opts?.projectRoot || projectContext.getRoot();
        if (!root) return { error: 'No project root set' };
        const { scoreReadiness } = require('../../code/governor/readiness.js');
        return scoreReadiness(root);
    });

    ipcMain.handle('code-resume', async (_event, opts) => {
        if (isRunBlocking()) {
            return { error: 'A code run is already active. Stop it first.' };
        }
        const sessionId = opts?.sessionId;
        if (!sessionId) return { error: 'sessionId is required' };

        const session = await CodeSession.load(userDataPath, sessionId);
        if (!session) return { error: 'Session not found' };

        // v53.1 — a finished/failed run is NOT resumable. The renderer's resume banner can
        // race the terminal save (or show a stale entry), and on mobile a single tap then
        // re-runs a task that already completed ("tasks loop/repeat after completion").
        // Refuse here so no client — desktop or phone — can restart a terminal session.
        const TERMINAL_STATUSES = new Set(['done', 'incomplete', 'unverified', 'error', 'aborted']);
        if (TERMINAL_STATUSES.has(session.status)) {
            return { error: `Session already finished (${session.status}) — start a new run instead of resuming.` };
        }

        const model = opts?.model || session.model;
        const numCtx = opts?.numCtx || session.numCtx;
        const apiBaseUrl = opts?.apiBaseUrl || getLmsUrl?.() || 'http://127.0.0.1:1234';

        return startCodeTask({
            model,
            numCtx,
            apiBaseUrl,
            apiKey: opts?.apiKey || null,
            requirePlanApproval: false,
            continueAfterApproval: session.status === 'awaiting_approval' && !!opts?.continueAfterApproval
        }, session);
    });

    ipcMain.handle('code-plan-approve', async (_event, opts) => {
        if (isRunBlocking()) {
            return { error: 'A code run is already active. Stop it first.' };
        }
        const sessionId = opts?.sessionId;
        if (!sessionId) return { error: 'sessionId is required' };

        const session = await CodeSession.load(userDataPath, sessionId);
        if (!session) return { error: 'Session not found' };
        if (session.status !== 'awaiting_approval') {
            return { error: 'Session is not awaiting plan approval' };
        }

        if (Array.isArray(opts?.steps) && opts.steps.length) {
            session.codePlan = createPlan(session.goal, opts.steps);
        }
        markApproved(session.codePlan);
        if (pluginManager?.fireHook) {
            await pluginManager.fireHook('onPlanApproved', {
                sessionId: session.id,
                goal: session.goal,
                codePlan: session.codePlan
            });
        }
        await CodeSession.save(userDataPath, session);

        return startCodeTask({
            model: opts?.model || session.model,
            numCtx: opts?.numCtx || session.numCtx,
            apiBaseUrl: opts?.apiBaseUrl || getLmsUrl?.() || 'http://127.0.0.1:1234',
            apiKey: opts?.apiKey || null,
            requirePlanApproval: false,
            continueAfterApproval: true,
            grindMode: opts?.grindMode !== false
        }, session);
    });

    ipcMain.handle('code-plan-reject', async (_event, opts) => {
        const sessionId = opts?.sessionId;
        if (!sessionId) return { error: 'sessionId is required' };

        const session = await CodeSession.load(userDataPath, sessionId);
        if (!session) return { error: 'Session not found' };

        session.status = 'aborted';
        session.finishedAt = Date.now();
        session.error = 'Plan rejected by user';
        await CodeSession.save(userDataPath, session);

        if (activeRun?.sessionId === sessionId) {
            activeRun = { status: 'aborted', sessionId };
        }

        emit({ type: 'plan_rejected', sessionId, goal: session.goal });
        return { success: true, sessionId };
    });

    ipcMain.handle('code-list-sessions', async (_event, opts) => {
        const projectRoot = opts?.projectRoot || projectContext.getRoot();
        let list = await CodeSession.listIncomplete(userDataPath, projectRoot);
        // v53.1: a session this process is actively running is LIVE, not resumable — the
        // renderer's "Resume Code run?" banner must never offer it (tapping would just hit
        // "A code run is already active"). This also covers the window between `done` and
        // the terminal save on other clients.
        const liveId = activeRun && activeRun.status === 'running' ? activeRun.sessionId : null;
        if (liveId) list = list.filter(s => s.id !== liveId);
        return { sessions: list };
    });

    ipcMain.handle('code-stop', async () => {
        if (!activeRun || activeRun.status !== 'running') {
            return { success: false, message: 'No active run' };
        }
        activeRun.controller?.abort();
        activeRun.status = 'aborted';
        // Kill any background commands the run spawned so they don't outlive the run (leak /
        // persistence). A naturally-completed run keeps them (e.g. a preview dev server).
        for (const info of bgProcesses.values()) {
            if (info.running && info.child) {
                try { info.child.kill('SIGTERM'); } catch (e) { /* already gone */ }
                info.running = false;
            }
        }
        emit({ type: 'error', message: 'Run stopped by user' });
        return { success: true };
    });

    ipcMain.handle('code-get-status', async () => {
        if (!activeRun) return { status: 'idle' };
        return {
            status: activeRun.status,
            sessionId: activeRun.sessionId || null
        };
    });

    ipcMain.handle('code-ledger-diff', async (_event, sessionId) => {
        const id = sessionId || activeRun?.sessionId;
        if (!id) return { error: 'No session id' };
        return changeLedger.diff(id);
    });
};
