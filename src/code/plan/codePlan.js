/**
 * Code Mode user-approved plan — ordered steps the harness tracks during execution.
 */
'use strict';

const crypto = require('crypto');
const { goalImpliesNewArtifacts, goalIsGame } = require('../context/artifactHints.js');

function stepId() {
    return `s_${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeSteps(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list
        .map((s, i) => {
            const title = String(s?.title || s?.text || s || '').trim();
            if (!title) return null;
            return {
                id: s.id || stepId(),
                title: title.slice(0, 500),
                status: s.status || 'pending'
            };
        })
        .filter(Boolean)
        .slice(0, 16);
}

function isExploreStep(title) {
    return /\bexplore\b/i.test(String(title || ''));
}

/** Collapse overly granular model plans (10+ feature steps) into trackable milestones. */
function collapseGranularWebPlan(steps, goal) {
    if (!goalImpliesNewArtifacts(goal) || goalIsGame(goal)) return steps;
    if (!Array.isArray(steps) || steps.length <= 8) return steps;
    return [
        { title: 'Create index.html with app structure and UI elements', status: 'active' },
        { title: 'Create style.css for layout and theme', status: 'pending' },
        { title: 'Create script.js with core app logic', status: 'pending' },
        { title: 'Implement localStorage, CRUD, filters, and interactions in script.js', status: 'pending' },
        { title: 'Create README.md and verify linked assets load', status: 'pending' }
    ].map(s => ({ id: stepId(), ...s }));
}

function createPlan(goal, steps) {
    let normalized = normalizeSteps(steps);
    if (!normalized.length) {
        return defaultPlan(goal);
    }
    normalized = collapseGranularWebPlan(normalized, goal);
    // Plans that start with "Explore" stall greenfield builds — jump to implement.
    if (goalImpliesNewArtifacts(goal) && isExploreStep(normalized[0]?.title)) {
        normalized[0] = {
            id: normalized[0].id || stepId(),
            title: 'Create required files (HTML, CSS, JS)',
            status: 'active'
        };
    } else {
        normalized[0].status = 'active';
    }
    return {
        goal: String(goal || '').trim(),
        steps: normalized,
        currentStepIndex: 0,
        approvedAt: null
    };
}

/** Build steps for a new GAME (game-specific wording is appropriate here). */
function gameBuildSteps() {
    return [
        { id: stepId(), title: 'Create required files (HTML, CSS, JS)', status: 'active' },
        { id: stepId(), title: 'Implement game logic — input, game loop, win/lose, scoring', status: 'pending' },
        { id: stepId(), title: 'Verify game behavior and show preview', status: 'pending' }
    ];
}

/** Build steps for a generic interactive web app (NO game-specific wording). */
function webAppBuildSteps() {
    return [
        { id: stepId(), title: 'Create HTML structure and responsive styling', status: 'active' },
        { id: stepId(), title: 'Implement app state and localStorage persistence', status: 'pending' },
        { id: stepId(), title: 'Implement core interactions (add/edit/delete, filters, totals)', status: 'pending' },
        { id: stepId(), title: 'Verify interactive app behavior and linked assets, then show preview', status: 'pending' }
    ];
}

function defaultPlan(goal) {
    const g = String(goal || '').toLowerCase();
    // New deliverable: branch by task type so a budget tracker doesn't get game wording.
    if (goalImpliesNewArtifacts(goal)) {
        return {
            goal: String(goal || '').trim(),
            steps: goalIsGame(goal) ? gameBuildSteps() : webAppBuildSteps(),
            currentStepIndex: 0,
            approvedAt: null
        };
    }
    const steps = g.includes('fix') || g.includes('bug')
        ? [
            { id: stepId(), title: 'Read and locate the issue', status: 'active' },
            { id: stepId(), title: 'Apply targeted fixes', status: 'pending' },
            { id: stepId(), title: 'Verify tests or syntax', status: 'pending' }
        ]
        : [
            { id: stepId(), title: 'Explore project layout and constraints', status: 'active' },
            { id: stepId(), title: 'Implement required files', status: 'pending' },
            { id: stepId(), title: 'Verify and polish', status: 'pending' }
        ];
    return {
        goal: String(goal || '').trim(),
        steps,
        currentStepIndex: 0,
        approvedAt: null
    };
}

function markApproved(plan) {
    if (!plan) return plan;
    plan.approvedAt = Date.now();
    if (plan.steps[0]) plan.steps[0].status = 'active';
    plan.currentStepIndex = 0;
    return plan;
}

function currentStep(plan) {
    if (!plan?.steps?.length) return null;
    const idx = plan.currentStepIndex ?? 0;
    return plan.steps[idx] || null;
}

function advanceStep(plan) {
    if (!plan?.steps?.length) return { advanced: false };
    const idx = plan.currentStepIndex ?? 0;
    if (plan.steps[idx]) plan.steps[idx].status = 'done';
    const next = idx + 1;
    if (next >= plan.steps.length) {
        plan.currentStepIndex = plan.steps.length - 1;
        return { advanced: true, complete: true };
    }
    plan.currentStepIndex = next;
    plan.steps[next].status = 'active';
    return { advanced: true, complete: false, stepIndex: next };
}

function stepProgress(plan) {
    if (!plan?.steps?.length) return { current: 0, total: 0, label: '' };
    const total = plan.steps.length;
    const done = plan.steps.filter(s => s.status === 'done').length;
    const cur = currentStep(plan);
    const current = (plan.currentStepIndex ?? 0) + 1;
    return {
        current,
        total,
        done,
        label: cur ? cur.title : '',
        steps: plan.steps
    };
}

function toContextBlock(plan, goal) {
    if (!plan?.steps?.length) return '';
    const prog = stepProgress(plan);
    const lines = ['[APPROVED PLAN — follow in order]'];
    plan.steps.forEach((s, i) => {
        const mark = s.status === 'done' ? 'x' : (i === plan.currentStepIndex ? '>' : ' ');
        lines.push(`  [${mark}] ${i + 1}. ${s.title}`);
    });
    lines.push('', `FOCUS NOW (step ${prog.current}/${prog.total}, ${prog.done} done): ${prog.label}`);
    if (goalImpliesNewArtifacts(goal) && isExploreStep(prog.label)) {
        lines.push('This is a greenfield build — use write_file to create files now; do not spend turns only reading.');
    } else {
        lines.push('Call mark_code_step_done when the current step is complete before moving on.');
    }
    return lines.join('\n');
}

/** Skip a stale explore step once the agent has started writing. */
function advancePastExploreIfNeeded(plan, goal) {
    if (!plan?.steps?.length || !goalImpliesNewArtifacts(goal)) return false;
    const cur = currentStep(plan);
    if (!cur || !isExploreStep(cur.title)) return false;
    advanceStep(plan);
    return true;
}

module.exports = {
    createPlan,
    defaultPlan,
    normalizeSteps,
    markApproved,
    currentStep,
    advanceStep,
    stepProgress,
    toContextBlock,
    advancePastExploreIfNeeded,
    isExploreStep,
    collapseGranularWebPlan
};
