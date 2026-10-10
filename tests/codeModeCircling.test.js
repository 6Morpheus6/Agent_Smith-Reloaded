// v54.7 — Code Mode circling fix: a turn that ends with NO content and NO tool call
// (clean-empty stop) must get a bounded "ACT NOW" recovery nudge instead of falling
// straight into the completion gate's generic COMPLETION BLOCKED nudges, which looped
// 40-minute dead turns until abort. Drives the REAL runTurnLoop with a scripted stubbed
// stream — no mocks of the loop itself.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runTurnLoop } = require('../src/code/loop/turnLoop.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { QualityMonitor } = require('../src/code/governor/qualityMonitor.js');

function makeSession(projectRoot, goal) {
    return {
        id: 'code_test_circling',
        runId: 'code_test_circling',
        goal,
        projectRoot,
        model: 'stub-model',
        numCtx: 65536,
        codeTemperature: 0.2,
        status: 'running',
        phase: 'implement',
        turn: 0,
        toolCount: 0,
        filesTouched: [],
        completionReflections: 0, // CodeSession initializes this; the gate's reflection budget reads it
        messages: [{ role: 'user', content: '[TASK] ' + goal }],
        planArtifacts: { enabled: false },
        grindMode: true,
        projectMeta: {},
        emptyWorkspace: true,
        greenfield: true
    };
}

function makeCtx(session, scripted) {
    const events = [];
    let i = 0;
    // Scripted stream stub — same call shape as the real streamCompletion. Once the script is
    // exhausted it returns a prose stop so the run terminates through the completion gate.
    async function streamStub() {
        if (i < scripted.length) return { message: scripted[i++].message, finishReason: 'stop', usage: null };
        return { message: { content: 'Done.', tool_calls: undefined }, finishReason: 'stop', usage: null };
    }
    return {
        session,
        apiBaseUrl: null,
        apiKey: null,
        userPrompt: session.goal,
        emit: (ev) => events.push(ev),
        signal: new AbortController().signal,
        execDeps: {},
        planAnchor: new PlanAnchor(session.goal, { enabled: false }),
        planArtifacts: { enabled: false },
        qualityMonitor: new QualityMonitor(),
        earlyStop: new EarlyStopDetector({ maxTurns: 12 }),
        trace: null,
        userDataPath: os.tmpdir(),
        streamCompletion: streamStub,
        events
    };
}

const emptyReply = () => ({ message: { content: '', tool_calls: undefined } });
const writeCall = (n) => ({
    message: {
        content: '',
        tool_calls: [{ id: 'c' + n, function: { name: 'write_file', arguments: JSON.stringify({ path: 'app.js', content: '// app\nmodule.exports = 1;\n' }) } }]
    }
});

test('v54.7 — clean-empty reply gets an ACT NOW nudge and retries (bounded)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circling-'));
    try {
        // Turn 1: empty stop → nudge + retry. Turn 2: model acts (writes a file).
        const session = makeSession(dir, 'create a small node module');
        const ctx = makeCtx(session, [emptyReply(), writeCall(2)]);
        await runTurnLoop(ctx);

        const nudges = session.messages.filter(m => m.role === 'system' && /ACT NOW/.test(String(m.content)));
        assert.equal(nudges.length, 1, 'exactly one ACT NOW nudge pushed: ' + JSON.stringify(session.messages.map(m => String(m.content).slice(0, 60))));
        const retryEvents = ctx.events.filter(e => e.type === 'empty_reply_retry');
        assert.equal(retryEvents.length, 1, 'empty_reply_retry event emitted once');
        // The nudge must have landed BEFORE the model's next (acting) turn.
        const nudgeIdx = session.messages.findIndex(m => /ACT NOW/.test(String(m.content)));
        const writeIdx = session.messages.findIndex(m => m.role === 'assistant' && m.tool_calls);
        assert.ok(nudgeIdx !== -1 && writeIdx > nudgeIdx, 'nudge precedes the acting turn');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('v54.7 — empty-reply nudges are bounded; after the cap normal gate logic applies', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circling-cap-'));
    try {
        // Two consecutive empty stops → 2 nudges (the cap); then prose stops flow to the
        // completion gate, which terminates the run after its reflection budget.
        const session = makeSession(dir, 'create a small node module');
        const ctx = makeCtx(session, [emptyReply(), emptyReply()]);
        await runTurnLoop(ctx);

        const nudges = session.messages.filter(m => m.role === 'system' && /ACT NOW/.test(String(m.content)));
        assert.equal(nudges.length, 2, 'exactly two ACT NOW nudges (cap): ' + JSON.stringify(session.messages.map(m => String(m.content).slice(0, 60))));
        const retryEvents = ctx.events.filter(e => e.type === 'empty_reply_retry');
        assert.equal(retryEvents.length, 2);
        // After the cap the run must TERMINATE (gate path), not loop forever.
        assert.notEqual(session.status, 'running', 'run terminated: ' + session.status);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('v54.7 — a tool-calling turn clears the empty-reply streak', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circling-clear-'));
    try {
        // Empty stop → nudge; model acts (write); then two more empty stops get their OWN
        // full budget of nudges because the acting turn reset the streak.
        const session = makeSession(dir, 'create a small node module');
        const ctx = makeCtx(session, [emptyReply(), writeCall(2), emptyReply(), emptyReply()]);
        await runTurnLoop(ctx);

        // 1 (before act) + 2 (after act, fresh budget) = 3 nudges total.
        const nudges = session.messages.filter(m => m.role === 'system' && /ACT NOW/.test(String(m.content)));
        assert.equal(nudges.length, 3, 'streak reset after acting turn: ' + JSON.stringify(session.messages.map(m => String(m.content).slice(0, 60))));
        const retryEvents = ctx.events.filter(e => e.type === 'empty_reply_retry');
        assert.equal(retryEvents.length, 3);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('v54.7 — a non-empty text stop is NOT treated as an empty reply', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circling-text-'));
    try {
        // The model stops with prose (no tool call): that goes straight to the completion
        // gate — no ACT NOW nudge, counter untouched.
        const session = makeSession(dir, 'create a small node module');
        const ctx = makeCtx(session, [{ message: { content: 'All done here.', tool_calls: undefined } }]);
        await runTurnLoop(ctx);

        const nudges = session.messages.filter(m => m.role === 'system' && /ACT NOW/.test(String(m.content)));
        assert.equal(nudges.length, 0, 'no ACT NOW nudge for a prose stop');
        assert.ok(!session._consecutiveEmptyReplies || session._consecutiveEmptyReplies === 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
