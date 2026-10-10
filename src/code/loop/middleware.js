/**
 * Composable middleware chain for the Code Mode turn loop.
 */
'use strict';

const { isToolAllowed, phaseGateError, maybeAdvancePhase, WRITE_TOOLS } = require('./phases.js');
const { runPostEditChecks } = require('../governor/postEditChecks.js');
const {
    checkMissingRefWrite,
    checkMissingRefRead,
    checkPrematurePreview,
    clearPendingIfCreated,
    syncPendingAfterHtmlWrite
} = require('./missingRefGuard.js');
const {
    captureHtmlIdContract,
    checkDomRepairWrite,
    clearDomRepairsIfScriptPatched
} = require('../context/htmlContract.js');
const { autoAdvancePlanSteps, planProgressPayload } = require('../plan/planStepAutoAdvance.js');

function mergeSensorWarnings(toolResult, sensor) {
    if (!sensor || (!sensor.warnings?.length && !sensor.remediation?.length)) return;
    const existing = Array.isArray(toolResult.warnings) ? toolResult.warnings.slice() : [];
    for (const w of (sensor.warnings || [])) {
        if (!existing.includes(w)) existing.push(w);
    }
    toolResult.warnings = existing;
    if (sensor.remediation?.length) {
        toolResult.sensorRemediation = sensor.remediation;
    }
}

function createDefaultMiddleware(ctx) {
    return [
        // loopDetect — duplicate handling stays in TurnDedup; middleware can veto re-runs
        {
            name: 'loopDetect',
            async beforeTool({ payload }) {
                if (payload.dup) {
                    return { veto: false };
                }
                return null;
            }
        },
        // planToolGuard — block re-submitting plan after user approval
        {
            name: 'planToolGuard',
            async beforeTool({ session, payload }) {
                if (payload.name === 'submit_code_plan' && session.workflow === 'executing') {
                    return {
                        veto: true,
                        result: {
                            error: 'BLOCKED: Plan already approved. Use write_file to create missing files — do NOT call submit_code_plan again.',
                            blockedReason: 'plan_resubmit_during_execute',
                            phaseBlocked: false
                        }
                    };
                }
                return null;
            }
        },
        // phaseGate — reject out-of-phase tools
        {
            name: 'phaseGate',
            async beforeTool({ session, payload }) {
                const phase = session.phase || 'explore';
                const name = payload.name;
                // Plugin tools aren't in the core PHASE_TOOLS table; allow them in any
                // phase except explore (which is read-only).
                const isPlugin = Array.isArray(session.pluginToolNames) && session.pluginToolNames.includes(name);
                if (isPlugin) {
                    if (phase === 'explore') return { veto: true, result: phaseGateError(phase, name) };
                    return null;
                }
                if (!isToolAllowed(phase, name)) {
                    return { veto: true, result: phaseGateError(phase, name) };
                }
                return null;
            }
        },
        // missingRefGuard — stop index.html rewrite loops while script.js/css are missing
        {
            name: 'missingRefGuard',
            async beforeTool({ session, payload }) {
                const previewBlocked = checkPrematurePreview(session, payload.name, payload.args);
                if (previewBlocked) {
                    return {
                        veto: true,
                        result: {
                            error: previewBlocked.error,
                            blockedReason: previewBlocked.blockedReason,
                            phaseBlocked: false
                        }
                    };
                }
                const readBlocked = checkMissingRefRead(session, payload.name, payload.args);
                if (readBlocked) {
                    return {
                        veto: true,
                        result: {
                            error: readBlocked.error,
                            blockedReason: readBlocked.blockedReason,
                            phaseBlocked: false
                        }
                    };
                }
                const blocked = checkMissingRefWrite(session, payload.name, payload.args);
                if (blocked) {
                    return {
                        veto: true,
                        result: {
                            error: blocked.error,
                            blockedReason: blocked.blockedReason,
                            phaseBlocked: false
                        }
                    };
                }
                const domWriteBlocked = checkDomRepairWrite(session, payload.name, payload.args);
                if (domWriteBlocked) {
                    return {
                        veto: true,
                        result: {
                            error: domWriteBlocked.error,
                            blockedReason: domWriteBlocked.blockedReason,
                            phaseBlocked: false
                        }
                    };
                }
                return null;
            },
            async afterTool({ session, payload }) {
                const { name, toolResult, ok, args } = payload;
                if (!ok || !WRITE_TOOLS.has(name)) return null;
                const relPath = toolResult?.relPath || args?.path;
                clearPendingIfCreated(session, relPath);
                syncPendingAfterHtmlWrite(session, relPath);
                if (relPath && /\.html?$/i.test(String(relPath))) {
                    captureHtmlIdContract(session, relPath);
                    session._injectDomContractNudge = true;
                }
                if (relPath && /\.(js|mjs|cjs)$/i.test(String(relPath))) {
                    // If we were in DOM-repair mode, re-check disk: clear the flag if the model's
                    // patch fixed the mismatch (read-only — never rewrites the model's code).
                    clearDomRepairsIfScriptPatched(session, relPath);
                }
                return null;
            }
        },
        // planAutoAdvance — tick checklist when deliverables land (no mark_code_step_done needed)
        {
            name: 'planAutoAdvance',
            async afterTool({ ctx, session, payload }) {
                const { name, toolResult, ok, args } = payload;
                if (!ok || !WRITE_TOOLS.has(name)) return null;
                if (!session.codePlan?.steps?.length) return null;
                const touched = [...(session.filesTouched || [])];
                const rel = toolResult?.relPath || args?.path;
                if (rel) {
                    const norm = String(rel).replace(/\\/g, '/');
                    if (!touched.includes(norm)) touched.push(norm);
                }
                const result = autoAdvancePlanSteps(
                    session.codePlan,
                    session.projectRoot,
                    touched,
                    session.goal,
                    session._preExistingFiles || null
                );
                if (result.advanced > 0 && ctx.emit) {
                    ctx.emit({
                        type: 'plan_step_update',
                        ...planProgressPayload(
                            session.codePlan,
                            session.projectRoot,
                            session.goal,
                            touched
                        )
                    });
                }
                return null;
            }
        },
        // planSync — milestone + IMPLEMENT on success
        {
            name: 'planSync',
            async afterTool({ session, payload }) {
                const { name, args, toolResult, ok } = payload;
                if (!ok || !session.planArtifacts?.enabled) return null;

                if (WRITE_TOOLS.has(name)) {
                    await session.planArtifacts.appendImplementEntry({
                        title: `${name} ${args.path || ''}`.trim(),
                        what: `Modified ${args.path || 'file'}`
                    }).catch(() => {});
                }
                return null;
            }
        },
        // postEditSensors — lint/format/rules after successful writes
        {
            name: 'postEditSensors',
            async afterTool({ ctx, session, payload }) {
                const { name, args, toolResult, ok } = payload;
                if (!ok || !WRITE_TOOLS.has(name)) return null;
                const rel = toolResult?.relPath || args.path;
                if (!rel || !session.projectRoot) return null;

                const sensor = await runPostEditChecks(
                    session.projectRoot,
                    rel,
                    session.projectMeta,
                    {}
                );
                mergeSensorWarnings(toolResult, sensor);

                if (ctx.emit && (sensor.warnings?.length || sensor.remediation?.length)) {
                    ctx.emit({
                        type: 'sensor_result',
                        path: rel,
                        tool: name,
                        warnings: sensor.warnings || [],
                        remediation: sensor.remediation || []
                    });
                }
                return null;
            }
        },
        // v51.5 testBeforeDone — TEST BEFORE DONE (Hermes standard): a run cannot be declared
        // complete until at least one verification command has PASSED since the last edit. The
        // SYSTEM_PROMPT tells the model this; this veto is what enforces it, so weak models can't
        // just assert "tests pass". forcePhase: 'verify' pushes the agent into the verify phase,
        // where run_command/tsc/pytest are offered and writes stay available for fixes.
        {
            name: 'testBeforeDone',
            async beforeDone({ session }) {
                if (!session.filesTouched?.length) return null; // no edits this run — nothing to verify here (gate covers chat-only)
                if (session.testRunsSinceEdit) return null;
                const meta = session.projectMeta || {};
                let cmdHint;
                if (meta.lintCmd || meta.testCmd) {
                    cmdHint = `the project's own command: ${[meta.lintCmd, meta.testCmd].filter(Boolean).join(' or ')}`;
                } else if (/\.py(\s|$)/.test(session.filesTouched.join(' '))) {
                    cmdHint = '`python3 -m py_compile` on each changed .py file, plus any test suite the project has (pytest / unittest)';
                } else {
                    cmdHint = '`node --check` on every new/changed .js file, then whatever test script package.json defines (npm test / npx jest); if no test script exists, run the main entry file with node to prove it loads without errors';
                }
                return {
                    veto: true,
                    messages: [
                        `TEST BEFORE DONE — you edited files but have not verified them since. Run ${cmdHint} and let it pass (exit 0) before declaring done.`
                    ],
                    forcePhase: 'verify'
                };
            }
        },
        // v54.6 stalePatchGuard — Hermes discipline: "If an edit fails to apply, re-read the
        // file for its current content instead of retrying the stale text." A failed write/patch
        // on a path means the model's picture of that file is wrong; retrying blind burns turns
        // and (for patches) can half-apply. Block further writes to that path until read_file
        // proves the model looked again. Cleared per-path on any successful read or write.
        {
            name: 'stalePatchGuard',
            async beforeTool({ session, payload }) {
                const { name, args } = payload;
                if (name === 'read_file') return null;
                if (!WRITE_TOOLS.has(name)) return null;
                const stale = session._staleWritePaths;
                if (!stale || !stale.size) return null;
                const rel = String(args?.path || '').replace(/\\/g, '/');
                if (rel && stale.has(rel)) {
                    return {
                        veto: true,
                        result: {
                            error: `BLOCKED: your last write/patch of "${rel}" FAILED — your copy of this file is stale. Call read_file on it first to see its CURRENT content, then retry the edit against what you actually read. Do not re-send the same text blind.`,
                            blockedReason: 'stale_write_retry',
                            phaseBlocked: false
                        }
                    };
                }
                return null;
            },
            async afterTool({ session, payload }) {
                const { name, args, toolResult, ok } = payload;
                if (!session._staleWritePaths) session._staleWritePaths = new Set();
                const stale = session._staleWritePaths;
                const rel = String(toolResult?.relPath || args?.path || '').replace(/\\/g, '/');
                if (!rel) return null;
                if (name === 'read_file' && ok) { stale.delete(rel); return null; }
                if (!WRITE_TOOLS.has(name)) return null;
                if (ok) stale.delete(rel);
                else stale.add(rel);
                return null;
            }
        },
        // v54.6 gatherBeforeChange — Hermes METHOD: "GATHER BEFORE CHANGING / VERIFY THE PREMISE."
        // A run that edited files but has read NOTHING since its last edit cannot know the code it
        // is finishing (fresh edits after a failed patch, or hallucinated context). One veto forces
        // a read pass; then it stays out of the way.
        {
            name: 'gatherBeforeChange',
            async beforeDone({ session }) {
                if (!session.filesTouched?.length) return null;
                if (session._gatherVetoed) return null;   // one-shot: advise once, never deadlock
                const readsSinceEdit = Number(session._readsSinceLastEdit || 0);
                if (readsSinceEdit > 0) return null;
                session._gatherVetoed = true;
                return {
                    veto: true,
                    messages: [
                        'GATHER BEFORE CHANGING — you edited files but have not read any file since your last edit. Before declaring done, read back what you changed (read_file on each touched file, or grep for the symbols you wired) and confirm the pieces actually connect: imports exist, ids/selectors match, callers use the new shape. Fix anything that does not line up.'
                    ]
                };
            }
        },
        // v54.6 backgroundJobsSettled — a run that started a background command (long build,
        // server) must KNOW how it ended before claiming done. While any job of this run is still
        // running, completion is refused once; the model then polls read_process_log and either
        // fixes the failure or declares done with evidence (second pass is allowed through so an
        // intentionally-persistent dev server can't deadlock the gate).
        {
            name: 'backgroundJobsSettled',
            async beforeDone({ ctx, session }) {
                if (!session._bgJobIds?.size) return null;
                const jobApi = ctx?.execDeps?.jobApi || ctx?.jobApi;
                if (typeof jobApi?.listJobs !== 'function') return null;
                let running = [];
                try {
                    running = (jobApi.listJobs() || []).filter(j => session._bgJobIds.has(String(j.job_id)) && j.running);
                } catch { return null; }
                if (!running.length) return null;
                const ids = running.map(j => j.job_id).join(', ');
                if (session._jobsVetoed) return null;    // warned once — model may be keeping a server up on purpose
                session._jobsVetoed = true;
                return {
                    veto: true,
                    messages: [
                        `BACKGROUND JOB STILL RUNNING (${ids}) — you cannot declare done while a command you backgrounded has not exited. Poll read_process_log for each job id until it reports an exit code. If it failed, read the output and fix; if it is only a server you intend to keep running, say so in your summary and finish.`
                    ]
                };
            }
        },
        // ghostTrace — optional trace hook (wired when ctx.trace present)
        {
            name: 'ghostTrace',
            async beforeTool({ ctx, payload }) {
                if (ctx.trace) ctx.trace.toolExecute(payload.name, true, 'start');
                return null;
            },
            async afterTool({ ctx, payload }) {
                /* trace.toolExecute called from turnLoop after result */
                return null;
            }
        }
    ];
}

async function runMiddlewareChain(middleware, hookName, hookCtx) {
    for (const mw of middleware) {
        const fn = mw[hookName];
        if (typeof fn !== 'function') continue;
        const out = await fn(hookCtx);
        if (out?.veto) return out;
    }
    return null;
}

function applyPhaseAdvance(session, payload) {
    const next = maybeAdvancePhase(session, payload);
    if (next && next !== session.phase) {
        session.phase = next;
        return true;
    }
    return false;
}

module.exports = {
    createDefaultMiddleware,
    runMiddlewareChain,
    applyPhaseAdvance,
    mergeSensorWarnings
};
