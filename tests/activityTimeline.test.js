/**
 * Activity timeline — eventAdapter + diffView unit tests.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    adaptCodeEvent, categoryForTool, CATEGORY_CONFIG
} = require('../src/renderer/timeline/eventAdapter.js');
const {
    parseDiffLines, buildDiffFromBeforeAfter, countDiffStats, truncateDiffLines
} = require('../src/renderer/timeline/diffView.js');

test('categoryForTool maps write tools', () => {
    assert.equal(categoryForTool('patch'), 'write');
    assert.equal(categoryForTool('grep'), 'search');
    assert.equal(CATEGORY_CONFIG.write.badgeClass, 'activity-badge--write');
});

test('adaptCodeEvent tool_start', () => {
    const n = adaptCodeEvent({ type: 'tool_start', name: 'read_file', args: { path: 'a.js' }, callId: 'c1' });
    assert.equal(n.type, 'tool');
    assert.equal(n.id, 'c1');
    assert.equal(n.category, 'read');
    assert.equal(n.status, 'running');
});

test('adaptCodeEvent tool_result with fileDiff', () => {
    const n = adaptCodeEvent({
        type: 'tool_result',
        name: 'patch',
        ok: true,
        callId: 'c1',
        result: { fileDiff: '--- a/x\n+++ b/x\n+line', relPath: 'x.js' }
    });
    assert.equal(n.status, 'ok');
    assert.ok(n.fileDiff.includes('+line'));
});

test('adaptCodeEvent context_budget', () => {
    const n = adaptCodeEvent({ type: 'context_budget', used: 4000, total: 8000 });
    assert.equal(n.budgetPct, 50);
});

test('parseDiffLines classifies add/del/ctx', () => {
    const lines = parseDiffLines('--- a/f\n+++ b/f\n old\n+new\n-del');
    assert.ok(lines.some(l => l.kind === 'add' && l.text === 'new'));
    assert.ok(lines.some(l => l.kind === 'del' && l.text === 'del'));
    assert.ok(lines.some(l => l.kind === 'ctx' && l.text === 'old'));
});

test('buildDiffFromBeforeAfter', () => {
    const d = buildDiffFromBeforeAfter('a\n', 'a\nb\n', 'f.js');
    assert.ok(d.includes('+++ b/f.js'));
    assert.ok(d.includes('+b'));
});

test('countDiffStats', () => {
    const lines = parseDiffLines('+a\n+b\n-c');
    const stats = countDiffStats(lines);
    assert.equal(stats.added, 2);
    assert.equal(stats.removed, 1);
});

test('truncateDiffLines', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ kind: 'ctx', text: String(i) }));
    const r = truncateDiffLines(many, 200);
    assert.equal(r.lines.length, 200);
    assert.equal(r.truncated, true);
});
