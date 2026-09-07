/**
 * Plan step auto-advance heuristics and idempotency.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPlan, defaultPlan } = require('../src/code/plan/codePlan.js');
const {
    isStepSatisfied,
    autoAdvancePlanSteps,
    buildStalePlanStepNudge,
    buildPlanCompleteGateNudge,
    collectPlanBlockers,
    domContractClean,
    planProgressPayload,
    fileExists
} = require('../src/code/plan/planStepAutoAdvance.js');

function tmpProject(files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-plan-'));
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(root, name), content, 'utf8');
    }
    return root;
}

const MATCHING_HTML = `<!DOCTYPE html>
<html><body>
<form id="transaction-form">
  <input id="transaction-type"><input id="transaction-description">
  <input id="search-input"><button id="export-btn"></button>
  <p id="total-income"></p><p id="total-expenses"></p><p id="current-balance"></p>
</form></body></html>`;

const BROKEN_JS = `
document.getElementById('searchInput').addEventListener('input', () => {});
document.getElementById('totalIncome').textContent = '0';
localStorage.setItem('a', 'b');
items.filter(x => x.type === 'income');
document.getElementById('transaction-form').addEventListener('submit', () => {});
`;

const FIXED_JS = `
let items = JSON.parse(localStorage.getItem('txns') || '[]');
document.getElementById('search-input').addEventListener('input', render);
document.getElementById('transaction-form').addEventListener('submit', (e) => {
  e.preventDefault();
  items.push({ type: 'income', amount: 1 });
  localStorage.setItem('txns', JSON.stringify(items));
  render();
});
function render() {
  const visible = items.filter(x => x.type === 'income');
  document.getElementById('total-income').textContent = visible.length;
}
render();
`;

test('isStepSatisfied matches index.html, style.css, script.js steps', () => {
    const root = tmpProject({
        'index.html': '<html></html>',
        'style.css': 'body {}',
        'script.js': 'console.log(1);'
    });
    assert.equal(isStepSatisfied('Create index.html with app structure', root, []), true);
    assert.equal(isStepSatisfied('Create style.css for layout', root, []), true);
    assert.equal(isStepSatisfied('Create script.js with core logic', root, []), true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('isStepSatisfied uses filesTouched when disk empty', () => {
    const root = tmpProject();
    assert.equal(isStepSatisfied('Create index.html', root, ['index.html']), true);
    assert.equal(isStepSatisfied('Add styling', root, ['style.css']), true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('isStepSatisfied detects localStorage when DOM ids match HTML', () => {
    const root = tmpProject({
        'index.html': MATCHING_HTML,
        'script.js': FIXED_JS
    });
    assert.equal(isStepSatisfied('Implement localStorage persistence', root, []), true);
    assert.equal(isStepSatisfied('Add filter by type', root, []), true);
    assert.equal(isStepSatisfied('Wire up transaction form', root, []), true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('isStepSatisfied rejects JS-heavy steps when DOM ids mismatch HTML', () => {
    const root = tmpProject({
        'index.html': MATCHING_HTML,
        'script.js': BROKEN_JS
    });
    assert.equal(domContractClean(root), false);
    assert.equal(isStepSatisfied('Implement localStorage persistence', root, []), false);
    assert.equal(isStepSatisfied('Implement core interactions (add/edit/delete)', root, []), false);
    assert.equal(isStepSatisfied('Verify interactive app behavior', root, [], 'Create README.md app'), false);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TIGHTENED: incidental keywords do NOT mark a step done', () => {
    // .filter() used only for a total, no filter UI; "theme"/"category" merely mentioned;
    // ES module import/export keywords (not a data import/export feature).
    const root = tmpProject({
        'index.html': MATCHING_HTML,
        'script.js': "import { x } from './y.js';\nexport const z = 1;\n"
            + "const total = [].filter(t => t.type === 'income').length;\n"
            + "// supports a theme and category later\n"
    });
    assert.equal(isStepSatisfied('Add filter by type', root, []), false, 'incidental .filter() is not a filter feature');
    assert.equal(isStepSatisfied('Implement import/export to JSON', root, []), false, 'ES import/export keyword is not data import/export');
    assert.equal(isStepSatisfied('Add a theme toggle', root, []), false, 'mentioning theme is not a toggle');
    assert.equal(isStepSatisfied('Group by category', root, []), false, 'mentioning category is not implementing it');
    fs.rmSync(root, { recursive: true, force: true });
});

test('TIGHTENED: real implementations DO satisfy their steps', () => {
    const root = tmpProject({
        'index.html': MATCHING_HTML,
        'script.js': FIXED_JS
            + "\nfunction exportData(){ const b = new Blob([JSON.stringify(items)]); URL.createObjectURL(b); }"
            + "\ndocument.body.addEventListener('click', () => document.documentElement.classList.toggle('dark'));"
    });
    assert.equal(isStepSatisfied('Add filter by type', root, []), true);   // input listener + .filter()
    assert.equal(isStepSatisfied('Wire up transaction form', root, []), true); // submit + push
    assert.equal(isStepSatisfied('Implement core interactions (add/edit/delete)', root, []), true); // listener + push
    assert.equal(isStepSatisfied('Import/export data as JSON', root, []), true); // JSON.stringify + Blob
    assert.equal(isStepSatisfied('Add a theme toggle', root, []), true); // classList.toggle('dark')
    fs.rmSync(root, { recursive: true, force: true });
});

test('verify step requires README and clean DOM when goal names README.md', () => {
    const goal = 'Create README.md and index.html budget tracker';
    const root = tmpProject({
        'index.html': MATCHING_HTML,
        'script.js': FIXED_JS
    });
    assert.equal(isStepSatisfied('Verify interactive app behavior', root, [], goal), false);
    fs.writeFileSync(path.join(root, 'README.md'), '# App\n');
    assert.equal(isStepSatisfied('Verify interactive app behavior', root, [], goal), true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('autoAdvancePlanSteps stops at interactions when DOM broken', () => {
    const goal = 'Create a web app budget tracker with README.md';
    const plan = defaultPlan(goal);
    const root = tmpProject({
        'index.html': MATCHING_HTML,
        'style.css': 'body {}',
        'script.js': BROKEN_JS
    });
    const r = autoAdvancePlanSteps(plan, root, ['index.html', 'style.css', 'script.js'], goal);
    assert.ok(r.advanced >= 1, 'html+css step should advance');
    assert.ok(r.advanced < 4, 'should not reach verify with broken DOM');
    const done = plan.steps.filter(s => s.status === 'done').length;
    assert.ok(done < 4, `expected <4 done, got ${done}`);
    fs.rmSync(root, { recursive: true, force: true });
});

test('autoAdvancePlanSteps advances through verify when DOM clean and README present', () => {
    const goal = 'Create a web app budget tracker with README.md';
    const plan = defaultPlan(goal);
    const root = tmpProject({
        'index.html': MATCHING_HTML,
        'style.css': 'body {}',
        'script.js': FIXED_JS,
        'README.md': '# Budget Tracker\n'
    });
    const r = autoAdvancePlanSteps(plan, root, ['index.html', 'style.css', 'script.js', 'README.md'], goal);
    assert.equal(r.advanced, 4);
    assert.equal(plan.steps.every(s => s.status === 'done'), true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('autoAdvancePlanSteps is idempotent on second call', () => {
    const goal = 'Create a budget tracker';
    const plan = createPlan(goal, ['Create index.html', 'Create style.css']);
    const root = tmpProject({ 'index.html': '<html></html>' });
    const first = autoAdvancePlanSteps(plan, root, ['index.html'], goal);
    assert.equal(first.advanced, 1);
    const snap = JSON.stringify(plan);
    const second = autoAdvancePlanSteps(plan, root, ['index.html'], goal);
    assert.equal(second.advanced, 0);
    assert.equal(JSON.stringify(plan), snap);
    fs.rmSync(root, { recursive: true, force: true });
});

test('collectPlanBlockers reports README and DOM issues', () => {
    const goal = 'Build README.md index.html script.js app';
    const root = tmpProject({
        'index.html': MATCHING_HTML,
        'script.js': BROKEN_JS
    });
    const b = collectPlanBlockers(root, goal);
    assert.ok(b.count >= 2);
    assert.ok(b.messages.some(m => /README/i.test(m)));
    assert.ok(b.messages.some(m => /^\[DOM\]/i.test(m)));
    fs.rmSync(root, { recursive: true, force: true });
});

test('planProgressPayload marks complete only when blockers clear', () => {
    const goal = 'Create README.md web app';
    const plan = defaultPlan(goal);
    plan.steps.forEach(s => { s.status = 'done'; });
    const root = tmpProject({
        'index.html': MATCHING_HTML,
        'script.js': BROKEN_JS
    });
    const payload = planProgressPayload(plan, root, goal, []);
    assert.equal(payload.gateBlockerCount > 0, true);
    assert.equal(payload.complete, false);
    fs.rmSync(root, { recursive: true, force: true });
});

test('buildPlanCompleteGateNudge lists blockers and patch guidance', () => {
    const nudge = buildPlanCompleteGateNudge('README.md app', '/tmp', [
        '[ARTIFACT] README.md is required by the prompt but missing',
        '[DOM] script references #searchInput but no element with id="searchInput" exists'
    ]);
    assert.match(nudge, /PLAN COMPLETE/);
    assert.match(nudge, /README/);
    assert.match(nudge, /patch script/i);
});

test('buildStalePlanStepNudge fires after 2+ turns when html exists', () => {
    const plan = createPlan('Budget tracker', ['Create index.html structure', 'Style the app']);
    const root = tmpProject({ 'index.html': '<html></html>' });
    const nudge = buildStalePlanStepNudge(plan, root, ['index.html'], 'Budget tracker', 3);
    assert.match(nudge, /Step 1/);
    assert.match(nudge, /index\.html/);
    assert.equal(buildStalePlanStepNudge(plan, root, [], 'Budget tracker', 1), '');
    fs.rmSync(root, { recursive: true, force: true });
});

test('collapseGranularWebPlan via createPlan reduces 12-step web plans', () => {
    const goal = 'Create a web app personal budget tracker with localStorage';
    const many = Array.from({ length: 12 }, (_, i) => `Feature step ${i + 1}`);
    const plan = createPlan(goal, many);
    assert.ok(plan.steps.length <= 6, `expected <=6 steps, got ${plan.steps.length}`);
});

test('goalImpliesNewArtifacts recognizes budget tracker', () => {
    const { goalImpliesNewArtifacts } = require('../src/code/context/artifactHints.js');
    assert.equal(goalImpliesNewArtifacts('Build a personal budget tracker'), true);
});
