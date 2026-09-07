// Partial-build recovery: detect missing script/README, nudge write-first, salvage malformed writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    detectPartialDeliverableState,
    pickNextWriteTarget,
    buildPartialBuildNudge,
    buildStallExhaustionNudge,
    buildMalformedWriteRecoveryNudge
} = require('../src/code/context/partialBuild.js');
const { repairMalformedWriteCalls, extractFromMessage } = require('../src/code/tools/extractor.js');
const { formatGateMessage } = require('../src/code/governor/completionGate.js');
const { runTurnLoop } = require('../src/code/loop/turnLoop.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { QualityMonitor } = require('../src/code/governor/qualityMonitor.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');

const GOAL = 'Build a complete Personal Budget Tracker web app from scratch with index.html, style.css, script.js, README.md';

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedPartialWeb(root) {
    fs.writeFileSync(path.join(root, 'index.html'), `<!DOCTYPE html>
<html><head><link rel="stylesheet" href="style.css"></head>
<body><input id="amount"><script src="script.js"></script></body></html>`);
    fs.writeFileSync(path.join(root, 'style.css'), 'body { margin: 0; }');
}

test('detectPartialDeliverableState finds missing script.js and README.md', () => {
    const root = tmpDir('partial-');
    seedPartialWeb(root);
    const state = detectPartialDeliverableState(root, GOAL, ['index.html', 'style.css']);
    assert.ok(state);
    assert.equal(state.htmlRel, 'index.html');
    assert.ok(state.missingRefs.includes('script.js'));
    assert.ok(state.missingArtifacts.includes('script.js'));
    assert.ok(state.missingArtifacts.includes('README.md'));
    assert.equal(state.nextFile, 'script.js');
});

test('buildPartialBuildNudge forbids HTML rewrite and names script.js', () => {
    const root = tmpDir('partial2-');
    seedPartialWeb(root);
    const nudge = buildPartialBuildNudge(
        { projectRoot: root, goal: GOAL, filesTouched: ['index.html', 'style.css'] },
        GOAL,
        root
    );
    assert.match(nudge, /do NOT rewrite/i);
    assert.match(nudge, /write_file path="script\.js"/);
    assert.match(nudge, /README\.md/);
});

test('repairMalformedWriteCalls salvages path from pending refs', () => {
    const msg = {
        tool_calls: [{
            id: 'c1',
            type: 'function',
            function: {
                name: 'write_file',
                arguments: { content: 'const x = 1;\n' }
            }
        }]
    };
    const fixed = repairMalformedWriteCalls(msg, 'script.js');
    assert.equal(fixed, 1);
    assert.equal(msg.tool_calls[0].function.arguments.path, 'script.js');
});

test('extractFromMessage repairs native tool_calls missing path', () => {
    const msg = {
        content: '',
        tool_calls: [{
            id: 'c1',
            type: 'function',
            function: {
                name: 'write_file',
                arguments: { content: 'document.addEventListener("DOMContentLoaded", () => {});' }
            }
        }]
    };
    const schemas = [{ function: { name: 'write_file' } }];
    const r = extractFromMessage(msg, schemas, { salvagePath: 'script.js' });
    assert.equal(r.repairedMalformed, 1);
    assert.equal(msg.tool_calls[0].function.arguments.path, 'script.js');
});

test('formatGateMessage leads with script.js when only README artifact missing', () => {
    const root = tmpDir('partial3-');
    seedPartialWeb(root);
    const gate = {
        allow: false,
        missingRefs: ['script.js'],
        messages: [
            '[WEB] index.html references "script.js" — create the file at script.js (it is missing on disk)',
            '[ARTIFACT] README.md is required by the prompt but missing'
        ]
    };
    const text = formatGateMessage(gate, GOAL, root);
    assert.match(text, /write_file path="script\.js"/);
    assert.match(text, /README\.md/);
    assert.match(text, /Do NOT rewrite index\.html/);
});

test('stall retry does not advance the turn counter', async () => {
    const root = tmpDir('stall-turn-');
    const session = {
        id: 'test', goal: 'say hello', projectRoot: root, model: 'glm-stall', numCtx: 8192,
        status: 'running', turn: 0, toolCount: 0, phase: 'implement',
        messages: [{ role: 'user', content: 'task' }],
        filesTouched: [], completionReflections: 0
    };
    let calls = 0;
    const events = [];
    const ctx = {
        session, apiBaseUrl: 'http://x', emit: (e) => events.push(e),
        signal: undefined, execDeps: {}, planAnchor: new PlanAnchor(session.goal),
        qualityMonitor: new QualityMonitor(),
        earlyStop: new EarlyStopDetector({ maxTurns: 40 }),
        streamCompletion: async () => {
            calls++;
            if (calls === 1) throw new Error('LM Studio response stalled for 60000ms');
            return { message: { role: 'assistant', content: 'All done!' }, finishReason: 'stop' };
        }
    };
    await runTurnLoop(ctx);
    assert.equal(session.turn, 1, 'one logical turn after a retried stall');
    assert.ok(events.some(e => e.type === 'stream_retry'));
});

test('stall exhaustion injects targeted recovery nudge', async () => {
    const root = tmpDir('stall-ex-');
    seedPartialWeb(root);
    const session = {
        id: 'test', goal: GOAL, projectRoot: root, model: 'glm-stall', numCtx: 8192,
        status: 'running', turn: 0, toolCount: 0, phase: 'implement',
        messages: [{ role: 'user', content: 'task' }],
        filesTouched: ['index.html', 'style.css'],
        pendingMissingRefs: ['script.js'],
        completionReflections: 0,
        greenfield: true
    };
    let calls = 0;
    const events = [];
    const ctx = {
        session, apiBaseUrl: 'http://x', emit: (e) => events.push(e),
        signal: undefined, execDeps: {}, planAnchor: new PlanAnchor(session.goal),
        qualityMonitor: new QualityMonitor(),
        earlyStop: new EarlyStopDetector({ maxTurns: 40 }),
        streamCompletion: async () => {
            calls++;
            throw new Error('LM Studio response stalled for 60000ms');
        }
    };
    await runTurnLoop(ctx);
    const stallRecovery = events.find(e => e.type === 'run_continue' && e.reason === 'stall_recovery');
    assert.ok(stallRecovery, 'stall_recovery event expected');
    const nudge = session.messages.find(m => m.role === 'system' && /STALL RECOVERY/.test(m.content));
    assert.ok(nudge);
    assert.match(nudge.content, /script\.js/);
    assert.match(buildStallExhaustionNudge(session, GOAL), /script\.js/);
    assert.match(buildMalformedWriteRecoveryNudge(session, GOAL), /script\.js/);
});

test('pickNextWriteTarget prefers pending JS refs', () => {
    const session = {
        pendingMissingRefs: ['README.md', 'script.js'],
        projectRoot: tmpDir('pick-'),
        goal: GOAL,
        filesTouched: ['index.html']
    };
    assert.equal(pickNextWriteTarget(session), 'script.js');
});
