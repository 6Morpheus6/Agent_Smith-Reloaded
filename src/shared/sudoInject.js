/**
 * SUDO OVERRIDE password injection — BROWSER-SAFE (no node builtins).
 *
 * Lives in its own module because it is required from BOTH sides of the
 * process boundary:
 *   - main:  src/code/tools/executor.js (via commandPolicy's re-export)
 *   - renderer: src/renderer/modes/agentTools.js — bundled by esbuild for a
 *     `nodeIntegration:false` browser context, where ANY node builtin require
 *     in the graph throws at load time and kills the whole UI.
 *
 * v55.2 regression note: agentTools.js originally required commandPolicy.js
 * directly; that module's top-level node-builtin require was left as an external
 * by esbuild and threw "require is not defined" in the renderer, blanking the
 * entire sidebar. This file carries only pure string logic — no builtins.
 */
'use strict';

/**
 * Inject the user's SUDO OVERRIDE password into every `sudo` in the command so it
 * runs non-interactively: `sudo apt update && sudo apt upgrade -y` becomes
 * `echo '<pass>' | sudo -S apt update && echo '<pass>' | sudo -S apt upgrade -y`.
 * The password is escaped for double quotes (", \, $ and backtick) so it can never break
 * out of the echo or spawn a subshell. A `sudo` that is already part of an injected prefix
 * is left alone (idempotent). No password / no sudo → command returned unchanged.
 */
function injectSudoPassword(command, pass) {
    const cmd = String(command || '');
    if (!cmd || !pass) return cmd;
    const q = String(pass).replace(/(["\\$`])/g, '\\$1');
    let out = '';
    let last = 0;
    const re = /\bsudo\b/g;
    let m;
    while ((m = re.exec(cmd))) {
        // already an injected `echo "..." | sudo -S` prefix — skip (idempotent)
        if (/echo\s+(?:"[^"]*"|'[^']*')\s*\|\s*$/.test(cmd.slice(last, m.index))) continue;
        out += cmd.slice(last, m.index) + 'echo "' + q + '" | sudo -S ';
        last = m.index + 'sudo'.length;
        // consume the original separator after `sudo` (we added our own space)
        if (/^\s/.test(cmd[last] || '')) last++;
    }
    return out + cmd.slice(last);
}

module.exports = { injectSudoPassword };
