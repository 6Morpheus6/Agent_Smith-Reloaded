const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// Run git via execFile (argv, NO shell) so user-controlled args — notably the commit
// message — can't be shell-interpreted ($(...), backticks, ;, &&, |). Also avoids the
// Windows cmd.exe vs POSIX quoting mismatch of building a shell string.
function gitExec(cwd, args) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                stdout: (stdout || '').trim(),
                stderr: (stderr || '').trim(),
                error: error ? error.message : null
            });
        });
    });
}

function isRepo(projectRoot) {
    return fs.existsSync(path.join(projectRoot, '.git'));
}

async function init(projectRoot) {
    if (isRepo(projectRoot)) return { ok: true, already: true };
    return gitExec(projectRoot, ['init']);
}

async function status(projectRoot) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    return gitExec(projectRoot, ['status', '--porcelain']);
}

async function diff(projectRoot) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    return gitExec(projectRoot, ['diff', '--stat']);
}

async function commit(projectRoot, message) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    await gitExec(projectRoot, ['add', '-A']);
    // execFile passes argv directly — no shell, no quoting needed (and no injection).
    return gitExec(projectRoot, ['commit', '-m', String(message || '').slice(0, 500), '--allow-empty']);
}

async function undoLast(projectRoot) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    const log = await gitExec(projectRoot, ['rev-parse', 'HEAD']);
    if (!log.ok) return log;
    const parent = await gitExec(projectRoot, ['rev-parse', 'HEAD~1']);
    if (!parent.ok) {
        return gitExec(projectRoot, ['update-ref', '-d', 'HEAD']);
    }
    return gitExec(projectRoot, ['reset', '--hard', 'HEAD~1']);
}

async function logOneline(projectRoot, n = 10) {
    if (!isRepo(projectRoot)) return { ok: false, lines: [] };
    const res = await gitExec(projectRoot, ['log', `--oneline`, `-n`, String(n)]);
    return { ...res, lines: res.stdout ? res.stdout.split('\n') : [] };
}

module.exports = {
    isRepo,
    init,
    status,
    diff,
    commit,
    undoLast,
    logOneline,
    gitExec
};
