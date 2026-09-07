/**
 * Code Mode outer orchestrator — bootstrap, optional plan approval, turn loop, persist.
 */
'use strict';

const crypto = require('crypto');
const { CodeSession } = require('../session/state.js');
const { PlanAnchor } = require('../context/planAnchor.js');
const { PlanArtifacts } = require('../context/planArtifacts.js');
const { buildBootstrapBlock } = require('../context/bootstrap.js');
const { detectProjectCommands } = require('../../shared/verificationHarness.js');
const { EarlyStopDetector } = require('../governor/earlyStop.js');
const { QualityMonitor } = require('../governor/qualityMonitor.js');
const { resolveInitialPhase, isGreenfieldWorkspace } = require('../loop/phases.js');
const { runTurnLoop } = require('./turnLoop.js');
const { createRunWatchdog } = require('./runWatchdog.js');
const { runPlanningPhase } = require('./planningPhase.js');
const { CodeRunTrace } = require('./codeTrace.js');
const { markApproved, isExploreStep } = require('../plan/codePlan.js');
const { goalImpliesNewArtifacts } = require('../context/artifactHints.js');
const { detectPartialDeliverableState } = require('../context/partialBuild.js');
const { snapshotExistingFiles } = require('../context/fileScan.js');
const { createRunWorktree, cleanupWorktree } = require('../../main/services/worktreeManager.js');
const {
    shouldUseSubagents,
    runMilestoneSubagentOrchestrator
} = require('./milestoneSubagents.js');

function newSessionId() {
    return `code_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

async function executeTurnLoop(opts) {
    const {
        session, planAnchor, planArtifacts, earlyStop, qualityMonitor, trace,
        userDataPath, buildExecDeps, execDeps: execDepsIn, emit, signal, pluginToolSchemas, pluginToolNames,
        streamCompletion, memory
    } = opts;

    const sessionId = session.id;
    const execDeps = typeof buildExecDeps === 'function'
        ? buildExecDeps(sessionId)
        : Object.assign({}, execDepsIn || {}, { sessionId });

    // Watchdog: emit liveness heartbeats and turn an async stall (silent model, an
    // unbounded await) into a clean abort + error instead of an invisible freeze.
    // Cannot interrupt synchronous blocks — those are bounded at their source.
    const watchdogAbort = new AbortController();
    let stallReason = null;
    const watchdog = createRunWatchdog({
        emit,
        meta: () => ({ sessionId, run_id: session.runId || sessionId, phase: session.phase, turn: session.turn }),
        heartbeatMs: Number(process.env.XK_CODE_HEARTBEAT_MS) || 20000,
        inactivityMs: Number(process.env.XK_CODE_INACTIVITY_MS) || 1200000,
        // v52.7: NO wall-clock cap by default (0 = unlimited). Turns are infinite and an active
        // build must not be killed after N hours; the 20-min inactivity guard above is what
        // detects a genuinely stuck run. Set XK_CODE_MAX_RUNTIME_MS to re-enable a ceiling.
        maxRuntimeMs: Number(process.env.XK_CODE_MAX_RUNTIME_MS) || 0,
        onStall: (reason) => { stallReason = reason; watchdogAbort.abort(); }
    });
    const onParentAbort = () => watchdogAbort.abort();
    if (signal) {
        if (signal.aborted) watchdogAbort.abort();
        else signal.addEventListener('abort', onParentAbort, { once: true });
    }

    const wrapEmit = (ev) => {
        watchdog.touch(); // any real run event = progress
        ev.run_id = session.runId || sessionId;
        ev.sessionId = sessionId;
        emit(ev);
    };

    let finalSummary = '';
    watchdog.start();
    // v53.1 — PERSIST-BEFORE-NOTIFY: the renderer's `done` handler immediately queries
    // code-list-sessions to decide whether to show "Resume Code run?". If the terminal
    // status is only saved AFTER the event (old order: emit done → memory.remember LLM
    // call → trace export → save), a phone client whose SSE round-trip lands before that
    // save still sees 'running' and offers Resume for a session that just finished —
    // tapping it re-runs the whole task ("tasks loop/repeat after completion"). Saving
    // first makes the on-disk state the source of truth by the time anyone can ask.
    const persistTerminal = async () => {
        try { await CodeSession.save(userDataPath, session); } catch (e) { /* non-fatal — final save below retries */ }
    };
    try {
        await runTurnLoop({
            session,
            apiBaseUrl: opts.apiBaseUrl,
            apiKey: opts.apiKey || null,
            tools: null,
            userPrompt: session.goal,
            emit: wrapEmit,
            signal: watchdogAbort.signal,
            execDeps,
            planAnchor,
            planArtifacts,
            qualityMonitor,
            earlyStop,
            trace,
            userDataPath,
            onCheckpoint: () => {
                session.planAnchorState = planAnchor.serialize();
                session.planArtifactsState = planArtifacts.serialize();
                CodeSession.saveDebounced(userDataPath, session);
            },
            pluginToolNames: pluginToolNames || session.pluginToolNames,
            pluginToolSchemas: pluginToolSchemas || [],
            streamCompletion
        });

        if (session.status === 'running') session.status = 'unverified';
        session.finishedAt = Date.now();
        if (session.isolatedRun && session.worktreePath && opts.projectRoot) {
            try { cleanupWorktree(session.parentProjectRoot || opts.projectRoot, sessionId); } catch (e) { /* non-fatal */ }
        }
        if (opts.pluginManager?.fireHook) {
            try {
                await opts.pluginManager.fireHook('sessionStop', {
                    sessionId: session.id,
                    status: session.status,
                    goal: session.goal
                });
            } catch (e) { /* non-fatal */ }
        }
        if (session.codePlan && opts.pluginManager?.fireHook) {
            try {
                await opts.pluginManager.fireHook('onPlanDone', {
                    sessionId: session.id,
                    goal: session.goal,
                    status: session.status,
                    codePlan: session.codePlan
                });
            } catch (e) { /* non-fatal */ }
        }
        // v53.1: persist the terminal status BEFORE announcing completion (see
        // persistTerminal above) — a client that lists sessions on `done` must never see
        // 'running' for a finished session.
        await persistTerminal();
        wrapEmit({
            type: 'done',
            sessionId,
            turn: session.turn,
            toolCount: session.toolCount,
            status: session.status
        });
    } catch (e) {
        if (stallReason) {
            session.status = 'error';
            session.error = stallReason;
            await persistTerminal();
            wrapEmit({ type: 'error', code: 'WATCHDOG_STALL', message: `Code Mode ${stallReason}` });
        } else if (/aborted/i.test(e.message)) {
            session.status = 'aborted';
            await persistTerminal();
            wrapEmit({ type: 'error', message: 'Run aborted' });
        } else {
            session.status = 'error';
            session.error = e.message;
            await persistTerminal();
            wrapEmit({ type: 'error', message: e.message });
        }
    } finally {
        watchdog.stop();
        if (signal) { try { signal.removeEventListener('abort', onParentAbort); } catch (_) { /* non-fatal */ } }
    }

    session.planAnchorState = planAnchor.serialize();
    session.planArtifactsState = planArtifacts.serialize();

    if (memory && typeof memory.remember === 'function' && (session.filesTouched || []).length) {
        try {
            await memory.remember(
                `Code task: "${session.goal}" → ${session.status}. Files: ${session.filesTouched.join(', ')}.`,
                { kind: 'code-run', status: session.status, project: session.projectRoot }
            );
        } catch (e) { /* best-effort */ }
    }

    try {
        trace.exportToUserData(userDataPath, session.goal, session.finalSummary || finalSummary);
    } catch (e) { /* non-fatal */ }

    await CodeSession.save(userDataPath, session);
    return session;
}

async function runCodeTask(opts) {
    const {
        prompt, projectRoot, model, numCtx, apiBaseUrl, apiKey,
        userDataPath, projectContext, buildExecDeps, emit, signal
    } = opts;

    const sessionId = opts.sessionId || newSessionId();
    let session;
    let planAnchor;
    let planArtifacts;
    let earlyStop;
    let qualityMonitor;
    let trace;

    const wrapEmit = (ev) => {
        ev.run_id = session?.runId || sessionId;
        ev.sessionId = sessionId;
        emit(ev);
    };

    if (opts.resumeSession) {
        session = opts.resumeSession;
        // Re-resolve the context window on resume: the persisted numCtx may be stale (the model
        // could be loaded at a different size now), and requesting more than is loaded would make
        // the harness over-pack and the backend silently truncate the prompt.
        try {
            const { resolveCodeNumCtx } = require('./contextWindow.js');
            const ctxResolved = await resolveCodeNumCtx(session.numCtx, apiBaseUrl, session.model || model);
            session.numCtx = ctxResolved.numCtx;
        } catch (e) { /* keep persisted numCtx */ }
        planArtifacts = await PlanArtifacts.load(projectRoot, session.goal);
        if (session.planArtifactsState) planArtifacts.restore(session.planArtifactsState);
        planAnchor = new PlanAnchor(session.goal, planArtifacts);
        if (session.planAnchorState) planAnchor.restore(session.planAnchorState);
        // Seed the turn counter from the persisted value so the max-turns budget is durable.
        // v52.7: no app-level cap — undefined/0/-1 all mean infinite (normalizeMaxTurns).
        earlyStop = new EarlyStopDetector({ maxTurns: opts.maxTurns, initialTurn: session.turn || 0 });
        qualityMonitor = new QualityMonitor();
        trace = new CodeRunTrace(session.runId || sessionId);
        trace.inputReceived('resume');
        // v52.5 — the run-start snapshot is not persisted; rebuild it at resume time so files
        // that exist on disk but were NOT written by this session (another project, another
        // user) are still excluded from plan-step evidence. Files THIS session wrote before
        // the interruption remain valid evidence via the persisted filesTouched list.
        if (!session._preExistingFiles) {
            try { session._preExistingFiles = snapshotExistingFiles(session.projectRoot); } catch (e) { /* non-fatal */ }
        }

        if (opts.continueAfterApproval) {
            markApproved(session.codePlan);
            if (session.codePlan?.steps?.length && goalImpliesNewArtifacts(session.goal)) {
                const idx = session.codePlan.currentStepIndex ?? 0;
                const cur = session.codePlan.steps[idx];
                if (cur && isExploreStep(cur.title)) {
                    cur.title = 'Create required files (HTML, CSS, JS)';
                }
            }
            if (opts.pluginManager?.fireHook) {
                try {
                    await opts.pluginManager.fireHook('onPlanApproved', {
                        sessionId: session.id,
                        goal: session.goal,
                        codePlan: session.codePlan
                    });
                } catch (e) { /* non-fatal */ }
            }
            session.status = 'running';
            session.workflow = 'executing';
            wrapEmit({ type: 'plan_approved', sessionId: session.id, codePlan: session.codePlan });
        } else if (session.status === 'awaiting_approval') {
            session.workflow = 'awaiting_approval';
        } else {
            session.status = 'running';
        }
    } else {
        // Code Mode needs room to hold a multi-file app in context. Raise to the model's loaded
        // window (floored/capped), never above what the backend actually has loaded.
        const { resolveCodeNumCtx } = require('./contextWindow.js');
        const ctxResolved = await resolveCodeNumCtx(numCtx, apiBaseUrl, model);
        if (ctxResolved.numCtx !== (Number(numCtx) || 8192)) {
            wrapEmit({
                type: 'model_advisory',
                message: `Code Mode context raised to ${ctxResolved.numCtx} tokens`
                    + (ctxResolved.loadedContext ? ` (model loaded at ${ctxResolved.loadedContext})` : '')
            });
        }
        session = new CodeSession(sessionId, {
            goal: prompt,
            projectRoot,
            model,
            numCtx: ctxResolved.numCtx,
            codeTemperature: opts.codeTemperature ?? 0.2
        });
        session.status = 'running';
        session.runId = sessionId;

        planArtifacts = await PlanArtifacts.ensure(projectRoot, prompt, {
            forcePlan: opts.forcePlan
        });
        planAnchor = new PlanAnchor(prompt, planArtifacts);
        // v52.7: no app-level cap — undefined/0/-1 all mean infinite (normalizeMaxTurns).
        earlyStop = new EarlyStopDetector({ maxTurns: opts.maxTurns });
        qualityMonitor = new QualityMonitor();

        session.isolatedRun = !!opts.isolatedRun;
        session.parallelMilestones = !!opts.parallelMilestones;
        session.milestoneWorktrees = !!opts.milestoneWorktrees;
        session.milestoneConcurrent = !!opts.milestoneConcurrent;

        const skipRunIsolation = session.milestoneWorktrees && session.parallelMilestones;
        if (session.isolatedRun && !skipRunIsolation) {
            const wt = createRunWorktree(projectRoot, sessionId);
            if (wt.error) {
                // v53.1: persist BEFORE the error event — same race as the main path; a client
                // listing sessions on `error` must see 'error', not 'running'.
                session.status = 'error';
                session.error = wt.error;
                await CodeSession.save(userDataPath, session);
                wrapEmit({ type: 'error', message: wt.error });
                return session;
            }
            session.worktreePath = wt.path;
            session.parentProjectRoot = projectRoot;
            session.projectRoot = wt.path;
            projectContext.setRoot(wt.path);
            wrapEmit({ type: 'worktree_created', path: wt.path, branch: wt.branch });
        }

        let treeSummary = '';
        try {
            const tree = await projectContext.listProjectTree();
            treeSummary = typeof tree === 'string' ? tree : JSON.stringify(tree).slice(0, 1500);
        } catch (e) { /* non-fatal */ }

        session.phase = resolveInitialPhase({ projectRoot, treeSummary, goal: prompt });
        session.greenfield = session.phase === 'implement';
        // True empty workspace (nothing meaningful on disk) — used to force a write-first turn
        // so the model doesn't explore an empty folder. Distinct from `greenfield`, which is
        // also true for "new artifact in an existing repo".
        session.emptyWorkspace = isGreenfieldWorkspace(projectRoot, treeSummary);
        const partialResume = detectPartialDeliverableState(projectRoot, prompt, []);
        if (partialResume) {
            session.phase = 'implement';
            session._partialBuildNudgeInjected = true;
        }
        // v52.5 — run-start file snapshot: plan-step auto-advance must only credit files THIS
        // run creates. Without it, a workspace that already contains index.html/style.css/
        // script.js (previous attempt, resumed project) has every "create" step marked done
        // instantly and the model stalls on contradictory "all steps complete / blocked" signals.
        try { session._preExistingFiles = snapshotExistingFiles(session.projectRoot); } catch (e) { /* non-fatal */ }
        session.projectMeta = detectProjectCommands(session.projectRoot || projectRoot);
        session.grindMode = opts.grindMode !== false;

        let bootstrap = buildBootstrapBlock(projectRoot, treeSummary, prompt);

        if (opts.memory && typeof opts.memory.recall === 'function') {
            try {
                const mems = await opts.memory.recall(prompt);
                if (Array.isArray(mems) && mems.length) {
                    bootstrap += '\n\n[RELEVANT MEMORY — from past sessions, may be stale]\n' +
                        mems.slice(0, 3).map(m => `- ${String(m).slice(0, 300)}`).join('\n');
                }
            } catch (e) { /* memory is best-effort */ }
        }

        session.messages.push({ role: 'user', content: `${bootstrap}\n\n[TASK]\n${prompt}` });

        trace = new CodeRunTrace(sessionId);
        trace.inputReceived(prompt.slice(0, 200));
        trace.contextLoaded('bootstrap');
    }

    session.planArtifacts = planArtifacts;
    session.pluginToolNames = (opts.pluginToolSchemas || [])
        .map(s => s.function && s.function.name).filter(Boolean);
    session.grindMode = opts.grindMode !== false;
    if (!session.projectMeta) {
        session.projectMeta = detectProjectCommands(session.projectRoot || projectRoot);
    }

    wrapEmit({ type: 'run_start', sessionId, goal: session.goal, resumed: !!opts.resumeSession, codePlan: session.codePlan || null });

    if (opts.pluginManager?.fireHook) {
        try {
            await opts.pluginManager.fireHook('sessionStart', {
                sessionId: session.id,
                goal: session.goal,
                projectRoot: session.projectRoot,
                isolated: !!session.isolatedRun
            });
        } catch (e) { /* non-fatal */ }
    }

    const execDeps = typeof buildExecDeps === 'function'
        ? buildExecDeps(sessionId)
        : Object.assign({}, opts.execDeps || {}, { sessionId });

    const needPlanning = opts.requirePlanApproval
        && !opts.continueAfterApproval
        && !session.codePlan
        && !opts.resumeSession;

    if (needPlanning) {
        await runPlanningPhase({
            session,
            apiBaseUrl,
            apiKey: apiKey || null,
            model: session.model,
            emit: wrapEmit,
            signal,
            execDeps,
            trace,
            streamCompletion: opts.streamCompletion
        });
        session.planAnchorState = planAnchor.serialize();
        await CodeSession.save(userDataPath, session);
        return session;
    }

    if (session.status === 'awaiting_approval' && !opts.continueAfterApproval) {
        wrapEmit({
            type: 'plan_awaiting_approval',
            sessionId,
            goal: session.goal,
            codePlan: session.codePlan
        });
        await CodeSession.save(userDataPath, session);
        return session;
    }

    const parentProjectRoot = session.parentProjectRoot || projectRoot;

    if (shouldUseSubagents(session, planArtifacts) && !opts._subagentChild) {
        const orch = await runMilestoneSubagentOrchestrator({
            session,
            planArtifacts,
            planAnchor,
            earlyStop,
            qualityMonitor,
            trace,
            userDataPath,
            buildExecDeps,
            execDeps: opts.execDeps,
            emit,
            signal,
            apiBaseUrl: opts.apiBaseUrl,
            apiKey: opts.apiKey || null,
            pluginToolSchemas: opts.pluginToolSchemas,
            pluginToolNames: opts.pluginToolNames,
            streamCompletion: opts.streamCompletion,
            memory: opts.memory,
            pluginManager: opts.pluginManager,
            parentProjectRoot,
            projectContext,
            executeTurnLoop
        });

        if (orch.handled) {
            const finalGate = orch.finalGate;
            session.status = finalGate.allow ? 'done' : 'unverified';
            session.validation = {
                status: session.status,
                messages: finalGate.messages,
                ranChecks: finalGate.ranChecks
            };
            // v53.1: persist BEFORE the done event (same race as executeTurnLoop — a client
            // listing sessions on `done` must see the terminal status, not 'running').
            try { await CodeSession.save(userDataPath, session); } catch (e) { /* non-fatal */ }
            wrapEmit({
                type: 'done',
                sessionId,
                status: session.status,
                subagents: true,
                subagentMode: orch.mode
            });
            if (session.isolatedRun && session.worktreePath && !session.milestoneWorktrees) {
                cleanupWorktree(session.parentProjectRoot || projectRoot, sessionId);
            }
            if (opts.pluginManager?.fireHook) {
                try {
                    await opts.pluginManager.fireHook('sessionStop', {
                        sessionId: session.id,
                        status: session.status,
                        subagents: true,
                        subagentMode: orch.mode
                    });
                } catch (e) { /* non-fatal */ }
            }
            await CodeSession.save(userDataPath, session);
            return session;
        }
    }

    return executeTurnLoop({
        session,
        planAnchor,
        planArtifacts,
        earlyStop,
        qualityMonitor,
        trace,
        userDataPath,
        buildExecDeps,
        execDeps: opts.execDeps,
        emit,
        signal,
        apiBaseUrl,
        apiKey: apiKey || null,
        pluginToolSchemas: opts.pluginToolSchemas,
        pluginToolNames: opts.pluginToolNames,
        streamCompletion: opts.streamCompletion,
        memory: opts.memory,
        pluginManager: opts.pluginManager
    });
}

module.exports = { runCodeTask, executeTurnLoop, newSessionId };
