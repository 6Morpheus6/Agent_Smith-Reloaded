/**
 * Agent Mode tool surface — full host control (shell + whole-host file management),
 * matching the "manage everything on this computer" doctrine. Code Mode keeps its
 * own root-contained executor; agent-* tools deliberately reach the whole host.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    AGENT_SYS_TOOLS,
    BUILD_TOOL_NAMES,
    isBuildTool,
    toolsForChatMode,
    extractTextToolCalls
} = require('../src/renderer/modes/agentTools.js');

test('Agent Mode includes full host-management tools (write/delete enabled)', () => {
    const names = new Set(AGENT_SYS_TOOLS.map(t => t.function.name));
    for (const required of ['write_file', 'delete_file', 'read_file', 'list_directory']) {
        assert.ok(names.has(required), `${required} must be available in Agent Mode`);
        assert.equal(isBuildTool(required), false, `${required} must NOT be blocked in Agent Mode`);
    }
});

test('Agent Mode includes shell, read_file, and process management', () => {
    const names = new Set(AGENT_SYS_TOOLS.map(t => t.function.name));
    assert.ok(names.has('run_shell_command'));
    assert.ok(names.has('read_file'));
    assert.ok(names.has('list_directory'));
    // Process management must be advertised, not just implemented in the dispatcher.
    assert.ok(names.has('list_processes'), 'list_processes must be advertised');
    assert.ok(names.has('stop_process'), 'stop_process must be advertised');
});

test('every advertised Agent tool is dispatchable (no schema/handler drift)', () => {
    // Guards the bug where list_processes/stop_process were handled but never advertised.
    const handled = require('fs').readFileSync(require('path').join(__dirname, '../src/renderer/modes/agentTools.js'), 'utf8');
    for (const t of AGENT_SYS_TOOLS) {
        const n = t.function.name;
        assert.ok(handled.includes(`name === '${n}'`) || ['task_begin', 'task_complete', 'memory_purge'].includes(n),
            `advertised tool "${n}" has no dispatch branch`);
    }
});

test('toolsForChatMode returns agent tools only when agent on', () => {
    const agent = toolsForChatMode({ agentEnabled: true, memoryEnabled: true });
    assert.ok(agent.some(t => t.function.name === 'run_shell_command'));
    const mem = toolsForChatMode({ agentEnabled: false, memoryEnabled: true });
    assert.equal(mem.length, 2);
    const none = toolsForChatMode({ agentEnabled: false, memoryEnabled: false });
    assert.equal(none.length, 0);
});

test('Agent Mode advertises web read tools', () => {
    const names = new Set(AGENT_SYS_TOOLS.map(t => t.function.name));
    for (const t of ['web_search', 'fetch_url']) {
        assert.ok(names.has(t), `${t} must be advertised in Agent Mode`);
    }
});

test('extractTextToolCalls recovers ANY tool emitted as raw JSON text (not just web_search)', () => {
    const known = ['write_file', 'web_search', 'read_file'];
    // The failure mode this guards: the model emits a tool as prose JSON instead of a native call.
    const text = 'Sure, I will write the file.\n{"name": "write_file", "parameters": {"filepath": "a.txt", "content": "Trinity", "append": false}}';
    const calls = extractTextToolCalls(text, known);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'write_file');
    assert.deepEqual(calls[0].arguments, { filepath: 'a.txt', content: 'Trinity', append: false });
    assert.ok(calls[0].raw.includes('write_file'));
});

test('extractTextToolCalls handles nested braces and "arguments" alias, ignores unknown tools', () => {
    const known = ['fetch_url'];
    const text = '{"name":"fetch_url","arguments":{"url":"https://x.io/?a={b}","meta":{"k":1}}} and {"name":"unknown_x","parameters":{}}';
    const calls = extractTextToolCalls(text, known);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'fetch_url');
    assert.equal(calls[0].arguments.url, 'https://x.io/?a={b}');
    assert.deepEqual(calls[0].arguments.meta, { k: 1 });
});

test('extractTextToolCalls returns nothing for plain prose', () => {
    assert.equal(extractTextToolCalls('Just a normal answer with no tools.', ['web_search']).length, 0);
});

test('Agent Mode never exposes a password-returning credential tool', () => {
    const names = new Set(AGENT_SYS_TOOLS.map(t => t.function.name));
    // The browser/credential-vault feature was removed; ensure no credential tool lingers
    // and the model is never handed a tool that returns a stored password.
    for (const forbidden of ['browser_login', 'vault_list_sites', 'vault_get', 'vault_get_password', 'get_credential']) {
        assert.equal(names.has(forbidden), false, `${forbidden} must NOT be exposed to the agent`);
    }
});

test('BUILD_TOOL_NAMES is empty — Agent Mode blocks nothing (full control)', () => {
    // Doctrine change: Agent Mode manages the whole computer, so no tool is hard-blocked.
    // Safety lives in commandPolicy (shell) and pathPolicy (file mutations), not here.
    assert.equal(BUILD_TOOL_NAMES.size, 0);
    assert.equal(isBuildTool('write_file'), false);
});

// ── v52.8: the agent appendix must not push conversation into tool calls ──

test('v52.8 agent appendix is conversation-first and recency-aware', () => {
    const { AGENT_MODE_SYSTEM_APPENDIX } = require('../src/renderer/modes/agentTools.js');
    assert.ok(/CONVERSATION FIRST/.test(AGENT_MODE_SYSTEM_APPENDIX), 'conversation-first rule present');
    assert.ok(/NO tool call/i.test(AGENT_MODE_SYSTEM_APPENDIX), 'plain answers need no tool call');
    assert.ok(/RECENCY/.test(AGENT_MODE_SYSTEM_APPENDIX), 'recency rule present');
    // The v52.7 line that made every turn a tool call is gone:
    assert.ok(!/Make progress every turn with a tool call/i.test(AGENT_MODE_SYSTEM_APPENDIX));
});

test('v52.8 task_begin/task_complete schemas are optional, not mandatory', () => {
    const byName = Object.fromEntries(AGENT_SYS_TOOLS.map(t => [t.function.name, t.function]));
    assert.match(byName.task_begin.description, /^Optional/);
    assert.match(byName.task_complete.description, /^Optional/);
});
