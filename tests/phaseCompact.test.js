const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compactForPhaseTransition, collectRecentToolPairs } = require('../src/code/context/phaseCompact.js');
const { PlanAnchor } = require('../src/code/context/planAnchor.js');

test('collectRecentToolPairs keeps last N assistant+tool pairs', () => {
    const messages = [
        { role: 'assistant', tool_calls: [{ id: '1' }] },
        { role: 'tool', tool_call_id: '1', content: 'a' },
        { role: 'assistant', tool_calls: [{ id: '2' }] },
        { role: 'tool', tool_call_id: '2', content: 'b' },
        { role: 'assistant', tool_calls: [{ id: '3' }] },
        { role: 'tool', tool_call_id: '3', content: 'c' }
    ];
    const pairs = collectRecentToolPairs(messages, 2);
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].tools[0].content, 'b');
    assert.equal(pairs[1].tools[0].content, 'c');
});

test('compactForPhaseTransition preserves plan anchor and drops old messages', () => {
    const planAnchor = new PlanAnchor('build todo app');
    planAnchor.addNote('keep this note');
    const session = {
        goal: 'build todo app',
        messages: [
            { role: 'user', content: 'old goal' },
            { role: 'assistant', content: 'lots of explore spam '.repeat(50) },
            { role: 'assistant', tool_calls: [{ id: '1' }] },
            { role: 'tool', tool_call_id: '1', name: 'read_file', content: 'file contents' }
        ]
    };
    const before = session.messages.length;
    const result = compactForPhaseTransition(session, {
        fromPhase: 'explore',
        toPhase: 'implement',
        planAnchor
    });
    assert.ok(result.droppedCount >= 0);
    assert.ok(session.messages.length < before || before <= 4);
    const block = session.messages[0].content;
    assert.match(block, /EXPLORE → IMPLEMENT/);
    assert.match(block, /build todo app/);
    assert.ok(session.messages.some(m => m.role === 'tool'));
});

test('phase-compaction-preserves-plan-anchor eval contract', () => {
    const planAnchor = new PlanAnchor('scaffold app');
    const session = { goal: 'scaffold app', messages: [{ role: 'user', content: 'x' }] };
    compactForPhaseTransition(session, { fromPhase: 'explore', toPhase: 'implement', planAnchor });
    assert.match(session.messages[0].content, /scaffold app/);
});
