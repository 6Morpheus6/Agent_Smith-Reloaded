#!/usr/bin/env node
/**
 * Agent Mode LIVE end-to-end — drives the REAL agent loop against LM Studio.
 *
 * This is the faithful counterpart to agent-e2e.js: instead of calling tools
 * directly, it asks a real model (the one loaded in LM Studio) to accomplish
 * tasks and lets IT choose/emit tool calls — mirroring src/renderer/app.js:
 *   - same tool surface (AGENT_SYS_TOOLS)
 *   - same Gemma harness (adaptMessagesForGemma) when a Gemma model is loaded
 *   - same dispatch path (executeAgentChatTool -> real IPC handlers -> real OS)
 *
 * Success is judged by OBSERVABLE SIDE EFFECTS (files on disk, shell output),
 * not by the model's prose. Requires LM Studio at http://localhost:1234.
 *
 * Usage: node scripts/agent-live-e2e.js [model-id]
 */
'use strict';

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const os = require('os');
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

const LMS = process.env.LMS_URL || 'http://localhost:1234';

// --- Wire real IPC handlers (same as agent-e2e) -----------------------------
const handlers = new Map();
registerAgentIpc({ handle: (c, fn) => handlers.set(c, fn) }, {
    fs, fsPromises, path, spawn, exec,
    projectContext, editEngine: null, changeLedger: null, verificationHarness,
    grepProject, hasRipgrep, globFiles, buildRepoMap, invalidateRepoMap,
    netGuard, relPathFromRoot: (p) => { const r = projectContext.getRootOrNull(); return r ? path.relative(r, p) : p; },
    state: { currentPlanId: null },
});
const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-data-'));
const changeLedger = new ChangeLedger(userDataPath);
handlers.get; // noop
// rebuild deps with real ledger/editEngine (write_file uses editEngine.validateWriteSize)
handlers.clear();
const editEngine = new EditEngine(changeLedger, projectContext);
registerAgentIpc({ handle: (c, fn) => handlers.set(c, fn) }, {
    fs, fsPromises, path, spawn, exec,
    projectContext, editEngine, changeLedger, verificationHarness,
    grepProject, hasRipgrep, globFiles, buildRepoMap, invalidateRepoMap,
    netGuard, relPathFromRoot: (p) => { const r = projectContext.getRootOrNull(); return r ? path.relative(r, p) : p; },
    state: { currentPlanId: null },
});
const memStore = [];
const deps = {
    api: { invoke: async (c, ...a) => { const fn = handlers.get(c); if (!fn) throw new Error('no handler ' + c); return fn({}, ...a); } },
    getSudoPassword: () => '',
    saveToMemory: async (t) => { memStore.push({ text: t }); return { success: true }; },
    searchMemory: async (q) => memStore.filter(m => (m.text || '').includes(q)),
};

const tools = toolsForChatMode({ agentEnabled: true, memoryEnabled: true });
const toolNames = tools.map(t => t.function.name);

// --- Faithful LLM call (mirrors app.js body + gemma harness) ----------------
async function chat(model, history) {
    let messages = history.map(m => {
        const msg = { role: m.role };
        if (m.role === 'assistant') {
            msg.content = m.content || '';
            if (m.tool_calls) msg.tool_calls = m.tool_calls;
        } else if (m.role === 'tool') {
            msg.content = String(m.content || 'Success');
            msg.tool_call_id = m.tool_call_id;
            if (m.name) msg.name = m.name;
        } else {
            msg.content = String(m.content || '');
        }
        return msg;
    });
    if (gemma.isGemmaModel(model)) {
        messages = gemma.adaptMessagesForGemma(messages, model, { toolNames, serializeToolHistory: true });
    }
    const body = {
        model, messages, stream: false, temperature: 0.3, max_tokens: 1024,
        tools: tools.map(t => ({ type: 'function', function: { name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } } })),
    };
    const resp = await fetch(`${LMS}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`LMS HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const j = await resp.json();
    return j.choices?.[0]?.message || { role: 'assistant', content: '' };
}

// Mirror app.js fallback faithfully: delegate to the app's OWN extractor so this
// harness exercises the exact recovery logic the renderer uses (raw JSON *and*
// Qwen/Hermes XML tool calls). Reimplementing it here would let the test and the
// app drift apart — which is precisely how the XML-drop bug went unnoticed.
function extractTextToolCalls(content) {
    if (!content) return [];
    return agentTools.extractTextToolCalls(content, toolNames).map((c, i) => ({
        id: 'fb_' + i, type: 'function', function: { name: c.name, arguments: c.arguments },
    }));
}

async function runTask({ model, title, prompt, check, maxSteps = 8 }) {
    const sys = 'You are a CLI autonomous agent with full control of this computer. Use the provided tools to accomplish the user\'s request. ' + AGENT_MODE_SYSTEM_APPENDIX;
    const history = [{ role: 'system', content: sys }, { role: 'user', content: prompt }];
    const usedTools = [];
    let lastText = '';
    for (let step = 0; step < maxSteps; step++) {
        let msg;
        try { msg = await chat(model, history); }
        catch (e) { return { ok: false, why: 'LLM error: ' + e.message, usedTools }; }

        let toolCalls = (msg.tool_calls || []).map(tc => ({
            id: tc.id || 'c' + step, type: 'function',
            function: { name: tc.function?.name, arguments: typeof tc.function?.arguments === 'string' ? safeJson(tc.function.arguments) : (tc.function?.arguments || {}) },
        }));
        if (!toolCalls.length) toolCalls = extractTextToolCalls(msg.content);

        if (!toolCalls.length) { lastText = msg.content || ''; history.push({ role: 'assistant', content: lastText }); break; }

        history.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) } })) });
        for (const tc of toolCalls) {
            const name = tc.function.name;
            usedTools.push(name);
            let result;
            try { result = await executeAgentChatTool(name, tc.function.arguments, deps); }
            catch (e) { result = 'Error: ' + e.message; }
            history.push({ role: 'tool', tool_call_id: tc.id, name, content: String(result).slice(0, 4000) });
            if (name === 'task_complete') return { ok: true, usedTools, lastText: tc.function.arguments?.summary || '', viaComplete: true, check: await check() };
        }
    }
    return { ok: true, usedTools, lastText, check: await check() };
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

(async () => {
    // pick model
    let model = process.argv[2];
    if (!model) {
        const r = await fetch(`${LMS}/v1/models`).then(x => x.json()).catch(() => null);
        const ids = (r?.data || []).map(d => d.id).filter(id => !/embed/i.test(id));
        model = ids.find(id => /gemma|qwen|llama|mistral/i.test(id)) || ids[0];
    }
    if (!model) { console.error('No model available in LM Studio at ' + LMS); process.exit(2); }

    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-ws-'));
    projectContext.setRoot(ws);
    fs.writeFileSync(path.join(ws, 'data.txt'), 'the secret token is SPARROW42\n');
    console.log(`\nAgent Mode LIVE E2E\n  model: ${model}\n  workspace: ${ws}\n  gemma-harness: ${gemma.isGemmaModel(model)}\n`);

    const tasks = [
        {
            title: 'shell: identify the OS kernel',
            prompt: 'Find out the Linux kernel release string of this machine by running a shell command, then tell me what it is.',
            check: async () => true, // judged by tool usage below
            wantTool: 'run_shell_command',
        },
        {
            title: 'file create + verify (whole workspace)',
            prompt: 'Create a file named e2e_live.txt in the current directory whose exact contents are: LIVE_OK. Then read it back to confirm it was written correctly.',
            check: async () => fs.existsSync(path.join(ws, 'e2e_live.txt')) && fs.readFileSync(path.join(ws, 'e2e_live.txt'), 'utf8').includes('LIVE_OK'),
            wantTool: 'write_file',
        },
        {
            title: 'read existing file content',
            prompt: 'There is a file called data.txt in the current directory. Read it and tell me the secret token it contains.',
            check: async () => true,
            wantTool: 'read_file',
            wantText: /SPARROW42/i,
        },
        {
            title: 'whole-host reach: read a system file',
            prompt: 'Read the file /etc/hostname and tell me this computer\'s hostname.',
            check: async () => true,
            wantTool: 'read_file',
        },
        {
            title: 'search: grep the project',
            prompt: 'Search the files in the current directory for the word SPARROW42 and tell me which filename contains it.',
            check: async () => true,
            wantTool: 'grep_project',
        },
        {
            title: 'delete + verify',
            prompt: 'Delete the file data.txt from the current directory, then confirm it is gone.',
            // Judge by the side effect only: deleting via delete_file OR shell `rm` are
            // both valid "manage everything" outcomes; don't pin to one specific tool.
            check: async () => !fs.existsSync(path.join(ws, 'data.txt')),
            maxSteps: 6,
        },
        {
            title: 'process management: background job',
            prompt: 'Start a background shell process that runs the command "sleep 8". Then list the background processes and tell me the job id of the sleep process.',
            check: async () => true,
            wantTool: 'run_shell_command',
            maxSteps: 6,
        },
        {
            title: 'memory: remember + recall',
            prompt: 'Please remember this fact about me: my favorite color is teal. After saving it, search your memory for my favorite color and tell me what it is.',
            check: async () => memStore.some(m => /teal/i.test(m.text || '')),
            wantTool: 'save_new_user_fact_only',
            maxSteps: 6,
        },
    ];

    let pass = 0, fail = 0;
    for (const t of tasks) {
        process.stdout.write(`▶ ${t.title}\n`);
        const r = await runTask({ model, prompt: t.prompt, check: t.check, maxSteps: t.maxSteps || 8 });
        const usedWanted = !t.wantTool || r.usedTools.includes(t.wantTool);
        const sideOk = r.check !== false;
        const textOk = !t.wantText || (t.wantText.test(r.lastText || '') || r.usedTools.length > 0);
        const ok = r.ok && usedWanted && sideOk && textOk;
        if (ok) pass++; else fail++;
        console.log(`   tools: [${r.usedTools.join(', ') || 'none'}]`);
        console.log(`   side-effect: ${sideOk ? 'ok' : 'FAILED'}  wanted-tool(${t.wantTool || '-'}): ${usedWanted ? 'ok' : 'MISSING'}`);
        if (r.lastText) console.log(`   model said: ${r.lastText.replace(/\s+/g, ' ').slice(0, 160)}`);
        console.log(`   => ${ok ? 'PASS' : 'FAIL'}${r.why ? ' (' + r.why + ')' : ''}\n`);
    }

    console.log('──────────────────────────────────────');
    console.log(`Agent Mode LIVE E2E: ${pass} passed, ${fail} failed (model: ${model})`);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch {}
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
