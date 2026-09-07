/**
 * v53.1 — no double-send (mobile "task loops after completion" fix).
 *
 * sendMessage() used to check its busy guard, then AWAIT pre-flight work before setting
 * isSending=true — two taps ~50ms apart both passed the guard and started the SAME task
 * twice. Fix: src/shared/sendSlot.js claims the slot SYNCHRONOUSLY before any await; this
 * test drives that real module (the exact claim/release shape app.js uses).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSendSlot } = require('../src/shared/sendSlot.js');

test('second send in the pre-flight window is refused (the mobile loop bug)', () => {
    const chatRunState = { isBusy: false };
    const codeRunState = { isBusy: false };
    const slot = createSendSlot({ chatRunState, codeRunState });

    assert.equal(slot.claim(), true, 'first tap claims the slot');
    // The first send is now in its pre-flight awaits (plugin expansion / context sync).
    // A second tap 20ms later must be refused — even though no run has "started" yet.
    assert.equal(slot.claim(), false, 'second tap while first is pre-flying is refused');
    slot.release();
});

test('early-return paths release the slot so a retry works', () => {
    const chatRunState = { isBusy: false };
    const codeRunState = { isBusy: false };
    const slot = createSendSlot({ chatRunState, codeRunState });

    assert.equal(slot.claim(), true);
    // "No model selected" early return → release (mirrors app.js releaseSendSlot()).
    slot.release();
    assert.equal(chatRunState.isBusy, false, 'release clears the mode-switch block');
    assert.equal(slot.claim(), true, 'retry after an early return claims normally');
});

test('a code run in flight blocks chat sends (and vice versa)', () => {
    const chatRunState = { isBusy: false };
    const codeRunState = { isBusy: false };
    const slot = createSendSlot({ chatRunState, codeRunState });

    codeRunState.isBusy = true; // Code Mode run in flight (set by setCodeRunActive)
    assert.equal(slot.claim(), false, 'chat send refused while a code run is busy');
    codeRunState.isBusy = false;
    assert.equal(slot.claim(), true);
});

test('release is idempotent — finally after an early-return release cannot unblock twice', () => {
    const chatRunState = { isBusy: false };
    const slot = createSendSlot({ chatRunState });
    slot.claim();
    slot.release(); // early return inside try
    slot.release(); // finally at run end — must be a safe no-op
    assert.equal(slot.claim(), true);
});
