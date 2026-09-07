/**
 * Git worktree isolation for Code Mode runs — file isolation v1 (single port deferred).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');
const WORKTREE_LIST_PREFIX = 'worktree ';

function worktreeBase(projectRoot) {
    return path.join(projectRoot, '.agentsmith', 'worktrees');
}

// Collision-safe naming: include a short hash of the full id so two sessions
// sharing a 40-char prefix do not reuse the wrong checkout. Previously the
// truncated id alone could collide and createRunWorktree returned { reused:true }
// for an existing path without checking branch/session ownership.
function shortHash(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

function branchName(sessionId) {
    const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
    return `agentsmith/run-${safe}-${shortHash(sessionId)}`;
}

function worktreePath(projectRoot, sessionId) {
    const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
    return path.join(worktreeBase(projectRoot), `${safe}-${shortHash(sessionId)}`);
}

function milestoneKey(parentSessionId, milestoneId) {
    const parent = String(parentSessionId).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
    const ms = String(milestoneId).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 12);
    const key = `${parent}--${ms}`;
    return `${key}-${shortHash(parentSessionId + ':' + milestoneId)}`;
}

function milestoneWorktreePath(projectRoot, parentSessionId, milestoneId) {
    return path.join(worktreeBase(projectRoot), milestoneKey(parentSessionId, milestoneId));
}

function milestoneBranchName(parentSessionId, milestoneId) {
    return `agentsmith/milestone-${milestoneKey(parentSessionId, milestoneId)}`;
}

function childSessionId(parentSessionId, milestoneId) {
    return `${parentSessionId}__${String(milestoneId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20)}`;
}

function gitOk(projectRoot) {
    try {
        execFileSync('git', ['rev-parse', '--git-dir'], { cwd: projectRoot, stdio: 'pipe' });
        return true;
    } catch (e) {
        return false;
    }
}

/** Verify an existing worktree path points at the expected branch before reuse. */
function worktreeBranchMatches(projectRoot, wtPath, expectedBranch) {
    try {
        const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
            cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8'
        });
        // Each worktree entry: `worktree <path>\n` then `branch refs/heads/<branch>\n` (or detached).
        const blocks = String(out).split(/\n\n/);
        for (const block of blocks) {
            const lines = block.split('\n');
            const wtLine = lines.find(l => l.startsWith(WORKTREE_LIST_PREFIX));
            const brLine = lines.find(l => l.startsWith('branch '));
            if (wtLine && path.resolve(wtLine.slice(WORKTREE_LIST_PREFIX.length)) === path.resolve(wtPath)) {
                if (!brLine) return false; // detached HEAD — not our branch
                const br = brLine.slice('branch '.length).replace(/^refs\/heads\//, '');
                return br === expectedBranch;
            }
        }
        return false;
    } catch (e) {
        return false;
    }
}

/**
 * Create an isolated worktree for a Code run.
 * @returns {{ path, branch, error? }}
 */
function createRunWorktree(projectRoot, sessionId) {
    if (!gitOk(projectRoot)) {
        return { error: 'Git repository required for isolated runs. Run git init first.' };
    }
    const wtPath = worktreePath(projectRoot, sessionId);
    const branch = branchName(sessionId);
    fs.mkdirSync(worktreeBase(projectRoot), { recursive: true });

    if (fs.existsSync(wtPath)) {
        // Verify the existing worktree points at our branch before reusing — a
        // truncated-id collision could otherwise reuse stale files from an
        // unrelated earlier run.
        if (worktreeBranchMatches(projectRoot, wtPath, branch)) {
            return { path: wtPath, branch, reused: true };
        }
        return { error: `Worktree path ${wtPath} already exists but does not point at branch ${branch}. Refusing to reuse an unrelated checkout.` };
    }

    try {
        // execFileSync with argv — paths/branches are argv values, not shell syntax,
        // so a repository path containing a double quote or shell metacharacter cannot
        // break quoting and change the command.
        execFileSync('git', ['worktree', 'add', '-B', branch, wtPath], {
            cwd: projectRoot, stdio: 'pipe', encoding: 'utf-8'
        });
        return { path: wtPath, branch };
    } catch (e) {
        return { error: `Failed to create worktree: ${e.message}` };
    }
}

function cleanupWorktree(projectRoot, sessionId) {
    const wtPath = worktreePath(projectRoot, sessionId);
    if (!fs.existsSync(wtPath)) return { ok: true, skipped: true };
    try {
        execFileSync('git', ['worktree', 'remove', wtPath, '--force'], {
            cwd: projectRoot, stdio: 'pipe', encoding: 'utf-8'
        });
    } catch (e) {
        try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    }
    const branch = branchName(sessionId);
    try {
        execFileSync('git', ['branch', '-D', branch], { cwd: projectRoot, stdio: 'pipe' });
    } catch (e) { /* branch may not exist */ }
    return { ok: true };
}

/**
 * Create a worktree for one PLAN milestone subagent.
 * @returns {{ path, branch, error? }}
 */
function createMilestoneWorktree(projectRoot, parentSessionId, milestoneId) {
    if (!gitOk(projectRoot)) {
        return { error: 'Git repository required for milestone worktrees. Run git init first.' };
    }
    const wtPath = milestoneWorktreePath(projectRoot, parentSessionId, milestoneId);
    const branch = milestoneBranchName(parentSessionId, milestoneId);
    fs.mkdirSync(worktreeBase(projectRoot), { recursive: true });

    if (fs.existsSync(wtPath)) {
        if (worktreeBranchMatches(projectRoot, wtPath, branch)) {
            return { path: wtPath, branch, reused: true };
        }
        return { error: `Milestone worktree path ${wtPath} already exists but does not point at branch ${branch}. Refusing to reuse an unrelated checkout.` };
    }

    try {
        execFileSync('git', ['worktree', 'add', '-B', branch, wtPath], {
            cwd: projectRoot, stdio: 'pipe', encoding: 'utf-8'
        });
        return { path: wtPath, branch };
    } catch (e) {
        return { error: `Failed to create milestone worktree: ${e.message}` };
    }
}

function cleanupMilestoneWorktree(projectRoot, parentSessionId, milestoneId) {
    const wtPath = milestoneWorktreePath(projectRoot, parentSessionId, milestoneId);
    if (!fs.existsSync(wtPath)) return { ok: true, skipped: true };
    try {
        execFileSync('git', ['worktree', 'remove', wtPath, '--force'], {
            cwd: projectRoot, stdio: 'pipe', encoding: 'utf-8'
        });
    } catch (e) {
        try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    }
    const branch = milestoneBranchName(parentSessionId, milestoneId);
    try {
        execFileSync('git', ['branch', '-D', branch], { cwd: projectRoot, stdio: 'pipe' });
    } catch (e) { /* branch may not exist */ }
    return { ok: true };
}

/** Copy touched files from milestone worktree into main checkout.
 *  Each relPath is confined to its root — `../` segments or absolute paths are
 *  rejected so a child session recording a touched path like `../victim.txt`
 *  cannot make the sync step copy from outside the worktree or overwrite outside
 *  the main project. */
function syncWorktreeFiles(mainRoot, worktreeRoot, relPaths) {
    const synced = [];
    const errors = [];
    const realMainRoot = fs.realpathSync(mainRoot);
    const realWorktreeRoot = fs.realpathSync(worktreeRoot);
    const isContained = (root, abs) => {
        const rel = path.relative(path.resolve(root), path.resolve(abs));
        return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    for (const rel of [...new Set((relPaths || []).filter(Boolean))]) {
        const normalized = rel.replace(/\\/g, '/');
        // Reject absolute paths and `..` segments before joining.
        if (path.isAbsolute(normalized)) {
            errors.push({ path: normalized, error: 'absolute paths are not allowed' });
            continue;
        }
        const src = path.join(worktreeRoot, normalized);
        const dst = path.join(mainRoot, normalized);
        if (!isContained(realWorktreeRoot, src)) {
            errors.push({ path: normalized, error: 'source path escapes the worktree root' });
            continue;
        }
        if (!isContained(realMainRoot, dst)) {
            errors.push({ path: normalized, error: 'destination path escapes the main project root' });
            continue;
        }
        try {
            if (!fs.existsSync(src)) {
                errors.push({ path: normalized, error: 'missing in worktree' });
                continue;
            }
            const srcStat = fs.lstatSync(src);
            const realSrc = fs.realpathSync(src);
            if (!isContained(realWorktreeRoot, realSrc)) {
                errors.push({ path: normalized, error: 'source symlink escapes the worktree root' });
                continue;
            }
            const targetStat = fs.statSync(realSrc);
            if (!targetStat.isFile()) {
                errors.push({ path: normalized, error: 'source path is not a file' });
                continue;
            }
            if (!srcStat.isFile() && !srcStat.isSymbolicLink()) {
                errors.push({ path: normalized, error: 'source path is not a regular file or symlink' });
                continue;
            }
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(realSrc, dst);
            synced.push(normalized);
        } catch (e) {
            errors.push({ path: normalized, error: e.message });
        }
    }
    return { synced, errors };
}

module.exports = {
    createRunWorktree,
    cleanupWorktree,
    worktreePath,
    branchName,
    createMilestoneWorktree,
    cleanupMilestoneWorktree,
    syncWorktreeFiles,
    milestoneWorktreePath,
    milestoneBranchName,
    milestoneKey,
    childSessionId,
    gitOk
};
