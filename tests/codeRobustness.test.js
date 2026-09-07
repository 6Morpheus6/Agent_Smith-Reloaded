/**
 * Code Mode robustness fixes from the audit:
 *  - fitBudget can evict accumulated [HARNESS] system nudges (prompt no longer overflows numCtx),
 *  - EarlyStopDetector seeds from the persisted turn so max-turns is durable across resumes,
 *  - CodeSession.toJSON persists isolation fields so a resumed isolated run cleans up its worktree.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fitBudget, estimateMessages } = require('../src/code/context/budget.js');
const { EarlyStopDetector } = require('../src/code/governor/earlyStop.js');
const { CodeSession } = require('../src/code/session/state.js');

test('fitBudget evicts accumulated system nudges to stay under target', () => {
    const msgs = [{ role: 'system', content: 'BASE PROMPT' }, { role: 'user', content: 'the goal' }];
    for (let i = 0; i < 60; i++) msgs.push({ role: 'system', content: '[HARNESS — NUDGE] ' + 'x'.repeat(800) });
    msgs.push({ role: 'user', content: 'FRESH latest tool result' });
    const target = 12288 - 3000;
    const out = fitBudget(msgs, 12288, 3000);
    assert.ok(estimateMessages(out) <= target, 'must fit under target after evicting nudges');
    assert.equal(out[0].content, 'BASE PROMPT', 'base system prompt preserved');
    assert.ok(out.some(m => m.content === 'the goal'), 'original goal preserved');
    assert.ok(out[out.length - 1].content.includes('FRESH'), 'latest message preserved');
    assert.ok(out.filter(m => /NUDGE/.test(m.content)).length < 60, 'some nudges were evicted');
});

test('EarlyStopDetector max-turns is durable across resume (seeds from initialTurn)', () => {
    // simulate a session resumed at turn 39 with a 40-turn budget: one more turn runs, then stop.
    const det = new EarlyStopDetector({ maxTurns: 40, initialTurn: 39 });
    assert.equal(det.onTurn().stop, false, 'the 40th turn still runs');
    assert.equal(det.onTurn().stop, true, 'past 40 stops — budget NOT reset by resume');

    // a fresh run executes exactly maxTurns turns, then stops on the next call.
    const fresh = new EarlyStopDetector({ maxTurns: 40 });
    let ran = 0;
    for (let i = 0; i < 45; i++) { if (fresh.onTurn().stop) break; ran++; }
    assert.equal(ran, 40, `fresh run executes exactly maxTurns (ran ${ran})`);
});

test('CodeSession.toJSON persists isolation fields for worktree cleanup on resume', () => {
    const s = new CodeSession('sess-iso', { goal: 'x', projectRoot: '/p' });
    s.isolatedRun = true;
    s.worktreePath = '/tmp/wt-abc';
    s.parentProjectRoot = '/p';
    const json = CodeSession.toJSON(s);
    assert.equal(json.isolatedRun, true);
    assert.equal(json.worktreePath, '/tmp/wt-abc');
    assert.equal(json.parentProjectRoot, '/p');
});
