const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    milestoneKey,
    milestoneWorktreePath,
    milestoneBranchName,
    childSessionId,
    syncWorktreeFiles
} = require('../src/main/services/worktreeManager.js');

const {
    resolveSubagentMode,
    shouldUseSubagents,
    openMilestones
} = require('../src/code/loop/milestoneSubagents.js');

test('milestoneKey and paths are stable', () => {
    const key = milestoneKey('code_123_abc', 'M1');
    assert.match(key, /code_123_abc--M1/);
    const root = '/proj';
    assert.match(milestoneWorktreePath(root, 'code_123_abc', 'M1'), /worktrees.*M1/);
    assert.match(milestoneBranchName('code_123_abc', 'M1'), /agentsmith\/milestone-/);
});

test('childSessionId suffixes milestone id', () => {
    assert.equal(childSessionId('code_parent', 'M2'), 'code_parent__M2');
});

test('syncWorktreeFiles copies touched files to main', () => {
    const main = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-main-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-child-'));
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'app.js'), 'module.exports = 1;\n');
    const r = syncWorktreeFiles(main, wt, ['src/app.js']);
    assert.deepEqual(r.synced, ['src/app.js']);
    assert.equal(r.errors.length, 0);
    assert.equal(fs.readFileSync(path.join(main, 'src', 'app.js'), 'utf-8'), 'module.exports = 1;\n');
});

test('resolveSubagentMode returns worktree-sequential when flags set', () => {
    const mode = resolveSubagentMode({
        parallelMilestones: true,
        milestoneWorktrees: true,
        milestoneConcurrent: false
    });
    assert.equal(mode, 'worktree-sequential');
});

test('resolveSubagentMode returns worktree-concurrent when enabled', () => {
    const mode = resolveSubagentMode({
        parallelMilestones: true,
        milestoneWorktrees: true,
        milestoneConcurrent: true
    });
    assert.equal(mode, 'worktree-concurrent');
});

test('shouldUseSubagents requires 3+ milestones', () => {
    assert.equal(shouldUseSubagents({ parallelMilestones: true }, { enabled: true, milestones: [{}, {}] }), false);
    assert.equal(shouldUseSubagents({ parallelMilestones: true }, { enabled: true, milestones: [{}, {}, {}] }), true);
});

test('openMilestones skips done entries', () => {
    const open = openMilestones({
        enabled: true,
        milestones: [{ id: 'M1', done: true }, { id: 'M2', done: false }]
    });
    assert.equal(open.length, 1);
    assert.equal(open[0].id, 'M2');
});
