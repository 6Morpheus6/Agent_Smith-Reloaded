// v51.3 — Qwen-3.x thinking-model fix (the "crash after plan approval" symptom).
//
// Root cause, verified live against LM Studio running qwen3.8-27b-uncensored:
// the Qwen3 chat template THOUGHTS BY DEFAULT and can spend the ENTIRE output budget on
// reasoning_content, returning finish_reason:"length" with empty content and no tool_calls.
// Code Mode then recorded six identical empty turns ("No project files were created...")
// and died — exactly what happened after the user accepted the task plan in v51.2.
//
// Fix under test: a 'qwen' modelHarness strategy that sends chat_template_kwargs
// {enable_thinking:false} on every request (LM Studio forwards it to the template), plus an
// abrupt-empty-stream guard so an LM Studio engine crash mid-request retries instead of
// masquerading as six empty turns.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
    getModelHarness,
    bodyOverridesFor,
    describeModelHarness
} = require('../src/code/context/modelHarness.js');
const { isQwenThinkingModel } = require('../src/shared/modelClassifier.js');
const { streamCompletion } = require('../src/code/loop/streamCompletion.js');
const { runTurnLoop } = require('../src/code/loop/turnLoop.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { QualityMonitor } = require('../src/code/governor/qualityMonitor.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

// --- classifier ---------------------------------------------------------------

test('isQwenThinkingModel matches Qwen 3.x ids and not 2.x', () => {
    assert.equal(isQwenThinkingModel('qwen3.8-27b-uncensored'), true, 'the model from the field report');
    assert.equal(isQwenThinkingModel('qwen/qwen3-coder-30b'), true);
    assert.equal(isQwenThinkingModel('Qwen3-Coder-4B'), true);
    assert.equal(isQwenThinkingModel('qwen3-14b-instruct-2507'), true);
    assert.equal(isQwenThinkingModel('qwen2.5-coder-7b'), false, 'Qwen 2.x has no thinking template');
    assert.equal(isQwenThinkingModel('qwen2.5-72b-instruct'), false);
    assert.equal(isQwenThinkingModel('gemma-4-26b-a4b-it'), false);
    assert.equal(isQwenThinkingModel('deepseek-r1-32b'), false);
    assert.equal(isQwenThinkingModel(''), false);
});

// --- harness routing ----------------------------------------------------------

test('qwen family routes to the qwen strategy with thinking off', () => {
    const s = getModelHarness('qwen3.8-27b-uncensored');
    assert.equal(s.id, 'qwen');
    assert.equal(s.nativeTools, true);
    // The wire-level fix: LM Studio forwards chat_template_kwargs to the chat template.
    const extra = bodyOverridesFor('qwen3.8-27b-uncensored');
    assert.deepEqual(extra.chat_template_kwargs, { enable_thinking: false });
});

test('non-qwen families keep their existing overrides (none for default/gemma/kimi)', () => {
    assert.deepEqual(bodyOverridesFor('gemma-4-26b-a4b-it'), {});
    assert.deepEqual(bodyOverridesFor('deepseek-r1-32b'), {});
    assert.deepEqual(bodyOverridesFor('kimi-k3'), {}, 'kimi pins temperature, not body fields');
    // qwen2.5 must NOT pick up thinking-off (its template has no enable_thinking var and
    // some servers choke on unknown kwargs — keep the blast radius to Qwen 3+).
    assert.deepEqual(bodyOverridesFor('qwen2.5-coder-7b'), {});
});

test('describeModelHarness documents the qwen strategy', () => {
    const d = describeModelHarness('qwen3-14b');
    assert.equal(d.id, 'qwen');
    assert.match(d.description, /thinking/i);
});

// --- message reshape (template shape contract) --------------------------------

test('reshape: multiple leading system blocks merge into one first message', () => {
    const msgs = [
        { role: 'system', content: 'persona' },
        { role: 'system', content: '[PHASE] implement' },
        { role: 'system', content: '[PLAN ANCHOR]' },
        { role: 'user', content: '[TASK]\nbuild snake' }
    ];
    const out = getModelHarness('qwen3.8-27b-uncensored').adaptMessages(msgs);
    assert.equal(out[0].role, 'system');
    assert.equal(out.filter(m => m.role === 'system').length, 1, 'exactly one system message');
    assert.match(out[0].content, /persona/);
    assert.match(out[0].content, /\[PHASE\] implement/);
    assert.match(out[0].content, /\[PLAN ANCHOR\]/);
    assert.equal(out[out.length - 1].role, 'user');
});

test('reshape: mid-conversation system nudges become user turns without stacking users', () => {
    const msgs = [
        { role: 'system', content: 'persona' },
        { role: 'user', content: '[TASK]' },
        { role: 'assistant', content: '' },
        { role: 'user', content: '[COMPLETION BLOCKED] no files yet' },
        { role: 'system', content: '[HARNESS — WRITE REQUIRED]\nwrite now' }
    ];
    const out = getModelHarness('qwen3.8-27b-uncensored').adaptMessages(msgs);
    assert.equal(out[0].role, 'system');
    // the empty assistant (no content, no tool_calls) is gone — nothing to see
    assert.ok(!out.some(m => m.role === 'assistant' && !m.content), 'empty assistant dropped');
    const users = out.filter(m => m.role === 'user');
    for (const u of users) {
        // every user message that carries the harness nudge must ALSO be the completion block —
        // i.e. the two same-role turns merged instead of stacking
        if (/HARNESS — WRITE REQUIRED/.test(u.content)) assert.match(u.content, /COMPLETION BLOCKED/);
    }
});

test('reshape: is idempotent and preserves tool-call pairing', () => {
    const msgs = [
        { role: 'system', content: 's1' },
        { role: 'system', content: 's2' },
        { role: 'user', content: 'task' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'write_file', content: '{"success":true}' },
        { role: 'system', content: '[NUDGE]' }
    ];
    const s = getModelHarness('qwen3.8-27b-uncensored');
    const once = s.adaptMessages(msgs);
    const twice = s.adaptMessages(once); // idempotent — second pass changes nothing
    assert.deepEqual(twice, once, 'reshape must be idempotent (callers may re-pass history)');
    assert.ok(once.some(m => m.role === 'assistant' && m.tool_calls), 'tool-carrying assistant kept');
    assert.ok(once.some(m => m.role === 'tool' && m.tool_call_id === 'c1'), 'tool result kept in pair order');
});

test('reshape: non-qwen families pass messages through untouched', () => {
    const msgs = [
        { role: 'system', content: 's1' },
        { role: 'system', content: 's2' },
        { role: 'user', content: 'task' }
    ];
    // deepseek-r1 rides the default strategy (no prompt reshaping at all) — gemma folds by design.
    const out = getModelHarness('deepseek-r1-32b').adaptMessages(msgs);
    assert.equal(out.filter(m => m.role === 'system').length, 2, 'default family untouched (no merge)');
    assert.deepEqual(out, msgs, 'byte-identical passthrough for non-qwen families');
});

// --- wire: real streamCompletion against a capture server ---------------------

function captureServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => handler(req, res));
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('streamCompletion puts chat_template_kwargs on the wire for qwen3 ids only', async () => {
    const seen = [];
    const server = await captureServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            seen.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end('data: [DONE]\n\n');
        });
    });
    const port = server.address().port;
    try {
        await streamCompletion({ apiBaseUrl: `http://127.0.0.1:${port}`, model: 'qwen3.8-27b-uncensored', messages: [{ role: 'user', content: 'hi' }], tools: [] });
        await streamCompletion({ apiBaseUrl: `http://127.0.0.1:${port}`, model: 'gemma-4-26b-a4b-it', messages: [{ role: 'user', content: 'hi' }], tools: [] });
        await streamCompletion({ apiBaseUrl: `http://127.0.0.1:${port}`, model: 'qwen2.5-coder-7b', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    } finally {
        server.closeAllConnections?.();
        await new Promise(r => server.close(r));
    }
    assert.deepEqual(seen[0].chat_template_kwargs, { enable_thinking: false }, 'qwen3 gets thinking off');
    assert.equal('chat_template_kwargs' in seen[1], false, 'gemma untouched');
    assert.equal('chat_template_kwargs' in seen[2], false, 'qwen 2.x untouched');
});

// --- wire: abrupt empty stream (engine crash) ---------------------------------

test('a 200 response with no deltas and no [DONE] rejects as an engine stall', async () => {
    const server = await captureServer((_req, res) => {
        // Engine died right after headers — exactly what LM Studio's SIGABRT leaves behind.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end();
    });
    const port = server.address().port;
    try {
        await assert.rejects(
            streamCompletion({ apiBaseUrl: `http://127.0.0.1:${port}`, model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }),
            /stream stalled right after headers/i
        );
    } finally {
        server.closeAllConnections?.();
        await new Promise(r => server.close(r));
    }
});

test('a protocol-complete stream ([DONE]) still resolves even when empty', async () => {
    const server = await captureServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
    });
    const port = server.address().port;
    try {
        const result = await streamCompletion({ apiBaseUrl: `http://127.0.0.1:${port}`, model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] });
        assert.equal(result.message.content, '');
    } finally {
        server.closeAllConnections?.();
        await new Promise(r => server.close(r));
    }
});

test('a stream with a finish_reason but no deltas still resolves (not an abort)', async () => {
    const server = await captureServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
        res.end();
    });
    const port = server.address().port;
    try {
        const result = await streamCompletion({ apiBaseUrl: `http://127.0.0.1:${port}`, model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] });
        assert.equal(result.finishReason, 'stop');
    } finally {
        server.closeAllConnections?.();
        await new Promise(r => server.close(r));
    }
});

// --- turn loop: budget exhaustion WITHOUT a reasoning signal -------------------

test('empty reply + finish_reason=length (no reasoning_content) retries with boosted budget', async () => {
    // The qwen3.8-27b field report shape: whole budget burned, nothing emitted, and the
    // server may not even expose how much of it was reasoning. v51.2 only fired when
    // sawReasoning AND length — this is the case that slipped through.
    const session = {
        id: 't', goal: 'build me a simple web based game of snake', projectRoot: tmp('qwen-empty-'),
        model: 'qwen3.8-27b-uncensored', numCtx: 18432, status: 'running', turn: 0, toolCount: 0,
        messages: [{ role: 'user', content: 'task' }], filesTouched: [], completionReflections: 0
    };
    const events = [];
    let calls = 0;
    const stream = async () => {
        calls++;
        if (calls === 1) return { message: { role: 'assistant', content: '' }, finishReason: 'length' };
        return { message: { role: 'assistant', content: 'All done!' }, finishReason: 'stop' };
    };
    await runTurnLoop({
        session, apiBaseUrl: 'http://x', emit: (e) => events.push(e), signal: undefined, execDeps: {},
        planAnchor: new PlanAnchor(session.goal), qualityMonitor: new QualityMonitor(),
        earlyStop: new EarlyStopDetector({ maxTurns: 40 }), streamCompletion: stream
    });
    assert.ok(calls >= 2, 'must retry the exhausted turn instead of looping to "no files written"');
    assert.equal(session.outReserveOverride, 8192, 'reply budget boosted for the retry');
    assert.ok(events.some(e => e.type === 'reasoning_truncated'), 'exhaustion surfaced as reasoning_truncated');
});
