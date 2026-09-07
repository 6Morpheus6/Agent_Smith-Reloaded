#!/usr/bin/env node
/**
 * assistant-parity follow-up: personalization / memory ACROSS conversations,
 * using the app's REAL semantic memory (MemoryManager + all-minilm via Ollama),
 * not a substring stub. Phase A saves a standing preference; Phase B starts a
 * FRESH conversation (no mention of it) and must recall it from memory.
 *
 * Usage: LMS_URL=http://127.0.0.1:11434 node scripts/agent-memory-recall-e2e.js [model]
 */
'use strict';
const fs = require('fs'), fsPromises = require('fs/promises'), path = require('path'), os = require('os');
const { spawn, exec } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const projectContext = require(path.join(ROOT, 'src/main/services/projectContext.js'));
const ChangeLedger = require(path.join(ROOT, 'src/main/services/changeLedger.js'));
const EditEngine = require(path.join(ROOT, 'src/main/services/editEngine.js'));
const verificationHarness = require(path.join(ROOT, 'src/shared/verificationHarness.js'));
const { grepProject, hasRipgrep } = require(path.join(ROOT, 'src/shared/grepTool.js'));
const { globFiles } = require(path.join(ROOT, 'src/shared/globTool.js'));
const { buildRepoMap, invalidate: invalidateRepoMap } = require(path.join(ROOT, 'src/shared/repoMap.js'));
const netGuard = require(path.join(ROOT, 'src/shared/netGuard.js'));
const registerAgentIpc = require(path.join(ROOT, 'src/main/ipc/agent.js'));
const gemma = require(path.join(ROOT, 'src/code/context/gemmaHarness.js'));
const agentTools = require(path.join(ROOT, 'src/renderer/modes/agentTools.js'));
const { executeAgentChatTool, toolsForChatMode, AGENT_MODE_SYSTEM_APPENDIX } = agentTools;
const memory = require(path.join(ROOT, 'src/main/services/memory.js')); // real singleton

const LMS = process.env.LMS_URL || 'http://localhost:1234';
const handlers = new Map();
const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mem-data-'));
const changeLedger = new ChangeLedger(userDataPath);
const editEngine = new EditEngine(changeLedger, projectContext);
registerAgentIpc({ handle: (c, fn) => handlers.set(c, fn) }, {
    fs, fsPromises, path, spawn, exec, projectContext, editEngine, changeLedger, verificationHarness,
    grepProject, hasRipgrep, globFiles, buildRepoMap, invalidateRepoMap, netGuard,
    relPathFromRoot: (p) => { const r = projectContext.getRootOrNull(); return r ? path.relative(r, p) : p; },
    state: { currentPlanId: null },
});

// Real semantic memory, redirected to a temp store.
memory.vectorDBPath = path.join(userDataPath, 'vectors.json');
memory.vectors = [];
const deps = {
    api: { invoke: async (c, ...a) => { const fn = handlers.get(c); if (!fn) throw new Error('no handler ' + c); return fn({}, ...a); } },
    getSudoPassword: () => '',
    // mirror app.js exactly: store via mem-store shape, query + filter similarity>0.15
    saveToMemory: async (t) => memory.storeVector(t),
    searchMemory: async (q) => { const r = await memory.queryVectors(q, 5); return r.success ? r.data.filter(x => x.similarity > 0.15) : []; },
};
const tools = toolsForChatMode({ agentEnabled: true, memoryEnabled: true });
const toolNames = tools.map(t => t.function.name);

async function chat(model, history) {
    let messages = history.map(m => {
        const msg = { role: m.role };
        if (m.role === 'assistant') { msg.content = m.content || ''; if (m.tool_calls) msg.tool_calls = m.tool_calls; }
        else if (m.role === 'tool') { msg.content = String(m.content || 'Success'); msg.tool_call_id = m.tool_call_id; if (m.name) msg.name = m.name; }
        else { msg.content = String(m.content || ''); }
        return msg;
    });
    if (gemma.isGemmaModel(model)) messages = gemma.adaptMessagesForGemma(messages, model, { toolNames, serializeToolHistory: true });
    const resp = await fetch(`${LMS}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, temperature: 0.2, max_tokens: 1024, tools: tools.map(t => ({ type: 'function', function: { name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } } })) }),
    });
    if (!resp.ok) throw new Error(`LMS HTTP ${resp.status}`);
    return (await resp.json()).choices?.[0]?.message || { role: 'assistant', content: '' };
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
async function runTask(model, prompt, maxSteps = 8) {
    const sys = 'You are a CLI autonomous personal-assistant agent. Use the tools. ' + AGENT_MODE_SYSTEM_APPENDIX;
    const history = [{ role: 'system', content: sys }, { role: 'user', content: prompt }];
    const usedTools = []; let lastText = '';
    for (let step = 0; step < maxSteps; step++) {
        let msg; try { msg = await chat(model, history); } catch (e) { return { usedTools, lastText: 'ERR ' + e.message }; }
        let toolCalls = (msg.tool_calls || []).map(tc => ({ id: tc.id || 'c' + step, type: 'function', function: { name: tc.function?.name, arguments: typeof tc.function?.arguments === 'string' ? safeJson(tc.function.arguments) : (tc.function?.arguments || {}) } }));
        if (!toolCalls.length && msg.content) toolCalls = agentTools.extractTextToolCalls(msg.content, toolNames).map((c, i) => ({ id: 't' + step + i, type: 'function', function: { name: c.name, arguments: c.arguments } }));
        if (!toolCalls.length) { lastText = msg.content || ''; history.push({ role: 'assistant', content: lastText }); break; }
        history.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) } })) });
        for (const tc of toolCalls) {
            usedTools.push(tc.function.name);
            let result; try { result = await executeAgentChatTool(tc.function.name, tc.function.arguments, deps); } catch (e) { result = 'Error: ' + e.message; }
            history.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: String(result).slice(0, 4000) });
            if (tc.function.name === 'task_complete') return { usedTools, lastText: tc.function.arguments?.summary || '' };
        }
    }
    return { usedTools, lastText };
}

(async () => {
    let model = process.argv[2];
    if (!model) { const r = await fetch(`${LMS}/v1/models`).then(x => x.json()).catch(() => null); const ids = (r?.data || []).map(d => d.id).filter(id => !/embed/i.test(id)); model = ids.find(id => /gemma|qwen|llama|mistral/i.test(id)) || ids[0]; }
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mem-ws-')); projectContext.setRoot(ws);
    console.log(`\nAssistant memory parity (REAL semantic memory, all-minilm)\n  model: ${model}\n`);

    console.log('▶ Phase A — save standing preference (conversation 1)');
    const a = await runTask(model, 'Going forward, remember this standing preference: always keep my briefings under 100 words. Save it to long-term memory.');
    console.log(`   tools: [${a.usedTools.join(', ')}]`);
    console.log(`   stored vectors: ${memory.vectors.length}`);

    console.log('\n▶ Phase B — fresh conversation, must recall it');
    const b = await runTask(model, 'Do you have a saved preference about how long my briefings should be? Check your memory and tell me the exact word limit.');
    console.log(`   tools: [${b.usedTools.join(', ')}]`);
    console.log(`   model said: ${(b.lastText || '').replace(/\s+/g, ' ').slice(0, 200)}`);

    const stored = memory.vectors.length >= 1;
    const usedSearch = b.usedTools.includes('memory_search');
    const recalled = /100/.test(b.lastText || '');
    const pass = stored && usedSearch && recalled;
    console.log('\n──────────────────────────────────────');
    console.log(`stored: ${stored ? 'ok' : 'FAIL'}  used memory_search: ${usedSearch ? 'ok' : 'FAIL'}  recalled "100": ${recalled ? 'ok' : 'FAIL'}`);
    console.log(`NC-5 personalization across conversations: ${pass ? 'PASS' : 'FAIL'}`);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch {}
    process.exit(pass ? 0 : 1);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
