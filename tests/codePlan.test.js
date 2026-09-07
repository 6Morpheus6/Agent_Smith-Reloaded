/**
 * Code plan model — step normalization and advancement.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    createPlan, defaultPlan, normalizeSteps, markApproved, advanceStep, stepProgress, toContextBlock
} = require('../src/code/plan/codePlan.js');

test('normalizeSteps drops empty titles and caps count', () => {
    const steps = normalizeSteps(['One', '', 'Two', 'Three']);
    assert.equal(steps.length, 3);
    assert.equal(steps[0].title, 'One');
    assert.ok(steps[0].id);
});

test('createPlan activates first step', () => {
    const plan = createPlan('Build app', ['Explore', 'Implement', 'Verify']);
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[0].status, 'active');
    assert.equal(plan.steps[1].status, 'pending');
    assert.equal(plan.currentStepIndex, 0);
});

test('defaultPlan provides fallback steps', () => {
    const plan = defaultPlan('Fix the login bug');
    assert.ok(plan.steps.length >= 3);
    assert.equal(plan.steps[0].status, 'active');
});

test('markApproved stamps approval time', () => {
    const plan = createPlan('Task', ['A', 'B']);
    markApproved(plan);
    assert.ok(plan.approvedAt > 0);
});

test('advanceStep marks done and activates next', () => {
    const plan = createPlan('Task', ['A', 'B', 'C']);
    markApproved(plan);
    const r1 = advanceStep(plan);
    assert.equal(r1.advanced, true);
    assert.equal(r1.complete, false);
    assert.equal(plan.steps[0].status, 'done');
    assert.equal(plan.steps[1].status, 'active');
    const r2 = advanceStep(plan);
    assert.equal(r2.complete, false);
    const r3 = advanceStep(plan);
    assert.equal(r3.complete, true);
    assert.equal(plan.steps[2].status, 'done');
});

test('createPlan replaces explore-first step for new artifact goals', () => {
    const goal = 'Create a web based pac-man game and show preview';
    const plan = createPlan(goal, ['Explore project layout', 'Implement files', 'Verify']);
    assert.match(plan.steps[0].title, /Create required files/i);
    assert.equal(plan.steps[0].status, 'active');
});

test('defaultPlan for new artifact skips explore', () => {
    const plan = defaultPlan('Create a web based pac-man game');
    assert.match(plan.steps[0].title, /Create required files/i);
    assert.doesNotMatch(plan.steps[0].title, /explore/i);
    assert.equal(plan.steps[0].status, 'active');
});

test('stepProgress and context block reflect state', () => {
    const plan = createPlan('Task', ['Alpha', 'Beta']);
    markApproved(plan);
    const prog = stepProgress(plan);
    assert.equal(prog.total, 2);
    assert.equal(prog.current, 1);
    const block = toContextBlock(plan);
    assert.match(block, /APPROVED PLAN/);
    assert.match(block, /Alpha/);
});
