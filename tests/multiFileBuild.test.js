/**
 * v52.4 — multi-file builds + step-3 loop regression.
 * The plan auto-advance must accept ANY file layout (multi-file, subdir, inline) so a run
 * can never hard-loop on a JS/CSS step because the model chose a different structure.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { defaultPlan } = require('../src/code/plan/codePlan.js');
const {
    isStepSatisfied,
    autoAdvancePlanSteps,
    htmlHasInlineJs,
    htmlHasInlineCss,
    htmlHasLinkedJs
} = require('../src/code/plan/planStepAutoAdvance.js');

function tmpProject(files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-v524-'));
    for (const [name, content] of Object.entries(files)) {
        const abs = path.join(root, name);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }
    return root;
}

function cleanup(root) {
    fs.rmSync(root, { recursive: true, force: true });
}

const GOAL = 'Create a web app budget tracker';

test('inline single-file build satisfies JS + CSS steps (no step-3 loop)', () => {
    const root = tmpProject({
        'index.html': `<!DOCTYPE html>
<html><head><style>body{margin:0;font-family:sans-serif}.card{border:1px solid #ccc;padding:8px}</style></head>
<body><form id="tx-form"><input id="amount"></form>
<script>
let items = JSON.parse(localStorage.getItem('items') || '[]');
document.getElementById('tx-form').addEventListener('submit', (e) => {
  e.preventDefault();
  items.push({ amount: document.getElementById('amount').value });
  localStorage.setItem('items', JSON.stringify(items));
});
</script></body></html>`
    });
    assert.equal(htmlHasInlineJs(root), true);
    assert.equal(htmlHasInlineCss(root), true);
    assert.equal(isStepSatisfied('Create HTML structure and responsive styling', root, []), true);
    assert.equal(isStepSatisfied('Implement app state and localStorage persistence', root, [], GOAL), true);
    const plan = defaultPlan(GOAL);
    const r = autoAdvancePlanSteps(plan, root, ['index.html'], GOAL);
    // Must advance past the JS steps — previously it stalled on step 3 forever.
    assert.ok(r.advanced >= 2, `expected >=2 advanced for inline build, got ${r.advanced}`);
    cleanup(root);
});

test('multi-file build with non-canonical names satisfies steps', () => {
    const root = tmpProject({
        'index.html': '<html><head><link rel="stylesheet" href="css/main.css"></head><body><div id="app"></div><script src="js/app.js"></script></body></html>',
        'css/main.css': 'body{margin:0}',
        'js/app.js': "document.getElementById('app');\nlocalStorage.setItem('a','b');"
    });
    assert.equal(htmlHasLinkedJs(root), true);
    assert.equal(isStepSatisfied('Create HTML structure and responsive styling', root, []), true);
    assert.equal(isStepSatisfied('Implement app state and localStorage persistence', root, [], GOAL), true);
    cleanup(root);
});

test('subdir deliverable (app/index.html) satisfies steps via linked refs', () => {
    const root = tmpProject({
        'app/index.html': '<html><head><link rel="stylesheet" href="style.css"></head><body><script src="script.js"></script></body></html>',
        'app/style.css': 'body{margin:0}',
        'app/script.js': "localStorage.setItem('a','b');"
    });
    assert.equal(isStepSatisfied('Create HTML structure and responsive styling', root, []), true);
    assert.equal(isStepSatisfied('Implement app state and localStorage persistence', root, [], GOAL), true);
    cleanup(root);
});

test('tiny inline snippets do NOT count as a JS/CSS build', () => {
    const root = tmpProject({
        'index.html': '<html><head><style>body{}</style></head><body><script>console.log(1)</script></body></html>'
    });
    assert.equal(htmlHasInlineJs(root), false, 'trivial inline script is not a build');
    assert.equal(htmlHasInlineCss(root), false, 'trivial inline style is not a build');
    cleanup(root);
});

test('linked external CDN scripts do NOT count as local JS', () => {
    const root = tmpProject({
        'index.html': '<html><body><script src="https://cdn.example.com/lib.js"></script></body></html>'
    });
    assert.equal(htmlHasLinkedJs(root), false);
    cleanup(root);
});

test('buildMultiFileNudge tells the model to split files', () => {
    const { buildMultiFileNudge } = require('../src/code/context/artifactHints.js');
    const nudge = buildMultiFileNudge(GOAL);
    assert.match(nudge, /MULTI-FILE BUILD/);
    assert.match(nudge, /style\.css/);
    assert.match(nudge, /script\.js/);
});
