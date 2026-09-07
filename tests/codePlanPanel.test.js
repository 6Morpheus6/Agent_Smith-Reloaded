/**
 * Plan panel + sidebar layout contracts (logic-only; DOM wiring is manual smoke).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { defaultPlan, createPlan, stepProgress } = require('../src/code/plan/codePlan.js');
const { PHASE_TOOLS, isToolAllowed } = require('../src/code/loop/phases.js');

test('defaultPlan for build tasks starts at implement step title', () => {
    const plan = defaultPlan('Create a web based pac-man game');
    assert.match(plan.steps[0].title, /Create required files/i);
});

test('createPlan rewrites explore-first steps for new artifact goals', () => {
    const plan = createPlan('Create a web game', ['Explore layout', 'Implement', 'Verify']);
    assert.match(plan.steps[0].title, /Create required files/i);
});

test('stepProgress reports active step index', () => {
    const plan = createPlan('Task', ['A', 'B']);
    const prog = stepProgress(plan);
    assert.equal(prog.current, 1);
    assert.equal(prog.total, 2);
});

test('verify phase includes write tools for gate fixes', () => {
    assert.ok(PHASE_TOOLS.verify.includes('write_file'));
    assert.ok(PHASE_TOOLS.verify.includes('patch'));
    assert.equal(isToolAllowed('verify', 'write_file'), true);
});
