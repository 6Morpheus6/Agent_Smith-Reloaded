/**
 * Command safety policy for Code Mode's autonomous `run_command`.
 *
 * Code Mode runs shell commands with no per-command confirmation after plan approval, so a
 * model mistake or prompt injection must not be able to damage the machine or exfiltrate
 * secrets. This is NOT a full sandbox, but it is a STRONG guardrail with three layers:
 *   1. an outright denylist for catastrophic / host-level operations,
 *   2. refusal of any command that touches home dotfiles / credentials / system secrets,
 *   3. refusal of destructive ops or output redirects whose target path escapes the project
 *      root (the same boundary the file tools enforce).
 * In-project dev commands (npm/node/python/git/ls/cat/mkdir/test runners, deletes inside the
 * project, redirects into project files) are allowed so the agent stays autonomous.
 *
 * SUDO: `sudo` is NOT on the denylist. When the user fills in the SUDO OVERRIDE field,
 * that IS explicit authorization to run with elevated privileges — the harness injects
 * the password (stdin via `echo '<pass>' | sudo -S`, never an interactive prompt) and
 * the policy must not veto it. A command that BEGINS with sudo (or the injected
 * `echo … | sudo` prefix) is therefore judged by layer 1 ONLY: layers 2/3 exist to keep
 * an UNPRIVILEGED autonomous agent inside its sandbox, but with explicit root
 * authorization system paths and files are the legitimate target (`sudo apt upgrade`,
 * `sudo dpkg -i /tmp/x.deb`, editing `/etc` or home dotfiles as root). Layer 1 still
 * applies to elevated commands — no override request implies unrecoverable machine
 * destruction (`sudo rm -rf /`, `sudo mkfs …`, `sudo dd of=/dev/sda`) or piping remote
 * downloads into an interpreter. A sudo that appears MID-command (not leading) does not
 * earn the exemption: the whole command is still screened by layers 2/3, so a non-elevated
 * secret read can't piggyback on an authorized elevated tail. Without a password supplied,
 * sudo commands run as-is and simply fail at the prompt — the policy never blocks on
 * "no password" alone; only the layers above do.
 */
'use strict';

const path = require('path');
// v55.2 fix: injectSudoPassword lives in the browser-safe sudoInject.js (no node
// builtins) so the renderer can require it without dragging `require('path')` into
// the esbuild bundle — that external was throwing "require is not defined" at load
// time and blanking the whole sidebar. Re-exported here to keep the main-process API stable.
const { injectSudoPassword } = require('./sudoInject.js');

// A command that BEGINS with `sudo` (optionally after an already-injected
// `echo '<pass>' | sudo -S` prefix) — i.e. an elevated command authorized by the user's
// SUDO OVERRIDE field.
const SUDO_LEADING = /^(?:echo\s+(?:"[^"]*"|'[^']*')\s*\|\s*)?sudo\b/;

// Layer 1 — catastrophic / host-level. Matched case-insensitively against the normalized command.
const RULES = [
    { re: /\brm\s+(?:-[a-z]*\s+)*-?[a-z]*r[a-z]*f?[a-z]*\b[^\n]*\s(?:\/|~|\/\*|\$HOME|\$\{HOME\})(?:\s|$)/i, reason: 'recursive delete of a root/home directory' },
    { re: /\brm\s+-[rf]+\s+\/(?:\s|$)/i, reason: 'rm -rf /' },
    { re: /\b(?:del|erase)\b[^\n]*\/[sq][^\n]*[a-z]:\\/i, reason: 'recursive Windows delete of a drive root' },
    { re: /\b(?:rd|rmdir)\b[^\n]*\/s[^\n]*[a-z]:\\?/i, reason: 'recursive Windows directory removal of a drive' },
    { re: /\bformat\s+[a-z]:/i, reason: 'disk format' },
    { re: /\bcipher\s+\/w/i, reason: 'secure-wipe (cipher /w)' },
    { re: /\bmkfs(\.\w+)?\b/i, reason: 'filesystem creation (mkfs)' },
    { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd|vd)/i, reason: 'dd writing to a raw disk device' },
    { re: />\s*\/dev\/(sd|nvme|disk|hd|vd)/i, reason: 'redirect into a raw disk device' },
    { re: /\bchmod\s+-R\s+[0-7]{3,4}\s+\/(?:\s|$)/i, reason: 'recursive chmod of /' },
    { re: /\bchown\s+-R\b[^\n]*\s\/(?:\s|$)/i, reason: 'recursive chown of /' },
    { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
    { re: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^|\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|powershell|pwsh|python\d?|node|ruby|perl)\b/i, reason: 'piping a remote download straight into an interpreter' },
    { re: /\b(?:iex|invoke-expression)\b[^\n]*(?:downloadstring|webclient|invoke-webrequest|iwr|curl|wget)/i, reason: 'IEX of a remote download (PowerShell)' },
    { re: /\b(?:shutdown|reboot|poweroff|halt|init\s+0|init\s+6)\b/i, reason: 'host power-state change' },
];

// Layer 2 — home dotfiles, credentials, and system secrets (a coding task in a project has no
// legitimate reason to read or write these). Project-local files (.env in the workspace, etc.)
// are NOT matched — only home/root/system locations.
const HOME_SECRET = /(?:~|\$HOME|\$\{HOME\}|\/root|\/home\/[^/\s]+|\/Users\/[^/\s]+)\/\.(?:ssh|aws|gnupg|kube|docker|azure|config\/gcloud|netrc|npmrc|pypirc|git-credentials|bash_history|bashrc|zshrc|bash_profile|zprofile|profile)\b/i;
const SYS_SECRET = /(?:\/etc\/(?:passwd|shadow|sudoers|ssh\b)|\bid_rsa\b|\bid_ed25519\b|\bid_dsa\b|\.ssh\/(?:id_|authorized_keys|known_hosts)|\.aws\/credentials|\.pem\b)/i;
const RAW_SOCKET = /\/dev\/(?:tcp|udp)\//i;

// Destructive verbs whose path arguments must stay inside the project root.
const DESTRUCTIVE = /(?:^|[\s;&|(])(?:rm|rmdir|unlink|shred|srm|wipe|truncate|mv|dd|tee)\b/i;
const FIND_DESTRUCTIVE = /\bfind\b[^\n]*-(?:delete|exec|execdir)\b/i;
const REDIRECT = /(?:^|[\s;&|(])>>?(?!&)/; // > or >> (not 2>&1)

function expandHome(tok) {
    return tok.replace(/^~(?=\/|$)/, process.env.HOME || '/home').replace(/\$\{?HOME\}?/g, process.env.HOME || '/home');
}

/** True if any path-like argument of a destructive command / redirect resolves outside root. */
function escapesRoot(command, projectRoot, cwd) {
    if (!projectRoot) return false;
    const root = path.resolve(projectRoot);
    const base = cwd ? path.resolve(cwd) : root;
    const tokens = command.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) || [];
    for (let raw of tokens) {
        let tok = raw.replace(/^['"]|['"]$/g, '');
        const redir = tok.match(/^>>?(.+)$/);
        if (redir) tok = redir[1].replace(/^['"]|['"]$/g, '');
        if (!tok || /^-/.test(tok)) continue;
        const looksPath = /^[~/]/.test(tok) || /^\.\.?\//.test(tok) || tok.includes('/');
        if (!looksPath) continue;
        // unresolvable shell expansion in a path position → can't verify → refuse (conservative)
        if (/\$\(|`/.test(tok)) return true;
        if (/^~/.test(tok) || /\$\{?HOME\}?/.test(tok)) {
            const expanded = expandHome(tok);
            const rel = path.relative(root, path.normalize(expanded));
            if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return true;
            continue;
        }
        if (/^\$/.test(tok)) return true; // other variable path → can't verify
        const abs = path.isAbsolute(tok) ? path.normalize(tok) : path.normalize(path.join(base, tok));
        const rel = path.relative(root, abs);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return true;
    }
    return false;
}

/**
 * @param {string} command
 * @param {{ projectRoot?: string, cwd?: string }} [opts]
 * @returns {{ allowed: boolean, reason?: string }}
 */
function assessCommand(command, opts = {}) {
    const cmd = String(command || '').replace(/\s+/g, ' ').trim();
    if (!cmd) return { allowed: true };

    // Layer 1 — catastrophic / host-level. Applies to EVERY command, including elevated ones:
    // an explicit sudo override authorizes root privileges, not unrecoverable machine damage.
    for (const rule of RULES) {
        if (rule.re.test(cmd)) return { allowed: false, reason: rule.reason };
    }

    // v55.2 — a command that BEGINS with sudo is explicitly authorized by the user's SUDO
    // OVERRIDE field; layers 2/3 (home/system secrets + project-root containment) exist to
    // sandbox an UNPRIVILEGED autonomous agent and must not veto it. System paths are the
    // legitimate target of elevated commands (`sudo apt upgrade`, `sudo dpkg -i /tmp/x.deb`).
    if (SUDO_LEADING.test(cmd)) return { allowed: true };

    if (HOME_SECRET.test(cmd) || SYS_SECRET.test(cmd)) {
        return { allowed: false, reason: 'accesses home dotfiles / credentials / system secrets outside the project' };
    }
    if (RAW_SOCKET.test(cmd)) {
        return { allowed: false, reason: 'raw network socket (/dev/tcp) — exfiltration risk' };
    }
    // inline interpreter script that spawns processes or opens sockets (an RCE/escape wrapper)
    if (/\b(?:node|deno|bun|python\d?|perl|ruby|php)\b[^\n]*\s-(?:e|c)\b/i.test(cmd) &&
        /\b(?:child_process|subprocess|os\.system|Runtime\.getRuntime|spawn|execSync|popen|pty\b)\b|\/dev\/tcp/i.test(cmd)) {
        return { allowed: false, reason: 'inline interpreter script spawning processes / sockets (RCE-escape)' };
    }
    // destructive op or redirect whose target escapes the project root
    if ((DESTRUCTIVE.test(cmd) || FIND_DESTRUCTIVE.test(cmd) || REDIRECT.test(cmd)) &&
        escapesRoot(cmd, opts.projectRoot, opts.cwd)) {
        return { allowed: false, reason: 'destructive operation or redirect targeting a path outside the project root' };
    }
    return { allowed: true };
}

function blockedResult(command, reason) {
    return {
        error: `Command blocked by safety policy (${reason}). It will not run. ` +
            'Operate inside the project root only: delete/redirect to paths within the project, do not touch home/credentials/system files. ' +
            'Commands that begin with sudo are permitted (the user authorizes them via the SUDO OVERRIDE field) but must not be catastrophic — no rm -rf of / or ~, no mkfs/dd onto raw disks, no piping remote downloads into an interpreter. ' +
            'If you genuinely need something else, ask the user to run it manually.',
        commandBlocked: true,
        reason
    };
}

module.exports = { assessCommand, blockedResult, escapesRoot, injectSudoPassword, RULES };
