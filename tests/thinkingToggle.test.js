// v54.4 — 🧠 THINK toggle: request-level thinking overrides (src/shared/thinkingToggle.js)
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isThinkingEnabled, thinkingBodyOverrides } = require('../src/shared/thinkingToggle.js');

test('thinking ON (or unknown/legacy state) sends nothing new', () => {
    // The default path must stay byte-identical to pre-v54.4 requests.
    assert.deepStrictEqual(thinkingBodyOverrides(true), {});
    assert.deepStrictEqual(thinkingBodyOverrides(undefined), {});
    assert.deepStrictEqual(thinkingBodyOverrides(null), {});
    assert.deepStrictEqual(thinkingBodyOverrides(true, { strict: true }), {},
        'strict is irrelevant while thinking is ON');
});

test('thinking OFF forces chat_template_kwargs.enable_thinking=false', () => {
    const extra = thinkingBodyOverrides(false);
    assert.deepStrictEqual(extra, { chat_template_kwargs: { enable_thinking: false } });
});

test('strict mode adds reasoning_effort=none (LM Studio native control)', () => {
    const extra = thinkingBodyOverrides(false, { strict: true });
    assert.strictEqual(extra.chat_template_kwargs.enable_thinking, false);
    assert.strictEqual(extra.reasoning_effort, 'none');
});

test('isThinkingEnabled: only explicit false disables', () => {
    // Old Code sessions saved before this field existed resume with thinking ON.
    assert.strictEqual(isThinkingEnabled(undefined), true);
    assert.strictEqual(isThinkingEnabled(true), true);
    assert.strictEqual(isThinkingEnabled(false), false);
});

test('module is also exposed as window.XKThinkingToggle', () => {
    assert.ok(globalThis.XKThinkingToggle, 'global not attached');
    assert.strictEqual(typeof globalThis.XKThinkingToggle.thinkingBodyOverrides, 'function');
});
