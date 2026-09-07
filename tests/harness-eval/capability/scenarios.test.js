const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { PlanArtifacts } = require('../../../src/code/context/planArtifacts.js');
const { checkCompletion, maxReflectionsForSession } = require('../../../src/code/governor/completionGate.js');
const { runPostEditChecks } = require('../../../src/code/governor/postEditChecks.js');
const { EarlyStopDetector } = require('../../../src/code/governor/earlyStop.js');
const { runTurnLoop } = require('../../../src/code/loop/turnLoop.js');
const { QualityMonitor } = require('../../../src/code/governor/qualityMonitor.js');
const { PlanAnchor } = require('../../../src/code/context/planAnchor.js');

test('capability-greenfield-scaffold touches file without infinite loop', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-green-'));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = () => 1;\n');
    const gate = await checkCompletion(root, ['index.js'], 'build a small module', { grindMode: false });
    // A valid single-file module must be ALLOWED to complete, with at least one real check
    // (JS syntax) run. (The old asserts — status in {done,unverified} and ranChecks>=0 —
    // passed for literally any outcome.)
    assert.equal(gate.allow, true, 'clean module must pass the gate; messages=' + (gate.messages || []).join(' | '));
    assert.ok(gate.ranChecks >= 1, 'at least the syntax check must have run');
    assert.equal(gate.messages.length, 0, 'no blocking messages for a clean module');
});

test('capability-grind-reflection blocks on failing test', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-grind-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        scripts: { test: 'node -e "process.exit(1)"' }
    }));
    fs.writeFileSync(path.join(root, 'a.js'), 'x();\n');
    const gate = await checkCompletion(root, ['a.js'], 'fix tests', {
        grindMode: true,
        projectMeta: { testCmd: 'npm test' }
    });
    assert.equal(gate.allow, false);
    assert.ok(gate.grindBlocked);
});

test('capability-rule-advisory surfaces RULE warning', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rule-'));
    const rulesDir = path.join(root, '.agentsmith', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'warn.js'), `
module.exports = {
    id: 'warn',
    match: () => true,
    check: async () => ({ ok: false, message: 'advisory', fix: 'fix' })
};
`);
    fs.writeFileSync(path.join(root, 'f.js'), 'ok();\n');
    const sensor = await runPostEditChecks(root, 'f.js', {}, {});
    assert.ok(sensor.warnings.some(w => /\[RULE:warn\]/.test(w)));
});

test('capability-early-stop prevents runaway turns', () => {
    // Contract (v46.24.0): exactly maxTurns turns EXECUTE — onTurn checks before
    // incrementing, so calls 1..maxTurns run and the next call stops.
    const es = new EarlyStopDetector({ maxTurns: 5 });
    for (let i = 0; i < 5; i++) {
        assert.equal(es.onTurn().stop, false, `turn ${i + 1} of 5 must execute`);
    }
    assert.equal(es.onTurn().stop, true, 'the turn beyond the budget must stop');
});

test('capability-plan-artifacts for non-trivial task', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-plan-'));
    const pa = await PlanArtifacts.ensure(root, 'build a react dashboard with charts');
    assert.equal(pa.enabled, true);
    assert.ok(pa.milestones.length >= 1);
});

test('capability-greenfield-pacman reaches verified done from empty workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-pacman-'));
    const good = path.join(__dirname, '..', '..', '..', 'examples', 'pacman');
    const sub = path.join(root, 'pacman');
    fs.mkdirSync(sub, { recursive: true });

    const session = {
        id: 'cap-pac',
        goal: 'Build a web based Pac-Man game',
        projectRoot: root,
        model: 'qwen2.5-coder',
        numCtx: 8192,
        status: 'running',
        turn: 0,
        toolCount: 0,
        messages: [{ role: 'user', content: 'task' }],
        filesTouched: [],
        completionReflections: 0,
        phase: 'implement'
    };

    const files = ['index.html', 'style.css', 'script.js'];
    let i = 0;
    const stream = async () => {
        if (i < files.length) {
            fs.copyFileSync(path.join(good, files[i]), path.join(sub, files[i]));
            const rel = `pacman/${files[i]}`;
            if (!session.filesTouched.includes(rel)) session.filesTouched.push(rel);
            i++;
        }
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
    };

    const events = [];
    await runTurnLoop({
        session,
        apiBaseUrl: 'http://x',
        emit: (e) => events.push(e),
        signal: undefined,
        execDeps: {},
        planAnchor: new PlanAnchor(session.goal),
        qualityMonitor: new QualityMonitor(),
        earlyStop: new EarlyStopDetector({ maxTurns: 40 }),
        streamCompletion: stream,
        userPrompt: session.goal
    });

    assert.equal(session.status, 'done');
    const fin = events.find(e => e.type === 'final_summary');
    assert.ok(fin);
    assert.match(fin.summary, /COMPLETE \(verified\)/);
});

test('maxReflectionsForSession allows more retries for multi-file web games', () => {
    assert.equal(maxReflectionsForSession({ goal: 'Build a web based Pac-Man game' }), 6);
    assert.equal(maxReflectionsForSession({
        goal: 'fix typo',
        pendingMissingRefs: ['pacman/style.css']
    }), 6);
    assert.equal(maxReflectionsForSession({ goal: 'fix typo' }), 3);
});
