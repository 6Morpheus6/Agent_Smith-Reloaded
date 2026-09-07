/**
 * gemmaHarness — Gemma message-adaptation contract.
 *
 * Pure helpers, no DOM. These lock the invariants the agent loop relies on: detection,
 * variant branching, system folding, tool-history serialization, the JSON tool preamble,
 * the gemma4 tool-result role, and the idempotency that lets the planning/recovery loops
 * re-send a growing array each turn without double-folding.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const gh = require('../src/code/context/gemmaHarness');

test('isGemmaModel detects gemma ids only', () => {
    assert.equal(gh.isGemmaModel('gemma-3-4b-it'), true);
    assert.equal(gh.isGemmaModel('google/gemma-2-9b'), true);
    assert.equal(gh.isGemmaModel('qwen2.5-coder-7b'), false);
    assert.equal(gh.isGemmaModel(''), false);
    assert.equal(gh.isGemmaModel(undefined), false);
});

test('gemmaVariant splits gemma4 from gemma3', () => {
    assert.equal(gh.gemmaVariant('gemma-4-e4b'), 'gemma4');
    assert.equal(gh.gemmaVariant('gemma4-27b'), 'gemma4');
    assert.equal(gh.gemmaVariant('gemma-3-4b-it'), 'gemma3');
    assert.equal(gh.gemmaVariant('gemma-2-9b'), 'gemma');
    assert.equal(gh.gemmaVariant('llama-3'), 'gemma'); // non-gemma falls back, never throws
});

test('toolResultRole is tool_responses for gemma4, tool otherwise', () => {
    assert.equal(gh.toolResultRole('gemma-4-31b'), 'tool_responses');
    assert.equal(gh.toolResultRole('gemma4-27b'), 'tool_responses');
    assert.equal(gh.toolResultRole('gemma-3-4b'), 'tool');
});

test('buildGemmaToolPreamble states the JSON-only contract and lists tools', () => {
    const p = gh.buildGemmaToolPreamble(['read_file', 'write_file']);
    assert.match(p, /parameters/);
    assert.match(p, /ONLY a JSON object and no other text/);
    assert.match(p, /read_file/);
    assert.match(p, /write_file/);
});

test('foldSystemForGemma merges system into the first user turn and drops system role', () => {
    const out = gh.foldSystemForGemma([
        { role: 'system', content: 'SYS RULES' },
        { role: 'user', content: 'build a thing' }
    ]);
    assert.equal(out.some(m => m.role === 'system'), false);
    assert.equal(out[0].role, 'user');
    assert.match(out[0].content, /SYS RULES/);
    assert.match(out[0].content, /build a thing/);
});

test('serializeToolTurnsForGemma rewrites assistant tool_calls + tool results to text', () => {
    const out = gh.serializeToolTurnsForGemma([
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
        { role: 'tool', name: 'read_file', content: 'file body', tool_call_id: 'c1' }
    ]);
    assert.equal(out.some(m => m.role === 'tool'), false);
    assert.equal(out.some(m => Array.isArray(m.tool_calls)), false);
    assert.match(out[0].content, /read_file/);
    assert.match(out[1].content, /Invoking tool `read_file` produced/);
    assert.match(out[1].content, /file body/);
});

test('adaptMessagesForGemma folds, serializes, and injects preamble once (idempotent)', () => {
    const messages = [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'go' }
    ];
    const opts = { toolNames: ['read_file'], serializeToolHistory: true };
    const once = gh.adaptMessagesForGemma(messages, 'gemma-3-4b', opts);
    assert.equal(once.some(m => m.role === 'system'), false);
    assert.equal(once[0].role, 'user');
    assert.match(once[0].content, new RegExp(gh.PREAMBLE_SENTINEL.replace(/[[\]]/g, '\\$&')));

    // Second pass on the already-adapted array must not add a second preamble.
    const twice = gh.adaptMessagesForGemma(once, 'gemma-3-4b', opts);
    const occurrences = twice.filter(m => typeof m.content === 'string' && m.content.includes(gh.PREAMBLE_SENTINEL)).length;
    assert.equal(occurrences, 1);
});

test('adaptMessagesForGemma is a pass-through for non-Gemma models', () => {
    const messages = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'go' }];
    const out = gh.adaptMessagesForGemma(messages, 'qwen2.5-coder-7b', { toolNames: ['read_file'] });
    assert.equal(out, messages); // same reference, untouched
});

test('adaptMessagesForGemma folds seeded assistant greeting before first user turn', () => {
    const out = gh.adaptMessagesForGemma([
        { role: 'system', content: 'SYS' },
        { role: 'assistant', content: 'Mr. Anderson. Welcome back.' },
        { role: 'user', content: 'Hey' }
    ], 'gemma-4-26b', { toolNames: ['memory_search'], serializeToolHistory: true });
    assert.equal(out[0].role, 'user');
    assert.equal(out.some(m => m.role === 'assistant'), false);
    assert.match(out[0].content, /Welcome back/);
    assert.match(out[0].content, /Hey/);
});
