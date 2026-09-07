/**
 * Temporary verification harness for the Phase 5 IPC extraction.
 *
 * Loads the real main.js under stubbed electron / whatsapp / qrcode / http /
 * memory so it evaluates fully in plain Node (no GUI, no port bind, no model
 * pull). Asserts that every extracted IPC channel registered exactly once and
 * that no channel registered twice (which would mean a leftover inline handler).
 */
const Module = require('module');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'smith-ipc-'));

const registered = [];
const fakeIpcMain = {
    handle(channel) { registered.push(channel); },
    on() {},
};

const fakeApp = {
    getPath: () => tmpUserData,
    commandLine: { appendSwitch() {} },
    disableHardwareAcceleration() {},
    whenReady: () => new Promise(() => {}), // never resolves -> createWindow never runs
    on() {},
    relaunch() {}, exit() {}, quit() {},
};

const electronStub = {
    app: { ...fakeApp, setName() {} },
    BrowserWindow: class { static getAllWindows() { return []; } loadFile() {} on() {} },
    ipcMain: fakeIpcMain,
    dialog: {},
    shell: {},
};

const httpStub = {
    // Mirror the http.Server surface main.js uses: listen + on('error') + close.
    createServer: () => ({ listen() { /* no bind */ return this; }, on() { return this; }, close() {} }),
    request: () => ({ on() {}, end() {}, write() {} }),
};

const memoryStub = {
    setGpuVendor() {}, setLlmBase() {},
    storeVector: async () => ({}), queryVectors: async () => ({ success: true, data: [] }),
    getCount: () => 0, clearMemory: () => ({}),
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === 'http') return httpStub;
    if (request === 'whatsapp-web.js') return { Client: class { on() {} initialize() {} }, LocalAuth: class {} };
    if (request === 'qrcode') return { toDataURL: async () => '' };
    // Only main.js's vector-memory require should be stubbed (avoid embedding
    // model pull). main.js now requires the service directly post shim-removal.
    if (request === './src/main/services/memory.js' && parent && /(^|[\\/])main\.js$/.test(parent.filename || '')) return memoryStub;
    return realLoad.apply(this, arguments);
};

const EXPECTED = [
    // auth
    'auth-login', 'auth-register', 'auth-check', 'auth-get-users', 'auth-update-user', 'auth-logout', 'auth-has-users',
    // history / dialogs
    'open-file-dialog', 'load-history', 'save-history', 'clear-history', 'export-session', 'import-session', 'select-directory',
    // agent
    'agent-run-command', 'agent-stop-process', 'agent-list-processes', 'agent-read-process-log', 'agent-send-input',
    'agent-read-file', 'agent-write-file', 'agent-delete-file', 'agent-list-directory', 'agent-list-project',
    'agent-fetch-url', 'agent-grep', 'agent-glob', 'agent-get-repo-map', 'agent-verify', 'agent-doctor',
    // edit
    'edit-apply', 'edit-apply-patch', 'edit-apply-batch',
    // project
    'project-get-root', 'project-set-root', 'project-resolve-path',
    // code
    'code-run', 'code-stop', 'code-get-status', 'code-ledger-diff',
    'code-list-sessions', 'code-resume', 'code-plan-approve', 'code-plan-reject',
    // preview
    'preview-show', 'preview-close', 'preview-list-sources', 'preview-capture-source',
    'preview-sync-desktop',
    // ledger
    'ledger-diff', 'ledger-revert-all',
    // git
    'git-init', 'git-status', 'git-diff', 'git-commit', 'git-undo', 'git-log',
    // memory
    'mem-store', 'mem-query', 'mem-count', 'mem-clear',
    // plugins
    'plugins-list', 'plugins-get-contributions', 'plugin-invoke-tool', 'plugin-run-command',
    'plugin-fire-hook', 'plugin-set-enabled', 'plugin-uninstall', 'plugin-install',
];

// OS/lifecycle channels that intentionally stay inline in main.js.
const INLINE = [
    'whatsapp-init', 'whatsapp-send', 'perform-search', 'get-gpu-telemetry',
    'app-reset', 'set-lms-url', 'get-host-url', 'get-remote-qr', 'open-external-url', 'get-env-info',
    'window-minimize', 'window-maximize', 'window-close', 'window-is-maximized',
];

try {
    require('../main.js');
} catch (e) {
    console.error('FAIL: main.js threw at load:', e && e.stack || e);
    process.exit(1);
}

let ok = true;

// Duplicate detection
const counts = registered.reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {});
const dups = Object.keys(counts).filter(c => counts[c] > 1);
if (dups.length) { ok = false; console.error('FAIL: channels registered more than once:', dups); }

const missing = EXPECTED.filter(c => !registered.includes(c));
if (missing.length) { ok = false; console.error('FAIL: expected extracted channels not registered:', missing); }

const inlineMissing = INLINE.filter(c => !registered.includes(c));
if (inlineMissing.length) { ok = false; console.error('FAIL: inline lifecycle channels missing:', inlineMissing); }

// Cross-check against the shared whitelist (invoke channels only).
const { INVOKE_CHANNELS } = require('../src/shared/ipcChannels.js');
const notInWhitelist = registered.filter(c => !INVOKE_CHANNELS.includes(c));
if (notInWhitelist.length) { ok = false; console.error('FAIL: registered channels missing from ipcChannels whitelist:', notInWhitelist); }

if (ok) {
    console.log(`PASS: ${registered.length} channels registered, no duplicates;`,
        `${EXPECTED.length} extracted + ${INLINE.length} inline verified; all in whitelist.`);
    process.exit(0);
}
process.exit(1);
