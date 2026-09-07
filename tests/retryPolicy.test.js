/**
 * v53.6 — retryPolicy: hermes-grade transient-failure recovery for the chat path.
 *
 * The chat loop previously ended a run on the FIRST failed request (failed to fetch,
 * engine SIGABRT after headers, ECONNRESET, 429/5xx). Code Mode already retried stalls
 * up to 8 times — this brings both loops to ONE shared policy. Tests call the pure
 * module directly (no source regex): classification, backoff bounds, and the two hard
 * safety rules (never retry once content streamed; never retry a user abort or a
 * permanent failure).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rp = require('../src/shared/retryPolicy.js');

test('transient failures are classified retryable', () => {
    const transient = [
        'LM Studio response stalled for 600000ms.',
        'LM Studio stream stalled right after headers with no output (engine may have crashed or the model failed to load mid-request).',
        'Failed to fetch',
        'TypeError: Failed to fetch',
        'network error',
        'socket hang up',
        'read ECONNRESET',
        'connect ECONNREFUSED 127.0.0.1:1234',
        'Uplink Error (503): Engine is overloaded',
        'LM Studio HTTP 500: engine protocol runtime exited unexpectedly',
        'rate limit exceeded, slow down',
        'Request timeout after 900s — no response from LM Studio.'
    ];
    for (const m of transient) {
        assert.equal(rp.classifyError(new Error(m)), 'transient', `should be transient: ${m}`);
        assert.equal(rp.isRetryableError(new Error(m)), true, m);
    }
});

test('permanent failures are fatal — retrying them only burns minutes', () => {
    const fatal = [
        "Prompt exceeds the model's loaded context window.",
        'exceed_context_size_error: this model’s maximum context length is 8192 tokens',
        'invalid api key',
        'unauthorized',
        'no models loaded',
        'Aborted'
    ];
    for (const m of fatal) {
        assert.equal(rp.classifyError(new Error(m)), 'fatal', `should be fatal: ${m}`);
        assert.equal(rp.isRetryableError(new Error(m)), false, m);
    }
});

test('backoff is bounded and grows with the attempt', () => {
    const d1 = rp.retryDelayMs(1);
    const d2 = rp.retryDelayMs(2);
    const d9 = rp.retryDelayMs(9);
    assert.ok(d1 >= 800 && d1 <= 15000, `attempt-1 delay in range: ${d1}`);
    assert.ok(d2 > d1 * 0.9, 'later attempts wait at least as long');
    assert.ok(d9 <= 18000, `hard cap respected: ${d9}`);
});

test('Retry-After hint is honored up to the 30s ceiling', () => {
    const d = rp.retryDelayMs(1, { retryAfterSec: 5 });
    assert.ok(d >= 5000 && d <= 30000, `retry-after respected: ${d}`);
    const capped = rp.retryDelayMs(1, { retryAfterSec: 600 });
    assert.equal(capped, 30000);
});

test('shouldRetry: retries transient errors within budget', () => {
    const d = rp.shouldRetry({ attempt: 1, maxAttempts: 2, error: new Error('Failed to fetch') });
    assert.equal(d.retry, true);
    assert.ok(d.delayMs > 0);
});

test('shouldRetry: never replays after content reached the user', () => {
    const d = rp.shouldRetry({ attempt: 1, maxAttempts: 2, contentSeen: true, error: new Error('socket hang up') });
    assert.equal(d.retry, false);
    assert.match(d.reason, /streaming/);
});

test('shouldRetry: never retries a user abort', () => {
    const d = rp.shouldRetry({ attempt: 1, maxAttempts: 2, aborted: true, error: new Error('Aborted') });
    assert.equal(d.retry, false);
});

test('shouldRetry: permanent errors fail fast', () => {
    const d = rp.shouldRetry({ attempt: 1, maxAttempts: 2, error: new Error("Prompt exceeds the model's loaded context window.") });
    assert.equal(d.retry, false);
    assert.match(d.reason, /permanent/);
});

test('shouldRetry: bounded — the budget runs out', () => {
    const d = rp.shouldRetry({ attempt: 3, maxAttempts: 2, error: new Error('Failed to fetch') });
    assert.equal(d.retry, false);
    assert.match(d.reason, /budget/);
});

test('unknown failures with no output get one safe replay', () => {
    const d = rp.shouldRetry({ attempt: 1, maxAttempts: 2, error: new Error('something strange happened') });
    assert.equal(d.retry, true);
});
