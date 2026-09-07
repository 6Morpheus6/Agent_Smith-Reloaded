// Code Mode reasoning-model guard: a model that spends its entire reply budget on
// internal reasoning (finish_reason 'length', empty content, no tool call) must not
// silently loop — the loop should bump the reply budget and nudge it to act.
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
        projectRoot: opts.projectRoot, model: 'gemma-4-26b', numCtx: 8192,
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

test('reasoning-truncated empty turn retries with a larger budget + brevity nudge', async () => {
    const session = mkSession({ projectRoot: tmp('reasoning-'), filesTouched: [] });
    let calls = 0;
    const { ctx, events } = ctxFor(session, async () => {
        calls++;
        if (calls === 1) {
            // Reasoning model: whole budget spent thinking, nothing emitted, truncated.
            return { message: { role: 'assistant', content: '' }, finishReason: 'length', sawReasoning: true };
        }
        // Next turn behaves normally so the run can terminate.
        return { message: { role: 'assistant', content: 'All done!' }, finishReason: 'stop' };
    });

    await runTurnLoop(ctx);

    assert.ok(calls >= 2, 'must retry after the empty reasoning-truncated turn, not give up or loop');
    assert.equal(session.reasoningModel, true, 'reasoning model detected at runtime');
    assert.equal(session.outReserveOverride, 8192, 'reply budget boosted to the ceiling');
    assert.ok(events.some(e => e.type === 'reasoning_truncated'), 'reasoning_truncated event emitted');
    assert.ok(
        session.messages.some(m => m.role === 'system' && /Stop reasoning now/i.test(m.content || '')),
        'a brevity nudge was injected for the retry'
    );
    const advisories = events.filter(e => e.type === 'model_advisory');
    assert.equal(advisories.length, 1, 'a single model advisory is emitted for a reasoning model');
    assert.match(advisories[0].message, /coder model/i);
});

test('a normal (non-reasoning) empty turn does NOT trigger the reasoning guard', async () => {
    const session = mkSession({ projectRoot: tmp('reasoning-neg-'), filesTouched: [] });
    let calls = 0;
    const { ctx, events } = ctxFor(session, async () => {
        calls++;
        // finish_reason 'stop' and no reasoning → not the reasoning-truncation case.
        return { message: { role: 'assistant', content: '' }, finishReason: 'stop', sawReasoning: false };
    }, { maxTurns: 3 });

    await runTurnLoop(ctx);
    assert.notEqual(session.outReserveOverride, 8192, 'must not boost budget for a normal empty reply');
    assert.notEqual(session.reasoningModel, true);
    assert.ok(!events.some(e => e.type === 'model_advisory'), 'no advisory for a non-reasoning model');
});
