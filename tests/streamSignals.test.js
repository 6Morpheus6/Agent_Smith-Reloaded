/**
 * v52.7 — streamSignals: model-agnostic interpretation of what an OpenAI-compatible
 * streaming server (LM Studio) actually did with a request. These are the signals every
 * "no cut-offs while generating" fix keys on, so they must be exact and family-independent.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBusyState, classifyStreamEnd, classifyHttpError } = require('../src/shared/streamSignals.js');

// ── isBusyState ────────────────────────────────────────────────────────────────

test('waiting and generating are busy; idle/null/unknown are not', () => {
    assert.equal(isBusyState('waiting'), true);
    assert.equal(isBusyState('generating'), true);
    assert.equal(isBusyState('idle'), false);
    assert.equal(isBusyState(null), false);
    assert.equal(isBusyState(undefined), false);
    assert.equal(isBusyState('done'), false);
});

// ── classifyStreamEnd: the exhaustion signature (the "Gemma4 looks broken" case) ──

test('length + no content + no tool call = budget_exhausted, WITH visible reasoning', () => {
    const r = classifyStreamEnd({ finishReason: 'length', contentChars: 0, reasoningChars: 812, toolCallCount: 0 });
    assert.equal(r.kind, 'budget_exhausted');
    assert.match(r.reason, /internal reasoning/);
});

test('length + no content + no tool call = budget_exhausted even WITHOUT a visible thinking channel', () => {
    // Some servers fold thinking into content or drop the field entirely — the signature is
    // still "stopped at the budget with nothing out", and it must be detected either way.
    const r = classifyStreamEnd({ finishReason: 'length', contentChars: 0, reasoningChars: 0, toolCallCount: 0 });
    assert.equal(r.kind, 'budget_exhausted');
});

test('a partial TOOL CALL with length is truncated (chunked-write recovery), not exhaustion', () => {
    const r = classifyStreamEnd({ finishReason: 'length', contentChars: 0, reasoningChars: 400, toolCallCount: 1 });
    assert.equal(r.kind, 'truncated');
});

test('partial CONTENT with length is truncated (something came out)', () => {
    const r = classifyStreamEnd({ finishReason: 'length', contentChars: 512, reasoningChars: 0, toolCallCount: 0 });
    assert.equal(r.kind, 'truncated');
});

test('clean stop with empty content is clean (a genuine "done" — must NOT trigger recovery)', () => {
    const r = classifyStreamEnd({ finishReason: 'stop', contentChars: 0, reasoningChars: 900, toolCallCount: 0 });
    assert.equal(r.kind, 'clean');
});

test('normal stop with content is clean', () => {
    const r = classifyStreamEnd({ finishReason: 'stop', contentChars: 1234, reasoningChars: 500, toolCallCount: 0 });
    assert.equal(r.kind, 'clean');
});

test('tool-call turn ending in length is truncated (partial args), not exhaustion', () => {
    const r = classifyStreamEnd({ finishReason: 'length', contentChars: 10, reasoningChars: 0, toolCallCount: 2 });
    assert.equal(r.kind, 'truncated');
});

test('missing/undefined fields degrade safely (treated as zero / no reason)', () => {
    const r = classifyStreamEnd({});
    assert.equal(r.kind, 'clean');
    const r2 = classifyStreamEnd(null);
    assert.equal(r2.kind, 'clean');
});

test('non-length finish reasons are always clean regardless of content', () => {
    for (const fr of ['stop', 'tool_calls', 'content_filter']) {
        assert.equal(classifyStreamEnd({ finishReason: fr, contentChars: 0 }).kind, 'clean');
    }
});

// ── classifyHttpError ──────────────────────────────────────────────────────────

test('LM Studio context-overflow body is classified with an actionable message', () => {
    const r = classifyHttpError({ status: 400, body: '{"error":{"message":"Prompt exceeds the available context size (exceed_context_size_error)"}}' });
    assert.equal(r.isContextOverflow, true);
    assert.match(r.message, /context window/i);
});

test('model-load failures get their own message', () => {
    const r = classifyHttpError({ status: 500, body: 'failed to load model: out of memory' });
    assert.equal(r.isContextOverflow, false);
    assert.match(r.message, /failed to load/i);
});

test('unrelated errors pass through with no override message', () => {
    const r = classifyHttpError({ status: 500, body: 'internal engine error' });
    assert.equal(r.isContextOverflow, false);
    assert.equal(r.message, null);
});

test('classifyHttpError tolerates missing body/message', () => {
    const r = classifyHttpError(null);
    assert.equal(r.isContextOverflow, false);
    assert.equal(r.message, null);
});
