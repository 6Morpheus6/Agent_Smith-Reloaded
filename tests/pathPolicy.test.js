/**
 * pathPolicy — whole-host file-mutation guardrail for Agent Mode.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { assessPathMutation, blockedPathResult } = require('../src/shared/pathPolicy.js');

const isWin = process.platform === 'win32';

test('refuses wiping a critical system root', () => {
    const root = isWin ? 'C:\\Windows' : '/etc';
    assert.equal(assessPathMutation(root, 'delete').allowed, false);
    assert.equal(assessPathMutation(root, 'write').allowed, false);
});

test('refuses "/" and the home root themselves', () => {
    const fsRoot = isWin ? 'C:\\' : '/';
    assert.equal(assessPathMutation(fsRoot, 'delete').allowed, false);
    assert.equal(assessPathMutation(os.homedir(), 'delete').allowed, false);
});

test('allows a specific file inside a system/home dir (legit management)', () => {
    const inEtc = isWin ? 'C:\\Windows\\my.cfg' : '/etc/myapp.conf';
    assert.equal(assessPathMutation(inEtc, 'write').allowed, true);
    const inHome = path.join(os.homedir(), 'notes.txt');
    assert.equal(assessPathMutation(inHome, 'delete').allowed, true);
});

test('normalizes before comparing (trailing slash / .. cannot bypass)', () => {
    const sneaky = (isWin ? 'C:\\Windows\\..\\Windows' : '/etc/../etc');
    assert.equal(assessPathMutation(sneaky, 'delete').allowed, false);
});

test('blockedPathResult shape', () => {
    const r = blockedPathResult('/etc', 'delete of a critical system/home root ("/etc")');
    assert.equal(r.pathBlocked, true);
    assert.match(r.error, /safety policy/i);
});
