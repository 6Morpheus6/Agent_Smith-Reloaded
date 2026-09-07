// v47.8.0 — kimi web_search builtin-collision fix + v47.7 whitelist follow-up.
//
// Agent Mode advertises a tool named `web_search`; Moonshot reserves that exact
// name for its server-side builtin (broken on kimi-k3 — the model receives
// {"success":false,"error":"Search request failed"} and the app's own
// DuckDuckGo search never runs). The harness renames it on the wire and maps
// it back on receipt. Also pins: the v47.7 agent-register-download channel is
// whitelisted in the preload (a miss there made the download fix unreachable
// in the desktop app), and backend search failures surface as failures (not
// "no results").
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    toolNameOverridesFor,
    wireToolName,
    canonicalToolName,
    adaptSystemPromptForModel,
    describeModelHarness
} = require('../src/code/context/modelHarness.js');
const ipcChannels = require('../src/shared/ipcChannels.js');
const { executeAgentChatTool } = require('../src/renderer/modes/agentTools.js');

test('kimi-k3 renames web_search on the wire; other families do not', () => {
    assert.equal(wireToolName('kimi-k3', 'web_search'), 'internet_search');
    assert.equal(wireToolName('kimi-k3', 'write_file'), 'write_file', 'unrelated tools untouched');
    assert.equal(wireToolName('qwen2.5-coder', 'web_search'), 'web_search');
    assert.equal(wireToolName('gemma-3-4b', 'web_search'), 'web_search');
    assert.equal(wireToolName('', 'web_search'), 'web_search');
    assert.deepEqual(toolNameOverridesFor('kimi-k3'), { web_search: 'internet_search' });
    assert.deepEqual(toolNameOverridesFor('qwen'), {});
});

test('wire→canonical round trip (dispatch sees the app tool name)', () => {
    assert.equal(canonicalToolName('kimi-k3', 'internet_search'), 'web_search');
    assert.equal(canonicalToolName('kimi-k3', 'write_file'), 'write_file');
    assert.equal(canonicalToolName('kimi-k3', 'web_search'), 'web_search',
        'a literal canonical name still passes through (older prompts / fallbacks)');
    assert.equal(canonicalToolName('qwen', 'web_search'), 'web_search');
});

test('system prompt is rewritten to the wire names for kimi only', () => {
    const prompt = 'To look things up online, use web_search; to read a page use fetch_url.';
    const adapted = adaptSystemPromptForModel(prompt, 'kimi-k3');
    assert.ok(adapted.includes('internet_search'), 'tool name rewritten');
    assert.ok(!/\bweb_search\b/.test(adapted), 'no canonical name left behind');
    assert.ok(adapted.includes('fetch_url'), 'unrelated tool mentions untouched');
    assert.equal(adaptSystemPromptForModel(prompt, 'qwen'), prompt, 'identity for other families');
});

test('kimi-k3 strategy description documents the collision', () => {
    assert.ok(describeModelHarness('kimi-k3').description.includes('web_search'));
});

test('every agent IPC channel the renderer can invoke is whitelisted (v47.7 follow-up)', () => {
    for (const ch of [
        'agent-run-command', 'agent-read-file', 'agent-write-file', 'agent-delete-file',
        'agent-list-directory', 'agent-list-project', 'agent-fetch-url',
        'agent-register-download', 'perform-search', 'perform-search-deep'
    ]) {
        assert.ok(ipcChannels.INVOKE_CHANNELS.includes(ch), `${ch} missing from INVOKE_CHANNELS`);
    }
});

test('web_search surfaces a backend failure as a failure (not "no results")', async () => {
    const deps = { api: { invoke: async () => ({ error: 'Search failed: Service Unavailable' }) } };
    const out = await executeAgentChatTool('web_search', { query: 'anything' }, deps);
    assert.ok(out.startsWith('Web search failed:'), out.slice(0, 60));
    assert.ok(out.includes('Service Unavailable'));
    assert.ok(!out.startsWith('No web results found'));
});

test('web_search: genuine zero-hit search still reports no results', async () => {
    const deps = { api: { invoke: async () => ({ query: 'zzz-no-hits', results: [], pagesRead: 0, report: null }) } };
    const out = await executeAgentChatTool('web_search', { query: 'zzz-no-hits' }, deps);
    assert.ok(out.startsWith('No web results found'));
});

test('v54: web_search calls perform-search-deep and returns the deep-research report verbatim', async () => {
    const report = [
        'DEEP RESEARCH REPORT — "q"',
        'Sources found: 1 · pages read in full: 1',
        '',
        'SOURCE 1: T',
        'URL: https://x.test',
        'WHAT I LEARNED FROM THIS PAGE:',
        'S is the detailed finding learned from reading the page.',
        '[SYSTEM NUDGE] This result is a DEEP RESEARCH REPORT…'
    ].join('\n');
    let invoked = null;
    const deps = {
        api: { invoke: async (channel, opts) => { invoked = [channel, opts]; return { query: 'q', results: [{ title: 'T', url: 'https://x.test', snippet: 'S' }], pagesRead: 1, report }; } }
    };
    const out = await executeAgentChatTool('web_search', { query: 'q' }, deps);
    assert.equal(invoked && invoked[0], 'perform-search-deep', 'must use the deep-research IPC channel');
    assert.deepEqual(invoked && invoked[1], { query: 'q' });
    // The report (findings + nudge) is what reaches the model — not a re-capped snippet list.
    assert.ok(out.startsWith('DEEP RESEARCH REPORT'), out.slice(0, 60));
    assert.ok(out.includes('WHAT I LEARNED FROM THIS PAGE:'));
    assert.ok(out.includes('[SYSTEM NUDGE]'));
});
