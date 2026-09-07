/**
 * contextPrune — bounds agent context so big browser snapshots don't overflow it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pruneChatHistory } = require('../src/shared/contextPrune.js');

const big = (n) => 'x'.repeat(n);

test('caps the size of recent tool results', () => {
    const h = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }, { role: 'tool', content: big(5000), name: 'browser_snapshot' }];
    const out = pruneChatHistory(h);
    assert.ok(out[2].content.length < 2000, 'recent tool result capped');
    assert.match(out[2].content, /truncated/);
});

test('collapses older tool results to a stub, keeps recent ones', () => {
    const h = [{ role: 'system', content: 's' }];
    for (let i = 0; i < 7; i++) { h.push({ role: 'assistant', content: '', tool_calls: [{}] }); h.push({ role: 'tool', content: 'RESULT_' + i + ' ' + big(50), name: 't' }); }
    const out = pruneChatHistory(h, undefined);
    const tools = out.filter(m => m.role === 'tool');
    // 7 tool results, keepRecentTool default 4 -> first 3 stubbed
    const stubs = tools.filter(t => /omitted to conserve context/.test(t.content));
    assert.equal(stubs.length, 3);
    // the last 4 keep their real content
    assert.match(tools[6].content, /RESULT_6/);
    assert.match(tools[3].content, /RESULT_3/);
});

test('leaves user/assistant/system messages untouched', () => {
    const h = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }, { role: 'assistant', content: 'A' }];
    const out = pruneChatHistory(h);
    assert.deepEqual(out, h);
});

test('idempotent: re-pruning is stable', () => {
    const h = [{ role: 'tool', content: big(5000) }];
    const a = pruneChatHistory(h);
    const b = pruneChatHistory(a);
    assert.equal(a[0].content, b[0].content);
});

test('non-array input returned as-is', () => {
    assert.equal(pruneChatHistory(null), null);
});

// ── v52.8: stale-task fixation — old conversation must not out-voice the latest message ──

function convo(n) {
    // n user/assistant pairs, each pair a distinct "task" from an older session.
    const h = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < n; i++) {
        h.push({ role: 'user', content: `Build me the thing number ${i} with lots of detail about the old task` });
        h.push({ role: 'assistant', content: `Working on thing ${i}. ` + big(200) });
    }
    return h;
}

test('compacts conversation older than keepRecentTurns, keeps recent verbatim', () => {
    const out = pruneChatHistory(convo(12)); // default keepRecentTurns=8 → first 4 pairs stale
    const users = out.filter(m => m.role === 'user');
    const stubbedUsers = users.filter(u => /older conversation compacted/.test(u.content));
    assert.equal(stubbedUsers.length, 4, 'first 4 user turns compacted');
    // Recent turns survive verbatim.
    assert.match(users[11].content, /thing number 11/);
    assert.ok(!/older conversation compacted/.test(users[7].content), 'turn 8 (oldest survivor) is intact');
});

test('exactly one message carries the CURRENT TOPIC tag — the LATEST user turn (v53.4)', () => {
    const out = pruneChatHistory(convo(12));
    const tagged = out.filter(m => String(m.content).includes('[CURRENT TOPIC'));
    assert.equal(tagged.length, 1, 'exactly one current-topic marker');
    assert.match(tagged[0].content, /thing number 11/, 'tag sits on the latest user turn — the job at hand');
});

test('stale assistant turns collapse to a bare marker (their content is gone)', () => {
    const out = pruneChatHistory(convo(12));
    const staleAssistants = out.filter(m => m.role === 'assistant' && /^\[Smith, earlier\]/.test(String(m.content)));
    assert.equal(staleAssistants.length, 4);
    for (const a of staleAssistants) {
        assert.ok(!big(1).repeat(50).slice(0, 50).includes(a.content.slice(30)), 'no long old content survives');
        assert.match(String(a.content), /older conversation compacted/);
    }
});

test('harness control messages ([CONTINUE]/[GUARD RAIL]) are never compacted', () => {
    const h = convo(12);
    // A live run's nudge sits between old turns — it must survive compaction.
    h.splice(6, 0, { role: 'user', content: '[CONTINUE] Your previous reply was cut off before any output.' });
    const out = pruneChatHistory(h);
    assert.ok(out.some(m => String(m.content).startsWith('[CONTINUE]')), 'nudge survives');
});

test('compaction is idempotent — re-pruning a pruned history changes nothing', () => {
    const once = pruneChatHistory(convo(12));
    const twice = pruneChatHistory(once);
    assert.deepEqual(twice.map(m => m.content), once.map(m => m.content));
});

test('a previously-tagged turn loses its CURRENT TOPIC tag when it becomes stale', () => {
    let h = convo(12);
    const first = pruneChatHistory(h); // tags user turn 4 (index 9)
    assert.ok(first.some(m => String(m.content).includes('[CURRENT TOPIC')));
    // The conversation grows: 8 more pairs push the tagged turn into the stale region.
    for (let i = 12; i < 20; i++) {
        h.push({ role: 'user', content: `Build me the thing number ${i}` });
        h.push({ role: 'assistant', content: `Working on thing ${i}.` });
    }
    const second = pruneChatHistory(first.concat(h.slice(25)));
    assert.equal(second.filter(m => String(m.content).includes('[CURRENT TOPIC')).length, 1);
});

test('keepRecentTurns:0 disables conversation compaction (tool capping still applies)', () => {
    const out = pruneChatHistory(convo(12), { keepRecentTurns: 0 });
    assert.ok(out.every(m => !/older conversation compacted/.test(String(m.content))));
    assert.equal(out.filter(m => String(m.content).includes('[CURRENT TOPIC')).length, 0);
});

test('short histories (below the window) are left completely untouched', () => {
    const h = [{ role: 'system', content: 's' }, { role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
    assert.deepEqual(pruneChatHistory(h), h);
});

// ── v53.4: fresh-start stale-task fixation — restored turns are CLOSED history ──

test('prior-session user/assistant turns compact to stubs even inside the recent window', () => {
    // Simulates a FRESH app start: everything loaded from disk carries __priorSession,
    // then the user types one new message. The old tasks must NOT survive verbatim.
    const h = [{ role: 'system', content: 'sys' },
        { role: 'user', content: 'Build me a snake game with 40 levels and boss fights', __priorSession: true },
        { role: 'assistant', content: 'Working on the snake game. ' + big(300), __priorSession: true },
        { role: 'tool', content: 'snake.js written', name: 'write_file', __priorSession: true },
        { role: 'user', content: 'What is 2+2?' }];
    const out = pruneChatHistory(h);
    assert.match(String(out[1].content), /older conversation compacted/, 'old task compacted despite being in the recent window');
    assert.match(String(out[1].content), /^\[User, earlier\] /, 'reduced to a one-line stub (≤120-char preview)');
    assert.ok(out[1].content.length < 200, 'old task body does not survive at length');
    assert.match(String(out[2].content), /^\[Smith, earlier\]/);
    assert.equal(out[3].content, '[earlier tool output omitted to conserve context]', 'prior-session tool result stubbed');
    // The new message survives verbatim and carries the CURRENT TOPIC tag (there is old
    // history to disambiguate from — that's what the tag is for).
    assert.match(out[4].content, /\[CURRENT TOPIC.*What is 2\+2\?$/);
});

test('CURRENT TOPIC skips prior-session turns and lands on the latest real message', () => {
    const h = [{ role: 'system', content: 'sys' },
        { role: 'user', content: 'old task A', __priorSession: true },
        { role: 'assistant', content: 'did A', __priorSession: true },
        { role: 'user', content: 'ignore that — do B now' }];
    const out = pruneChatHistory(h);
    const tagged = out.filter(m => String(m.content).includes('[CURRENT TOPIC'));
    assert.equal(tagged.length, 1);
    assert.match(tagged[0].content, /do B now/);
});

test('a CURRENT TOPIC tag persisted on a prior-session turn is stripped', () => {
    const h = [{ role: 'system', content: 'sys' },
        { role: 'user', content: '[CURRENT TOPIC — answer THIS; earlier history is background only, not a task list] old task from last session', __priorSession: true },
        { role: 'user', content: 'new job' }];
    const out = pruneChatHistory(h);
    assert.ok(!String(out[1].content).includes('[CURRENT TOPIC'), 'stale tag removed');
    const tagged = out.filter(m => String(m.content).includes('[CURRENT TOPIC'));
    assert.equal(tagged.length, 1);
    assert.match(tagged[tagged.length - 1].content, /new job/);
});

test('prior-session compaction is idempotent', () => {
    const h = [{ role: 'system', content: 's' },
        { role: 'user', content: 'old task', __priorSession: true },
        { role: 'assistant', content: 'did it', __priorSession: true },
        { role: 'user', content: 'new thing' }];
    const once = pruneChatHistory(h);
    const twice = pruneChatHistory(once);
    assert.deepEqual(twice.map(m => m.content), once.map(m => m.content));
});

test('live-session turns (no stamp) are never compacted by the prior-session rule', () => {
    const h = [{ role: 'system', content: 's' },
        { role: 'user', content: 'task one' },
        { role: 'assistant', content: 'working on one' },
        { role: 'user', content: 'task two' }];
    const out = pruneChatHistory(h);
    assert.ok(!out.some(m => /older conversation compacted/.test(String(m.content))), 'no compaction below the window');
    // The latest live turn carries the tag; everything else passes through verbatim.
    assert.equal(out.filter(m => String(m.content).includes('[CURRENT TOPIC')).length, 1);
    assert.match(out[3].content, /\[CURRENT TOPIC.*task two/);
    assert.equal(out[1].content, 'task one');
    assert.equal(out[2].content, 'working on one');
});
