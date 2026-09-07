/**
 * gitIntegration — exercises real git in a temp repo. The key guarantee is that the
 * commit message is passed as argv (execFile), NOT through a shell, so it can't be
 * injected ($(...), ;, backticks). Also covers non-repo guards and undoLast.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const git = require('../src/shared/gitIntegration.js');

let GIT_OK = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { GIT_OK = false; }

function repo() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gitint-'));
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: d });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: d });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: d });
    return d;
}
const showMsg = (d) => execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: d, encoding: 'utf8' }).trim();

test('non-repo dirs return consistent ok:false / empty results', { skip: !GIT_OK }, async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'norepo-'));
    assert.equal((await git.status(d)).error, 'not a git repo');
    assert.equal((await git.diff(d)).error, 'not a git repo');
    assert.equal((await git.commit(d, 'x')).ok, false);
    assert.equal((await git.undoLast(d)).ok, false);
    const log = await git.logOneline(d);
    assert.equal(log.ok, false);
    assert.deepEqual(log.lines, []);
});

test('SECURITY: commit message is literal, NOT shell-interpreted', { skip: !GIT_OK }, async () => {
    const d = repo();
    fs.writeFileSync(path.join(d, 'a.txt'), 'hi');
    const evil = 'safe message; touch INJECTED.txt && echo $(whoami)';
    const res = await git.commit(d, evil);
    assert.equal(res.ok, true, 'commit succeeds: ' + res.error);
    assert.ok(!fs.existsSync(path.join(d, 'INJECTED.txt')), 'no shell side-effect — injection blocked');
    assert.equal(showMsg(d), evil, 'message stored verbatim (argv, not a shell string)');
});

test('commit truncates the message to 500 chars', { skip: !GIT_OK }, async () => {
    const d = repo();
    await git.commit(d, 'y'.repeat(600));
    assert.ok(showMsg(d).length <= 500);
});

test('undoLast: single commit removes HEAD; second commit resets to the first', { skip: !GIT_OK }, async () => {
    const d = repo();
    fs.writeFileSync(path.join(d, 'f.txt'), 'one');
    await git.commit(d, 'first');
    const firstHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(d, 'f.txt'), 'two');
    await git.commit(d, 'second');
    const u = await git.undoLast(d);
    assert.equal(u.ok, true);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim(), firstHead,
        'reset --hard HEAD~1 returns to the first commit');
    assert.equal(fs.readFileSync(path.join(d, 'f.txt'), 'utf8'), 'one', 'working tree reverted');

    // now only one commit remains → undo removes HEAD entirely
    const u2 = await git.undoLast(d);
    assert.equal(u2.ok, true);
    assert.throws(() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, stdio: 'ignore' }),
        'no commits remain after undoing the last one');
});

test('init is idempotent on an existing repo', { skip: !GIT_OK }, async () => {
    const d = repo();
    const r = await git.init(d);
    assert.equal(r.ok, true);
    assert.equal(r.already, true);
});
