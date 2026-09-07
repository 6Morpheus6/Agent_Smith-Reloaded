/**
 * Exit-path tests — the completion gate must run and set an HONEST status on every way
 * the turn loop can end. No path may report success without validation, and reflection
 * exhaustion must yield INCOMPLETE, never a silent "done".
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runTurnLoop } = require('../src/code/loop/turnLoop.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { QualityMonitor } = require('../src/code/governor/qualityMonitor.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');

function mkSession(opts) {
    return {
        id: 'test', goal: opts.goal || 'Build a web based Pac-Man game',
        projectRoot: opts.projectRoot, model: 'qwen2.5-coder', numCtx: 8192,
        status: 'running', turn: 0, toolCount: 0,
        messages: [{ role: 'user', content: 'task' }],
        filesTouched: opts.filesTouched || [], completionReflections: 0,
        // v51.5 TEST BEFORE DONE: these sessions model an ALREADY-VERIFIED state (the fixture's
        // code passed its checks in the run before this window). A session that has NOT been
        // verified yet must leave this false and get vetoed — see testBeforeDone.test.js.
        testRunsSinceEdit: opts.filesTouched ? true : false
    };
}

function ctxFor(session, streamFn, opts = {}) {
    const events = [];
    return {
        ctx: {
            session, apiBaseUrl: 'http://x', tools: [], emit: (e) => events.push(e),
            signal: undefined, execDeps: {}, planAnchor: new PlanAnchor(session.goal),
            qualityMonitor: new QualityMonitor(),
            earlyStop: new EarlyStopDetector({ maxTurns: opts.maxTurns || 40 }),
            streamCompletion: streamFn
        },
        events
    };
}

const noToolReply = async () => ({ message: { role: 'assistant', content: 'All done!' }, finishReason: 'stop' });

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

test('empty-files build goal blocks one-turn exit and uses reflection', async () => {
    const session = mkSession({ projectRoot: tmp('exit-empty-build-'), filesTouched: [] });
    let calls = 0;
    const { ctx, events } = ctxFor(session, async () => {
        calls++;
        return noToolReply();
    });
    await runTurnLoop(ctx);
    assert.ok(calls >= 2, 'should continue after blocked empty completion');
    assert.ok(session.completionReflections >= 1);
    assert.ok(events.some(e => e.type === 'verify_blocked'));
    assert.equal(session.status, 'incomplete');
});
test('max-turns exit still runs the gate and sets a status (never silently done)', async () => {
    const session = mkSession({ projectRoot: tmp('exit-maxturns-'), filesTouched: [], goal: 'say hello' });
    let streamCalled = 0;
    const { ctx, events } = ctxFor(session, async () => { streamCalled++; return noToolReply(); }, { maxTurns: 1 });
    await runTurnLoop(ctx);
    assert.equal(streamCalled, 1, 'maxTurns=1 runs exactly one turn, then max-turns trips');
    assert.ok(['unverified', 'incomplete'].includes(session.status));
    assert.ok(events.some(e => e.type === 'final_summary'), 'final_summary must be emitted');
});

test('normal stop with a verified project reports done', async () => {
    const root = path.join(__dirname, '..', 'examples', 'pacman');
    const session = mkSession({ projectRoot: root, filesTouched: ['index.html', 'style.css', 'script.js'] });
    const { ctx, events } = ctxFor(session, noToolReply);
    await runTurnLoop(ctx);
    assert.equal(session.status, 'done');
    const fin = events.find(e => e.type === 'final_summary');
    assert.equal(fin.status, 'done');
    assert.match(fin.summary, /COMPLETE \(verified\)/);
});

test('reflection exhaustion yields INCOMPLETE, not success', async () => {
    const d = tmp('exit-reflect-');
    // a broken project the model keeps declaring "done" on
    fs.writeFileSync(path.join(d, 'index.html'), '<!DOCTYPE html><html><body><div id="game-board"></div><script src="script.js"></script></body></html>');
    fs.writeFileSync(path.join(d, 'script.js'), 'const GRID_SIZE = 20;\nconst MAZE = ["111","101","111"];\n');
    const session = mkSession({
        projectRoot: d,
        filesTouched: ['index.html', 'script.js'],
        goal: 'fix script.js constants to match the maze'
    });

    const { ctx, events } = ctxFor(session, noToolReply);
    await runTurnLoop(ctx);

    assert.equal(session.status, 'incomplete', 'must not report success');
    assert.equal(session.completionReflections, 3, 'non-game goals use the default reflection budget');
    const blocks = events.filter(e => e.type === 'verify_blocked');
    assert.equal(blocks.length, 3, 'gate should block on each reflection');
    const fin = events.find(e => e.type === 'final_summary');
    assert.match(fin.summary, /INCOMPLETE/);
    assert.match(fin.summary, /Not reported as success/);
});

test('the final summary never contains raw tool JSON', async () => {
    const root = path.join(__dirname, '..', 'examples', 'pacman');
    const session = mkSession({ projectRoot: root, filesTouched: ['index.html', 'style.css', 'script.js'] });
    // a model that leaks tool JSON in its final prose
    const leaky = async () => ({ message: { role: 'assistant', content: 'Done. {"name":"write_file","parameters":{"path":"x"}}' }, finishReason: 'stop' });
    const { ctx, events } = ctxFor(session, leaky);
    await runTurnLoop(ctx);
    const done = events.find(e => e.type === 'assistant_done');
    assert.ok(!/write_file/.test(done.content), 'final answer must be generated, not the leaky model prose');
    assert.ok(!/\{"name"/.test(done.content));
});

test('a stalled Pac-Man repair turn falls back to harness recovery and completes', async () => {
    const root = tmp('exit-stalled-pacman-');
    const game = path.join(root, 'game');
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, 'index.html'),
        '<html><link rel="stylesheet" href="style.css"><div id="game-container"></div><script src="script.js"></script></html>');
    fs.writeFileSync(path.join(game, 'style.css'), '.wall { color: blue; }\n');
    fs.writeFileSync(path.join(game, 'script.js'), 'function setupInputListeners() {}\n');
    const session = mkSession({
        projectRoot: root,
        filesTouched: ['game/index.html', 'game/style.css', 'game/script.js'],
        goal: 'create a pac man web browser game'
    });
    let calls = 0;
    const stream = async () => {
        calls++;
        if (calls === 1) throw new Error('LM Studio response stalled for 60000ms');
        return noToolReply();
    };

    const { ctx, events } = ctxFor(session, stream);
    await runTurnLoop(ctx);

    assert.equal(session.status, 'done');
    assert.ok(events.some(e => e.type === 'harness_scaffold' && e.reason === 'acceptance_repair'));
});
