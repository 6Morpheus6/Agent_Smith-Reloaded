// v47.6.0 — model harness restructure + budget eviction audit fixes.
//
// modelHarness.js is the single table-driven place that decides how to talk to the
// loaded model (prompt adaptation + temperature pins per family). These tests pin
// the routing contract, Gemma parity with the legacy path, passthrough stability,
// and the fitBudget atomic-eviction guarantee (no split tool runs).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    getModelHarness,
    adaptMessagesForModel,
    pinTemperatureForModel,
    describeModelHarness,
    STRATEGIES
} = require('../src/code/context/modelHarness.js');
const gemmaHarness = require('../src/code/context/gemmaHarness.js');
const { fitBudget } = require('../src/code/context/budget.js');

// --- Routing --------------------------------------------------------------------

test('harness routing: every model family lands on the right strategy', () => {
    assert.equal(getModelHarness('gemma-3-4b-it').id, 'gemma');
    assert.equal(getModelHarness('google/gemma4-27b').id, 'gemma');
    assert.equal(getModelHarness('kimi-k3').id, 'kimi-k3');
    assert.equal(getModelHarness('moonshot/kimi-k3-instruct').id, 'kimi-k3');
    assert.equal(getModelHarness('qwen2.5-coder-7b').id, 'default');
    assert.equal(getModelHarness('deepseek-r1-32b').id, 'default');
    assert.equal(getModelHarness('').id, 'default');
    assert.equal(getModelHarness(null).id, 'default');
    assert.equal(getModelHarness(undefined).id, 'default');
});

test('harness lookup can never fail (default row matches everything)', () => {
    assert.equal(STRATEGIES[STRATEGIES.length - 1].id, 'default');
    assert.equal(typeof describeModelHarness('anything-at-all').description, 'string');
    assert.ok(describeModelHarness('anything-at-all').description.length > 10);
});

// --- Gemma parity + stability ---------------------------------------------------

const GEMMA_HISTORY = [
    { role: 'system', content: 'You are Agent Smith.' },
    { role: 'user', content: 'build a page' },
    {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.js","content":"x"}' } }]
    },
    { role: 'tool', tool_call_id: 'c1', name: 'write_file', content: '{"ok":true}' },
    { role: 'assistant', content: 'next step' }
];

test('gemma strategy is byte-identical to the legacy gemmaHarness path', () => {
    const viaHarness = adaptMessagesForModel(GEMMA_HISTORY, 'gemma-3-4b', {
        toolNames: ['write_file'], serializeToolHistory: true
    });
    const viaLegacy = gemmaHarness.adaptMessagesForGemma(GEMMA_HISTORY, 'gemma-3-4b', {
        toolNames: ['write_file'], serializeToolHistory: true
    });
    assert.deepEqual(viaHarness, viaLegacy);
});

test('gemma adaptation leaves a shape small models understand (no system/tool roles)', () => {
    const out = adaptMessagesForModel(GEMMA_HISTORY, 'gemma-3-4b', {
        toolNames: ['write_file'], serializeToolHistory: true
    });
    assert.ok(!out.some(m => m.role === 'system'), 'system folded into user turns');
    assert.ok(!out.some(m => m.role === 'tool'), 'tool results serialized to text');
    assert.ok(!out.some(m => Array.isArray(m.tool_calls) && m.tool_calls.length),
        'no native tool_calls remain for gemma');
    assert.ok(out.some(m => typeof m.content === 'string' && m.content.includes(gemmaHarness.PREAMBLE_SENTINEL)),
        'tool protocol preamble present');
});

test('adaptMessagesForModel is idempotent for gemma (safe to re-run every turn)', () => {
    const once = adaptMessagesForModel(GEMMA_HISTORY, 'gemma-3-4b', {
        toolNames: ['write_file'], serializeToolHistory: true
    });
    const twice = adaptMessagesForModel(once, 'gemma-3-4b', {
        toolNames: ['write_file'], serializeToolHistory: true
    });
    assert.deepEqual(twice, once);
});

// --- Passthrough families --------------------------------------------------------

test('default + kimi strategies pass messages through untouched (native tool path)', () => {
    for (const model of ['qwen2.5-coder-7b', 'kimi-k3']) {
        const out = adaptMessagesForModel(GEMMA_HISTORY, model, {
            toolNames: ['write_file'], serializeToolHistory: true
        });
        assert.deepEqual(out, GEMMA_HISTORY, `${model} must not be reshaped`);
    }
});

// --- Temperature pins ------------------------------------------------------------

test('temperature pins: kimi-k3 forced to 1, everything else respected', () => {
    assert.equal(pinTemperatureForModel('kimi-k3', 0.2), 1);
    assert.equal(pinTemperatureForModel('Kimi-K3', 0.7), 1);
    assert.equal(pinTemperatureForModel('kimi-k2.6', 0.2), 0.2, 'non-K3 kimi keeps caller temperature');
    assert.equal(pinTemperatureForModel('qwen2.5-coder', 0.2), 0.2);
    assert.equal(pinTemperatureForModel('gemma-3-4b', 0.5), 0.5);
    assert.equal(pinTemperatureForModel('', 0.3), 0.3);
});

// --- fitBudget atomic eviction ---------------------------------------------------

test('fitBudget never splits a tool run (atomic eviction keeps pairing coherent)', () => {
    const big = 'x'.repeat(4000);
    const messages = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'the goal' },
        {
            role: 'assistant', content: '',
            tool_calls: [
                { id: 'a1', type: 'function', function: { name: 'write_file', arguments: '{}' } },
                { id: 'a2', type: 'function', function: { name: 'run_command', arguments: '{}' } }
            ]
        },
        { role: 'tool', tool_call_id: 'a1', name: 'write_file', content: big },
        { role: 'tool', tool_call_id: 'a2', name: 'run_command', content: big },
        { role: 'assistant', content: big },
        { role: 'user', content: 'latest instruction' }
    ];
    const out = fitBudget(messages, 400, 0); // tiny budget forces several evictions
    // Invariant WITHOUT any sanitizer: no orphaned tool messages, no unanswered calls.
    let open = new Set();
    for (const m of out) {
        if (m.role === 'assistant' && m.tool_calls?.length) {
            assert.equal(open.size, 0, 'assistant tool_calls left unanswered after eviction');
            m.tool_calls.forEach(tc => open.add(tc.id));
        } else if (m.role === 'tool') {
            assert.ok(open.has(m.tool_call_id), `orphan tool message ${m.tool_call_id} after eviction`);
            open.delete(m.tool_call_id);
        } else if (m.role !== 'system') {
            assert.equal(open.size, 0, 'non-tool message with unanswered calls after eviction');
        }
    }
    // The protected head + tail survive.
    assert.equal(out[0].role, 'system');
    assert.equal(out[0].content, 'system prompt');
    assert.equal(out[out.length - 1].content, 'latest instruction');
});
