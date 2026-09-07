/**
 * ipcChannels — the single source of truth for the IPC channel whitelist.
 *
 * Both the preload bridge (src/preload/index.js) and the tool registry
 * (src/code/tools/schemas.js) import these lists so a channel is declared in
 * exactly one place. Main-process handlers (registered in main.js) must use a
 * channel that appears here; the registry integrity test enforces that the
 * tool-facing channels are present.
 */

// invoke = renderer -> main, returns a value (ipcRenderer.invoke / ipcMain.handle).
const INVOKE_CHANNELS = [
    'whatsapp-init', 'whatsapp-send', 'whatsapp-cancel', 'open-file-dialog', 'select-directory',
    'load-history', 'save-history', 'clear-history',
    'agent-run-command', 'agent-read-file', 'agent-write-file',
    'agent-delete-file', 'agent-list-directory', 'agent-list-project',
    'agent-read-process-log', 'agent-send-input',
    'agent-stop-process', 'agent-list-processes', 'agent-fetch-url',
    'agent-grep', 'agent-glob', 'agent-get-repo-map', 'agent-verify', 'agent-doctor',
    'agent-register-download',
    'actions-list', 'actions-undo', 'actions-clear',
    'edit-apply', 'edit-apply-patch', 'edit-apply-batch',
    'project-get-root', 'project-set-root', 'project-resolve-path',
    'ledger-diff', 'ledger-revert-all',
    'git-init', 'git-status', 'git-diff', 'git-commit', 'git-undo', 'git-log',
    'perform-search',
    // v54 deep research — search + read top pages, returns {query,results,pagesRead,report}.
    'perform-search-deep',
    'mem-store', 'mem-query', 'mem-count', 'mem-clear',
    'export-session', 'import-session', 'get-host-url', 'get-remote-qr', 'get-env-info', 'open-external-url', 'set-lms-url',
    'window-minimize', 'window-maximize', 'window-close', 'window-is-maximized',
    'get-gpu-telemetry', 'app-reset',
    'lmstudio-get-status', 'lmstudio-ensure-model', 'lmstudio-unload-all',
    // v52.5: model swap (dropdown pick → unload others + load selection) and the
    // startup embedding-model guarantee for memory recall.
    'lmstudio-swap-model', 'lmstudio-ensure-embedding',
    'auth-login', 'auth-register', 'auth-check', 'auth-logout', 'auth-has-users',
    'auth-get-users', 'auth-update-user',
    'plugins-list', 'plugins-get-contributions', 'plugin-invoke-tool',
    'plugin-run-command', 'plugin-fire-hook', 'plugin-set-enabled',
    'plugin-uninstall', 'plugin-install',
    'code-run', 'code-stop', 'code-get-status', 'code-ledger-diff',
    'code-list-sessions', 'code-resume', 'code-plan-approve', 'code-plan-reject',
    'code-readiness',
    'preview-show', 'preview-close', 'preview-list-sources', 'preview-capture-source',
    'preview-sync-desktop',
    'imagegen-status', 'imagegen-set-enabled', 'imagegen-update-settings',
    'imagegen-list-models', 'imagegen-import-model', 'imagegen-pick-file',
    'imagegen-import-url', 'imagegen-select-model', 'imagegen-remove-model', 'imagegen-generate',
    'ghosttrace-append'
];

// send = renderer -> main, fire-and-forget (ipcRenderer.send / ipcMain.on).
const SEND_CHANNELS = [];

// receive = main -> renderer push events (ipcRenderer.on).
const RECEIVE_CHANNELS = [
    'whatsapp-qr', 'whatsapp-ready', 'whatsapp-error', 'whatsapp-disconnected',
    'resource-update', 'plugin-ui-event',
    'code-event', 'preview-event', 'imagegen-event'
];

const api = { INVOKE_CHANNELS, SEND_CHANNELS, RECEIVE_CHANNELS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKIpcChannels = api;
