const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { runValidation, checkCompletion } = require('../../../src/code/governor/completionGate.js');
const { PlanArtifacts } = require('../../../src/code/context/planArtifacts.js');
const { runMiddlewareChain, createDefaultMiddleware } = require('../../../src/code/loop/middleware.js');
const { runPostEditChecks } = require('../../../src/code/governor/postEditChecks.js');
const { compactForPhaseTransition } = require('../../../src/code/context/phaseCompact.js');
const { PlanAnchor } = require('../../../src/code/context/planAnchor.js');

test('pacman-complete fixture passes validation', async () => {
    const root = path.join(__dirname, '..', '..', '..', 'examples', 'pacman');
    const r = await runValidation(root, ['index.html', 'style.css', 'script.js'], 'Build Pac-Man');
    assert.equal(r.status, 'done');
});

test('plan-artifacts-created for build prompt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plan-'));
    const pa = await PlanArtifacts.ensure(root, 'build a todo app');
    assert.equal(pa.enabled, true);
});

test('phase-gate-explore rejects write via middleware', async () => {
    const mw = createDefaultMiddleware({});
    const veto = await runMiddlewareChain(mw, 'beforeTool', {
        ctx: {},
        session: { phase: 'explore' },
        payload: { name: 'patch', args: {}, dup: false }
    });
    assert.equal(veto.veto, true);
});

test('post-edit-lint-surfaces-warning via project rule sensor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'he-postedit-'));
    const rulesDir = path.join(root, '.agentsmith', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'no-x.js'), `
module.exports = {
    id: 'no-x',
    match: () => true,
    check: async (ctx) => /MARKER/.test(ctx.content)
        ? { ok: false, message: 'MARKER found', fix: 'Remove MARKER' } : { ok: true }
};
`);
    fs.writeFileSync(path.join(root, 'file.js'), 'const MARKER = 1;\n');
    const sensor = await runPostEditChecks(root, 'file.js', {}, {});
    assert.ok(sensor.warnings.length > 0);
});

test('grind-blocks-done-on-test-fail', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'he-grind-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        scripts: { test: 'node -e "process.exit(1)"' }
    }));
    fs.writeFileSync(path.join(root, 'lib.js'), 'module.exports = {};\n');
    const gate = await checkCompletion(root, ['lib.js'], 'build lib', {
        grindMode: true,
        projectMeta: { testCmd: 'npm test' }
    });
    assert.equal(gate.allow, false);
    assert.ok(gate.messages.some(m => /\[TEST FAILED\]/.test(m)));
});

test('playwright-grind-blocks-on-failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'he-e2e-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        scripts: { 'test:e2e': 'node -e "process.exit(1)"', test: 'node -e "process.exit(0)"' }
    }));
    fs.writeFileSync(path.join(root, 'lib.js'), 'module.exports = {};\n');
    const gate = await checkCompletion(root, ['lib.js'], 'build lib', {
        grindMode: true,
        projectMeta: { testCmd: 'npm test', e2eCmd: 'npm run test:e2e' }
    });
    assert.equal(gate.allow, false);
    assert.ok(gate.messages.some(m => /\[E2E FAILED\]/.test(m)));
});

test('beforeDone-middleware-veto', async () => {
    const mw = [{
        name: 'vetoDone',
        async beforeDone() {
            return { veto: true, messages: ['not ready'] };
        }
    }];
    const veto = await runMiddlewareChain(mw, 'beforeDone', {
        ctx: {},
        session: {},
        payload: {}
    });
    assert.equal(veto.veto, true);
});

test('project-rule-blocks-done', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'he-rule-'));
    const rulesDir = path.join(root, '.agentsmith', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'r1.js'), `
module.exports = {
    id: 'r1',
    match: () => true,
    check: async () => ({ ok: false, message: 'always fail', fix: 'fix it' })
};
`);
    fs.writeFileSync(path.join(root, 'x.js'), 'x();\n');
    const r = await runValidation(root, ['x.js'], 'task', { grindMode: false });
    assert.equal(r.allow, false);
    assert.ok(r.messages.some(m => /\[RULE:r1\]/.test(m)));
});

test('phase-compaction-preserves-plan-anchor', () => {
    const anchor = new PlanAnchor('build feature X');
    const session = { goal: 'build feature X', messages: [{ role: 'user', content: 'noise' }] };
    compactForPhaseTransition(session, { fromPhase: 'explore', toPhase: 'implement', planAnchor: anchor });
    assert.match(session.messages[0].content, /build feature X/);
});

test('plugin-beforeDone-veto contract', async () => {
    const { HOOK_EVENTS } = require('../../../src/main/services/pluginManager.js');
    for (const ev of [
        'beforeDone', 'onPlanApproved', 'onPlanDone',
        'sessionStart', 'sessionStop', 'afterTurn', 'afterToolBatch', 'phaseChange'
    ]) {
        assert.ok(HOOK_EVENTS.includes(ev), `missing hook ${ev}`);
    }
});
