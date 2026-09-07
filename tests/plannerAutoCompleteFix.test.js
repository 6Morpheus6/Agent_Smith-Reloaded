/**
 * v52.5 — planner auto-complete regression tests.
 *
 * The v52.4 bug: on any workspace that already contains index.html/style.css/script.js
 * (previous attempt, resumed project), plan-step auto-advance marked EVERY step done
 * instantly without the model writing a single line; mark_code_step_done advanced steps
 * with zero evidence. The run then stalled on contradictory "all steps complete / gate
 * blocked" signals until the watchdog killed it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPlan, defaultPlan } = require('../src/code/plan/codePlan.js');
const {
    isStepSatisfied,
    isNewFile,
    autoAdvancePlanSteps
} = require('../src/code/plan/planStepAutoAdvance.js');
const { snapshotExistingFiles } = require('../src/code/context/fileScan.js');
const { executeTool } = require('../src/code/tools/executor.js');

function tmpProject(files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-planner-fix-'));
    for (const [name, content] of Object.entries(files)) {
        const p = path.join(root, name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, 'utf8');
    }
    return root;
}

// --- snapshotExistingFiles -------------------------------------------------

test('snapshotExistingFiles captures files incl. subdirs, skips ignored dirs', () => {
    const root = tmpProject({
        'index.html': '<html></html>',
        'style.css': 'body {}',
        'src/js/app.js': 'console.log(1);',
        'node_modules/junk/x.js': 'x'
    });
    const snap = snapshotExistingFiles(root);
    assert.ok(snap && typeof snap.files.has === 'function');
    assert.ok(snap.files.has('index.html'));
    assert.ok(snap.files.has('style.css'));
    assert.ok(snap.files.has('src/js/app.js'));
    assert.ok(!snap.files.has('node_modules/junk/x.js'), 'ignored dirs must not be snapshotted');
    assert.equal(typeof snap.hashes.get('index.html'), 'string', 'small files get content hashes');
    fs.rmSync(root, { recursive: true, force: true });
});

test('snapshotExistingFiles: null for falsy root, empty snapshot for missing path', () => {
    assert.equal(snapshotExistingFiles(null), null);
    const snap = snapshotExistingFiles('/nonexistent/path/xyz123');
    assert.ok(snap && snap.files.size === 0 && snap.hashes.size === 0);
});

// --- isNewFile -------------------------------------------------------------

test('isNewFile: touched file is evidence even if it pre-existed (rewrite)', () => {
    const root = tmpProject({ 'index.html': '<html></html>' });
    const snap = snapshotExistingFiles(root);
    assert.equal(isNewFile(root, 'index.html', ['index.html'], snap), true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('isNewFile: pre-existing untouched file is NOT evidence (the v52.4 bug)', () => {
    const root = tmpProject({ 'index.html': '<html></html>', 'style.css': 'body {}' });
    const snap = snapshotExistingFiles(root);
    assert.equal(isNewFile(root, 'index.html', [], snap), false);
    assert.equal(isNewFile(root, 'style.css', [], snap), false);
    fs.rmSync(root, { recursive: true, force: true });
});

test('isNewFile: file created after snapshot IS evidence; modified pre-existing file IS evidence', () => {
    const root = tmpProject({ 'index.html': '<html></html>' });
    const snap = snapshotExistingFiles(root);
    fs.writeFileSync(path.join(root, 'style.css'), 'body {}', 'utf8');
    assert.equal(isNewFile(root, 'style.css', [], snap), true);
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>new</body></html>', 'utf8');
    assert.equal(isNewFile(root, 'index.html', [], snap), true, 'content change = fresh');
    fs.rmSync(root, { recursive: true, force: true });
});

test('isNewFile: no snapshot falls back to plain disk existence (legacy callers)', () => {
    const root = tmpProject({ 'index.html': '<html></html>' });
    assert.equal(isNewFile(root, 'index.html', [], null), true);
    assert.equal(isNewFile(root, 'missing.js', [], undefined), false);
    fs.rmSync(root, { recursive: true, force: true });
});

// --- THE regression: pre-populated workspace must not auto-complete --------

test('REGRESSION: pre-existing app files do NOT satisfy create steps (v52.4 bug)', () => {
    const goal = 'Create a web app personal budget tracker with localStorage';
    // Workspace already contains a complete-looking app from an earlier attempt.
    const root = tmpProject({
        'index.html': '<html><body><div id="app"></div></body></html>',
        'style.css': 'body { margin: 0; }',
        'script.js': "localStorage.setItem('x','y');",
        'README.md': '# App\n'
    });
    const snap = snapshotExistingFiles(root);
    const plan = defaultPlan(goal);

    // v52.4 behavior: autoAdvancePlanSteps(plan, root, [], goal) advanced ALL 4 steps here.
    const r = autoAdvancePlanSteps(plan, root, [], goal, snap);
    assert.equal(r.advanced, 0, 'no work this run → no step may advance');
    assert.equal(plan.steps.every(s => s.status !== 'done'), true);

    // The model writes the first two deliverables → exactly one step advances.
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body></body></html>', 'utf8');
    const r2 = autoAdvancePlanSteps(plan, root, ['index.html', 'style.css'], goal, snap);
    assert.equal(r2.advanced, 1, 'only the html+css step is satisfied by this run\'s writes');

    fs.rmSync(root, { recursive: true, force: true });
});

test('REGRESSION: pre-existing UNCHANGED feature code does not satisfy feature steps', () => {
    const goal = 'Create a web app personal budget tracker with localStorage';
    // A previous attempt already implemented persistence + filters. This run has done nothing.
    const root = tmpProject({
        'index.html': '<html><body><input id="search-input"><form id="transaction-form"></form></body></html>',
        'script.js': [
            "let items = JSON.parse(localStorage.getItem('txns') || '[]');",
            "document.getElementById('search-input').addEventListener('input', render);",
            "function render(){ const v = items.filter(x => x.type === 'income'); }"
        ].join('\n')
    });
    const snap = snapshotExistingFiles(root);
    assert.equal(isStepSatisfied('Implement app state and localStorage persistence', root, [], goal, snap), false,
        'pre-existing unchanged localStorage code is not this run\'s evidence');
    assert.equal(isStepSatisfied('Implement core interactions (add/edit/delete, filters)', root, [], goal, snap), false);

    // The model modifies script.js → the feature step becomes satisfiable.
    fs.appendFileSync(path.join(root, 'script.js'), '\ndocument.getElementById("transaction-form").addEventListener("submit", () => { items.push({}); });\n', 'utf8');
    assert.equal(isStepSatisfied('Implement app state and localStorage persistence', root, ['script.js'], goal, snap), true);

    fs.rmSync(root, { recursive: true, force: true });
});

test('REGRESSION: without a snapshot (legacy) disk existence still satisfies', () => {
    const goal = 'Create a web app personal budget tracker';
    const root = tmpProject({
        'index.html': '<html></html>',
        'style.css': 'body {}'
    });
    const plan = defaultPlan(goal);
    // No snapshot → old behavior preserved for tests/legacy callers.
    const r = autoAdvancePlanSteps(plan, root, [], goal);
    assert.ok(r.advanced >= 1);
    fs.rmSync(root, { recursive: true, force: true });
});

test('REGRESSION: isStepSatisfied create steps require freshness with snapshot', () => {
    const root = tmpProject({ 'index.html': '<html></html>' });
    const snap = snapshotExistingFiles(root);
    assert.equal(isStepSatisfied('Create index.html with app structure', root, [], '', snap), false);
    assert.equal(isStepSatisfied('Create index.html with app structure', root, ['index.html'], '', snap), true);
    fs.rmSync(root, { recursive: true, force: true });
});

// --- mark_code_step_done evidence gate --------------------------------------

test('mark_code_step_done is REJECTED without verification since last edit', async () => {
    const session = {
        codePlan: createPlan('Build a budget tracker', ['Create index.html', 'Add styling']),
        agentRanOkAfterEdit: false,
        testRunsSinceEdit: false
    };
    const r = await executeTool('mark_code_step_done', {}, { session });
    assert.ok(r.error, 'must be rejected without evidence');
    assert.match(r.error, /no verification since your last edit/i);
    // Plan must be untouched.
    assert.equal(session.codePlan.steps[0].status, 'active');
    assert.equal(session.codePlan.currentStepIndex, 0);
});

test('mark_code_step_done advances after a passing verification command', async () => {
    const session = {
        codePlan: createPlan('Build a budget tracker', ['Create index.html', 'Add styling']),
        agentRanOkAfterEdit: true, // e.g. `node --check script.js` exited 0 since last edit
        testRunsSinceEdit: false
    };
    const r = await executeTool('mark_code_step_done', {}, { session });
    assert.equal(r.success, true);
    assert.equal(r.advanced, true);
    assert.equal(session.codePlan.steps[0].status, 'done');
    assert.equal(session.codePlan.currentStepIndex, 1);
});

test('mark_code_step_done advances after a passing test run (testRunsSinceEdit)', async () => {
    const session = {
        codePlan: createPlan('Build a budget tracker', ['Create index.html']),
        agentRanOkAfterEdit: false,
        testRunsSinceEdit: true // e.g. `npm test` exited 0 since last edit
    };
    const r = await executeTool('mark_code_step_done', {}, { session });
    assert.equal(r.success, true);
});

test('mark_code_step_done still errors without an active plan', async () => {
    const r = await executeTool('mark_code_step_done', {}, { session: {} });
    assert.ok(r.error);
});
