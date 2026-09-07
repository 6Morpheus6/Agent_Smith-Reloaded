#!/usr/bin/env node
/**
 * Agent Mode — personal-assistant capability parity battery.
 *
 * Benchmarks Agent Mode against the headline jobs of a full personal-assistant
 * harness (a hosted agent reachable over chat channels), namely:
 *   1. scheduled/recurring autonomous tasks that message you back
 *   2. web research -> briefing  ("compile HN/TechCrunch news and message me")
 *   3. working over a mounted folder (Obsidian-vault overview)
 *   4. git-aware repo maintenance ("review git history for drift, update README")
 *   5. personalization / memory across conversations
 *
 * Agent Smith's Agent Mode doesn't own the delivery/channel/scheduler wrapper,
 * but it should be able to do the SUBSTANTIVE WORK of each. This battery strips
 * the messaging wrapper and tests the work — judged purely by side effects.
 *
 * Faithful to the app: real agent IPC + the real perform-search (main.js) +
 * the app's own extractTextToolCalls (JSON + Qwen XML).
 *
 * Usage: LMS_URL=http://127.0.0.1:11434 node scripts/agent-assistant-parity-e2e.js [model-id]
 */
'use strict';

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, exec, execSync } = require('child_process');

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

// --- Wire real IPC handlers -------------------------------------------------
const handlers = new Map();
const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-nc-data-'));
const changeLedger = new ChangeLedger(userDataPath);
const editEngine = new EditEngine(changeLedger, projectContext);
registerAgentIpc({ handle: (c, fn) => handlers.set(c, fn) }, {
    fs, fsPromises, path, spawn, exec,
    projectContext, editEngine, changeLedger, verificationHarness,
    grepProject, hasRipgrep, globFiles, buildRepoMap, invalidateRepoMap,
    netGuard, relPathFromRoot: (p) => { const r = projectContext.getRootOrNull(); return r ? path.relative(r, p) : p; },
    state: { currentPlanId: null },
});

// Faithful copy of main.js 'perform-search' (DuckDuckGo HTML scrape) so web_search
// behaves exactly as in the app. NOTE: html.duckduckgo.com currently returns an
// anti-bot "anomaly" page from many IPs -> real app web_search returns no results
// too; tasks that need the web should fall back to fetch_url, as a good agent would.
handlers.set('perform-search', async (_e, query) => {
    try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 15000);
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.5', 'Referer': 'https://html.duckduckgo.com/' }, signal: controller.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error('Search failed: ' + r.statusText);
        const html = await r.text();
        const results = [];
        const bodies = html.split('result__body');
        const clean = (s) => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        for (let i = 1; i < bodies.length && results.length < 6; i++) {
            const b = bodies[i];
            const lm = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
            const sm = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
            if (!lm) continue;
            let u = lm[1];
            if (u.startsWith('//duckduckgo.com/l/?uddg=')) { try { const o = new URL('https:' + u); const g = o.searchParams.get('uddg'); if (g) u = decodeURIComponent(g); } catch {} }
            const title = clean(lm[2]); const snippet = sm ? clean(sm[1]) : '';
            if (u && title) results.push({ url: u, title, snippet });
        }
        return results;
    } catch (e) { return { error: e.message }; }
});

const memStore = [];
const deps = {
    api: { invoke: async (c, ...a) => { const fn = handlers.get(c); if (!fn) throw new Error('no handler ' + c); return fn({}, ...a); } },
    getSudoPassword: () => '',
    saveToMemory: async (t) => { memStore.push({ text: t }); return { success: true }; },
    searchMemory: async (q) => memStore.filter(m => (m.text || '').toLowerCase().includes(String(q).toLowerCase())),
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

async function runTask({ model, prompt, check, maxSteps = 14, history }) {
    const sys = 'You are a CLI autonomous personal-assistant agent with full control of this computer and read-only web access. Use the tools to actually DO the task end to end, verify your own work, and only call task_complete when the goal is truly achieved. ' + AGENT_MODE_SYSTEM_APPENDIX;
    history = history || [{ role: 'system', content: sys }, { role: 'user', content: prompt }];
    const usedTools = [];
    let lastText = '';
    for (let step = 0; step < maxSteps; step++) {
        let msg;
        try { msg = await chat(model, history); }
        catch (e) { return { ok: false, why: 'LLM error: ' + e.message, usedTools, history }; }

        let toolCalls = (msg.tool_calls || []).map(tc => ({
            id: tc.id || 'c' + step, type: 'function',
            function: { name: tc.function?.name, arguments: typeof tc.function?.arguments === 'string' ? safeJson(tc.function.arguments) : (tc.function?.arguments || {}) },
        }));
        if (!toolCalls.length && msg.content) {
            toolCalls = agentTools.extractTextToolCalls(msg.content, toolNames)
                .map((c, i) => ({ id: 't' + step + i, type: 'function', function: { name: c.name, arguments: c.arguments } }));
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
            if (name === 'task_complete') return { ok: true, usedTools, lastText: tc.function.arguments?.summary || '', viaComplete: true, history, check: await check({ usedTools }) };
        }
    }
    return { ok: true, usedTools, lastText, history, check: await check({ usedTools }) };
}

function sh(cmd, cwd) { execSync(cmd, { cwd, stdio: 'ignore' }); }

function makeTasks(ws) {
    return [
        {
            title: 'NC-1 git-aware maintenance: detect doc drift, update README',
            setup: () => {
                const d = path.join(ws, 'repo'); fs.mkdirSync(d, { recursive: true });
                fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'widget', version: '1.0.0' }, null, 2) + '\n');
                fs.writeFileSync(path.join(d, 'README.md'), '# Widget\n\nCurrent version: 1.0.0\n\nA small widget.\n');
                sh('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -q -m "init 1.0.0"', d);
                // a later commit bumps package.json but NOT the README -> drift
                fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'widget', version: '2.3.0' }, null, 2) + '\n');
                sh('git add -A && git -c user.email=t@t -c user.name=t commit -q -m "release 2.3.0"', d);
            },
            prompt: 'Inside the repo/ subdirectory there is a git project. Review the git history and the current files to find where the README has drifted out of sync with the actual version in package.json. Then update repo/README.md so the version it states matches package.json. Verify the README is now correct.',
            check: async () => {
                try {
                    const r = fs.readFileSync(path.join(ws, 'repo/README.md'), 'utf8');
                    return /2\.3\.0/.test(r) && !/1\.0\.0/.test(r);
                } catch { return false; }
            },
        },
        {
            title: 'NC-2 mounted-folder digest: summarize a notes vault',
            setup: () => {
                const d = path.join(ws, 'vault'); fs.mkdirSync(d, { recursive: true });
                fs.writeFileSync(path.join(d, 'project.md'), '# Project Zephyr\nDeadline is March 14. Lead is Dana.\n');
                fs.writeFileSync(path.join(d, 'budget.md'), '# Budget\nApproved budget is 50000 USD for Q2.\n');
                fs.writeFileSync(path.join(d, 'risks.md'), '# Risks\nMain risk: the Helsinki vendor may slip delivery.\n');
            },
            prompt: 'The vault/ directory contains my notes as markdown files. Read ALL of them and write a single overview file vault/OVERVIEW.md that captures the key facts from every note: the project name and deadline, the budget amount, and the main risk. Make sure each of those facts appears in the overview.',
            check: async () => {
                try {
                    const o = fs.readFileSync(path.join(ws, 'vault/OVERVIEW.md'), 'utf8');
                    return /Zephyr/i.test(o) && /March 14|March/i.test(o) && /50000|50,000/.test(o) && /Helsinki/i.test(o);
                } catch { return false; }
            },
        },
        {
            title: 'NC-3 web research briefing: top Hacker News stories',
            setup: () => {},
            prompt: 'Research the current top stories on Hacker News (news.ycombinator.com). Use your web tools to read the live front page or its public API, then write a file hn_briefing.md containing the titles of the top 3 stories right now, one per line as a markdown list. These must be REAL current titles you fetched, not placeholders.',
            maxSteps: 16,
            check: async ({ usedTools }) => {
                try {
                    const usedWeb = usedTools.includes('fetch_url') || usedTools.includes('web_search');
                    const b = fs.readFileSync(path.join(ws, 'hn_briefing.md'), 'utf8');
                    const lines = b.split('\n').map(l => l.replace(/^[-*\d.\s]+/, '').trim()).filter(l => l.length > 8);
                    // each "title" line should look like prose, not a placeholder
                    const realish = lines.filter(l => !/placeholder|example|story \d|title \d|lorem/i.test(l));
                    return usedWeb && realish.length >= 3;
                } catch { return false; }
            },
        },
        {
            title: 'NC-4 recurring/scheduled job (no native scheduler): improvise via background',
            setup: () => {},
            prompt: 'I want a recurring heartbeat. Start a background process that appends the current date/time to a file heartbeat.log once every 2 seconds (e.g. a shell loop). Let it run for about 8 seconds, then read heartbeat.log and confirm it has accumulated at least 3 timestamped lines. Finally stop the background process.',
            maxSteps: 14,
            check: async () => {
                try {
                    const lines = fs.readFileSync(path.join(ws, 'heartbeat.log'), 'utf8').trim().split(/\n+/).filter(Boolean);
                    return lines.length >= 3;
                } catch { return false; }
            },
        },
        {
            title: 'NC-5a personalization: store a standing preference to memory',
            setup: () => {},
            prompt: 'Going forward, remember this standing preference about how I like things: always keep my briefings under 100 words. Save that to your long-term memory so you can honor it in future conversations.',
            check: async () => memStore.some(m => /100 words|under 100|brief/i.test(m.text || '')),
        },
        {
            title: 'NC-5b personalization recall (fresh conversation): honor the stored preference',
            setup: () => {},
            // fresh history (no mention of the preference) — must recall from memory
            prompt: 'Do you have any standing preferences saved about how long my briefings should be? Search your memory and tell me the word limit I asked for.',
            check: async ({ usedTools }) => usedTools.includes('memory_search'),
            judgeText: (t) => /100/.test(t || ''),
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

    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-nc-ws-'));
    projectContext.setRoot(ws);
    console.log(`\nAgent Mode — assistant parity battery\n  model: ${model}\n  endpoint: ${LMS}\n  workspace: ${ws}\n`);

    const tasks = makeTasks(ws);
    let pass = 0, fail = 0;
    for (const t of tasks) {
        try { t.setup && t.setup(); } catch (e) { console.log('  setup error', e.message); }
        process.stdout.write(`▶ ${t.title}\n`);
        const r = await runTask({ model, prompt: t.prompt, check: t.check, maxSteps: t.maxSteps || 14 });
        const sideOk = r.check !== false;
        const textOk = !t.judgeText || t.judgeText(r.lastText || '');
        const ok = r.ok && sideOk && textOk;
        if (ok) pass++; else fail++;
        console.log(`   tools: [${r.usedTools.join(', ') || 'none'}]`);
        console.log(`   side-effect: ${sideOk ? 'ok' : 'FAILED'}${t.judgeText ? '  recall-text: ' + (textOk ? 'ok' : 'FAILED') : ''}`);
        if (r.lastText) console.log(`   model said: ${r.lastText.replace(/\s+/g, ' ').slice(0, 200)}`);
        console.log(`   => ${ok ? 'PASS' : 'FAIL'}${r.why ? ' (' + r.why + ')' : ''}\n`);
    }

    console.log('──────────────────────────────────────');
    console.log(`Agent Mode assistant parity: ${pass} passed, ${fail} failed (model: ${model})`);
    console.log('Note: a full assistant harness also owns scheduling + chat-channel delivery (out of Agent Mode scope);');
    console.log('this battery tests the SUBSTANTIVE WORK behind each assistant use case.');
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch {}
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
