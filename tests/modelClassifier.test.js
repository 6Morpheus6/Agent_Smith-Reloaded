const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyModel } = require('../src/shared/modelClassifier.js');

test('classifyModel detects qwen coder 7b', () => {
    const c = classifyModel('qwen2.5-coder-7b-instruct');
    assert.equal(c.family, 'qwen');
    assert.equal(c.sizeB, 7);
    assert.equal(c.isCoder, true);
    assert.match(c.label, /7B/);
    assert.match(c.label, /coder/i);
});

test('classifyModel detects gemma 3 12b', () => {
    const c = classifyModel('google/gemma-3-12b-it');
    assert.equal(c.family, 'gemma');
    assert.equal(c.sizeB, 14);
    assert.equal(c.isCoder, false);
});

test('classifyModel detects llama 70b', () => {
    const c = classifyModel('meta-llama/Llama-3.1-70B-Instruct');
    assert.equal(c.family, 'llama');
    assert.equal(c.sizeB, 70);
});

test('classifyModel handles unknown id', () => {
    const c = classifyModel('my-custom-local-model');
    assert.equal(c.family, 'unknown');
    assert.equal(c.sizeB, null);
    assert.equal(c.isCoder, false);
});

test('classifyModel detects reasoning models', () => {
    const c = classifyModel('deepseek-r1-distill-7b');
    assert.equal(c.isReasoning, true);
    assert.match(c.label, /reasoning/i);
});
