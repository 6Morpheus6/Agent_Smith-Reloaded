/**
 * Code tool schemas — IPC channel whitelist integrity.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toolNames, CODE_TOOLS } = require('../src/code/tools/schemas.js');
const ipcChannels = require('../src/shared/ipcChannels.js');

test('code IPC channels are whitelisted', () => {
    for (const ch of [
        'code-run', 'code-stop', 'code-get-status', 'code-ledger-diff',
        'code-list-sessions', 'code-resume', 'code-plan-approve', 'code-plan-reject',
        'preview-show', 'preview-close', 'preview-list-sources', 'preview-capture-source'
    ]) {
        assert.ok(ipcChannels.INVOKE_CHANNELS.includes(ch), `${ch} missing from INVOKE_CHANNELS`);
    }
    assert.ok(ipcChannels.INVOKE_CHANNELS.includes('ghosttrace-append'));
    assert.ok(ipcChannels.RECEIVE_CHANNELS.includes('code-event'), 'code-event missing from RECEIVE_CHANNELS');
    assert.ok(ipcChannels.RECEIVE_CHANNELS.includes('preview-event'), 'preview-event missing from RECEIVE_CHANNELS');
});

test('code tools v50 unified surface', () => {
    const names = toolNames();
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('patch'));
    assert.ok(names.includes('run_command'));
    assert.ok(names.includes('show_preview'));
    assert.ok(names.includes('browser_verify'));
    // v50 merged the Agent Mode host-control tools into this one surface. Pin the exact
    // set so adding/removing a tool is a deliberate, visible change (the old
    // `CODE_TOOLS.length === names.length` was a tautology — names is derived from CODE_TOOLS).
    // v53.1: run_code joined the surface in v52.6 (dsh ordered-lane loop-over-tools) but the
    // pin was never updated, so this test failed on every run since.
    assert.deepEqual(names.slice().sort(), [
        'append_file', 'browser_verify', 'delete_host_file', 'fetch_url', 'glob', 'grep',
        'list_host_directory', 'list_processes', 'list_project', 'memory_search',
        'patch', 'query_run_trace', 'read_file', 'read_host_file', 'read_process_log',
        'review_actions', 'run_code', 'run_command', 'save_user_fact', 'send_input', 'show_preview',
        'stop_process', 'undo_action', 'web_search', 'write_file', 'write_host_file'
    ]);
    assert.equal(CODE_TOOLS.length, names.length);
});
