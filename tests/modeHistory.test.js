/**
 * Mode-switch history logic — the pure core of the "Chat, Agent and Code each keep a
 * SEPARATE, persisted conversation" rule, extracted from app.js so it is unit-testable
 * without a DOM. The renderer wrapper (maybeSwitchModeChat) only adds DOM side-effects.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planModeSwitch } = require('../src/renderer/modes/modeHistory.js');

const seed = (mode) => [{ role: 'system', content: `sys:${mode}` }];

test('no switch when the target mode is already active', () => {
    const histories = { chat: [{ role: 'user', content: 'hi' }], agent: [], code: [] };
    const res = planModeSwitch(histories, 'chat', histories.chat, 'chat', seed);
    assert.equal(res.switched, false);
    assert.equal(res.currentMode, 'chat');
    assert.equal(res.chatHistory, histories.chat, 'pointer unchanged');
    assert.equal(histories.agent.length, 0, 'other modes untouched');
});

test('switching seeds a never-visited mode and flags timeline restore for code', () => {
    const histories = { chat: [{ role: 'user', content: 'hi chat' }], agent: [], code: [] };
    const res = planModeSwitch(histories, 'chat', histories.chat, 'code', seed);
    assert.equal(res.switched, true);
    assert.equal(res.currentMode, 'code');
    assert.equal(res.seeded, true);
    assert.deepEqual(res.chatHistory, [{ role: 'system', content: 'sys:code' }]);
    assert.equal(res.snapshotLeavingCode, false, 'we are leaving chat, not code');
    assert.equal(res.restoreCodeTimeline, true, 'entering code restores its timeline');
    assert.equal(histories.chat[histories.chat.length - 1].content, 'hi chat', 'outgoing chat stashed intact');
});

test('leaving code flags a timeline snapshot; an existing history is reused, not reseeded', () => {
    const codeArr = [{ role: 'system', content: 'sys:code' }, { role: 'user', content: 'build x' }];
    const chatArr = [{ role: 'system', content: 'sys:chat' }, { role: 'user', content: 'earlier chat' }];
    const histories = { chat: chatArr, agent: [], code: codeArr };
    const res = planModeSwitch(histories, 'code', codeArr, 'chat', seed);
    assert.equal(res.snapshotLeavingCode, true, 'leaving code must snapshot its timeline');
    assert.equal(res.restoreCodeTimeline, false);
    assert.equal(res.seeded, false, 'chat already has content — do not reseed');
    assert.equal(res.chatHistory, chatArr, 'returns the SAME chat array (restored, not rebuilt)');
});

test('INVARIANT: a full Chat→Agent→Code→Chat tour keeps every conversation separate', () => {
    // Start in Chat with the active array seeded.
    const histories = { chat: seed('chat'), agent: [], code: [] };
    let mode = 'chat';
    let active = histories.chat;

    const goto = (target) => {
        const r = planModeSwitch(histories, mode, active, target, seed);
        mode = r.currentMode;
        active = r.chatHistory;
        return r;
    };

    active.push({ role: 'user', content: 'CHAT-MSG' });
    goto('agent');
    active.push({ role: 'user', content: 'AGENT-MSG' });
    goto('code');
    active.push({ role: 'user', content: 'CODE-MSG' });
    goto('chat'); // back to where we started

    // Each mode holds ONLY its own message — no cross-contamination across the tour.
    const contents = (m) => histories[m].map(x => x.content);
    assert.ok(contents('chat').includes('CHAT-MSG'));
    assert.ok(!contents('chat').includes('AGENT-MSG') && !contents('chat').includes('CODE-MSG'),
        'chat must not absorb agent/code messages');
    assert.ok(contents('agent').includes('AGENT-MSG') && !contents('agent').includes('CHAT-MSG'));
    assert.ok(contents('code').includes('CODE-MSG') && !contents('code').includes('AGENT-MSG'));

    // Returning to chat restores the original chat array (persisted across the tour).
    assert.equal(active, histories.chat);
    assert.equal(mode, 'chat');
});
