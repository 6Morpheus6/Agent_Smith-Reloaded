// Kimi K3 (hosted Moonshot API) provider support — the toggle routes Chat/Agent/Code
// through https://api.moonshot.ai with a Bearer key. These tests pin the plumbing:
// the Code Mode stream must attach Authorization when an apiKey is threaded through
// (and must NOT send one for local LM Studio), every loop layer must forward it,
// and kimi-k3's temperature must be pinned to 1 (the API rejects any other value).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { streamCompletion } = require('../src/code/loop/streamCompletion.js');
const { runTurnLoop } = require('../src/code/loop/turnLoop.js');
const { runPlanningPhase } = require('../src/code/loop/planningPhase.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { QualityMonitor } = require('../src/code/governor/qualityMonitor.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');
const { isKimiK3Model } = require('../src/shared/modelClassifier.js');
const netGuard = require('../src/shared/netGuard.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Deliberately NOT an sk-* shaped literal so secret-scanning/redaction layers leave it alone.
const TEST_KEY = 'test-kimi-key-0001';
const THREADED_KEY = 'test-threaded-key-0002';
const PLAN_KEY = 'test-plan-key-0003';

// Minimal OpenAI-compatible SSE server that records the Authorization header.
function fakeLlmServer(onRequest) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            onRequest({ headers: req.headers, body: body ? JSON.parse(body) : null });
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

test('streamCompletion sends Authorization: Bearer <key> when apiKey is provided', async () => {
    let seen = null;
    const { server, port } = await fakeLlmServer((r) => { seen = r; });
    try {
        const result = await streamCompletion({
            apiBaseUrl: `http://127.0.0.1:${port}`,
            apiKey: TEST_KEY,
            model: 'kimi-k3',
            messages: [{ role: 'user', content: 'hello' }]
        });
        assert.equal(result.message.content, 'hi');
        assert.ok(seen, 'server received a request');
        assert.equal(seen.headers['authorization'], `Bearer ${TEST_KEY}`);
        assert.equal(seen.body.model, 'kimi-k3');
    } finally {
        server.close();
    }
});

test('streamCompletion sends NO Authorization header without an apiKey (local LM Studio)', async () => {
    let seen = null;
    const { server, port } = await fakeLlmServer((r) => { seen = r; });
    try {
        await streamCompletion({
            apiBaseUrl: `http://127.0.0.1:${port}`,
            model: 'local-model',
            messages: [{ role: 'user', content: 'hello' }]
        });
        assert.ok(seen, 'server received a request');
        assert.equal(seen.headers['authorization'], undefined);
    } finally {
        server.close();
    }
});

test('kimi-k3 temperature is pinned to 1 on the wire (HTTP 400 regression)', async () => {
    let seen = null;
    const { server, port } = await fakeLlmServer((r) => { seen = r; });
    try {
        await streamCompletion({
            apiBaseUrl: `http://127.0.0.1:${port}`,
            apiKey: TEST_KEY,
            model: 'kimi-k3',
            temperature: 0.2, // Code Mode default — must NOT reach the server for kimi-k3
            messages: [{ role: 'user', content: 'hello' }]
        });
        assert.ok(seen, 'server received a request');
        assert.equal(seen.body.temperature, 1, 'kimi-k3 rejects any temperature but 1');
    } finally {
        server.close();
    }
});

test('non-kimi models keep their requested temperature', async () => {
    let seen = null;
    const { server, port } = await fakeLlmServer((r) => { seen = r; });
    try {
        await streamCompletion({
            apiBaseUrl: `http://127.0.0.1:${port}`,
            model: 'qwen3-7b',
            temperature: 0.2,
            messages: [{ role: 'user', content: 'hello' }]
        });
        assert.ok(seen, 'server received a request');
        assert.equal(seen.body.temperature, 0.2);
    } finally {
        server.close();
    }
});

test('isKimiK3Model matches only kimi-k3 ids, not other kimi models', () => {
    assert.equal(isKimiK3Model('kimi-k3'), true);
    assert.equal(isKimiK3Model('Kimi-K3'), true);
    assert.equal(isKimiK3Model('kimi_k3'), true);
    assert.equal(isKimiK3Model('kimi-k2.6'), false);
    assert.equal(isKimiK3Model('kimi-k2.7-code-highspeed'), false);
    assert.equal(isKimiK3Model('qwen3-7b'), false);
    assert.equal(isKimiK3Model(''), false);
    assert.equal(isKimiK3Model(null), false);
});

function mkSession(opts) {
    return {
        id: 'test', goal: 'say hello',
        projectRoot: opts.projectRoot, model: 'kimi-k3', numCtx: 8192,
        status: 'running', turn: 0, toolCount: 0,
        messages: [{ role: 'user', content: 'task' }],
        filesTouched: [], completionReflections: 0
    };
}

test('runTurnLoop forwards ctx.apiKey to the stream call', async () => {
    const session = mkSession({ projectRoot: tmp('kimi-turn-') });
    let captured = null;
    await runTurnLoop({
        session,
        apiBaseUrl: 'https://api.moonshot.ai',
        apiKey: THREADED_KEY,
        tools: [],
        emit: () => {},
        execDeps: {},
        planAnchor: new PlanAnchor(session.goal),
        qualityMonitor: new QualityMonitor(),
        earlyStop: new EarlyStopDetector({ maxTurns: 5 }),
        streamCompletion: async (args) => {
            captured = args;
            return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        }
    });
    assert.ok(captured, 'stream was invoked');
    assert.equal(captured.apiKey, THREADED_KEY);
    assert.equal(captured.apiBaseUrl, 'https://api.moonshot.ai');
    assert.equal(captured.model, 'kimi-k3');
});

test('runPlanningPhase forwards ctx.apiKey to the stream call', async () => {
    const session = mkSession({ projectRoot: tmp('kimi-plan-') });
    let captured = null;
    await runPlanningPhase({
        session,
        apiBaseUrl: 'https://api.moonshot.ai',
        apiKey: PLAN_KEY,
        model: 'kimi-k3',
        emit: () => {},
        execDeps: {},
        streamCompletion: async (args) => {
            captured = args;
            return {
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call_1', type: 'function',
                        function: { name: 'submit_code_plan', arguments: { steps: ['do it'] } }
                    }]
                },
                finishReason: 'tool_calls'
            };
        }
    });
    assert.ok(captured, 'planning stream was invoked');
    assert.equal(captured.apiKey, PLAN_KEY);
});

test('proxy allow-list accepts a configured remote LLM origin (Kimi)', () => {
    const ok = netGuard.validateProxyTarget(
        'https://api.moonshot.ai/v1/chat/completions',
        'https://api.moonshot.ai'
    );
    assert.ok(ok, 'configured Kimi origin must be a valid proxy target');
    const other = netGuard.validateProxyTarget(
        'https://evil.example.com/v1/chat/completions',
        'https://api.moonshot.ai'
    );
    assert.equal(other, null, 'unrelated remote origins stay blocked');
});
