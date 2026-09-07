/**
 * Workflow phases — shrink tool surface per stage for small models.
 */
'use strict';

const fs = require('fs');
const { isNonTrivialTask } = require('../context/planArtifacts.js');
const { goalImpliesNewArtifacts } = require('../context/artifactHints.js');
const { HOST_TOOLS } = require('../tools/schemas.js');

// v50: host-control tools are available in EVERY phase. The harness is all-purpose —
// a run may need to read /etc, check processes, or search the web on turn one; only
// the project BUILD surface (writes/shell) stays phase-gated for small models.
const PHASE_TOOLS = {
    explore: ['read_file', 'grep', 'glob', 'list_project', 'show_preview'].concat(HOST_TOOLS),
    // v52.6 — run_code (dsh Code Mode transport) joins implement + verify: programs can
    // write through sub-calls, so it is withheld from explore (read-only) and from the
    // empty-workspace write-first turn (WRITE_OR_HOST below), where direct writes win.
    // v53.7 — run_command joins implement: "create X … then run it to confirm" tasks are
    // the common case, and without shell in implement the model could write files but never
    // execute them (phase only advances to verify at turn ≥ 8 / milestones done), so runs
    // stalled re-reading their own plan artifacts. run_code's sub-tool surface mirrors the
    // offered set, so this also fixes `tools.run_command is not a function` inside programs.
    implement: ['read_file', 'grep', 'glob', 'list_project', 'write_file', 'append_file', 'patch', 'run_command', 'run_code', 'show_preview', 'mark_code_step_done'].concat(HOST_TOOLS),
    // Writes stay available in verify so the agent can fix gate failures (missing refs, syntax, etc.).
    verify: ['read_file', 'grep', 'glob', 'run_command', 'list_project', 'write_file', 'append_file', 'patch', 'run_code', 'show_preview', 'browser_verify', 'query_run_trace', 'mark_code_step_done'].concat(HOST_TOOLS)
};

const WRITE_TOOLS = new Set(['write_file', 'append_file', 'patch']);

// Tools offered on the FIRST write turn of an empty workspace: there is nothing to read,
// grep, list, or preview, so offering those just invites weak models to waste turns
// exploring an empty folder before creating any files. Restrict to writes (+ step-done).
const WRITE_FIRST_TOOLS = new Set(['write_file', 'append_file', 'patch', 'mark_code_step_done']);

// v50: host-control tools are ALSO offered on that first write turn — even a greenfield
// build may need web_search / process inspection before the first file exists. The router
// filters by this set when writeOnly is on.
const WRITE_OR_HOST = new Set(WRITE_FIRST_TOOLS);
for (const n of HOST_TOOLS) WRITE_OR_HOST.add(n);

function initialPhase() {
    return 'explore';
}

function allowedToolsForPhase(phase) {
    return PHASE_TOOLS[phase] || PHASE_TOOLS.implement;
}

function isToolAllowed(phase, toolName) {
    return allowedToolsForPhase(phase).includes(toolName);
}

function phaseHint(phase) {
    const hints = {
        explore: 'Phase: EXPLORE — read and search only. No write_file, append_file, or patch until you understand the project.',
        implement: 'Phase: IMPLEMENT — write_file (complete files), patch (change existing code; replace_all for repeated text), append_file (extend only). Verify syntax after each write.',
        verify: 'Phase: VERIFY — run tests/commands and read files. Use write_file/append_file/patch to fix issues before declaring done.'
    };
    return hints[phase] || hints.implement;
}

/**
 * Advance phase based on turn activity.
 * @returns {string|null} new phase if changed
 */
function maybeAdvancePhase(session, { lastTool, toolWasWrite }) {
    const cur = session.phase || 'explore';
    if (cur === 'explore') {
        if (toolWasWrite || (session.turn >= 3 && lastTool === 'read_file')) {
            return 'implement';
        }
    }
    if (cur === 'implement') {
        const allMilestonesDone = session.planArtifacts?.milestones?.every(m => m.done);
        if (allMilestonesDone || (toolWasWrite && session.turn >= 8)) {
            return 'verify';
        }
    }
    return null;
}

function phaseGateError(phase, toolName) {
    const next = phase === 'explore'
        ? 'Read the project first (read_file, grep, list_project). Writes unlock in implement phase after turn 3 or first read.'
        : phase === 'verify'
            ? 'Use read_file, grep, run_command to verify. Use write_file/patch to fix any remaining issues.'
            : 'Complete exploration before writing.';
    // `error` is a STRING (consistent with every other tool result) so consumers that
    // read result.error as text don't break; phaseBlocked carries the structured signal.
    return {
        error: `Tool "${toolName}" is not available in ${phase} phase. ${next}`,
        phaseBlocked: true,
        message: `Tool "${toolName}" is not available in ${phase} phase. ${next}`
    };
}

const SKIP_DIRS = new Set(['.agentsmith', '.git', 'node_modules', 'dist']);

/** Empty or nearly empty workspace — greenfield scaffold tasks should write immediately. */
function isGreenfieldWorkspace(projectRoot, treeSummary) {
    try {
        const entries = fs.readdirSync(projectRoot).filter((e) => {
            if (SKIP_DIRS.has(e)) return false;
            if (e.startsWith('.') && e !== '.') return false;
            return true;
        });
        const meaningful = entries.filter(e => e !== '.agentsmith');
        if (meaningful.length === 0) return true;
    } catch (e) { /* fall through */ }
    const t = String(treeSummary || '').trim();
    if (!t || t === '[]' || t === '{}' || t.length < 24) return true;
    return false;
}

/**
 * Greenfield build tasks start in implement (write tools available turn 1).
 * Brownfield / non-build tasks stay in explore first.
 */
function resolveInitialPhase({ projectRoot, treeSummary, goal }) {
    if (!isNonTrivialTask(goal)) return initialPhase();
    if (isGreenfieldWorkspace(projectRoot, treeSummary)) return 'implement';
    // Brownfield but task is "create/build a new game/app" — writes unlock turn 1.
    if (goalImpliesNewArtifacts(goal)) return 'implement';
    return initialPhase();
}

module.exports = {
    PHASE_TOOLS,
    WRITE_TOOLS,
    WRITE_FIRST_TOOLS,
    WRITE_OR_HOST,
    initialPhase,
    resolveInitialPhase,
    isGreenfieldWorkspace,
    goalImpliesNewArtifacts,
    allowedToolsForPhase,
    isToolAllowed,
    phaseHint,
    maybeAdvancePhase,
    phaseGateError
};
