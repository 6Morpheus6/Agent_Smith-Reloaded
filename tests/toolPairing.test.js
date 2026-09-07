// v47.5.0 — "Invalid request: tool_call_id is not found" (HTTP 400) against strict
// hosted APIs (Kimi/Moonshot). Two-layer fix: phase compaction must keep COMPLETE
// multi-tool runs, and the wire sanitizer must guarantee a valid tool/tool_call
// sequence no matter how history was damaged (resume, truncation, slicing).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { sanitizeToolPairing } = require('../src/shared/toolPairing.js');
const { collectRecentToolPairs, compactForPhaseTransition } = require('../src/code/context/phaseCompact.js');
const { streamCompletion } = require('../src/code/loop/streamCompletion.js');

function assistantMsg(calls) {
    return {
        role: 'assistant',
        content: '',
        tool_calls: calls.map((c) => ({
            id: c.id, type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
        }))
    };
}
function toolMsg(id, name, content) {
    return { role: 'tool', tool_call_id: id, name, content: content || '{"ok":true}' };
}

/** Strict-API validity check: mirrors what Moonshot/OpenAI validate server-side. */
function assertValidPairing(messages) {
    let open = new Map();
    for (const m of messages) {
        if (m.role === 'assistant' && m.tool_calls?.length) {
            assert.equal(open.size, 0, 'previous assistant tool_calls left unanswered');
            for (const tc of m.tool_calls) {
                assert.ok(tc.id, 'every tool_call has an id');
                open.set(tc.id, true);
            }
        } else if (m.role === 'tool') {
            assert.ok(open.has(m.tool_call_id), `tool_call_id ${m.tool_call_id} must match an open tool_call`);
            open.delete(m.tool_call_id);
        } else {
            assert.equal(open.size, 0, 'non-tool message arrived with unanswered tool_calls');
        }
    }
    assert.equal(open.size, 0, 'trailing unanswered tool_calls');
}

test('valid multi-tool history passes through unchanged', () => {
    const msgs = [
        { role: 'user', content: 'build it' },
        assistantMsg([{ id: 'a1', name: 'read_file' }, { id: 'a2', name: 'write_file' }]),
        toolMsg('a1', 'read_file'),
        toolMsg('a2', 'write_file'),
        { role: 'assistant', content: 'done' }
    ];
    const out = sanitizeToolPairing(msgs);
    assert.equal(out.length, msgs.length);
    assertValidPairing(out);
});

test('multi-tool assistant with only ONE response gets the rest synthesized (compaction regression)', () => {
    // This is the exact shape phaseCompact used to produce: assistant with 3
    // tool_calls but only the first tool message kept.
    const msgs = [
        { role: 'user', content: 'task' },
        assistantMsg([{ id: 'a1', name: 'read_file' }, { id: 'a2', name: 'write_file' }, { id: 'a3', name: 'run_command' }]),
        toolMsg('a1', 'read_file')
    ];
    const out = sanitizeToolPairing(msgs);
    assertValidPairing(out);
    const tools = out.filter((m) => m.role === 'tool');
    assert.equal(tools.length, 3);
    assert.ok(tools.find((m) => m.tool_call_id === 'a2').content.includes('skipped'));
    assert.ok(tools.find((m) => m.tool_call_id === 'a3').content.includes('skipped'));
});

test('orphan tool messages are dropped', () => {
    const msgs = [
        { role: 'user', content: 'task' },
        toolMsg('ghost_1', 'read_file'), // no assistant tool_call before it
        { role: 'assistant', content: 'ok' }
    ];
    const out = sanitizeToolPairing(msgs);
    assertValidPairing(out);
    assert.equal(out.filter((m) => m.role === 'tool').length, 0);
});

test('missing tool_call ids are backfilled and matched', () => {
    const msgs = [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', name: 'read_file', content: '{}' } // no tool_call_id at all
    ];
    const out = sanitizeToolPairing(msgs);
    assertValidPairing(out);
});

test('a new assistant block before responses are given closes out the old one first', () => {
    const msgs = [
        assistantMsg([{ id: 'a1', name: 'read_file' }]),
        assistantMsg([{ id: 'b1', name: 'write_file' }]),
        toolMsg('b1', 'write_file')
    ];
    const out = sanitizeToolPairing(msgs);
    assertValidPairing(out);
    // a1's synthesized response must sit between the two assistant messages.
    const aIdx = out.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'a1');
    assert.ok(out[aIdx - 1].role === 'assistant' && out[aIdx + 1].role === 'assistant');
});

test('phaseCompact keeps the COMPLETE tool run of a multi-tool turn', () => {
    const session = {
        goal: 'build app',
        messages: [
            { role: 'user', content: 'build app' },
            assistantMsg([{ id: 'a1', name: 'read_file' }, { id: 'a2', name: 'write_file' }, { id: 'a3', name: 'run_command' }]),
            toolMsg('a1', 'read_file'),
            toolMsg('a2', 'write_file'),
            toolMsg('a3', 'run_command'),
            assistantMsg([{ id: 'b1', name: 'read_file' }]),
            toolMsg('b1', 'read_file')
        ]
    };
    const pairs = collectRecentToolPairs(session.messages, 4);
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].tools.length, 3, 'multi-tool run kept whole (was: only the first)');
    assert.equal(pairs[1].tools.length, 1);
    compactForPhaseTransition(session, { fromPhase: 'explore', toPhase: 'implement' });
    assertValidPairing(sanitizeToolPairing(session.messages));
    // And the compacted history must be valid even WITHOUT the sanitizer.
    assertValidPairing(session.messages);
});

// --- Wire-level end to end: a damaged history must go out valid ----------------
function fakeLlmServer(onRequest) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            onRequest({ headers: req.headers, body: body ? JSON.parse(body) : null });
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

test('streamCompletion sends a strict-valid message sequence even from a broken history', async () => {
    let seen = null;
    const { server, port } = await fakeLlmServer((r) => { seen = r; });
    try {
        await streamCompletion({
            apiBaseUrl: `http://127.0.0.1:${port}`,
            model: 'kimi-k3',
            messages: [
                { role: 'user', content: 'build app' },
                assistantMsg([{ id: 'a1', name: 'read_file' }, { id: 'a2', name: 'write_file' }]),
                toolMsg('a1', 'read_file'), // a2 response lost (compaction/resume)
                toolMsg('ghost', 'read_file'), // orphan from a dropped assistant
                { role: 'user', content: 'continue' }
            ]
        });
        assert.ok(seen, 'server received a request');
        assertValidPairing(seen.body.messages);
    } finally {
        server.close();
    }
});

// --- v47.5.1: canonical wire shape for strict APIs -------------------------------

test('wire normalization strips undocumented fields (name on tool messages, extras)', async () => {
    let seen = null;
    const { server, port } = await fakeLlmServer((r) => { seen = r; });
    try {
        await streamCompletion({
            apiBaseUrl: `http://127.0.0.1:${port}`,
            model: 'kimi-k3',
            messages: [
                { role: 'user', content: 'task' },
                assistantMsg([{ id: 'a1', name: 'read_file' }]),
                toolMsg('a1', 'read_file')
            ]
        });
        assert.ok(seen);
        const tool = seen.body.messages.find((m) => m.role === 'tool');
        assert.ok(tool, 'tool message present');
        assert.deepEqual(Object.keys(tool).sort(), ['content', 'role', 'tool_call_id'],
            'tool message must carry ONLY role/tool_call_id/content (Moonshot documents no name field)');
        const assistant = seen.body.messages.find((m) => m.role === 'assistant' && m.tool_calls);
        assert.ok(!('content' in assistant) || assistant.content !== '',
            'assistant with tool_calls must not send empty-string content');
    } finally {
        server.close();
    }
});

test('normalizeWireMessage keeps multimodal array content on user messages', () => {
    const { normalizeWireMessage } = require('../src/shared/toolPairing.js');
    const img = [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }
    ];
    const out = normalizeWireMessage({ role: 'user', content: img });
    assert.deepEqual(out.content, img);
    const toolOut = normalizeWireMessage({ role: 'tool', tool_call_id: 'x', name: 'write_file', content: 'ok' });
    assert.deepEqual(Object.keys(toolOut).sort(), ['content', 'role', 'tool_call_id']);
    const aOut = normalizeWireMessage({ role: 'assistant', content: '', tool_calls: [{ id: 'x' }] });
    assert.ok(!('content' in aOut), 'empty content omitted when tool_calls present');
});

test('malformed tool schemas are normalized to the minimum valid shape on the wire', async () => {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const parsed = JSON.parse(body);
            assert.ok(Array.isArray(parsed.tools) && parsed.tools.length === 2, 'valid entries kept');
            for (const t of parsed.tools) {
                assert.equal(t.type, 'function');
                assert.ok(t.function.name);
                assert.equal(t.function.parameters.type, 'object');
                assert.ok(t.function.parameters.properties && typeof t.function.parameters.properties === 'object');
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            server.close();
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        await streamCompletion({
            apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
            model: 'kimi-k3',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [
                { function: { name: 'no_params_schema' } },               // missing parameters entirely
                { name: 'flat_schema' },                                  // missing function wrapper
                null                                                      // junk entry dropped
            ]
        });
    } finally {
        server.close();
    }
});

test('a strict-API 400 surfaces the validator param/code/type in the error message', async () => {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid request', param: 'messages.[3].name', code: 'invalid_field', type: 'invalid_request_error' } }));
            server.close();
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        await assert.rejects(
            streamCompletion({
                apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
                model: 'kimi-k3',
                messages: [{ role: 'user', content: 'hi' }]
            }),
            (err) => {
                assert.ok(err.message.includes('Invalid request'));
                assert.ok(err.message.includes('param: messages.[3].name'), 'param surfaced');
                assert.ok(err.message.includes('code: invalid_field'), 'code surfaced');
                return true;
            }
        );
    } finally {
        server.close();
    }
});
