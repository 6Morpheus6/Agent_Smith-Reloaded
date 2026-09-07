/**
 * Output-truncation regression. Root cause of "writes index.html/style.css but never
 * script.js": fitBudget reserved only 512 tokens for output, so a large file was cut off
 * at the context-window edge, and finish_reason="length" was ignored — the truncated tool
 * call silently became {} ("Empty path"), looping forever with no signal.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { fitBudget, estimateMessages } = require('../src/code/context/budget.js');
const { runTurnLoop } = require('../src/code/loop/turnLoop.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { QualityMonitor } = require('../src/code/governor/qualityMonitor.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

test('fitBudget reserves real output room (a full file can be emitted)', () => {
    const msgs = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 60; i++) msgs.push({ role: 'user', content: 'x'.repeat(2000) });
    msgs.push({ role: 'user', content: 'latest' });

    const numCtx = 8192, reserve = 3000;
    const out = fitBudget(msgs, numCtx, reserve);
    assert.ok(estimateMessages(out) <= numCtx - reserve, 'input must be trimmed to leave the output reserve free');
    assert.ok(out.some(m => m.content === 'latest'), 'latest goal kept');
});

test('default fitBudget reserve is large enough for a source file (>= 2048 tokens)', () => {
    // a near-full window of input should still be trimmed to leave >= 2048 tokens out.
    const msgs = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 60; i++) msgs.push({ role: 'user', content: 'y'.repeat(2000) });
    const out = fitBudget(msgs, 8192); // default reserve
    assert.ok(estimateMessages(out) <= 8192 - 2048);
});

test('streamCompletion sends max_tokens:-1 on the wire — unbounded replies (v52.7)', async () => {
    // v52.7 REVERSED the old "explicit positive cap" design: LM Studio honors -1 as "no cap"
    // (verified live), and a per-reply cap is exactly what cut thinking-by-default models off
    // before any content could come out. The wire body must therefore carry -1 no matter what
    // the caller passes — the reply can only end when the model stops, not at a budget.
    const { streamCompletion } = require('../src/code/loop/streamCompletion.js');
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => { try { seen.push(JSON.parse(body)); } catch {} res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        const base = `http://127.0.0.1:${port}`;
        await streamCompletion({ apiBaseUrl: base, model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: -1 });
        await streamCompletion({ apiBaseUrl: base, model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: undefined });
        await streamCompletion({ apiBaseUrl: base, model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 6144 }); // caller cap must NOT leak onto the wire
    } finally {
        await new Promise(r => server.close(r));
    }
    for (const [i, body] of seen.entries()) {
        assert.equal(body.max_tokens, -1, `request ${i}: reply must be unbounded (-1) on the wire`);
    }
});

test('streamCompletion reports live generation state: waiting → generating on first delta (v52.7)', async () => {
    // The "is the model still busy" signal is driven by WIRE events only, so it must be
    // identical for every model family: 'waiting' when the request goes out, 'generating'
    // exactly once on the first delta of ANY kind (content, reasoning or tool_call).
    const { streamCompletion } = require('../src/code/loop/streamCompletion.js');
    const states = [];
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // reasoning first (thinking model), then content — the state must flip on the FIRST one.
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\n');
        res.end('data: [DONE]\n\n');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        await streamCompletion({
            apiBaseUrl: `http://127.0.0.1:${port}`, model: 'm',
            messages: [{ role: 'user', content: 'hi' }], tools: [],
            onState: (s) => states.push(s)
        });
    } finally {
        await new Promise(r => server.close(r));
    }
    assert.deepEqual(states, ['waiting', 'generating'], 'exactly waiting→generating, in order');
});

test('turn loop no longer caps replies with maxTokens — context room is reserved instead (v52.7)', async () => {
    // The old test asserted a positive reply budget on the wire; v52.7 removed per-reply caps
    // entirely (unbounded -1 in streamCompletion). What must still hold: fitBudget trims the
    // INPUT so the window has room for an arbitrarily long reply — that's what outReserve is for now.
    const session = {
        id: 't', goal: 'Build a web based Pac-Man game', projectRoot: tmp('mt-'),
        model: 'qwen2.5-coder', numCtx: 8192, status: 'running', turn: 0, toolCount: 0,
        messages: [{ role: 'user', content: 'task' }], filesTouched: [], completionReflections: 0
    };
    let seenMax = 'UNSET';
    const capture = async (opts) => { seenMax = opts.maxTokens; return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' }; };
    await runTurnLoop({
        session, apiBaseUrl: 'http://x', emit: () => {}, signal: undefined, execDeps: {},
        planAnchor: new PlanAnchor(session.goal), qualityMonitor: new QualityMonitor(),
        earlyStop: new EarlyStopDetector({ maxTurns: 2 }), streamCompletion: capture
    });
    assert.equal(seenMax, undefined, 'turn loop must not pass a reply cap (reply is unbounded)');
});

test('finish_reason=length is surfaced, retried, then bails with an accurate reason', async () => {
    const session = {
        id: 't', goal: 'Build a large React dashboard with routing', projectRoot: tmp('trunc-'),
        model: 'qwen2.5-coder', numCtx: 8192, status: 'running', turn: 0, toolCount: 0,
        messages: [{ role: 'user', content: 'task' }], filesTouched: [], completionReflections: 0
    };
    const events = [];
    // a model whose every reply is cut off at the token limit
    const truncated = async () => ({ message: { role: 'assistant', content: '<!DOCTYPE html><html>…cut', tool_calls: undefined }, finishReason: 'length' });

    await runTurnLoop({
        session, apiBaseUrl: 'http://x', emit: (e) => events.push(e), signal: undefined,
        execDeps: {}, planAnchor: new PlanAnchor(session.goal),
        qualityMonitor: new QualityMonitor(), earlyStop: new EarlyStopDetector({ maxTurns: 40 }),
        streamCompletion: truncated
    });

    const truncEvents = events.filter(e => e.type === 'output_truncated');
    assert.ok(truncEvents.length >= 1, 'must emit output_truncated (not silently loop)');
    assert.ok(session.messages.some(m => m.role === 'user' && /CONTINUE.*truncated/i.test(m.content)), 'must tell the model to continue after cut off');

    const fin = events.find(e => e.type === 'final_summary');
    assert.ok(fin, 'run finalizes');
    assert.match(fin.summary, /output-length limit|larger context|smaller files/i, 'gives the user an accurate, actionable fix');
    assert.notEqual(session.status, 'done', 'never reported as success');
});

test('truncation retries demand progressively smaller appendable chunks', async () => {
    const session = {
        id: 't', goal: 'Build a large browser game', projectRoot: tmp('trunc-chunk-'),
        model: 'google/gemma-4-e4b', numCtx: 131072, status: 'running', turn: 0, toolCount: 0,
        messages: [{ role: 'user', content: 'task' }], filesTouched: [], completionReflections: 0
    };
    const seenMessages = [];
    const stream = async (opts) => {
        seenMessages.push(opts.messages);
        return {
            message: {
                role: 'assistant',
                content: '{"name":"write_file","parameters":{"path":"game.js","content":"' + 'x'.repeat(1900)
            },
            finishReason: 'length'
        };
    };

    await runTurnLoop({
        session, apiBaseUrl: 'http://x', emit: () => {}, signal: undefined,
        execDeps: {}, planAnchor: new PlanAnchor(session.goal),
        qualityMonitor: new QualityMonitor(), earlyStop: new EarlyStopDetector({ maxTurns: 10 }),
        streamCompletion: stream
    });

    const retryPrompts = seenMessages.slice(1).map(messages =>
        messages.filter(m => m.role === 'user').at(-1)?.content || ''
    );
    assert.match(retryPrompts[0], /(?:at most|≤)\s*30 lines/i);
    assert.match(retryPrompts[1], /(?:at most|≤)\s*20 lines/i);
    assert.match(retryPrompts[2], /(?:at most|≤)\s*12 lines/i);
    assert.match(retryPrompts[0], /append_file/i, 'retry must continue in chunks instead of regenerating a large file');
});

test('streamCompletion rejects LM Studio HTTP errors instead of returning an empty reply', async () => {
    const { streamCompletion } = require('../src/code/loop/streamCompletion.js');
    const server = http.createServer((_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Model qwen/qwen3-14b is not loaded' } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        await assert.rejects(
            streamCompletion({
                apiBaseUrl: `http://127.0.0.1:${port}`,
                model: 'qwen/qwen3-14b',
                messages: [{ role: 'user', content: 'hello' }],
                tools: [],
                maxTokens: 1024
            }),
            /not loaded|HTTP 400/i
        );
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('streamCompletion serializes tool call arguments for the OpenAI wire format', async () => {
    const { streamCompletion } = require('../src/code/loop/streamCompletion.js');
    let received;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            received = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end('data: [DONE]\n\n');
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        await streamCompletion({
            apiBaseUrl: `http://127.0.0.1:${port}`,
            model: 'qwen/qwen3-14b',
            messages: [{
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'write_file', arguments: { path: 'index.html', content: '<main></main>' } }
                }]
            }],
            tools: [],
            maxTokens: 1024
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }

    const args = received.messages[0].tool_calls[0].function.arguments;
    assert.equal(typeof args, 'string');
    assert.deepEqual(JSON.parse(args), { path: 'index.html', content: '<main></main>' });
});

test('streamCompletion aborts a request that exceeds its hard deadline', async () => {
    const { streamCompletion } = require('../src/code/loop/streamCompletion.js');
    const server = http.createServer(() => {
        // Deliberately never send headers or a body.
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        await assert.rejects(
            streamCompletion({
                apiBaseUrl: `http://127.0.0.1:${port}`,
                model: 'qwen/qwen3-14b',
                messages: [{ role: 'user', content: 'hello' }],
                requestTimeoutMs: 40,
                inactivityTimeoutMs: 1000
            }),
            /timed out after 40ms/i
        );
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});

test('streamCompletion surfaces reasoning_content to onDelta but does NOT fold it into content', async () => {
    // Code Mode reasoning gap: a reasoning model streams its thinking in
    // delta.reasoning_content; that must reach the timeline (via onDelta) so the run isn't
    // silent, but must NOT become part of the message content (which is re-sent to the model).
    const { streamCompletion } = require('../src/code/loop/streamCompletion.js');
    const deltas = [];
    const server = http.createServer((req, res) => {
        let body = ''; req.on('data', c => { body += c; });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking step 1 ' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'and step 2' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'the answer' } }] }) + '\n\n');
            res.end('data: [DONE]\n\n');
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    let result;
    try {
        result = await streamCompletion({
            apiBaseUrl: `http://127.0.0.1:${port}`, model: 'm',
            messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 64,
            onDelta: (d) => deltas.push(d)
        });
    } finally {
        await new Promise(r => server.close(r));
    }
    const streamed = deltas.join('');
    assert.match(streamed, /thinking step 1/, 'reasoning streamed to onDelta (timeline not silent)');
    assert.match(streamed, /the answer/, 'content also streamed');
    assert.equal(result.message.content, 'the answer', 'reasoning is NOT in message.content (not re-sent to the model)');
});
