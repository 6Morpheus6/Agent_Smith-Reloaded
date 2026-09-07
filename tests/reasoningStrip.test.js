const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripInlineReasoning } = require('../src/code/loop/reasoningStrip.js');

test('removes a complete <think>...</think> block, keeps the real content', () => {
    const r = stripInlineReasoning('<think>let me plan this</think>\nconsole.log("hi");');
    assert.equal(r.text, 'console.log("hi");');
    assert.equal(r.hadReasoning, true);
});

test('keeps content that follows an orphaned closing tag', () => {
    const r = stripInlineReasoning('planning the change...\n</think>\n{"name":"write_file"}');
    assert.equal(r.text, '{"name":"write_file"}');
    assert.equal(r.hadReasoning, true);
});

test('drops an unclosed (truncated) opening reasoning tag entirely', () => {
    const r = stripInlineReasoning('<think>I will first consider the edge cases and');
    assert.equal(r.text, '');
    assert.equal(r.hadReasoning, true);
});

test('passes through normal content untouched', () => {
    const r = stripInlineReasoning('function add(a,b){ return a+b; }');
    assert.equal(r.text, 'function add(a,b){ return a+b; }');
    assert.equal(r.hadReasoning, false);
});

test('handles <thinking> variant', () => {
    const r = stripInlineReasoning('<thinking>hmm</thinking>DONE');
    assert.equal(r.text, 'DONE');
    assert.equal(r.hadReasoning, true);
});
