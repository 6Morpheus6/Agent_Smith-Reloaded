/**
 * Regression: per-mode chat state (historiesReady etc.) must be declared BEFORE the
 * first module-load call to updateCodeModeUI(), which reaches maybeSwitchModeChat() and
 * reads it. A `let` declared afterwards sits in the temporal dead zone and throws at
 * load, aborting app.js — which silently broke login (no handlers attached).
 * node --check can't catch TDZ, so guard the ordering statically.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

test('mode-state vars are declared before the first updateCodeModeUI() call', () => {
    const declIdx = src.search(/\blet\s+historiesReady\b/);
    const callIdx = src.search(/\n\s+updateCodeModeUI\(\);/); // an indented call, not the def
    assert.ok(declIdx >= 0, 'historiesReady must be declared');
    assert.ok(callIdx >= 0, 'updateCodeModeUI() must be called at module load');
    assert.ok(declIdx < callIdx, 'historiesReady must be declared before updateCodeModeUI() runs (TDZ guard)');
});

test('maybeSwitchModeChat bails before touching state until histories are ready', () => {
    const fn = src.slice(src.indexOf('function maybeSwitchModeChat'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /^\s*function[^\n]*\n\s*if\s*\(!historiesReady\)\s*return;/, 'first statement must guard on historiesReady');
});
