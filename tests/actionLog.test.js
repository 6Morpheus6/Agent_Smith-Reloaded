/**
 * Action Log — audit + undo trust layer.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createActionLog } = require('../src/main/services/actionLog.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'alog-'));

test('records and lists actions, newest first, no undo internals', () => {
    const log = createActionLog({ userDataPath: tmp() });
    log.record({ type: 'shell', summary: 'ran ls' });
    log.record({ type: 'write_file', summary: 'wrote a.txt', undo: { op: 'write', path: '/x', existed: false } });
    const list = log.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].summary, 'wrote a.txt'); // newest first
    assert.equal(list[0].reversible, true);
    assert.equal(list[1].reversible, false);
    assert.equal('_undo' in list[0], false, 'undo internals must not leak');
});

test('undo restores an overwritten file', () => {
    const dir = tmp();
    const f = path.join(dir, 'note.txt');
    fs.writeFileSync(f, 'ORIGINAL');
    const log = createActionLog({ userDataPath: dir });
    const undo = log.captureWriteUndo(f, true, 'ORIGINAL');
    fs.writeFileSync(f, 'CHANGED');
    const { id } = log.record({ type: 'write_file', summary: 'overwrote note', undo });
    assert.equal(log.undo(id).ok, true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'ORIGINAL');
    assert.equal(log.undo(id).error, 'That action was already undone.');
});

test('undo removes a newly-created file', () => {
    const dir = tmp();
    const f = path.join(dir, 'new.txt');
    fs.writeFileSync(f, 'hi');
    const log = createActionLog({ userDataPath: dir });
    const { id } = log.record({ type: 'create_file', summary: 'created new', undo: { op: 'write', path: f, existed: false } });
    assert.equal(log.undo(id).ok, true);
    assert.equal(fs.existsSync(f), false);
});

test('undo restores a deleted file', () => {
    const dir = tmp();
    const f = path.join(dir, 'gone.txt');
    const log = createActionLog({ userDataPath: dir });
    const { id } = log.record({ type: 'delete_file', summary: 'deleted gone', undo: { op: 'delete', path: f, isDir: false, content: 'RESTORED' } });
    assert.equal(log.undo(id).ok, true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'RESTORED');
});

test('audit-only actions cannot be undone', () => {
    const log = createActionLog({ userDataPath: tmp() });
    const { id } = log.record({ type: 'browser_send', summary: 'sent a message' });
    assert.match(log.undo(id).error, /cannot be undone/);
});

test('captureWriteUndo returns null for files over the size cap (audit-only)', () => {
    const log = createActionLog({ userDataPath: tmp(), maxUndoBytes: 10 });
    assert.equal(log.captureWriteUndo('/x', true, 'this is more than ten bytes'), null);
    assert.deepEqual(log.captureWriteUndo('/x', false, null), { op: 'write', path: '/x', existed: false });
});

test('persists across instances', () => {
    const dir = tmp();
    createActionLog({ userDataPath: dir }).record({ type: 'shell', summary: 'persisted' });
    assert.equal(createActionLog({ userDataPath: dir }).list()[0].summary, 'persisted');
});
