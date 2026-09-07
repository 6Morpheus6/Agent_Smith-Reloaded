// A transient model stall (idle timeout) mid-build must RETRY the turn, not end the
// whole run — one hiccup from a local/reasoning model shouldn't kill a progressing build.
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
        id: 'test', goal: opts.goal || 'say hello',
        projectRoot: opts.projectRoot, model: 'glm-stall', numCtx: 8192,
        status: 'running', turn: 0, toolCount: 0,
        messages: [{ role: 'user', content: 'task' }],
        filesTouched: opts.filesTouched || [], completionReflections: 0
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
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('a transient stall retries the turn instead of ending the run', async () => {
    const session = mkSession({ projectRoot: tmp('stall-'), filesTouched: [] });
    let calls = 0;
    const { ctx, events } = ctxFor(session, async () => {
        calls++;
        if (calls === 1) throw new Error('LM Studio response stalled for 60000ms');
        return { message: { role: 'assistant', content: 'All done!' }, finishReason: 'stop' };
    });

    await runTurnLoop(ctx);

    assert.ok(calls >= 2, 'must retry the turn after a stall (not stop on the first stall)');
    assert.ok(events.some(e => e.type === 'stream_retry'), 'a stream_retry event is emitted');
    assert.equal(session.turn, 1, 'stall retry must not consume an extra turn slot');
    assert.equal(session.status !== 'error' || !/stalled/i.test(session.error || ''), true,
        'the run must not end with the stall error after a successful retry');
});

test('persistent stalls give up after the retry budget (no infinite loop)', async () => {
    const session = mkSession({ projectRoot: tmp('stall2-'), filesTouched: [] });
    let calls = 0;
    const { ctx, events } = ctxFor(session, async () => {
        calls++;
        throw new Error('LM Studio response stalled for 60000ms'); // always stalls
    }, { maxTurns: 40 });

    await runTurnLoop(ctx);

    // bounded: ~8 retries then it stops, nowhere near the 40-turn cap
    const retries = events.filter(e => e.type === 'stream_retry').length;
    assert.ok(retries >= 1 && retries <= 9, `bounded stall retries, got ${retries}`);
    assert.ok(calls <= 12, `must not retry forever, got ${calls} calls`);
});
