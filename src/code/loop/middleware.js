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
