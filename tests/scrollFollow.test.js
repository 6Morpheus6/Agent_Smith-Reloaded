/**
 * Scroll follow — stick-to-bottom logic for agent runs.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    shouldAutoScroll,
    isNearBottom,
    distanceFromBottom,
    DEFAULT_THRESHOLD
} = require('../src/renderer/ui/scrollFollow.js');

test('shouldAutoScroll when near bottom', () => {
    assert.equal(shouldAutoScroll({ nearBottom: true, force: false }), true);
});

test('shouldAutoScroll false when scrolled up', () => {
    assert.equal(shouldAutoScroll({ nearBottom: false, force: false }), false);
});

test('shouldAutoScroll force overrides', () => {
    assert.equal(shouldAutoScroll({ nearBottom: false, force: true }), true);
});

test('isNearBottom uses threshold', () => {
    const el = { scrollHeight: 1000, scrollTop: 850, clientHeight: 100 };
    assert.equal(distanceFromBottom(el), 50);
    assert.equal(isNearBottom(el, DEFAULT_THRESHOLD), true);
    assert.equal(isNearBottom(el, 40), false);
});
