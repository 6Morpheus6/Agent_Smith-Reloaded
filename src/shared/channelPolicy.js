/**
 * IPC channel permission policy. Single source of truth for which channels expose
 * tool/agent CAPABILITY (shell, file writes, git, plugin install, code-run) and must
 * therefore be gated behind the `canUseTools` permission — for BOTH the Electron
 * preload bridge and the web `/api/invoke` surface.
 *
 * Previously the web gate keyed on the `agent-` prefix alone, which let a non-tool
 * web user invoke `code-run` (full executor incl. run_command) and `git-*`. This
 * closes that by gating on capability, not name shape.
 */
'use strict';

// Any channel starting with one of these performs tool-level actions.
const TOOL_PREFIXES = ['agent-', 'code-', 'git-', 'edit-', 'plugin-', 'ledger-', 'preview-', 'actions-'];

// Individually dangerous channels that don't share a tool prefix.
const TOOL_CHANNELS = new Set([
    'app-reset',
    'set-lms-url',
    'open-external-url',
    'run-command',
    'spawn-shell'
]);

function requiresToolPermission(channel) {
    if (typeof channel !== 'string') return true; // unknown → treat as privileged
    if (TOOL_CHANNELS.has(channel)) return true;
    return TOOL_PREFIXES.some(p => channel.startsWith(p));
}

module.exports = { requiresToolPermission, TOOL_PREFIXES, TOOL_CHANNELS };
