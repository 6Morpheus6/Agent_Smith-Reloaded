/**
 * Path safety policy — a default-allow guardrail for whole-host file mutations.
 *
 * Agent Mode is meant to "manage the whole computer": its file tools (read/write/
 * delete) reach outside the project root, matching their "host system" descriptions.
 * Shell mutations are screened by commandPolicy; the file tools bypass the shell, so
 * they need an equivalent guardrail. This is NOT a sandbox — it refuses only the
 * clearly-catastrophic targets (wiping a critical system/home root) and allows
 * everything else, including editing individual files under /etc, /usr, etc.
 *
 * Read access is never restricted here (the OS permission model is the boundary for
 * reads); only mutating ops (write/delete) are screened.
 */
'use strict';

const path = require('path');
const os = require('os');

// Directories that must never be deleted/overwritten *as a whole*. Deleting or
// overwriting a specific file *inside* these is allowed (legit host management);
// targeting the directory itself is what we refuse.
function criticalRoots() {
    const roots = new Set();
    const add = (p) => { if (p) roots.add(path.resolve(p)); };
    if (process.platform === 'win32') {
        for (const drive of ['C:\\', 'D:\\']) add(drive);
        add('C:\\Windows');
        add('C:\\Windows\\System32');
        add('C:\\Program Files');
        add('C:\\Program Files (x86)');
        add('C:\\Users');
        add(process.env.USERPROFILE);
    } else {
        for (const p of ['/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
            '/boot', '/dev', '/proc', '/sys', '/var', '/root', '/home', '/opt', '/srv', '/Applications', '/System', '/Library']) add(p);
    }
    add(os.homedir());
    return roots;
}

/**
 * Screen a mutating file operation against an absolute path.
 * @param {string} absPath absolute, normalized path being written/deleted
 * @param {'write'|'delete'} op
 * @returns {{ allowed: boolean, reason?: string }}
 */
function assessPathMutation(absPath, op) {
    if (!absPath) return { allowed: true };
    const target = path.resolve(absPath);
    const roots = criticalRoots();
    if (roots.has(target)) {
        return {
            allowed: false,
            reason: `${op} of a critical system/home root ("${target}")`,
        };
    }
    return { allowed: true };
}

function blockedPathResult(absPath, reason) {
    return {
        error: `Operation blocked by safety policy (${reason}). Agent Mode can manage the whole host, ` +
            `but it will not wipe a critical system or home root. Target a specific file or subdirectory instead, ` +
            `or ask the user to perform this manually.`,
        pathBlocked: true,
        reason,
    };
}

module.exports = { assessPathMutation, blockedPathResult, criticalRoots };
