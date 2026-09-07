/**
 * v53.4 — CodeSession.sweepStale: sessions left open by a PREVIOUS app process must be
 * closed at startup so they never resurface as "Resume" candidates (the fresh-start
 * stale-task bug). 'awaiting_approval' survives (intentional cross-restart plan review).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodeSession } = require('../src/code/session/state.js');

function mkSessions(dir, specs) {
    const sdir = CodeSession.sessionDir(dir);
    fs.mkdirSync(sdir, { recursive: true });
    for (const [id, status] of specs) {
        fs.writeFileSync(path.join(sdir, `${id}.json`), JSON.stringify({ id, goal: 'g', status, turn: 3 }));
    }
    return sdir;
}

test('sweepStale closes sessions left running by a previous process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sweep-'));
    const sdir = mkSessions(dir, [['a', 'running'], ['b', 'idle'], ['c', 'done']]);
    const closed = CodeSession.sweepStale(dir);
    assert.equal(closed, 2);
    const a = JSON.parse(fs.readFileSync(path.join(sdir, 'a.json'), 'utf-8'));
    assert.equal(a.status, 'aborted');
    assert.match(a.error, /previous session/);
    // done sessions untouched; file preserved for history.
    const c = JSON.parse(fs.readFileSync(path.join(sdir, 'c.json'), 'utf-8'));
    assert.equal(c.status, 'done');
});

test('sweepStale preserves awaiting_approval (cross-restart plan review is a feature)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sweep-'));
    const sdir = mkSessions(dir, [['p', 'awaiting_approval']]);
    assert.equal(CodeSession.sweepStale(dir), 0);
    const p = JSON.parse(fs.readFileSync(path.join(sdir, 'p.json'), 'utf-8'));
    assert.equal(p.status, 'awaiting_approval');
});

test('swept sessions drop out of listIncomplete', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sweep-'));
    mkSessions(dir, [['r', 'running'], ['ok', 'done']]);
    assert.equal((await CodeSession.listIncomplete(dir, null)).length, 1);
    CodeSession.sweepStale(dir);
    assert.equal((await CodeSession.listIncomplete(dir, null)).length, 0);
});

test('sweepStale is safe with no dir and corrupt files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sweep-'));
    assert.equal(CodeSession.sweepStale(dir), 0, 'no code-sessions dir → 0');
    const sdir = CodeSession.sessionDir(dir);
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'bad.json'), '{not json');
    assert.equal(CodeSession.sweepStale(dir), 0, 'corrupt file skipped, no throw');
});
