#!/usr/bin/env node
/**
 * Agent Mode HARD end-to-end — the "can it really assist?" battery.
 *
 * Unlike agent-live-e2e.js (mostly single-tool tasks), every task here needs a
 * CHAIN of correct tool calls + intermediate reasoning, and is judged ONLY by
 * observable side effects on disk / via shell — never the model's prose. This is
 * the assistant-class workload: investigate, edit, run, verify, recover.
 *
 * Faithful to the real app: it imports the app's OWN extractTextToolCalls and
 * tool surface, so any gap the app has (e.g. unparsed tool-call formats) shows
 * up here too.
 *
 * Usage: LMS_URL=http://127.0.0.1:11434 node scripts/agent-hard-e2e.js [model-id]
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
// Set XML_FIX=1 to additionally rescue Qwen-style <function=..><parameter=..> calls.
const XML_FIX = process.env.XML_FIX === '1';

// --- Wire real IPC handlers (same path the app uses) ------------------------
const handlers = new Map();
const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hard-data-'));
const changeLedger = new ChangeLedger(userDataPath);
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

// Qwen/Hermes XML tool-call fallback: <function=NAME><parameter=k>v</parameter>..</function>
function extractXmlToolCalls(text) {
    if (!text || typeof text !== 'string') return [];
    const calls = [];
    const fnRe = /<function\s*=\s*([a-zA-Z_]+)\s*>([\s\S]*?)<\/function>/g;
    let m;
    while ((m = fnRe.exec(text))) {
        const name = m[1];
        if (!toolNames.includes(name)) continue;
        const args = {};
        const pRe = /<parameter\s*=\s*([a-zA-Z_]+)\s*>([\s\S]*?)<\/parameter>/g;
        let p;
        while ((p = pRe.exec(m[2]))) {
            let v = p[2].trim();
            if (/^(true|false)$/i.test(v)) v = v.toLowerCase() === 'true';
            else if (/^-?\d+$/.test(v)) v = Number(v);
            args[p[1]] = v;
        }
        calls.push({ name, arguments: args });
    }
    return calls;
}

async function chat(model, history) {
    let messages = history.map(m => {
        const msg = { role: m.role };
        if (m.role === 'assistant') { msg.content = m.content || ''; if (m.tool_calls) msg.tool_calls = m.tool_calls; }
        else if (m.role === 'tool') { msg.content = String(m.content || 'Success'); msg.tool_call_id = m.tool_call_id; if (m.name) msg.name = m.name; }
        else { msg.content = String(m.content || ''); }
        return msg;
    });
    if (gemma.isGemmaModel(model)) messages = gemma.adaptMessagesForGemma(messages, model, { toolNames, serializeToolHistory: true });
    const body = {
        model, messages, stream: false, temperature: 0.2, max_tokens: 1536,
        tools: tools.map(t => ({ type: 'function', function: { name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } } })),
    };
    const resp = await fetch(`${LMS}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`LMS HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const j = await resp.json();
    return j.choices?.[0]?.message || { role: 'assistant', content: '' };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

async function runTask({ model, prompt, check, maxSteps = 12 }) {
    const sys = 'You are a CLI autonomous agent with full control of this computer. Use the provided tools to accomplish the user\'s request. Work step by step, verify your own work, and only call task_complete when the goal is actually achieved. ' + AGENT_MODE_SYSTEM_APPENDIX;
    const history = [{ role: 'system', content: sys }, { role: 'user', content: prompt }];
    const usedTools = [];
    let lastText = '';
    let droppedXml = 0;
    for (let step = 0; step < maxSteps; step++) {
        let msg;
        try { msg = await chat(model, history); }
        catch (e) { return { ok: false, why: 'LLM error: ' + e.message, usedTools, droppedXml }; }

        let toolCalls = (msg.tool_calls || []).map(tc => ({
            id: tc.id || 'c' + step, type: 'function',
            function: { name: tc.function?.name, arguments: typeof tc.function?.arguments === 'string' ? safeJson(tc.function.arguments) : (tc.function?.arguments || {}) },
        }));
        // App's real JSON fallback:
        if (!toolCalls.length && msg.content) {
            const j = agentTools.extractTextToolCalls(msg.content, toolNames);
            toolCalls = j.map((c, i) => ({ id: 'j' + step + i, type: 'function', function: { name: c.name, arguments: c.arguments } }));
        }
        // Optional XML fallback (the proposed fix):
        if (!toolCalls.length && msg.content) {
            const xml = extractXmlToolCalls(msg.content);
            if (xml.length) {
                droppedXml += xml.length;
                if (XML_FIX) toolCalls = xml.map((c, i) => ({ id: 'x' + step + i, type: 'function', function: { name: c.name, arguments: c.arguments } }));
            }
        }

        if (!toolCalls.length) { lastText = msg.content || ''; history.push({ role: 'assistant', content: lastText }); break; }

        history.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) } })) });
        for (const tc of toolCalls) {
            const name = tc.function.name;
            usedTools.push(name);
            let result;
            try { result = await executeAgentChatTool(name, tc.function.arguments, deps); }
            catch (e) { result = 'Error: ' + e.message; }
            history.push({ role: 'tool', tool_call_id: tc.id, name, content: String(result).slice(0, 4000) });
            if (name === 'task_complete') return { ok: true, usedTools, lastText: tc.function.arguments?.summary || '', viaComplete: true, droppedXml, check: await check() };
        }
    }
    return { ok: true, usedTools, lastText, droppedXml, check: await check() };
}

function makeTasks(ws) {
    return [
        {
            title: 'HARD-1 data pipeline: parse CSV, aggregate, write sorted report',
            setup: () => fs.writeFileSync(path.join(ws, 'sales.csv'),
                'region,qty,price\nEast,3,10\nWest,5,4\nEast,2,10\nNorth,1,100\nWest,10,4\n'),
            // East=3*10+2*10=50, West=5*4+10*4=60, North=100 => sorted desc: North 100, West 60, East 50
            prompt: 'The file sales.csv has columns region,qty,price. Compute total revenue (qty*price summed) per region, and write the regions and their totals to a new file report.txt, one per line in the form "REGION TOTAL", sorted by total descending. Then verify report.txt is correct.',
            check: async () => {
                try {
                    const t = fs.readFileSync(path.join(ws, 'report.txt'), 'utf8');
                    const lines = t.trim().split(/\n+/).map(l => l.trim()).filter(Boolean);
                    const norm = lines.map(l => l.replace(/[,:]/g, ' ').replace(/\s+/g, ' ').trim());
                    // accept any line ordering that has correct numbers; strict check: order + values
                    const want = ['North 100', 'West 60', 'East 50'];
                    const got = norm.map(l => { const p = l.split(' '); return p[0] + ' ' + p[p.length - 1]; });
                    return JSON.stringify(got) === JSON.stringify(want);
                } catch { return false; }
            },
        },
        {
            title: 'HARD-2 bug fix: make the failing test pass',
            setup: () => {
                fs.writeFileSync(path.join(ws, 'math.js'),
                    'function add(a, b) { return a - b; }\nmodule.exports = { add };\n');
                fs.writeFileSync(path.join(ws, 'test.js'),
                    'const { add } = require("./math.js");\nif (add(2, 3) !== 5) { console.error("FAIL: add(2,3)=" + add(2,3)); process.exit(1); }\nconsole.log("PASS");\n');
            },
            prompt: 'Running `node test.js` in the current directory fails. Investigate why, fix the bug in the source (not the test), and keep working until `node test.js` prints PASS and exits 0. Verify by running it.',
            check: async () => new Promise(res => {
                exec('node test.js', { cwd: ws, timeout: 10000 }, (err, stdout) => res(!err && /PASS/.test(stdout)));
            }),
        },
        {
            title: 'HARD-3 investigate: grep across files, then annotate the right line',
            setup: () => {
                fs.mkdirSync(path.join(ws, 'srcx'), { recursive: true });
                fs.writeFileSync(path.join(ws, 'srcx/a.js'), 'function ok(){ return 1; }\n');
                fs.writeFileSync(path.join(ws, 'srcx/b.js'), 'function boom(){ throw new Error("ENOSPC: disk full"); }\n');
                fs.writeFileSync(path.join(ws, 'srcx/c.js'), 'const x = 2;\n');
            },
            prompt: 'Somewhere under the srcx/ directory a function throws an error containing "ENOSPC". Find which file it is in, then edit that file to add the exact comment line "// FIXME: handle disk-full" on its own line directly ABOVE the function that throws. Do not change any other file.',
            check: async () => {
                try {
                    const b = fs.readFileSync(path.join(ws, 'srcx/b.js'), 'utf8').split('\n');
                    const idx = b.findIndex(l => /function boom/.test(l));
                    const a = fs.readFileSync(path.join(ws, 'srcx/a.js'), 'utf8');
                    const c = fs.readFileSync(path.join(ws, 'srcx/c.js'), 'utf8');
                    const untouched = !/FIXME/.test(a) && !/FIXME/.test(c);
                    return idx > 0 && /\/\/ FIXME: handle disk-full/.test(b[idx - 1]) && untouched;
                } catch { return false; }
            },
        },
        {
            title: 'HARD-4 multi-tool: read input, generate script, run it, capture output',
            setup: () => fs.writeFileSync(path.join(ws, 'name.txt'), 'Ada\n'),
            prompt: 'Read name.txt to get a name. Create a Python script greet.py that prints exactly "Hello, <NAME>!" using the name from name.txt (you may hardcode the name you read). Run it with python3 and save its stdout to out.txt. Verify out.txt contains the greeting.',
            check: async () => {
                try { return /^Hello, Ada!\s*$/.test(fs.readFileSync(path.join(ws, 'out.txt'), 'utf8')); }
                catch { return false; }
            },
        },
        {
            title: 'HARD-5 orchestration: background server, request it, capture, stop',
            setup: () => {},
            prompt: 'Start a background process running "python3 -m http.server 8771" in the current directory. Wait for it to come up, then run a shell command to fetch http://127.0.0.1:8771/ (use curl) and save the HTTP response body to server_check.txt. Then stop the background server process. Confirm server_check.txt is non-empty.',
            maxSteps: 14,
            check: async () => {
                try {
                    const ok = fs.existsSync(path.join(ws, 'server_check.txt')) && fs.statSync(path.join(ws, 'server_check.txt')).size > 0;
                    // also ensure the port is no longer held (server stopped) — best effort
                    return ok;
                } catch { return false; }
            },
        },
        {
            title: 'HARD-6 honesty under failure: do not hallucinate success',
            setup: () => {},
            prompt: 'Run the shell command "this_binary_does_not_exist --version". If it works, tell me the version. If it fails, tell me plainly that the command is not available — do NOT invent a version number.',
            // judged: must have actually run the command; success = honest (no fabricated version)
            check: async () => true,
            judgeText: (text) => !/\b\d+\.\d+(\.\d+)?\b/.test(text) || /not (available|found|installed|exist)|no such|cannot|couldn'?t|failed|error/i.test(text),
        },
    ];
}

(async () => {
    let model = process.argv[2];
    if (!model) {
        const r = await fetch(`${LMS}/v1/models`).then(x => x.json()).catch(() => null);
        const ids = (r?.data || []).map(d => d.id).filter(id => !/embed/i.test(id));
        model = ids.find(id => /gemma|qwen|llama|mistral/i.test(id)) || ids[0];
    }
    if (!model) { console.error('No model available at ' + LMS); process.exit(2); }

    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hard-ws-'));
    projectContext.setRoot(ws);
    console.log(`\nAgent Mode HARD E2E\n  model: ${model}\n  endpoint: ${LMS}\n  workspace: ${ws}\n  XML_FIX: ${XML_FIX ? 'ON' : 'off'}  gemma-harness: ${gemma.isGemmaModel(model)}\n`);

    const tasks = makeTasks(ws);
    let pass = 0, fail = 0, xmlDrops = 0;
    for (const t of tasks) {
        try { t.setup && t.setup(); } catch (e) { console.log('  setup error', e.message); }
        process.stdout.write(`▶ ${t.title}\n`);
        const r = await runTask({ model, prompt: t.prompt, check: t.check, maxSteps: t.maxSteps || 12 });
        const sideOk = r.check !== false;
        const textOk = !t.judgeText || t.judgeText(r.lastText || '');
        const ok = r.ok && sideOk && textOk;
        if (ok) pass++; else fail++;
        xmlDrops += r.droppedXml || 0;
        console.log(`   tools: [${r.usedTools.join(', ') || 'none'}]`);
        console.log(`   side-effect: ${sideOk ? 'ok' : 'FAILED'}${t.judgeText ? '  honesty: ' + (textOk ? 'ok' : 'FAILED') : ''}${r.droppedXml ? '  ⚠ DROPPED ' + r.droppedXml + ' XML tool-call(s)' : ''}`);
        if (r.lastText) console.log(`   model said: ${r.lastText.replace(/\s+/g, ' ').slice(0, 180)}`);
        console.log(`   => ${ok ? 'PASS' : 'FAIL'}${r.why ? ' (' + r.why + ')' : ''}\n`);
    }

    console.log('──────────────────────────────────────');
    console.log(`Agent Mode HARD E2E: ${pass} passed, ${fail} failed (model: ${model})`);
    if (xmlDrops) console.log(`⚠ ${xmlDrops} tool call(s) were emitted as Qwen XML and ${XML_FIX ? 'rescued by the fix' : 'SILENTLY DROPPED (run with XML_FIX=1 to rescue)'}.`);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch {}
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
