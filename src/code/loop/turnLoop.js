/**
 * Inner turn loop — one LLM call, parse tools, execute until model stops.
 */
'use strict';

const { streamCompletion } = require('./streamCompletion.js');
const { extractFromMessage } = require('../tools/extractor.js');
const { executeTool } = require('../tools/executor.js');
const { TurnDedup } = require('../tools/dedup.js');
const { selectToolsForTurn } = require('../tools/router.js');
const { fitBudget, estimateMessages } = require('../context/budget.js');
const { compactForPhaseTransition } = require('../context/phaseCompact.js');
const { adaptMessagesForModel } = require('../context/modelHarness.js');
const { checkCompletion, runValidation, formatGateMessage, formatBeforeDoneMessage, maxReflectionsForSession, runMilestoneVerify, goalImpliesBuildWork } = require('../governor/completionGate.js');
const { buildWriteNudge, buildMissingRefsNudge, goalImpliesNewArtifacts, buildMultiFileNudge } = require('../context/artifactHints.js');
const {
    detectPartialDeliverableState,
    pickNextWriteTarget,
    buildPartialBuildNudge,
    buildStallExhaustionNudge,
    buildMalformedWriteRecoveryNudge
} = require('../context/partialBuild.js');
const {
    buildDomContractNudge,
    buildDomRepairNudge,
    bootstrapDomRepair,
    refreshPendingDomRepairs
} = require('../context/htmlContract.js');
const { maybeProactiveRuntimeCheck } = require('../governor/proactiveRuntime.js');
const { buildFinalSummary } = require('./finalSummary.js');
const { phaseHint, WRITE_TOOLS } = require('./phases.js');
const { createDefaultMiddleware, runMiddlewareChain, applyPhaseAdvance } = require('./middleware.js');
const { createDispatchLane } = require('../tools/concurrency.js');
const { classifyStreamEnd } = require('../../shared/streamSignals.js');
const { buildRunCodeSdkSection } = require('../tools/runCode.js');
const { toContextBlock, stepProgress, advancePastExploreIfNeeded } = require('../plan/codePlan.js');
const {
    autoAdvancePlanSteps,
    buildStalePlanStepNudge,
    buildPlanCompleteGateNudge,
    planProgressPayload,
    planAllStepsDone,
    collectPlanBlockers
} = require('../plan/planStepAutoAdvance.js');
const { MARK_CODE_STEP_DONE } = require('../tools/planTools.js');
const { seedPendingMissingRefs, pickNextMissing } = require('./missingRefGuard.js');
const { tryHarnessScaffold } = require('./harnessScaffold.js');

const SYSTEM_PROMPT = `You are Agent Smith, a professional coding agent running on the user's machine — work like a careful senior engineer pairing with them. You operate autonomously with tools: you can build and modify projects AND inspect or operate the host system (read config files anywhere, manage background processes, search the web).

METHOD (the Hermes standard):
- GATHER BEFORE CHANGING — read the relevant code before editing it; trace a symbol to its definition and usages rather than guessing its shape. Never invent files, symbols, APIs or imports: if you have not seen it in the project, go look (read_file / grep / glob). Check the project manifest (package.json / pyproject.toml / Cargo.toml) before assuming a library is available.
- BATCH INDEPENDENT WORK — when several tool calls don't depend on each other's results (reading 3 files, grepping 2 patterns), emit them ALL in ONE reply: they run concurrently and the whole batch costs one round trip instead of N. Only serialize calls that genuinely need an earlier result (read a file before patching it).
- LOOP OVER TOOLS WITH run_code — when a task is "do X for EVERY Y" (syntax-check every changed file, collect test output per module, read 10 files and summarize), write ONE run_code program instead of dozens of sequential tool calls: \`const results = []; for (const f of files) { const r = await tools.read_file({path:f}); ... }\`. Only what you print/return comes back — curate it.
- EDIT WITH TOOLS — write code through write_file / patch / append_file, never by describing what you would do. Your reply text is NOT the deliverable; files on disk are. Apply the change, then report it briefly.
- SMALLEST CORRECT CHANGE — match the project's existing style and conventions (naming, formatting, error handling); touch only what the task needs. No drive-by refactors, renames or reformatting. Add every import / dependency your code requires.
- VERIFY THE PREMISE — when fixing a bug, reproduce it first if possible, find the exact line where it manifests, and fix the whole class (sibling call paths included), not just the reported site. When an edit fails to apply, re-read the file for its current content instead of retrying the stale text.
- VERIFY THE RESULT — exercise what you built with real commands before claiming it works; a green check from YOUR OWN verification beats a plausible-sounding description. If something cannot be run, say so honestly rather than asserting success.

Write COMPLETE, working code — fully implement every feature the task asks for. NEVER leave placeholder comments, stubs, "..." elisions, or "TODO: implement" notes in place of real logic; a feature is not done until its code actually runs.

Rules (follow strictly):
1. write_file takes a file's COMPLETE content (up to ~1000 lines). Use it for new files and to rewrite a file you must restructure. To change existing code use patch (set replace_all when the text repeats). Use append_file ONLY to add new content at the end — NEVER to revise code already in the file (that creates duplicate definitions).
2. JavaScript template literals MUST use backticks: \`repeat(\${n}, 30px)\` — not repeat(\${n}, 30px).
3. CSS selectors must match JS class names (e.g. .card in CSS if classList.add('card') in JS).
4. For web apps (HTML/CSS/JS): build with SEPARATE FILES — index.html + style.css + script.js (+ extra modules as needed). Do NOT cram all CSS and JS into one giant HTML file: separate files are easier to patch, diff, revert and verify. Create ALL the files index.html links (style.css and every script). You MAY emit several write_file calls in ONE turn to create multiple files at once — prefer this for small/medium modules so the build doesn't drag across many turns; keep a single very large file to its own turn so it isn't truncated.
5. After writing .js files, fix any syntax warnings returned by the tool. Use read_file to verify content.
6. Prefer patch for small fixes; write_file for new files or full rewrites; append_file only to continue a cut-off file. read_file before editing existing files. If a patch reports "Multiple exact matches", either set replace_all:true or rewrite the whole file with write_file — do NOT append.
7. Call list_project at most once at the start — the bootstrap already includes the tree.
8. When index.html exists but script.js or style.css is missing, create those files next — never rewrite index.html again.
9. For games: use a fixed maze/layout array, not random walls that block the player spawn. Constants (GRID_SIZE/ROWS/COLS) MUST match the map's real dimensions.
10. When done, give a brief summary — but the run is only accepted after every file passes syntax, all references resolve, selectors match, constants match the map, and the page loads without errors. The harness verifies this; you cannot mark success by asserting it.
11. Long-lived progress belongs in .agentsmith/PLAN.md and IMPLEMENT.md — update milestones when verify gates pass.
12. For a static/offline web app, write CLASSIC scripts, NOT ES modules: every linked .js must contain ZERO "import" and ZERO "export" statements. Share state across files via window globals (e.g. window.Storage = { save, load };) and link each file with a plain <script src> in dependency order (utilities first, entry/app last). Reason: <script type="module"> is blocked over file:// (CORS) so the opened page breaks, and an "import"/"export" in a plain <script src> throws "Cannot use import statement outside a module" / "Unexpected token 'export'". Only use ES modules if the app will be served over http.
13. HOST TOOLS: project tools (read_file/patch/write_file/grep/glob/run_command) are RELATIVE to the project root and stay inside it. To reach ANYWHERE ELSE on this machine use the host tools with absolute paths (~ ok): read_host_file, write_host_file, delete_host_file, list_host_directory. Host mutations are audited (review_actions / undo_action). For long-running commands use run_command is_background:true, then track them with list_processes / read_process_log / send_input / stop_process — a foreground command that blocks has a 5-minute timeout and should be backgrounded instead.
14. TEST BEFORE DONE — before declaring the task complete (no more tool calls), you MUST have run at least one verification command that passed (exit code 0) SINCE your last file edit:
    - Node.js projects: \`node --check\` on each new/changed .js file, then whatever test script package.json defines (npm test / npx jest). If no test script exists, run the main entry file with node to confirm it loads without errors.
    - Python projects: \`python3 -m py_compile\` on each changed .py, then any test suite (pytest / unittest) if one exists in the project.
    - TypeScript: \`npx tsc --noEmit\` for type checking plus the project's test command.
    - Static HTML/CSS/JS apps: syntax-check every script you wrote or changed with node --check (the harness also smoke-tests the page).
    A successful verification run since your last edit is what unblocks completion — running tests BEFORE editing again does not count. If a check fails, fix it and verify again.
15. RUN_CODE DISCIPLINE — use run_code for work that loops over tools; do NOT use it to write files (write_file/patch are better: they diff, snapshot for Revert All, and syntax-check). Inside a program: independent reads may be parallelized with Promise.all; writes and commands serialize automatically in submission order. A tool denial THROWS — handle it with try/catch or keep the program small enough that one failure is informative. Keep programs under ~50 sub-calls; for bigger sweeps, split across multiple run_code calls.`;

function trackFileTouch(session, name, args, toolResult) {
    if (!toolResult || toolResult.error || toolResult.skipped) return;
    if (name === 'write_file' || name === 'append_file' || name === 'patch') {
        const rel = toolResult.relPath || args.path;
        if (rel && !session.filesTouched.includes(rel)) {
            session.filesTouched.push(rel);
        }
    }
}

async function evaluateCompletionBlock(ctx, session, planArtifacts, execDeps) {
    const gateOpts = {
        planArtifacts: planArtifacts || session.planArtifacts,
        grindMode: session.grindMode !== false,
        projectMeta: session.projectMeta,
        agentRanOkAfterEdit: session.agentRanOkAfterEdit,
        // Real-browser runtime verification of built web apps (Electron in-app, injected in tests).
        runtimeVerify: execDeps && execDeps.runtimeVerify,
        // Route the gate's deterministic web-wiring repair through the change ledger (Revert All).
        changeLedger: execDeps && execDeps.changeLedger,
        sessionId: session.id
    };

    const beforePayload = {
        filesTouched: session.filesTouched,
        goal: session.goal,
        grindMode: gateOpts.grindMode
    };

    if (execDeps?.fireHook) {
        const pluginVeto = await execDeps.fireHook('beforeDone', beforePayload);
        if (pluginVeto?.blocked) {
            return {
                allow: false,
                messages: [pluginVeto.reason || 'Blocked by plugin beforeDone hook'],
                status: 'incomplete',
                pluginBlocked: true,
                ranChecks: 0,
                checked: 0
            };
        }
    }

    const middleware = ctx.middleware || createDefaultMiddleware(ctx);
    const mwVeto = await runMiddlewareChain(middleware, 'beforeDone', {
        ctx, session, payload: beforePayload
    });
    if (mwVeto?.veto) {
        const msgs = mwVeto.messages || (mwVeto.message ? [mwVeto.message] : ['beforeDone middleware veto']);
        return {
            allow: false,
            messages: msgs,
            status: 'incomplete',
            middlewareBlocked: true,
            ranChecks: 0,
            checked: 0,
            forcePhase: mwVeto.forcePhase || null // v51.5 — middleware phase steering (testBeforeDone → verify)
        };
    }

    return checkCompletion(
        session.projectRoot,
        session.filesTouched,
        session.goal,
        gateOpts
    );
}

function emitVerifyBlocked(emit, gate, session, { reflection, madeProgress }) {
    const grindBlocked = gate.grindBlocked ||
        (gate.messages || []).some(m => /^\[(?:LINT|TEST) FAILED\]/i.test(m));
    emit({
        type: 'verify_blocked',
        subType: grindBlocked ? 'grind_blocked' : 'gate_blocked',
        messages: gate.messages,
        reflection,
        madeProgress,
        filesTouched: session.filesTouched
    });
}

async function handleCompletionReflection(ctx, session, planArtifacts, execDeps, emit, trace) {
    const gate = await evaluateCompletionBlock(ctx, session, planArtifacts, execDeps);
    if (!gate.allow) {
        const fileCount = new Set(session.filesTouched).size;
        const issueCount = (gate.messages || []).length;
        const missingCount = (gate.missingRefs || []).length;
        const snap = session._reflectSnap;
        const madeProgress = !!snap && (
            fileCount > snap.files
            || issueCount < snap.issues
            || missingCount < (snap.missingRefs ?? missingCount)
        );
        session._reflectSnap = { files: fileCount, issues: issueCount, missingRefs: missingCount };
        if (madeProgress) session.completionReflections = 0;

        if (gate.missingRefs?.length) {
            session.pendingMissingRefs = [...gate.missingRefs];
        } else {
            delete session.pendingMissingRefs;
        }

        const reflectionLimit = maxReflectionsForSession(session);
        if (session.completionReflections < reflectionLimit) {
            session.completionReflections++;
            const blockMsg = gate.middlewareBlocked || gate.pluginBlocked
                ? formatBeforeDoneMessage(gate.messages)
                : formatGateMessage(gate, session.goal, session.projectRoot);
            session.messages.push({ role: 'user', content: blockMsg });
            const noFiles = !(session.filesTouched || []).length;
            const missingRefs = gate.missingRefs || [];
            // Ensure fix turns can write (verify phase previously blocked write_file).
            if (!gate.allow && (noFiles || missingRefs.length)) {
                session.phase = 'implement';
            }
            if (missingRefs.length) {
                session.messages.push({
                    role: 'system',
                    content: buildMissingRefsNudge(missingRefs, session.goal, session.projectRoot)
                });
            } else {
                const partialNudge = buildPartialBuildNudge(session, session.goal, session.projectRoot);
                const domNudge = buildDomRepairNudge(session, gate.messages || []);
                if (domNudge) {
                    session.messages.push({ role: 'system', content: domNudge });
                    session.phase = 'implement';
                } else if (partialNudge) {
                    session.messages.push({ role: 'system', content: partialNudge });
                } else if (noFiles && goalImpliesBuildWork(session.goal)) {
                    session.messages.push({
                        role: 'system',
                        content: buildWriteNudge(session.goal, session.projectRoot)
                    });
                }
            }
            // v51.5 — middleware phase steering: testBeforeDone's forcePhase:'verify' takes the
            // agent into the verify phase where run_command/tsc/pytest are offered and writes
            // stay available for fixes. Applied last so the nudge branches above can't undo it.
            if (gate.forcePhase && session.phase !== gate.forcePhase) {
                session.phase = gate.forcePhase;
            }
            emit({ type: 'run_continue', reason: 'gate_retry', reflection: session.completionReflections });
            if (trace) trace.verifyBlocked((gate.messages || []).slice(0, 4).join(' | '), session.completionReflections);
            emitVerifyBlocked(emit, gate, session, {
                reflection: session.completionReflections,
                madeProgress
            });
            return { continue: true, gate: null, exitReason: null };
        }
        const scaffolded = await tryHarnessScaffold(session, execDeps, emit, gate);
        if (scaffolded?.ok) {
            session.completionReflections = 0;
            session.phase = 'verify';
            emit({ type: 'run_continue', reason: 'harness_scaffold', path: scaffolded.path });
            return { continue: true, gate: null, exitReason: null };
        }
        return {
            continue: false,
            gate,
            exitReason: `no progress after ${reflectionLimit} reflections with unresolved issues`
        };
    }
    return { continue: false, gate, exitReason: null };
}

function emitPlanProgress(emit, session, extra = {}) {
    if (!session.codePlan?.steps?.length || !emit) return;
    emit({
        type: 'plan_step_update',
        ...planProgressPayload(
            session.codePlan,
            session.projectRoot,
            session.goal,
            session.filesTouched
        ),
        ...extra
    });
}

function applyDomRepairIfNeeded(session, gateMessages, { pushNudge = false } = {}) {
    // Read-only: recompute the pending DOM-mismatch list from disk, then nudge the model to
    // patch script.js itself. The harness does NOT rewrite the model's code.
    if (session?.projectRoot) {
        refreshPendingDomRepairs(session);
    }
    const domNudge = buildDomRepairNudge(session, gateMessages);
    if (!domNudge) {
        if (session?.pendingDomRepairs) delete session.pendingDomRepairs;
        return false;
    }
    if (pushNudge && !session._domBlockerNudgeSent) {
        session._domBlockerNudgeSent = true;
        session.messages.push({ role: 'system', content: domNudge });
        session.phase = 'implement';
    }
    return true;
}

async function syncPlanProgressAndNudges(ctx, session, emit, { hadEdit = false } = {}) {
    if (!session.codePlan?.steps?.length) return;

    const planIdx = session.codePlan.currentStepIndex ?? 0;
    if (session._planActiveIdx !== planIdx) {
        session._planActiveIdx = planIdx;
        session._planActiveSinceTurn = session.turn;
        session._planStaleNudgeForIdx = null;
    }

    const auto = autoAdvancePlanSteps(
        session.codePlan,
        session.projectRoot,
        session.filesTouched,
        session.goal,
        session._preExistingFiles || null
    );
    if (auto.advanced > 0) {
        session._planActiveIdx = session.codePlan.currentStepIndex ?? 0;
        session._planActiveSinceTurn = session.turn;
        session._planStaleNudgeForIdx = null;
    }

    emitPlanProgress(emit, session);

    const allDone = planAllStepsDone(session.codePlan);
    const blockers = collectPlanBlockers(session.projectRoot, session.goal, session.filesTouched);
    const domMsgs = blockers.messages.filter(m => /^\[DOM\]/i.test(m));
    if (domMsgs.length > 0) {
        applyDomRepairIfNeeded(session, blockers.messages, { pushNudge: !session._domBlockerNudgeSent });
        if (!hadEdit) {
            session._domReadStreak = (session._domReadStreak || 0) + 1;
            if (session._domReadStreak >= 2 && session._domReadNudgeTurn !== session.turn) {
                session._domReadNudgeTurn = session.turn;
                session._domReadStreak = 0;
                const repeatNudge = buildDomRepairNudge(session, blockers.messages);
                if (repeatNudge) {
                    session.messages.push({ role: 'system', content: repeatNudge });
                    session.phase = 'implement';
                }
            }
        } else {
            session._domReadStreak = 0;
        }
    }
    if (allDone) {
        const { count, messages } = blockers;
        if (count > 0) {
            if (!session._planCompleteGateNudge) {
                session._planCompleteGateNudge = true;
                const nudge = buildPlanCompleteGateNudge(session.goal, session.projectRoot, messages);
                if (nudge) {
                    session.messages.push({ role: 'system', content: nudge });
                    session.phase = 'implement';
                }
                const domNudge = buildDomRepairNudge(session, messages);
                if (domNudge) session.messages.push({ role: 'system', content: domNudge });
            } else if (!hadEdit) {
                session._planCompleteReadTurns = (session._planCompleteReadTurns || 0) + 1;
                if (session._planCompleteReadTurns >= 3
                    && session._planCompleteReadNudgeTurn !== session.turn) {
                    session._planCompleteReadNudgeTurn = session.turn;
                    session._planCompleteReadTurns = 0;
                    const domNudge = buildDomRepairNudge(session, messages);
                    if (domNudge) {
                        session.messages.push({ role: 'system', content: domNudge });
                        session.phase = 'implement';
                    } else {
                        session.messages.push({
                            role: 'system',
                            content: buildPlanCompleteGateNudge(session.goal, session.projectRoot, messages)
                        });
                    }
                }
            } else {
                session._planCompleteReadTurns = 0;
            }
        }
        return;
    }

    const turnsOnStep = session.turn - (session._planActiveSinceTurn ?? session.turn);
    const staleNudge = buildStalePlanStepNudge(
        session.codePlan,
        session.projectRoot,
        session.filesTouched,
        session.goal,
        turnsOnStep,
        session._preExistingFiles || null
    );
    if (staleNudge && session._planStaleNudgeForIdx !== planIdx) {
        session._planStaleNudgeForIdx = planIdx;
        session.messages.push({ role: 'system', content: staleNudge });
    }
}

async function runTurnLoop(ctx) {
    const {
        session, apiBaseUrl, apiKey, emit, signal, execDeps, planAnchor, planArtifacts,
        qualityMonitor, earlyStop, trace, userDataPath, onCheckpoint, userPrompt,
        pluginToolNames = [], pluginToolSchemas = []
    } = ctx;

    const stream = ctx.streamCompletion || streamCompletion;
    const dedup = new TurnDedup();
    const middleware = ctx.middleware || createDefaultMiddleware(ctx);
    let continueLoop = true;
    let exitReason = null;
    let finalGate = null;

    const seededMissing = seedPendingMissingRefs(session, session.goal);
    if (seededMissing.length) {
        session.phase = 'implement';
        session._injectMissingRefsNudge = true;
    }
    const partialState = detectPartialDeliverableState(
        session.projectRoot, session.goal, session.filesTouched
    );
    if (partialState) {
        session.phase = 'implement';
        const merged = [...new Set([
            ...(session.pendingMissingRefs || []),
            ...partialState.missingRefs,
            ...partialState.missingArtifacts
        ])];
        if (merged.length) session.pendingMissingRefs = merged;
        if (!session._partialBuildNudgeInjected) {
            session._partialBuildNudgeInjected = true;
            const nudge = buildPartialBuildNudge(session, session.goal, session.projectRoot);
            if (nudge) session.messages.push({ role: 'system', content: nudge });
        }
    }

    bootstrapDomRepair(session, { pushMessages: true });

    async function finalize(reason, gate) {
        let validation;
        if (gate && gate.messages !== undefined) {
            validation = {
                status: gate.status,
                messages: gate.messages || [],
                ranChecks: gate.ranChecks ?? gate.checked ?? 0,
                acceptance: gate.acceptance,
                smoke: gate.smoke,
                allow: gate.allow
            };
        } else {
            // A validation error must NOT sink the whole run (which would lose the verdict and
            // final summary and surface as a bare "error"). Fall back to an honest 'unverified'.
            try {
                validation = await runValidation(
                    session.projectRoot,
                    session.filesTouched,
                    session.goal,
                    {
                        planArtifacts: planArtifacts || session.planArtifacts,
                        grindMode: session.grindMode !== false,
                        projectMeta: session.projectMeta,
                        agentRanOkAfterEdit: session.agentRanOkAfterEdit,
                        // Honest final verdict: even when the run ends without a completion
                        // reflection (e.g. early-stop), still load the built web app in a real
                        // browser so the status reflects whether it actually runs.
                        runtimeVerify: execDeps && execDeps.runtimeVerify,
                        changeLedger: execDeps && execDeps.changeLedger,
                        sessionId: session.id
                    }
                );
            } catch (e) {
                validation = { status: 'unverified', messages: [], ranChecks: 0, acceptance: undefined, smoke: undefined, allow: false };
            }
        }
        let status = validation.status;
        if (reason && status === 'done' && validation.ranChecks === 0) status = 'unverified';
        session.status = status;
        session.validation = {
            status,
            messages: validation.messages,
            ranChecks: validation.ranChecks
        };
        session.unresolved = validation.messages || [];

        const summary = buildFinalSummary({
            status,
            goal: session.goal,
            filesTouched: session.filesTouched,
            validation: { messages: validation.messages, ranChecks: validation.ranChecks },
            acceptance: validation.acceptance,
            smoke: validation.smoke,
            exitReason: reason
        });

        session.finalSummary = summary;
        if (trace) {
            trace.verifyGate(status, (validation.messages || []).slice(0, 6).join(' | '));
            trace.finalize(status, summary.slice(0, 300));
        }
        emit({ type: 'final_summary', status, summary, validation: session.validation, acceptance: validation.acceptance, smoke: validation.smoke });
        emit({ type: 'assistant_done', content: summary });
    }

    // Record an output-truncation event, warn the model/user, and signal whether to bail.
    // Returns true when truncation has repeated too often (caller sets exitReason via this).
    async function recordTruncation(message) {
        session.truncationCount = (session.truncationCount || 0) + 1;
        const outputChars = String(message?.content || '').length;
        const chunkLimits = [30, 20, 12];
        const chunkLines = chunkLimits[Math.min(session.truncationCount - 1, chunkLimits.length - 1)];
        emit({
            type: 'output_truncated',
            turn: session.turn,
            count: session.truncationCount,
            outputChars,
            chunkLines
        });
        if (trace && trace.verifyBlocked) trace.verifyBlocked('output truncated (token limit)', session.truncationCount);
        if (session.truncationCount > 3) {
            // v53.1: was `truncationScaffoldAttemps` (typo) — the counter still worked, but
            // any future code reading the intended name would see undefined and re-scaffold
            // past the cap. Renamed; old persisted sessions simply start fresh at 0.
            session.truncationScaffoldAttempts = (session.truncationScaffoldAttempts || 0) + 1;
            if (session.truncationScaffoldAttempts <= 2) {
                const scaffolded = await tryHarnessScaffold(session, execDeps, emit);
                if (scaffolded?.ok) {
                    session.truncationCount = 0;
                    session.completionReflections = 0;
                    session.phase = 'verify';
                    return false;
                }
            }
            exitReason = 'model replies were repeatedly cut off at the server\'s output-length limit, which is separate from the context window. The configured context may be large while the server still caps each reply. Increase the server\'s max response/output tokens, or keep file writes in small appendable chunks.';
            return true;
        }
        emit({ type: 'run_continue', reason: 'truncation_retry', attempt: session.truncationCount });
        session.messages.push({
            role: 'user',
            content: '[CONTINUE — output truncated] Your reply was cut off; the run continues. Any COMPLETE file in it was saved. ' +
                `Your server appears to enforce a small per-reply cap despite the larger context window. Write ONE tool call with at most ${chunkLines} lines. ` +
                'For a new file, write_file only the first complete chunk; on later turns use append_file for the next chunk. ' +
                'End each chunk at a complete statement or block. Do not regenerate or repeat content already on disk.' +
                (session.pendingMissingRefs?.length
                    ? ` NEXT REQUIRED: create "${pickNextMissing(session.pendingMissingRefs)}" in a chunk of at most ${chunkLines} lines, then continue it with append_file on later turns.`
                    : '')
        });
        return false;
    }

    while (continueLoop) {
        const turnCheck = earlyStop.onTurn();
        if (turnCheck.stop) {
            emit({ type: 'error', message: turnCheck.reason });
            exitReason = turnCheck.reason;
            break;
        }

        // No-progress backstop: stop early if the run keeps taking turns (e.g. read-only
        // exploration) without ever writing a file, instead of burning all 40 turns.
        const progressCheck = earlyStop.onProgress(new Set(session.filesTouched || []).size, {
            hadEdit: !!session._turnHadEdit
        });
        session._turnHadEdit = false;
        if (progressCheck.stop) {
            emit({ type: 'error', code: 'NO_PROGRESS', message: progressCheck.reason });
            exitReason = progressCheck.reason;
            break;
        }

        session.turn++;
        dedup.reset();

        // Empty workspace + nothing written yet → write-first: drop read/search/preview so the
        // model creates files immediately instead of exploring an empty folder. Also applies to
        // greenfield artifact goals in a non-empty host repo (turn 1), and to partial builds
        // where HTML/CSS exist but linked JS/README are still missing.
        const noWritesYet = !(session.filesTouched || []).length;
        const pendingMissing = (session.pendingMissingRefs || []).length > 0;
        const partialDeliverable = detectPartialDeliverableState(
            session.projectRoot, session.goal, session.filesTouched
        );
        const writeFirstGoal = session.greenfield || goalImpliesNewArtifacts(session.goal);
        const writeOnlyEmpty = session.phase === 'implement' && noWritesYet
            && (session.emptyWorkspace || writeFirstGoal);
        const writeOnlyPartial = session.phase === 'implement' && !noWritesYet
            && (pendingMissing || !!partialDeliverable?.nextFile);
        const preBlockers = collectPlanBlockers(
            session.projectRoot, session.goal, session.filesTouched
        );
        if (preBlockers.messages.some(m => /^\[DOM\]/i.test(m))) {
            applyDomRepairIfNeeded(session, preBlockers.messages, { pushNudge: false });
        } else if ((session.pendingDomRepairs || []).length) {
            refreshPendingDomRepairs(session); // read-only: clear if the model already fixed it
        }
        // NOTE: DOM repair does NOT force write-only — the model needs read_file to find the
        // exact patch text in script.js. The repair nudge + the index.html-rewrite block guide it.
        const writeOnly = writeOnlyEmpty || writeOnlyPartial;
        const tools = selectToolsForTurn({
            userPrompt: userPrompt || session.goal,
            turnIndex: session.turn - 1,
            phase: session.phase,
            writeOnly,
            pluginToolNames,
            pluginToolSchemas
        });
        if (session.codePlan?.steps?.length) {
            tools.push(MARK_CODE_STEP_DONE);
        }

        let messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'system', content: phaseHint(session.phase || 'explore') },
            { role: 'system', content: planAnchor.toBlock() },
            ...session.messages
        ];
        if (session.codePlan?.steps?.length) {
            messages.splice(3, 0, { role: 'system', content: toContextBlock(session.codePlan, session.goal) });
        }

        // v52.6 — dsh SDK section: when run_code is offered this turn, its prompt guidance
        // (available tools + program rules) is assembled from the SAME source of truth as
        // the schema (buildRunCodeSdkSection), so the two can never drift apart.
        if (tools.some(t => t.function.name === 'run_code')) {
            const sdk = buildRunCodeSdkSection(tools.map(t => t.function.name));
            if (sdk) messages.splice(3, 0, { role: 'system', content: sdk });
        }

        const qHint = qualityMonitor.hintBlock();
        if (qHint) messages.push({ role: 'system', content: qHint });

        // Reserve output room proportional to the window (clamped 4096–16384 tokens) so the
        // model can emit a whole source file without being truncated at the window edge.
        // The previous 6144 cap was too small for single-file builds (e.g. a full Pac-Man
        // page) — the reply got chopped mid-CSS and zero files landed.
        // Reply budget. A reasoning model that exhausted the budget on internal
        // reasoning (and produced no output) bumps session.outReserveOverride so the
        // retry gets the full ceiling for reasoning + content.
        const outReserve = session.outReserveOverride
            || Math.min(8192, Math.max(4096, Math.floor(session.numCtx * 0.25)));
        messages = fitBudget(messages, session.numCtx, outReserve);

        const usedTokens = estimateMessages(messages);
        emit({
            type: 'context_budget',
            used: usedTokens,
            total: session.numCtx,
            turn: session.turn,
            toolCountSoFar: session.toolCount,
            phase: session.phase
        });

        let bodyMessages = messages.slice();
        // Per-family prompt adaptation (Gemma folds/serializes; others pass through).
        // Routed by the table in modelHarness.js — no per-model ifs here.
        bodyMessages = adaptMessagesForModel(bodyMessages, session.model, {
            toolNames: tools.map(t => t.function.name),
            serializeToolHistory: true
        });

        emit({
            type: 'turn_start',
            turn: session.turn,
            toolCountSoFar: session.toolCount,
            phase: session.phase,
            planProgress: session.codePlan ? stepProgress(session.codePlan) : null
        });

        const inferStart = Date.now();
        let result;
        try {
            result = await stream({
                apiBaseUrl,
                apiKey: apiKey || null,
                model: session.model,
                messages: bodyMessages,
                tools,
                signal,
                // v52.7: max_tokens is unbounded (-1) inside streamCompletion — this value
                // no longer caps the reply; outReserve only reserves CONTEXT room for it.
                temperature: session.codeTemperature,
                onDelta: (d) => emit({ type: 'delta', text: d }),
                // v52.7: live generation state ('waiting' → 'generating') — model-agnostic,
                // driven by what arrives on the wire. The UI shows "model is generating" and
                // refuses actions that would cut this reply off mid-stream.
                onState: (state) => emit({ type: 'gen_state', state }),
                // Constrained tool-call decoding (opt-in) — forces valid tool calls from
                // local models that otherwise narrate/malform. LM Studio json_schema.
                constrain: process.env.XK_CODE_CONSTRAIN_TOOLS === '1'
            });
            if (trace) trace.inferenceOk(Date.now() - inferStart);
            session.stallRetries = 0;
        } catch (e) {
            if (/aborted/i.test(e.message)) throw e;
            if (trace) trace.inferenceError(Date.now() - inferStart, e.message);
            // Local/reasoning models intermittently stall mid-stream (no tokens for the
            // idle window). A stall is usually transient — retry the turn on a FRESH
            // request a few times before giving up, so ONE hiccup doesn't end an
            // otherwise-progressing build. Bounded; no-progress + max-turn guards apply.
            const STALL_RETRY_LIMIT = Math.max(Number(process.env.XK_CODE_STALL_RETRIES) || 0, 8);
            if (/stalled|timed out/i.test(e.message)) {
                session.stallRetries = (session.stallRetries || 0) + 1;
                if (session.stallRetries <= STALL_RETRY_LIMIT) {
                    emit({ type: 'stream_retry', turn: session.turn, attempt: session.stallRetries, message: `Model stalled mid-reply — retrying (${session.stallRetries}/${STALL_RETRY_LIMIT}).` });
                    session.turn--;
                    continue;
                }
                const stallNudge = buildStallExhaustionNudge(session, session.goal);
                if (stallNudge && (session.stallRecoveryAttempts || 0) < 2) {
                    session.stallRecoveryAttempts = (session.stallRecoveryAttempts || 0) + 1;
                    session.messages.push({ role: 'system', content: stallNudge });
                    session.phase = 'implement';
                    session.turn--;
                    emit({
                        type: 'run_continue',
                        reason: 'stall_recovery',
                        attempt: session.stallRecoveryAttempts
                    });
                    continue;
                }
            }
            const gate = await evaluateCompletionBlock(ctx, session, planArtifacts, execDeps);
            if (gate.allow) {
                finalGate = gate;
                break;
            }
            const scaffolded = await tryHarnessScaffold(session, execDeps, emit, gate);
            if (scaffolded?.ok) {
                session.completionReflections = 0;
                session.phase = 'verify';
                continue;
            }
            emit({ type: 'error', message: e.message });
            exitReason = e.message;
            break;
        }

        const msg = result.message;
        // Live status indicator (v52.4): accumulate server-reported token usage per run and
        // emit a compact status event after every inference so the UI can show
        // "(⊙_⊙) writing code… ↓ 12.3k t · 0:42" instead of a frozen screen.
        if (result.usage && Number.isFinite(result.usage.total_tokens)) {
            session.tokenUsage = session.tokenUsage || { prompt: 0, completion: 0, total: 0 };
            session.tokenUsage.prompt += result.usage.prompt_tokens || 0;
            session.tokenUsage.completion += result.usage.completion_tokens || 0;
            session.tokenUsage.total += result.usage.total_tokens || 0;
        }
        emit({
            type: 'run_status',
            turn: session.turn,
            phase: session.phase,
            tokensTotal: session.tokenUsage ? session.tokenUsage.total : null,
            elapsedMs: session.startedAt ? Date.now() - session.startedAt : null
        });
        // One-time, non-blocking advisory: if the model reasons at runtime (emits
        // reasoning_content / inline <think>), let the user know a coder model is a
        // better fit for Code Mode. Detected by behavior, not by model name.
        // v53.8 — also surface the single biggest speed lever for thinking-by-default models:
        // LM Studio's per-model "Reasoning" toggle. A 27B abliterated Qwen that thinks ~15k tokens
        // before its first tool call takes ~20 min/turn at ~12 tok/s and looks frozen; setting
        // Reasoning=off (or a coder model) makes the same build finish in minutes.
        if (result.sawReasoning && !session.modelAdvised) {
            session.modelAdvised = true;
            emit({
                type: 'model_advisory',
                level: 'info',
                message: 'This looks like a reasoning model — it thinks for many tokens before each tool call, so Code Mode turns are slow. To speed up builds: set the model\'s "Reasoning" toggle to Off in LM Studio (biggest lever), or use a coder model (e.g. Qwen2.5-Coder).'
            });
        }
        const extractSchemas = goalImpliesBuildWork(session.goal)
            ? selectToolsForTurn({
                userPrompt: userPrompt || session.goal,
                turnIndex: session.turn - 1,
                phase: 'implement',
                pluginToolNames,
                pluginToolSchemas
            })
            : tools;
        const salvageTarget = pickNextWriteTarget(session);
        extractFromMessage(msg, extractSchemas, {
            salvagePath: salvageTarget || null
        });

        // Reasoning-model guard: if the model spent the whole reply budget on internal
        // reasoning and emitted no content and no tool call (finish_reason === 'length'),
        // give the next turn the full budget and tell it to stop reasoning and act. This
        // keeps reasoning models (e.g. gemma-4, qwen3) from silently looping on empty
        // output — which presents as a "frozen" run. Code Mode only.
        // v51.3: also catches budget-exhausting replies that arrive WITHOUT a
        // reasoning_content signal (some servers fold thinking into content or drop the
        // field) — finish_reason 'length' with nothing emitted is the exhaustion signature
        // either way. A genuine stop with an empty reply still falls through to the
        // completion gate untouched.
        // v52.7: MODEL-AGNOSTIC cut-off detection (streamSignals.classifyStreamEnd). The
        // exhaustion signature — finish_reason:"length" with no content and no tool call,
        // whether or not a thinking channel was visible — means the reply was CUT OFF before
        // any output could come out. This is what makes thinking-by-default models of ANY
        // family (gemma4, qwen3, …) look "broken": they are generating fine; their whole
        // reply budget went to internal reasoning first. The fix is the same for every model:
        // nudge it to act and retry — persistently, not after two tries. With v52.7's
        // unbounded max_tokens this path is a safety net (server-side caps, context fill),
        // but when it fires it must recover instead of dying on "no files written".
        const endKind = classifyStreamEnd(result.streamEnd || {
            finishReason: result.finishReason,
            contentChars: String(msg.content || '').length,
            reasoningChars: 0,
            sawAnyDelta: true
        });
        if (endKind.kind === 'budget_exhausted') {
            session.reasoningModel = true;
            session.outReserveOverride = Math.max(session.outReserveOverride || 0, 8192);
            session.reasoningRetries = (session.reasoningRetries || 0) + 1;
            // v52.7: persistent recovery — the old "give up after 2" turned a slow thinker
            // into a dead run. The nudge is cheap and idempotent; keep retrying until the
            // model actually emits something (the no-write / error guards still bound it).
            const REASONING_RETRY_LIMIT = Math.max(Number(process.env.XK_CODE_REASONING_RETRIES) || 0, 5);
            if (session.reasoningRetries <= REASONING_RETRY_LIMIT) {
                emit({
                    type: 'reasoning_truncated',
                    turn: session.turn,
                    message: `${endKind.reason} Retrying with a brevity nudge (${session.reasoningRetries}/${REASONING_RETRY_LIMIT}).`
                });
                session.messages.push({
                    role: 'system',
                    content: 'Your previous reply was cut off before any output could be produced — the entire budget went to internal reasoning. Stop reasoning now: in your next reply, immediately emit the required tool call (e.g. write_file) or the file contents. Keep any reasoning to at most one short sentence.'
                });
                continue;
            }
            // Exhausted retries: fall through so normal completion/exit logic applies.
        } else if (endKind.kind === 'clean') {
            // A clean stop means the model is DONE thinking — reset the exhaustion counter so
            // one slow turn can't poison later turns of a long run.
            session.reasoningRetries = 0;
        }

        session.messages.push({
            role: 'assistant',
            content: msg.content || '',
            tool_calls: msg.tool_calls
        });

        if (session.workflow === 'executing' && (!msg.tool_calls || !msg.tool_calls.length)
            && /submit_code_plan/i.test(msg.content || '')) {
            session.messages.push({
                role: 'system',
                content: buildMissingRefsNudge(
                    session.pendingMissingRefs || [],
                    session.goal,
                    session.projectRoot
                ) || buildWriteNudge(session.goal, session.projectRoot)
            });
            session.phase = 'implement';
            continue;
        }

        // Truncation: the model hit its output limit (finish_reason="length"). COMPLETE
        // files in the reply were still recovered by the extractor and will be executed
        // below (salvage progress); only the cut-off tail is lost. We tell the model it was
        // truncated and retry. If nothing parsed, retry straight away.
        const truncated = result.finishReason === 'length';

        if (!msg.tool_calls || !msg.tool_calls.length) {
            if (truncated) {
                if (await recordTruncation(msg)) { finalGate = null; continueLoop = false; break; }
                continue;
            }
            const reflection = await handleCompletionReflection(
                ctx, session, planArtifacts, execDeps, emit, trace
            );
            if (reflection.continue) continue;
            if (reflection.exitReason) exitReason = reflection.exitReason;
            finalGate = reflection.gate;
            continueLoop = false;
            break;
        }

        // ── v52.6 — dsh ordered-lane batch execution (tools/concurrency.js) ────────────
        // The model's tool_calls run under the DeepSeek Harness concurrency contract:
        //   - pre-execute (dedup + middleware veto) is strictly submission-ordered, done in
        //     this for-loop before each call enters the lane;
        //   - only the body stage runs concurrently — read-only calls overlap up to
        //     maxParallel, writes/shell/preview are exclusive barriers that run alone and
        //     hold their barrier through commit (dsh's native exclusive-group semantics);
        //   - results COMMIT in submission order through a head-of-line cursor: onCommit
        //     runs INSIDE the ordered commit stage (awaited by the driver before the next
        //     commit begins), so every piece of shared-state bookkeeping below — history
        //     pushes, session flags, phase advances — can never interleave with another
        //     commit. History is byte-identical to what sequential execution produced; only
        //     wall-clock time changes (parallel reads overlap).
        const offeredToolNames = tools.map(t => t.function.name);
        const lane = createDispatchLane({
            maxParallel: Math.max(1, Number(process.env.XK_CODE_MAX_PARALLEL) || 4)
        });
        let batchAbort = false;
        let nextFallbackIdx = session.toolCount;

        for (const tc of msg.tool_calls) {
            const name = tc.function.name;
            let args = tc.function.arguments || {};
            if ((name === 'write_file' || name === 'patch') && !args.path) {
                const salvagedPath = pickNextWriteTarget(session);
                if (salvagedPath) args = { ...args, path: salvagedPath };
            }

            // Pre-execute stage (ordered): dedup + middleware veto. A vetoed/duplicate call
            // settles immediately — it never enters the body pool.
            const dup = dedup.isDuplicate(name, args);
            const callId = tc.id || `call_${session.turn}_${nextFallbackIdx++}`;

            let preResult = null;
            if (dup) {
                preResult = { skipped: true, reason: 'Duplicate call this turn' };
            } else {
                const veto = await runMiddlewareChain(middleware, 'beforeTool', {
                    ctx, session, payload: { name, args, dup }
                });
                if (veto?.veto) preResult = veto.result;
            }

            lane.submit({
                name,
                body: async () => {
                    // tool_start fires at START (ordered by the driver), not commit — the UI's
                    // pending cards appear in submission order as dsh presents them.
                    const startedAt = Date.now();
                    emit({ type: 'tool_start', name, args, callId });
                    if (preResult) return preResult;
                    // run_code sees exactly the tools offered THIS turn — a program can never
                    // reach a tool the phase router withheld.
                    const execArgs = Object.assign({}, execDeps, { sessionId: session.id, session, trace, callId });
                    if (name === 'run_code') execArgs.offeredToolNames = offeredToolNames;
                    const r = await executeTool(name, args, execArgs);
                    // Attach the start time so the commit stage can report durationMs.
                    if (r && typeof r === 'object' && !Array.isArray(r)) r._startedAt = startedAt;
                    return r;
                },
                onCommit: async ({ result }) => {
                    // Commit stage — ordered through the head-of-line cursor, awaited by the
                    // driver before the next commit begins. ALL shared-state bookkeeping lives
                    // here so it can never interleave with another commit (dsh's
                    // post-execute-in-commit contract).
                    const toolResult = result;
                    try {
                        if (toolResult && toolResult.error === 'tool call abandoned') {
                            // dsh abort semantics: queued-unstarted dispatches are abandoned when the
                            // run stops mid-batch. The model still gets a tool response for its call
                            // (history must stay valid) but no bookkeeping runs.
                            session.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: JSON.stringify(toolResult) });
                            return;
                        }

                        const ok = !toolResult.error && !toolResult.skipped && !toolResult.phaseBlocked;
                        // Track whether the agent has run a foreground command successfully (exit 0)
                        // since its last edit. A passing run of the project's own code/test is real
                        // evidence the current files at least execute — the completion gate credits
                        // this so scriptless JS projects aren't perpetually "unverified". A new write
                        // invalidates the signal (the run no longer reflects the latest code).
                        if (ok && name === 'run_command' && !args.is_background) session.agentRanOkAfterEdit = true;
                        if (WRITE_TOOLS.has(name) && ok) session.agentRanOkAfterEdit = false;
                        // v51.5 TEST BEFORE DONE tracking: a verification command that PASSED since the last
                        // edit is what unblocks completion; every successful write resets it so each new
                        // state of the code must be re-verified before "done".
                        if (name === 'run_command' && !args.is_background) {
                            const cmd = String(args.command || '');
                            const isVerification = /(test|lint|check|compile|tsc|py_compile|mypy|eslint|jest|vitest|pytest|npm run test|npm run lint)/.test(cmd);
                            if (isVerification && ok) session.testRunsSinceEdit = true;
                        }
                        if (WRITE_TOOLS.has(name) && ok) session.testRunsSinceEdit = false;
                        if (ok && WRITE_TOOLS.has(name)) dedup.clearFailures();
                        if (ok && WRITE_TOOLS.has(name)) session._turnHadEdit = true;
                        dedup.recordResult(name, args, ok);
                        qualityMonitor.record(name, ok, toolResult.error || toolResult.reason || toolResult.message);
                        const stopCheck = earlyStop.onToolResult(ok, dup);
                        session.toolCount++;

                        if (trace && !dup) trace.toolExecute(name, ok, JSON.stringify(args).slice(0, 120));

                        await runMiddlewareChain(middleware, 'afterTool', {
                            ctx, session, payload: { name, args, toolResult, ok }
                        });

                        const toolWasWrite = WRITE_TOOLS.has(name) && ok;
                        const prevPhase = session.phase;
                        if (applyPhaseAdvance(session, { lastTool: name, toolWasWrite })) {
                            const compact = compactForPhaseTransition(session, {
                                fromPhase: prevPhase,
                                toPhase: session.phase,
                                planAnchor,
                                planArtifacts
                            });
                            emit({
                                type: 'context_compacted',
                                fromPhase: prevPhase,
                                toPhase: session.phase,
                                droppedCount: compact.droppedCount,
                                keptCount: compact.keptCount,
                                turn: session.turn
                            });
                            emit({ type: 'phase_change', phase: session.phase, turn: session.turn });
                            if (execDeps?.fireHook) {
                                try {
                                    await execDeps.fireHook('phaseChange', {
                                        fromPhase: prevPhase,
                                        toPhase: session.phase,
                                        droppedCount: compact.droppedCount,
                                        keptCount: compact.keptCount
                                    });
                                } catch (e) { /* non-fatal */ }
                            }
                        }

                        if (ok && toolWasWrite && planArtifacts?.enabled) {
                            const mv = await runMilestoneVerify(session.projectRoot, planArtifacts, session.filesTouched);
                            if (mv.passed && mv.milestoneId) {
                                await planArtifacts.markMilestoneDone(mv.milestoneId);
                                planAnchor.addNote(`Milestone ${mv.milestoneId} verified`);
                            }
                        }

                        // v52.6 — history text: the pipeline's post-spill `resultStr` when present
                        // (oversized results were spilled to .agentsmith/tool-results/), else the
                        // structured result as before.
                        const resultStr = typeof toolResult === 'string' || !toolResult.resultStr
                            ? JSON.stringify(toolResult, null, 2)
                            : toolResult.resultStr;
                        session.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: resultStr });

                        emit({
                            type: 'tool_result',
                            name,
                            ok,
                            result: toolResult,
                            callId,
                            durationMs: Date.now() - (toolResult._startedAt || 0),
                            toolCountSoFar: session.toolCount,
                            turn: session.turn
                        });

                        if (!ok && name === 'write_file' && /requires a "path"/i.test(String(toolResult.error || ''))) {
                            const nudge = buildMalformedWriteRecoveryNudge(session, session.goal);
                            if (nudge) {
                                session.messages.push({ role: 'system', content: nudge });
                                session.phase = 'implement';
                            }
                        }

                        if (ok && name === 'mark_code_step_done' && toolResult?.advanced) {
                            session._planActiveIdx = session.codePlan.currentStepIndex ?? 0;
                            session._planActiveSinceTurn = session.turn;
                            session._planStaleNudgeForIdx = null;
                            emitPlanProgress(emit, session);
                        }

                        if (ok) {
                            trackFileTouch(session, name, args, toolResult);
                            planAnchor.recordDone(`${name} on ${args.path || args.pattern || args.command || ''}`);
                            // v52.4 multi-file steering: an HTML write that inlines substantive CSS/JS
                            // (and links no local assets) is the single-file failure mode — nudge ONCE to
                            // split into index.html + style.css + script.js. Never blocks; auto-advance
                            // still accepts inline builds so a stubborn model can't loop on layout.
                            if (!session._multiFileNudgeSent && (name === 'write_file' || name === 'append_file')
                                && /\.html?$/i.test(String(args.path || ''))
                                && goalImpliesNewArtifacts(session.goal)
                                && /<style\b[^>]*>[\s\S]{40,}/i.test(String(args.content || ''))
                                && /<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]{40,}<\/script>/i.test(String(args.content || ''))) {
                                session._multiFileNudgeSent = true;
                                const nudge = buildMultiFileNudge(session.goal);
                                if (nudge) session.messages.push({ role: 'system', content: nudge });
                            }
                            if (toolWasWrite && advancePastExploreIfNeeded(session.codePlan, session.goal)) {
                                emitPlanProgress(emit, session);
                            }
                        }

                        if (onCheckpoint) onCheckpoint();

                        if (stopCheck.stop && !batchAbort) {
                            // dsh abort semantics: stop the run; queued-unstarted dispatches are
                            // abandoned, in-flight bodies complete and commit normally.
                            batchAbort = true;
                            await lane.abort();
                            emit({ type: 'error', message: stopCheck.reason });
                            exitReason = stopCheck.reason;
                            continueLoop = false;
                        } else if (stopCheck.stop) {
                            // Already stopped by an earlier commit in this batch — the error was
                            // emitted once; later commits just settle quietly.
                            void stopCheck;
                        }
                    } catch (e) {
                        // Contain callback exceptions in the dispatcher (dsh defensive pattern): one
                        // bad commit must not reject the lane or starve later commits.
                        try { emit({ type: 'error', message: `tool commit failed for ${name}: ${e.message}` }); } catch (_) {}
                    }
                }
            }).promise.catch(() => { /* the lane never rejects — normalization guarantees a value */ });

            if (batchAbort) break; // nothing after a stop should even be submitted
        }

        await lane.drain();


        if (execDeps?.fireHook) {
            try {
                await execDeps.fireHook('afterToolBatch', {
                    turn: session.turn,
                    toolCount: session.toolCount
                });
            } catch (e) { /* non-fatal */ }
        }

        if (session._injectMissingRefsNudge) {
            delete session._injectMissingRefsNudge;
            const nudge = buildMissingRefsNudge(
                session.pendingMissingRefs,
                session.goal,
                session.projectRoot
            );
            if (nudge) {
                session.messages.push({ role: 'system', content: nudge });
                session.phase = 'implement';
            }
        } else if (session._injectDomContractNudge) {
            delete session._injectDomContractNudge;
            const domNudge = buildDomContractNudge(session);
            if (domNudge) {
                session.messages.push({ role: 'system', content: domNudge });
                session.phase = 'implement';
            }
        } else {
            // Once the web project is structurally complete, load it in a real browser mid-build
            // and feed any runtime errors back so the model fixes them in-flight — without waiting
            // for it to declare "done" (which local models often never do). Throttled + capped.
            await maybeProactiveRuntimeCheck(session, execDeps, emit);
        }

        await runMiddlewareChain(middleware, 'afterTurn', {
            ctx, session, payload: { turn: session.turn, reason: continueLoop ? null : 'model_stop' }
        });

        await syncPlanProgressAndNudges(ctx, session, emit, {
            hadEdit: !!session._turnHadEdit
        });

        if (execDeps?.fireHook) {
            try {
                await execDeps.fireHook('afterTurn', {
                    turn: session.turn,
                    phase: session.phase,
                    toolCount: session.toolCount
                });
            } catch (e) { /* non-fatal */ }
        }

        // The reply was cut off, but its complete files were just saved above. Tell the
        // model to continue with the next file, then retry (bail if it keeps truncating).
        if (truncated) {
            if (await recordTruncation(msg)) { finalGate = null; continueLoop = false; break; }
            continue;
        }

        if (result.finishReason === 'stop' && (!msg.tool_calls || !msg.tool_calls.length)) {
            continueLoop = false;
        }
    }

    await finalize(exitReason, finalGate);
}

module.exports = { runTurnLoop, SYSTEM_PROMPT };
