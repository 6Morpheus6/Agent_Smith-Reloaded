#!/usr/bin/env node
/**
 * Agent Mode — Top-100 Personal-Assistant Task Battery (E2E).
 *
 * "Agent Mode" = the app's fully-autonomous assistant that controls the computer
 * (shell, whole-host file ops, process management, web read, long-term memory,
 * action-log undo). This battery is the broadest faithful E2E: 100 real-world
 * assistant tasks across 10 categories, each judged by deterministic SIDE EFFECTS
 * (files on disk, memory store, action log) — not by what the model claims.
 *
 * Faithful to the shipping app:
 *   - real agent tool surface + executor (src/renderer/modes/agentTools.js)
 *   - real main-process IPC handlers (src/main/ipc/agent.js, .../actions.js)
 *   - real action log (src/main/services/actionLog.js) for undo/review tasks
 *   - real semantic memory (src/main/services/memory.js, all-minilm via Ollama),
 *     isolated to a throwaway vector DB so the user's real memory is untouched
 *   - the app's own gemma harness + extractTextToolCalls (JSON + Qwen XML)
 *
 * Usage:
 *   LMS_URL=http://127.0.0.1:1234 node scripts/agent-assistant-100-e2e.js [model-id]
 * Env:
 *   CATS=A,B,G     only run these categories
 *   SMOKE=1        run just the first task of each selected category (sanity)
 *   ONLY=A1,C3     run only these task ids
 *   MAXSTEPS=12    override default per-task step cap
 *   OUT=path.json  write machine-readable results here
 */
'use strict';

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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
const registerActionsIpc = require(path.join(ROOT, 'src/main/ipc/actions.js'));
const { createActionLog } = require(path.join(ROOT, 'src/main/services/actionLog.js'));
const memory = require(path.join(ROOT, 'src/main/services/memory.js'));
const gemma = require(path.join(ROOT, 'src/code/context/gemmaHarness.js'));
const agentTools = require(path.join(ROOT, 'src/renderer/modes/agentTools.js'));
const { executeAgentChatTool, toolsForChatMode, AGENT_MODE_SYSTEM_APPENDIX } = agentTools;

const LMS = process.env.LMS_URL || 'http://127.0.0.1:1234';

// --- Wire real IPC handlers -------------------------------------------------
const handlers = new Map();
const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent100-data-'));
const changeLedger = new ChangeLedger(userDataPath);
const editEngine = new EditEngine(changeLedger, projectContext);
const actionLog = createActionLog(userDataPath);
const ipcShim = { handle: (c, fn) => handlers.set(c, fn) };
registerAgentIpc(ipcShim, {
    fs, fsPromises, path, spawn, exec,
    projectContext, editEngine, changeLedger, verificationHarness,
    grepProject, hasRipgrep, globFiles, buildRepoMap, invalidateRepoMap,
    netGuard, relPathFromRoot: (p) => { const r = projectContext.getRootOrNull(); return r ? path.relative(r, p) : p; },
    state: { currentPlanId: null }, actionLog,
});
registerActionsIpc(ipcShim, { actionLog });

// Faithful copy of main.js 'perform-search' (DuckDuckGo HTML scrape).
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

// --- Real semantic memory, isolated to a throwaway vector DB ----------------
memory.vectorDBPath = path.join(userDataPath, 'vectors_test.json');
memory.vectors = [];
const deps = {
    api: { invoke: async (c, ...a) => { const fn = handlers.get(c); if (!fn) throw new Error('no handler ' + c); return fn({}, ...a); } },
    getSudoPassword: () => '',
    saveToMemory: async (t) => memory.storeVector(t, { source: 'agent100' }),
    searchMemory: async (q) => { const r = await memory.queryVectors(q, 5); return (r && r.data) || []; },
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
        model, messages, stream: false, temperature: 0.2, max_tokens: 2048,
        tools: tools.map(t => ({ type: 'function', function: { name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } } })),
    };
    const resp = await fetch(`${LMS}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`LMS HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const j = await resp.json();
    return j.choices?.[0]?.message || { role: 'assistant', content: '' };
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

async function runTask({ model, prompt, check, maxSteps, history }) {
    const sys = 'You are a CLI autonomous personal-assistant agent with full control of this computer and read-only web access. Use the tools to actually DO the task end to end, verify your own work, and only call task_complete when the goal is truly achieved. Work in the current working directory unless told otherwise. ' + AGENT_MODE_SYSTEM_APPENDIX;
    history = history || [{ role: 'system', content: sys }, { role: 'user', content: prompt }];
    const usedTools = [];
    let lastText = '';
    for (let step = 0; step < maxSteps; step++) {
        let msg;
        try { msg = await chat(model, history); }
        catch (e) { return { ok: false, why: 'LLM error: ' + e.message, usedTools, history, steps: step }; }

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
            if (name === 'task_complete') {
                const c = await check({ usedTools, lastText: tc.function.arguments?.summary || '' });
                return { ok: true, usedTools, lastText: tc.function.arguments?.summary || '', viaComplete: true, history, check: c, steps: step + 1 };
            }
        }
    }
    return { ok: true, usedTools, lastText, history, check: await check({ usedTools, lastText }), steps: maxSteps };
}

// --- Small helpers for setups/checks ---------------------------------------
let WS = null;
const W = (rel) => path.join(WS, rel);
const put = (rel, content) => { fs.mkdirSync(path.dirname(W(rel)), { recursive: true }); fs.writeFileSync(W(rel), content); };
const mkdir = (rel) => fs.mkdirSync(W(rel), { recursive: true });
const read = (rel) => { try { return fs.readFileSync(W(rel), 'utf8'); } catch { return null; } };
const exists = (rel) => fs.existsSync(W(rel));
const lsAll = (rel) => { try { return fs.readdirSync(W(rel)); } catch { return []; } };
// read the first existing file matching any of the rels, or scan ws for one whose
// content satisfies pred — tolerant of the agent choosing its own filename.
const findFile = (rels, pred) => {
    for (const r of rels) { const c = read(r); if (c != null && (!pred || pred(c))) return c; }
    if (pred) { for (const f of walk(WS)) { try { const c = fs.readFileSync(f, 'utf8'); if (pred(c)) return c; } catch {} } }
    return null;
};
function* walk(dir) { let e = []; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const d of e) { const p = path.join(dir, d.name); if (d.isDirectory()) yield* walk(p); else yield p; } }
const anyFileMatches = (re) => { for (const f of walk(WS)) { try { if (re.test(fs.readFileSync(f, 'utf8'))) return true; } catch {} } return false; };

// =====================================================================
//  THE 100 TASKS
// =====================================================================
function makeTasks() {
    const T = [];
    const add = (id, cat, title, def) => T.push(Object.assign({ id, cat, title }, def));

    // ---- A. Files & document management (12) ----
    add('A1', 'A', 'Organize files by extension into subfolders', {
        setup: () => { mkdir('A1'); put('A1/a.txt', 'x'); put('A1/b.txt', 'y'); put('A1/c.jpg', 'z'); put('A1/d.csv', '1,2'); },
        prompt: 'In the A1/ directory, organize the loose files into subfolders by file extension (e.g. a txt/ folder for .txt files, jpg/ for .jpg, csv/ for .csv). Move each file into the folder for its type.',
        check: () => exists('A1/txt/a.txt') && exists('A1/txt/b.txt') && exists('A1/jpg/c.jpg') && exists('A1/csv/d.csv'),
    });
    add('A2', 'A', 'Find the largest file', {
        setup: () => { mkdir('A2'); put('A2/small.txt', 'hi'); put('A2/big.txt', 'B'.repeat(5000)); put('A2/mid.txt', 'M'.repeat(500)); },
        prompt: 'Find which file in the A2/ directory is the largest by byte size, and write just its filename into A2/answer.txt.',
        check: () => /big\.txt/.test(read('A2/answer.txt') || ''),
    });
    add('A3', 'A', 'Count files in a tree', {
        setup: () => { mkdir('A3'); for (let i = 0; i < 7; i++) put(`A3/sub${i % 2}/f${i}.dat`, 'd'); },
        prompt: 'Count the total number of files (recursively) under the A3/ directory and write just that number into A3/count.txt.',
        check: () => (read('A3/count.txt') || '').trim().includes('7'),
    });
    add('A4', 'A', 'Find duplicate files by content', {
        setup: () => { mkdir('A4'); put('A4/one.txt', 'IDENTICAL'); put('A4/two.txt', 'IDENTICAL'); put('A4/three.txt', 'different'); },
        prompt: 'Two files in A4/ have identical content. Find them and write the two filenames (one per line) into A4/dupes.txt.',
        check: () => { const c = read('A4/dupes.txt') || ''; return /one\.txt/.test(c) && /two\.txt/.test(c) && !/three\.txt/.test(c); },
    });
    add('A5', 'A', 'Batch-rename .txt to .md', {
        setup: () => { mkdir('A5'); put('A5/note1.txt', '1'); put('A5/note2.txt', '2'); },
        prompt: 'Rename every .txt file in the A5/ directory to have a .md extension instead, keeping the same base name.',
        check: () => exists('A5/note1.md') && exists('A5/note2.md') && !exists('A5/note1.txt'),
    });
    add('A6', 'A', 'Delete files matching a pattern', {
        setup: () => { mkdir('A6'); put('A6/keep.log', 'k'); put('A6/a.tmp', 't'); put('A6/b.tmp', 't'); },
        prompt: 'Delete all files ending in .tmp inside the A6/ directory. Leave everything else.',
        check: () => exists('A6/keep.log') && !exists('A6/a.tmp') && !exists('A6/b.tmp'),
    });
    add('A7', 'A', 'Create a nested directory structure', {
        setup: () => { mkdir('A7'); },
        prompt: 'Inside A7/, create this folder structure: project/src, project/tests, and project/docs (three subfolders under A7/project).',
        check: () => exists('A7/project/src') && exists('A7/project/tests') && exists('A7/project/docs'),
    });
    add('A8', 'A', 'Merge text files into one', {
        setup: () => { mkdir('A8'); put('A8/p1.txt', 'ALPHA\n'); put('A8/p2.txt', 'BRAVO\n'); put('A8/p3.txt', 'CHARLIE\n'); },
        prompt: 'Concatenate the three files A8/p1.txt, A8/p2.txt and A8/p3.txt (in that order) into a single file A8/merged.txt.',
        check: () => { const c = read('A8/merged.txt') || ''; return /ALPHA/.test(c) && /BRAVO/.test(c) && /CHARLIE/.test(c) && c.indexOf('ALPHA') < c.indexOf('CHARLIE'); },
    });
    add('A9', 'A', 'Extract first N lines', {
        setup: () => { mkdir('A9'); put('A9/data.txt', Array.from({ length: 20 }, (_, i) => 'line' + (i + 1)).join('\n') + '\n'); },
        prompt: 'Take the first 5 lines of A9/data.txt and write them to A9/head.txt.',
        check: () => { const c = read('A9/head.txt') || ''; return /line1/.test(c) && /line5/.test(c) && !/line6\b/.test(c); },
    });
    add('A10', 'A', 'Archive a folder', {
        setup: () => { mkdir('A10/payload'); put('A10/payload/x.txt', 'data'); put('A10/payload/y.txt', 'more'); },
        prompt: 'Create a gzipped tar archive of the A10/payload directory at A10/payload.tar.gz.',
        check: () => exists('A10/payload.tar.gz') && fs.statSync(W('A10/payload.tar.gz')).size > 0,
    });
    add('A11', 'A', 'Search file contents for a keyword', {
        setup: () => { mkdir('A11'); put('A11/f1.txt', 'nothing here'); put('A11/f2.txt', 'the SECRET token'); put('A11/f3.txt', 'also SECRET word'); },
        prompt: 'Find which files in A11/ contain the word "SECRET" and write their filenames (one per line) into A11/matches.txt.',
        check: () => { const c = read('A11/matches.txt') || ''; return /f2\.txt/.test(c) && /f3\.txt/.test(c) && !/f1\.txt/.test(c); },
    });
    add('A12', 'A', 'Total size of a directory', {
        setup: () => { mkdir('A12'); put('A12/a.bin', 'A'.repeat(1000)); put('A12/b.bin', 'B'.repeat(1000)); },
        prompt: 'Compute the total size in bytes of all files in the A12/ directory and write just the number into A12/size.txt. (It should be at least 2000.)',
        check: () => { const n = parseInt((read('A12/size.txt') || '').replace(/[^\d]/g, ''), 10); return n >= 2000; },
    });

    // ---- B. Text & data processing (14) ----
    add('B1', 'B', 'Most frequent word', {
        setup: () => put('B1/text.txt', 'apple banana apple cherry apple banana\n'),
        prompt: 'Find the single most frequently occurring word in B1/text.txt and write just that word into B1/top.txt.',
        check: () => /apple/i.test((read('B1/top.txt') || '').trim()),
    });
    add('B2', 'B', 'Extract email addresses', {
        setup: () => put('B2/contacts.txt', 'Call Bob at bob@example.com or Alice (alice@test.org). Not an email: hello.\n'),
        prompt: 'Extract every email address from B2/contacts.txt and write them one per line into B2/emails.txt.',
        check: () => { const c = read('B2/emails.txt') || ''; return /bob@example\.com/.test(c) && /alice@test\.org/.test(c); },
    });
    add('B3', 'B', 'Find & replace across files', {
        setup: () => { put('B3/a.txt', 'use foobar widget\n'); put('B3/b.txt', 'foobar again\n'); },
        prompt: 'In every .txt file under B3/, replace all occurrences of the word "foobar" with "gadget". Save the changes in place.',
        check: () => { const a = read('B3/a.txt') || '', b = read('B3/b.txt') || ''; return /gadget/.test(a) && /gadget/.test(b) && !/foobar/.test(a + b); },
    });
    add('B4', 'B', 'Sort lines alphabetically', {
        setup: () => put('B4/list.txt', 'cherry\napple\nbanana\n'),
        prompt: 'Sort the lines of B4/list.txt in alphabetical order and write the result to B4/sorted.txt.',
        check: () => (read('B4/sorted.txt') || '').replace(/\s+/g, ' ').trim().startsWith('apple banana cherry'),
    });
    add('B5', 'B', 'Deduplicate lines', {
        setup: () => put('B5/dupes.txt', 'red\nblue\nred\ngreen\nblue\nred\n'),
        prompt: 'Remove duplicate lines from B5/dupes.txt (keep one of each) and write the unique lines to B5/unique.txt.',
        check: () => { const lines = (read('B5/unique.txt') || '').split('\n').map(s => s.trim()).filter(Boolean); return lines.length === 3 && new Set(lines).size === 3; },
    });
    add('B6', 'B', 'CSV to JSON', {
        setup: () => put('B6/people.csv', 'name,age\nAda,36\nBob,40\n'),
        prompt: 'Convert the CSV file B6/people.csv into a JSON array of objects and write it to B6/people.json. Each row becomes an object with name and age keys.',
        check: () => { try { const j = JSON.parse(read('B6/people.json')); return Array.isArray(j) && j.length === 2 && j[0].name === 'Ada' && String(j[1].age) === '40'; } catch { return false; } },
    });
    add('B7', 'B', 'JSON to CSV', {
        setup: () => put('B7/data.json', JSON.stringify([{ city: 'Oslo', pop: 700 }, { city: 'Bergen', pop: 280 }])),
        prompt: 'Convert the JSON array in B7/data.json into a CSV file B7/data.csv with a header row (city,pop) and one row per object.',
        check: () => { const c = read('B7/data.csv') || ''; return /city/.test(c) && /Oslo/.test(c) && /Bergen/.test(c) && /700/.test(c); },
    });
    add('B8', 'B', 'Sum a CSV column', {
        setup: () => put('B8/sales.csv', 'item,amount\npen,3\nbook,10\nlamp,7\n'),
        prompt: 'Add up all the values in the "amount" column of B8/sales.csv and write just the total into B8/total.txt.',
        check: () => (read('B8/total.txt') || '').replace(/[^\d]/g, '').includes('20'),
    });
    add('B9', 'B', 'Average of a column', {
        setup: () => put('B9/scores.csv', 'name,score\na,10\nb,20\nc,30\n'),
        prompt: 'Compute the average (mean) of the "score" column in B9/scores.csv and write just the number into B9/avg.txt.',
        check: () => (read('B9/avg.txt') || '').replace(/[^\d]/g, '').includes('20'),
    });
    add('B10', 'B', 'Count occurrences of a word', {
        setup: () => put('B10/log.txt', 'ok\nERROR\nok\nERROR\nERROR\nok\n'),
        prompt: 'Count how many times the word "ERROR" appears in B10/log.txt and write just the count into B10/errors.txt.',
        check: () => (read('B10/errors.txt') || '').replace(/[^\d]/g, '').includes('3'),
    });
    add('B11', 'B', 'Extract URLs', {
        setup: () => put('B11/page.txt', 'See https://foo.com/a and also http://bar.org/b for details.\n'),
        prompt: 'Extract all the URLs from B11/page.txt and write them one per line into B11/urls.txt.',
        check: () => { const c = read('B11/urls.txt') || ''; return /https:\/\/foo\.com\/a/.test(c) && /http:\/\/bar\.org\/b/.test(c); },
    });
    add('B12', 'B', 'Prettify JSON', {
        setup: () => put('B12/min.json', '{"a":1,"b":{"c":2,"d":[3,4]}}'),
        prompt: 'Reformat (pretty-print with indentation) the JSON in B12/min.json and write the indented version to B12/pretty.json. The data must stay equivalent.',
        check: () => { try { const j = JSON.parse(read('B12/pretty.json')); return j.a === 1 && j.b.c === 2 && (read('B12/pretty.json') || '').includes('\n'); } catch { return false; } },
    });
    add('B13', 'B', 'Reverse line order', {
        setup: () => put('B13/seq.txt', 'first\nsecond\nthird\n'),
        prompt: 'Reverse the order of the lines in B13/seq.txt and write the result to B13/reversed.txt (so "third" is first).',
        check: () => (read('B13/reversed.txt') || '').replace(/\s+/g, ' ').trim().startsWith('third second first'),
    });
    add('B14', 'B', 'wc report', {
        setup: () => put('B14/doc.txt', 'one two three\nfour five\n'),
        prompt: 'Count the number of lines and words in B14/doc.txt and write a short report to B14/stats.txt containing both numbers (2 lines, 5 words).',
        check: () => { const c = read('B14/stats.txt') || ''; return /\b2\b/.test(c) && /\b5\b/.test(c); },
    });

    // ---- C. Coding / dev (12) ----
    add('C1', 'C', 'Scaffold and run a Node script', {
        setup: () => mkdir('C1'),
        prompt: 'Create a Node.js script at C1/hello.js that prints "HELLO_AGENT" to stdout, then run it with node and confirm it prints that.',
        check: () => /HELLO_AGENT/.test(read('C1/hello.js') || ''),
    });
    add('C2', 'C', 'Fix a broken shell script', {
        setup: () => put('C2/run.sh', '#!/bin/sh\nif [ 1 -eq 1 ]\n  echo "missing then"\nfi\n'),
        prompt: 'The shell script C2/run.sh has a syntax error (the if-statement is missing "then"). Fix it so it runs without error and prints its message, then run it to verify.',
        check: () => { try { execSync('sh ' + W('C2/run.sh'), { stdio: 'ignore' }); return true; } catch { return false; } },
    });
    add('C3', 'C', 'Write and run a unit test', {
        setup: () => put('C3/math.js', 'function add(a,b){return a+b;}\nmodule.exports={add};\n'),
        prompt: 'C3/math.js exports an add(a,b) function. Write a Node test file C3/test.js that uses the assert module to check add(2,3)===5, then run it. It should exit 0 with no assertion error.',
        check: () => { try { execSync('node ' + W('C3/test.js'), { stdio: 'ignore', cwd: W('C3') }); return true; } catch { return false; } },
    });
    add('C4', 'C', 'Find TODO comments', {
        setup: () => { put('C4/a.js', 'var x=1; // TODO refactor this\n'); put('C4/b.js', 'ok();\n// TODO: handle errors\n'); put('C4/c.js', 'done();\n'); },
        prompt: 'Search the JavaScript files in C4/ for "TODO" comments and write a list of the files that contain a TODO (one filename per line) into C4/todos.txt.',
        check: () => { const c = read('C4/todos.txt') || ''; return /a\.js/.test(c) && /b\.js/.test(c) && !/c\.js/.test(c); },
    });
    add('C5', 'C', 'Bump version in package.json', {
        setup: () => put('C5/package.json', JSON.stringify({ name: 'app', version: '1.2.3' }, null, 2) + '\n'),
        prompt: 'Bump the version in C5/package.json from 1.2.3 to 1.3.0 (a minor version bump). Keep it valid JSON.',
        check: () => { try { return JSON.parse(read('C5/package.json')).version === '1.3.0'; } catch { return false; } },
    });
    add('C6', 'C', 'Write a .gitignore', {
        setup: () => mkdir('C6'),
        prompt: 'Create a .gitignore file at C6/.gitignore for a Node project. It must at least ignore node_modules and .env files.',
        check: () => { const c = read('C6/.gitignore') || ''; return /node_modules/.test(c) && /\.env/.test(c); },
    });
    add('C7', 'C', 'Init git repo and commit', {
        setup: () => { mkdir('C7'); put('C7/readme.txt', 'hello'); },
        prompt: 'Initialize a git repository inside C7/, add all files, and make an initial commit with the message "init". (Set a user.email and user.name if git complains.)',
        check: () => { try { return /init/.test(execSync('git -C ' + W('C7') + ' log --oneline', { encoding: 'utf8' })); } catch { return false; } },
    });
    add('C8', 'C', 'Generate and run a Python script', {
        setup: () => mkdir('C8'),
        prompt: 'Write a Python script C8/sum.py that prints the sum of numbers 1 to 100, then run it with python3. It should print 5050.',
        check: () => /5050|range\(1,\s*101\)|sum\(/.test(read('C8/sum.py') || ''),
    });
    add('C9', 'C', 'Rename a function across files', {
        setup: () => { put('C9/lib.js', 'function calcOld(x){return x*2;}\nmodule.exports={calcOld};\n'); put('C9/use.js', 'const {calcOld}=require("./lib");\nconsole.log(calcOld(3));\n'); },
        prompt: 'Rename the function "calcOld" to "calcDouble" everywhere it appears across the files in C9/ (both the definition and the call sites).',
        check: () => { const a = read('C9/lib.js') || '', b = read('C9/use.js') || ''; return /calcDouble/.test(a) && /calcDouble/.test(b) && !/calcOld/.test(a + b); },
    });
    add('C10', 'C', 'Add a CLI argument to a script', {
        setup: () => put('C10/greet.js', 'console.log("Hello, world");\n'),
        prompt: 'Modify C10/greet.js so that it reads a name from the first command-line argument (process.argv[2]) and prints "Hello, <name>". If run as `node greet.js Sam` it should print "Hello, Sam".',
        check: () => { try { const out = execSync('node ' + W('C10/greet.js') + ' Sam', { encoding: 'utf8' }); return /Hello,\s*Sam/.test(out); } catch { return false; } },
    });
    add('C11', 'C', 'Write a Dockerfile', {
        setup: () => { mkdir('C11'); put('C11/package.json', JSON.stringify({ name: 'svc', version: '1.0.0', main: 'index.js' })); },
        prompt: 'Write a Dockerfile at C11/Dockerfile for this Node.js app. It should be based on a node image, copy the app in, run npm install, and start it with node.',
        check: () => { const c = read('C11/Dockerfile') || ''; return /FROM\s+node/i.test(c) && /COPY/i.test(c) && /CMD|ENTRYPOINT/i.test(c); },
    });
    add('C12', 'C', 'Validate JSON config', {
        setup: () => put('C12/config.json', '{ "port": 8080, "debug": true, }'),
        prompt: 'The file C12/config.json has a JSON syntax error (a trailing comma). Fix it so it is valid JSON, keeping the same data, and save it back.',
        check: () => { try { const j = JSON.parse(read('C12/config.json')); return j.port === 8080 && j.debug === true; } catch { return false; } },
    });

    // ---- D. System / ops / processes (12) ----
    add('D1', 'D', 'Disk usage summary', {
        setup: () => mkdir('D1'),
        prompt: 'Check the disk usage of the filesystem (e.g. with df) and write a short summary including the percentage used of the main filesystem into D1/disk.txt.',
        check: () => /%/.test(read('D1/disk.txt') || ''),
    });
    add('D2', 'D', 'Count running processes', {
        setup: () => mkdir('D2'),
        prompt: 'Count how many processes are currently running on this machine (e.g. with ps) and write just the number into D2/procs.txt. It should be a positive integer.',
        check: () => { const n = parseInt((read('D2/procs.txt') || '').replace(/[^\d]/g, ''), 10); return n > 0; },
    });
    add('D3', 'D', 'Report OS / kernel', {
        setup: () => mkdir('D3'),
        prompt: 'Find out what operating system / kernel this machine is running (e.g. with uname -a) and save the full output into D3/os.txt.',
        check: () => /Linux/i.test(read('D3/os.txt') || ''),
    });
    add('D4', 'D', 'Environment info to file', {
        setup: () => mkdir('D4'),
        prompt: 'Write the Node.js version and the current username into D4/env.txt (e.g. by running node --version and whoami).',
        check: () => /v?\d+\.\d+/.test(read('D4/env.txt') || ''),
    });
    add('D5', 'D', 'Background heartbeat loop', {
        setup: () => mkdir('D5'),
        prompt: 'Start a background process that appends the current date/time to D5/heartbeat.log once every 1 second. Let it run for about 5 seconds, then read the log and confirm it has at least 3 timestamped lines. Finally stop the background process.',
        maxSteps: 14,
        check: () => (read('D5/heartbeat.log') || '').trim().split(/\n+/).filter(Boolean).length >= 3,
    });
    add('D6', 'D', 'Wait until a file appears', {
        setup: () => mkdir('D6'),
        prompt: 'Run a single background shell command that sleeps 3 seconds and then creates the file D6/ready.flag with the text "done". Wait (e.g. poll/sleep) until D6/ready.flag exists, then read it to confirm it says "done".',
        maxSteps: 14,
        check: () => /done/.test(read('D6/ready.flag') || ''),
    });
    add('D7', 'D', 'Gzip a log file', {
        setup: () => put('D7/app.log', 'log line\n'.repeat(200)),
        prompt: 'Compress the file D7/app.log with gzip, producing D7/app.log.gz.',
        check: () => exists('D7/app.log.gz') && fs.statSync(W('D7/app.log.gz')).size > 0,
    });
    add('D8', 'D', 'Compute a sha256 checksum', {
        setup: () => put('D8/file.bin', 'checksum me please'),
        prompt: 'Compute the SHA-256 checksum of D8/file.bin and write just the hex digest into D8/sum.txt.',
        check: () => { const want = crypto.createHash('sha256').update('checksum me please').digest('hex'); return (read('D8/sum.txt') || '').toLowerCase().includes(want); },
    });
    add('D9', 'D', 'Verify a checksum matches', {
        setup: () => { put('D9/data.bin', 'verify this content'); const h = crypto.createHash('sha256').update('verify this content').digest('hex'); put('D9/expected.sha256', h + '\n'); },
        prompt: 'D9/expected.sha256 holds the expected SHA-256 of D9/data.bin. Compute the actual checksum of D9/data.bin, compare it to the expected one, and write either "MATCH" or "MISMATCH" into D9/result.txt.',
        check: () => /MATCH/.test(read('D9/result.txt') || '') && !/MISMATCH/.test(read('D9/result.txt') || ''),
    });
    add('D10', 'D', 'Days until a date', {
        setup: () => mkdir('D10'),
        prompt: 'Compute how many whole days there are from today until 2027-01-01, and write just that number into D10/days.txt. Use the system date.',
        check: () => { const n = parseInt((read('D10/days.txt') || '').replace(/[^\d]/g, ''), 10); return n > 100 && n < 1000; },
    });
    add('D11', 'D', 'Count ERROR lines in a log', {
        setup: () => put('D11/server.log', 'INFO start\nERROR boom\nWARN slow\nERROR crash\nINFO ok\nERROR again\n'),
        prompt: 'Count how many lines in D11/server.log contain "ERROR" and write just the count into D11/errcount.txt.',
        check: () => (read('D11/errcount.txt') || '').replace(/[^\d]/g, '').includes('3'),
    });
    add('D12', 'D', 'Tail last N lines', {
        setup: () => put('D12/big.log', Array.from({ length: 100 }, (_, i) => 'event ' + (i + 1)).join('\n') + '\n'),
        prompt: 'Write the last 10 lines of D12/big.log into D12/tail.txt.',
        check: () => { const c = read('D12/tail.txt') || ''; return /event 100/.test(c) && /event 91/.test(c) && !/event 90\b/.test(c); },
    });

    // ---- E. Web / research (8) ----
    add('E1', 'E', 'HN top-3 briefing', {
        setup: () => mkdir('E1'),
        maxSteps: 16,
        prompt: 'Research the current top stories on Hacker News (news.ycombinator.com). Use your web tools to read the live front page or its public Firebase API, then write E1/hn.md with the titles of the top 3 stories right now as a markdown list. They must be REAL current titles you fetched, not placeholders.',
        check: ({ usedTools }) => { const web = usedTools.includes('fetch_url') || usedTools.includes('web_search'); const b = read('E1/hn.md') || ''; const lines = b.split('\n').map(l => l.replace(/^[-*\d.\s]+/, '').trim()).filter(l => l.length > 8); const real = lines.filter(l => !/placeholder|example|story \d|title \d|lorem/i.test(l)); return web && real.length >= 3; },
    });
    add('E2', 'E', 'Fetch JSON API, extract a field', {
        setup: () => mkdir('E2'),
        maxSteps: 14,
        prompt: 'Fetch the public GitHub API endpoint https://api.github.com/repos/nodejs/node as JSON, extract the value of the "stargazers_count" field, and write just that number into E2/stars.txt.',
        check: () => { const n = parseInt((read('E2/stars.txt') || '').replace(/[^\d]/g, ''), 10); return n > 1000; },
    });
    add('E3', 'E', 'Check if a website is up', {
        setup: () => mkdir('E3'),
        maxSteps: 12,
        prompt: 'Check whether https://example.com is reachable right now. Fetch it and write either "UP" or "DOWN" into E3/status.txt based on whether you got content back.',
        check: () => /UP/.test(read('E3/status.txt') || ''),
    });
    add('E4', 'E', 'Fetch a page, find a word', {
        setup: () => mkdir('E4'),
        maxSteps: 12,
        prompt: 'Fetch the page https://example.com and check whether the word "Example" appears in it. Write "YES" or "NO" into E4/found.txt.',
        check: () => /YES/.test(read('E4/found.txt') || ''),
    });
    add('E5', 'E', 'Extract links from a fetched page', {
        setup: () => mkdir('E5'),
        maxSteps: 14,
        prompt: 'Fetch https://example.com and extract any hyperlink (href URL) found in the page. Write the link(s) you find, one per line, into E5/links.txt. (example.com links to iana.org.)',
        check: () => /iana\.org/i.test(read('E5/links.txt') || ''),
    });
    add('E6', 'E', 'Fetch crypto price from API', {
        setup: () => mkdir('E6'),
        maxSteps: 14,
        prompt: 'Fetch the current Bitcoin price in USD from the public Coinbase spot price API (https://api.coinbase.com/v2/prices/BTC-USD/spot) and write just the numeric price into E6/btc.txt.',
        check: () => { const n = parseFloat((read('E6/btc.txt') || '').replace(/[^\d.]/g, '')); return n > 1000; },
    });
    add('E7', 'E', 'Wikipedia summary fetch', {
        setup: () => mkdir('E7'),
        maxSteps: 14,
        prompt: 'Fetch the REST summary for "Linux" from Wikipedia (https://en.wikipedia.org/api/rest_v1/page/summary/Linux) and save the human-readable extract/summary text into E7/linux.md.',
        check: () => { const c = read('E7/linux.md') || ''; return c.length > 80 && /Linux|kernel|operating system/i.test(c); },
    });
    add('E8', 'E', 'Web search and summarize', {
        setup: () => mkdir('E8'),
        maxSteps: 14,
        prompt: 'Find out (using your web tools) what the capital city of Australia is, and write a one-sentence answer naming the city into E8/answer.txt.',
        check: () => /Canberra/i.test(read('E8/answer.txt') || ''),
        soft: true, // DDG may be bot-blocked; informational, not counted as a hard fail
    });

    // ---- F. Productivity / personal docs (12) ----
    add('F1', 'F', 'Create a to-do list', {
        setup: () => mkdir('F1'),
        prompt: 'Create a markdown to-do list at F1/todo.md with these three tasks as checkbox items: "Buy milk", "Email Dana", "Pay rent".',
        check: () => { const c = read('F1/todo.md') || ''; return /Buy milk/i.test(c) && /Email Dana/i.test(c) && /Pay rent/i.test(c) && /\[ \]|\[x\]|- /.test(c); },
    });
    add('F2', 'F', 'Append an item to a to-do list', {
        setup: () => put('F2/todo.md', '# Todo\n- [ ] Buy milk\n- [ ] Email Dana\n'),
        prompt: 'Add a new task "- [ ] Call plumber" to the existing to-do list F2/todo.md, keeping the current items.',
        check: () => { const c = read('F2/todo.md') || ''; return /Buy milk/.test(c) && /Call plumber/i.test(c); },
    });
    add('F3', 'F', 'Mark a to-do item done', {
        setup: () => put('F3/todo.md', '# Todo\n- [ ] Buy milk\n- [ ] Email Dana\n- [ ] Pay rent\n'),
        prompt: 'In F3/todo.md, mark the "Email Dana" task as completed by changing its checkbox from [ ] to [x]. Leave the others unchecked.',
        check: () => { const c = read('F3/todo.md') || ''; return /\[x\]\s*Email Dana/i.test(c) && /\[ \]\s*Buy milk/i.test(c); },
    });
    add('F4', 'F', 'Draft an email', {
        setup: () => mkdir('F4'),
        prompt: 'Draft a short professional email and save it to F4/email.txt. It should be addressed to dana@example.com, have a Subject line about rescheduling tomorrow\'s meeting, and a brief polite body.',
        check: () => { const c = read('F4/email.txt') || ''; return /dana@example\.com/.test(c) && /subject/i.test(c) && /meeting|reschedul/i.test(c); },
    });
    add('F5', 'F', 'Meeting agenda', {
        setup: () => mkdir('F5'),
        prompt: 'Create a meeting agenda at F5/agenda.md for a 30-minute project sync. Include a title, the date, and at least 3 agenda items as a list.',
        check: () => { const c = read('F5/agenda.md') || ''; return /agenda/i.test(c) && (c.match(/\n\s*[-*\d]/g) || []).length >= 3; },
    });
    add('F6', 'F', 'ICS calendar event', {
        setup: () => mkdir('F6'),
        prompt: 'Create an iCalendar (.ics) file at F6/event.ics for an event titled "Dentist" on 2026-07-15. It must contain valid VCALENDAR/VEVENT structure with a SUMMARY of Dentist.',
        check: () => { const c = read('F6/event.ics') || ''; return /BEGIN:VCALENDAR/.test(c) && /BEGIN:VEVENT/.test(c) && /SUMMARY:.*Dentist/i.test(c); },
    });
    add('F7', 'F', 'Grouped shopping list', {
        setup: () => mkdir('F7'),
        prompt: 'Create a grocery list at F7/groceries.md that groups these items under category headings: apples and bananas (Produce); milk and cheese (Dairy); bread (Bakery).',
        check: () => { const c = read('F7/groceries.md') || ''; return /Produce/i.test(c) && /Dairy/i.test(c) && /apples/i.test(c) && /milk/i.test(c); },
    });
    add('F8', 'F', 'Summarize raw meeting notes', {
        setup: () => put('F8/raw.txt', 'so um we decided to ship friday, dana owns the launch, budget is 5000, oh and the api migration is blocked on legal\n'),
        prompt: 'Read the messy meeting notes in F8/raw.txt and write a clean summary to F8/summary.md capturing: the ship date, who owns the launch, the budget, and what is blocked.',
        check: () => { const c = read('F8/summary.md') || ''; return /friday/i.test(c) && /dana/i.test(c) && /5000|5,000/.test(c) && /legal|block/i.test(c); },
    });
    add('F9', 'F', 'Trip itinerary', {
        setup: () => mkdir('F9'),
        prompt: 'Create a simple 3-day trip itinerary for Tokyo at F9/itinerary.md, with a heading for Day 1, Day 2, and Day 3, each with at least one activity.',
        check: () => { const c = read('F9/itinerary.md') || ''; return /Day 1/i.test(c) && /Day 2/i.test(c) && /Day 3/i.test(c) && /Tokyo/i.test(c); },
    });
    add('F10', 'F', 'Dated journal entry', {
        setup: () => mkdir('F10'),
        prompt: 'Create a journal entry file F10/journal.md. Put today\'s actual date (find it from the system) as a heading, followed by a sentence or two of reflective text.',
        check: () => { const c = read('F10/journal.md') || ''; const y = new Date().getFullYear(); return new RegExp(String(y)).test(c) && c.length > 30; },
    });
    add('F11', 'F', 'Budget table from numbers', {
        setup: () => mkdir('F11'),
        prompt: 'Create a markdown table at F11/budget.md with columns Category and Amount, with rows: Rent 1200, Food 400, Transport 150. Then add a Total row summing to 1750.',
        check: () => { const c = read('F11/budget.md') || ''; return /Rent/i.test(c) && /1200/.test(c) && /1750/.test(c) && /\|/.test(c); },
    });
    add('F12', 'F', 'Reminders file', {
        setup: () => mkdir('F12'),
        prompt: 'Create a reminders file F12/reminders.md listing three reminders with times: "09:00 Standup", "13:00 Lunch with Sam", "17:30 Gym".',
        check: () => { const c = read('F12/reminders.md') || ''; return /09:00.*Standup/i.test(c) && /Lunch with Sam/i.test(c) && /Gym/i.test(c); },
    });

    // ---- G. Memory / personalization (8, real semantic memory) ----
    add('G1', 'G', 'Store a standing preference', {
        setup: () => {},
        prompt: 'Going forward, remember this standing preference: always keep my briefings under 100 words. Save it to your long-term memory.',
        check: ({ usedTools }) => usedTools.includes('save_new_user_fact_only') && memory.vectors.some(v => /100|brief/i.test(v.text || '')),
    });
    add('G2', 'G', 'Recall the preference (fresh)', {
        setup: () => {},
        prompt: 'Do you have any saved preference about how long my briefings should be? Search your memory and tell me the word limit I asked for.',
        check: ({ usedTools }) => usedTools.includes('memory_search'),
        judgeText: (t) => /100/.test(t || ''),
    });
    add('G3', 'G', 'Store contact info', {
        setup: () => {},
        prompt: "Please remember my dentist's phone number for later: it's 555-0142. Save it to long-term memory.",
        check: ({ usedTools }) => usedTools.includes('save_new_user_fact_only') && memory.vectors.some(v => /555-?0142/.test(v.text || '')),
    });
    add('G4', 'G', 'Recall contact info', {
        setup: () => {},
        prompt: "What's my dentist's phone number? Look it up in your memory and tell me.",
        check: ({ usedTools }) => usedTools.includes('memory_search'),
        judgeText: (t) => /555-?0142/.test(t || ''),
    });
    add('G5', 'G', 'Store project context', {
        setup: () => {},
        prompt: 'Remember this project fact for the future: the launch deadline for Project Zephyr is March 14. Save it to long-term memory.',
        check: ({ usedTools }) => usedTools.includes('save_new_user_fact_only') && memory.vectors.some(v => /Zephyr/i.test(v.text || '')),
    });
    add('G6', 'G', 'Recall project context', {
        setup: () => {},
        prompt: 'When is the launch deadline for Project Zephyr? Search your memory and answer.',
        check: ({ usedTools }) => usedTools.includes('memory_search'),
        judgeText: (t) => /March 14|March/i.test(t || ''),
    });
    add('G7', 'G', 'Store dietary preference', {
        setup: () => {},
        prompt: 'For future restaurant and recipe suggestions, remember that I am vegetarian and allergic to peanuts. Save this to long-term memory.',
        check: ({ usedTools }) => usedTools.includes('save_new_user_fact_only') && memory.vectors.some(v => /vegetarian|peanut/i.test(v.text || '')),
    });
    add('G8', 'G', 'Recall dietary preference', {
        setup: () => {},
        prompt: 'Do I have any dietary restrictions you should know about before suggesting a recipe? Check your memory.',
        check: ({ usedTools }) => usedTools.includes('memory_search'),
        judgeText: (t) => /vegetarian|peanut/i.test(t || ''),
    });

    // ---- H. Math / utilities / conversions (12) ----
    add('H1', 'H', 'Evaluate an arithmetic expression', {
        setup: () => mkdir('H1'),
        prompt: 'Compute (1234 * 5678) + 9012 and write just the resulting number into H1/answer.txt.',
        check: () => (read('H1/answer.txt') || '').replace(/[^\d]/g, '').includes(String(1234 * 5678 + 9012)),
    });
    add('H2', 'H', 'Miles to kilometers', {
        setup: () => mkdir('H2'),
        prompt: 'Convert 26.2 miles to kilometers (1 mile = 1.60934 km) and write the result (about 42.2) into H2/km.txt.',
        check: () => { const n = parseFloat((read('H2/km.txt') || '').replace(/[^\d.]/g, '')); return n > 41.5 && n < 43; },
    });
    add('H3', 'H', 'Generate a secure password', {
        setup: () => mkdir('H3'),
        prompt: 'Generate a random secure password that is at least 16 characters long and contains a mix of letters and digits, then write just the password into H3/pw.txt.',
        check: () => { const c = (read('H3/pw.txt') || '').trim().split('\n').pop().trim(); return c.length >= 16 && /[a-zA-Z]/.test(c) && /[0-9]/.test(c); },
    });
    add('H4', 'H', 'Generate a UUID', {
        setup: () => mkdir('H4'),
        prompt: 'Generate a version-4 UUID and write just it into H4/uuid.txt.',
        check: () => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(read('H4/uuid.txt') || ''),
    });
    add('H5', 'H', 'Base64 encode', {
        setup: () => mkdir('H5'),
        prompt: 'Base64-encode the exact string "Agent Smith" and write just the encoded value into H5/enc.txt.',
        check: () => (read('H5/enc.txt') || '').includes(Buffer.from('Agent Smith').toString('base64')),
    });
    add('H6', 'H', 'Base64 decode', {
        setup: () => put('H6/enc.txt', Buffer.from('matrix unlocked').toString('base64') + '\n'),
        prompt: 'The file H6/enc.txt contains a base64-encoded string. Decode it and write the plain text into H6/dec.txt.',
        check: () => /matrix unlocked/.test(read('H6/dec.txt') || ''),
    });
    add('H7', 'H', 'SHA-256 of a string', {
        setup: () => mkdir('H7'),
        prompt: 'Compute the SHA-256 hash of the exact string "hello" and write just the hex digest into H7/hash.txt.',
        check: () => (read('H7/hash.txt') || '').toLowerCase().includes(crypto.createHash('sha256').update('hello').digest('hex')),
    });
    add('H8', 'H', 'Celsius to Fahrenheit', {
        setup: () => mkdir('H8'),
        prompt: 'Convert 100 degrees Celsius to Fahrenheit and write just the number into H8/f.txt. (Formula: F = C*9/5 + 32.)',
        check: () => (read('H8/f.txt') || '').replace(/[^\d]/g, '').includes('212'),
    });
    add('H9', 'H', 'Total with tax', {
        setup: () => mkdir('H9'),
        prompt: 'A purchase is 80.00 before tax with 8.5% sales tax. Compute the final total (about 86.80) and write just the number into H9/total.txt.',
        check: () => { const n = parseFloat((read('H9/total.txt') || '').replace(/[^\d.]/g, '')); return n > 86.5 && n < 87.1; },
    });
    add('H10', 'H', 'Fibonacci via script', {
        setup: () => mkdir('H10'),
        prompt: 'Compute the 20th Fibonacci number (with fib(1)=1, fib(2)=1, so fib(20)=6765) and write just it into H10/fib.txt.',
        check: () => (read('H10/fib.txt') || '').replace(/[^\d]/g, '').includes('6765'),
    });
    add('H11', 'H', 'Random pick from a list', {
        setup: () => put('H11/options.txt', 'pizza\nsushi\ntacos\nramen\n'),
        prompt: 'Randomly pick one of the food options listed in H11/options.txt and write just that one choice into H11/pick.txt.',
        check: () => /^(pizza|sushi|tacos|ramen)\s*$/im.test((read('H11/pick.txt') || '').trim()),
    });
    add('H12', 'H', 'Day of week for a date', {
        setup: () => mkdir('H12'),
        prompt: 'Determine what day of the week 2026-12-25 falls on and write just the weekday name into H12/day.txt.',
        check: () => /friday/i.test(read('H12/day.txt') || ''),
    });

    // ---- I. Search / discovery (5) ----
    add('I1', 'I', 'Grep for a function definition', {
        setup: () => { put('I1/utils.js', 'function helperA(){}\nfunction targetFn(x){return x;}\n'); put('I1/other.js', 'const z=1;\n'); },
        prompt: 'Search the files in I1/ to find which file defines the function "targetFn", and write that filename into I1/where.txt.',
        check: () => /utils\.js/.test(read('I1/where.txt') || ''),
    });
    add('I2', 'I', 'Glob and count .js files', {
        setup: () => { mkdir('I2'); for (let i = 0; i < 4; i++) put(`I2/m${i}.js`, '//'); put('I2/readme.md', 'x'); },
        prompt: 'Count how many .js files exist under I2/ and write just the number into I2/jscount.txt.',
        check: () => (read('I2/jscount.txt') || '').replace(/[^\d]/g, '').includes('4'),
    });
    add('I3', 'I', 'Find which file holds a secret string', {
        setup: () => { mkdir('I3'); for (let i = 0; i < 6; i++) put(`I3/file${i}.txt`, i === 4 ? 'token=HUNTER2 here' : 'nothing'); },
        prompt: 'Exactly one file under I3/ contains the string "HUNTER2". Find it and write that filename into I3/found.txt.',
        check: () => /file4\.txt/.test(read('I3/found.txt') || ''),
    });
    add('I4', 'I', 'List a directory tree', {
        setup: () => { mkdir('I4'); put('I4/top.txt', 't'); put('I4/sub/deep.txt', 'd'); },
        prompt: 'Produce a recursive listing of everything under I4/ and write it to I4/tree.txt. Both top.txt and sub/deep.txt should appear in the listing.',
        check: () => { const c = read('I4/tree.txt') || ''; return /top\.txt/.test(c) && /deep\.txt/.test(c); },
    });
    add('I5', 'I', 'Find files by name pattern', {
        setup: () => { mkdir('I5'); put('I5/report_jan.csv', 'a'); put('I5/report_feb.csv', 'b'); put('I5/notes.txt', 'c'); },
        prompt: 'Find all files under I5/ whose names start with "report_" and write their filenames (one per line) into I5/reports.txt.',
        check: () => { const c = read('I5/reports.txt') || ''; return /report_jan\.csv/.test(c) && /report_feb\.csv/.test(c) && !/notes\.txt/.test(c); },
    });

    // ---- J. Safety / trust / verify (5) ----
    add('J1', 'J', 'Make a change then undo it', {
        setup: () => put('J1/important.txt', 'ORIGINAL CONTENT\n'),
        prompt: 'First overwrite J1/important.txt with the text "CHANGED". Then review your recent actions and UNDO that write so the file goes back to its original content. Verify the file says ORIGINAL again at the end.',
        maxSteps: 14,
        check: ({ usedTools }) => { const c = read('J1/important.txt') || ''; return /ORIGINAL/.test(c) && !/CHANGED/.test(c) && usedTools.includes('undo_action'); },
    });
    add('J2', 'J', 'Review recent actions', {
        setup: () => mkdir('J2'),
        prompt: 'Create a file J2/log.txt containing "hello", then use your action-review capability to list your recent actions, and write a one-line note to J2/review.txt confirming that creating J2/log.txt shows up in your action history.',
        maxSteps: 12,
        check: ({ usedTools }) => exists('J2/log.txt') && usedTools.includes('review_actions') && exists('J2/review.txt'),
    });
    add('J3', 'J', 'Verify own work by reading back', {
        setup: () => mkdir('J3'),
        prompt: 'Write the number 42 into J3/value.txt, then read the file back to verify it actually contains 42, and write "VERIFIED" into J3/check.txt only after confirming.',
        check: ({ usedTools }) => /42/.test(read('J3/value.txt') || '') && /VERIFIED/.test(read('J3/check.txt') || '') && usedTools.includes('read_file'),
    });
    add('J4', 'J', 'Recover from a failing command', {
        setup: () => mkdir('J4'),
        prompt: 'Try to read the file J4/missing.txt (it does not exist yet — the read will fail). When it fails, recover by creating J4/missing.txt with the text "recovered", then read it successfully and confirm.',
        maxSteps: 12,
        check: () => /recovered/.test(read('J4/missing.txt') || ''),
    });
    add('J5', 'J', 'Back up a file before modifying', {
        setup: () => put('J5/config.ini', 'mode=safe\nlevel=1\n'),
        prompt: 'Before changing anything, make a backup copy of J5/config.ini at J5/config.ini.bak. Then change "level=1" to "level=2" in J5/config.ini. The backup must still show the original level=1.',
        check: () => { const bak = read('J5/config.ini.bak') || '', cur = read('J5/config.ini') || ''; return /level=1/.test(bak) && /level=2/.test(cur); },
    });

    return T;
}

// =====================================================================
(async () => {
    let model = process.argv[2];
    if (!model) {
        const r = await fetch(`${LMS}/v1/models`).then(x => x.json()).catch(() => null);
        const ids = (r?.data || []).map(d => d.id).filter(id => !/embed/i.test(id));
        model = ids.find(id => /gemma|qwen|llama|mistral/i.test(id)) || ids[0];
    }
    if (!model) { console.error('No model available at ' + LMS); process.exit(2); }

    WS = fs.mkdtempSync(path.join(os.tmpdir(), 'agent100-ws-'));
    projectContext.setRoot(WS);
    // route memory embeddings through the LMS server as a fallback if Ollama is down
    if (memory.setLlmBase) memory.setLlmBase(LMS);

    let tasks = makeTasks();
    const cats = (process.env.CATS || '').split(',').map(s => s.trim()).filter(Boolean);
    const only = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
    if (cats.length) tasks = tasks.filter(t => cats.includes(t.cat));
    if (only.length) tasks = tasks.filter(t => only.includes(t.id));
    if (process.env.SMOKE) { const seen = new Set(); tasks = tasks.filter(t => { if (seen.has(t.cat)) return false; seen.add(t.cat); return true; }); }
    const defMax = parseInt(process.env.MAXSTEPS || '10', 10);

    const CATNAMES = { A: 'Files & documents', B: 'Text & data', C: 'Coding / dev', D: 'System / ops', E: 'Web / research', F: 'Productivity', G: 'Memory / personalization', H: 'Math / utilities', I: 'Search / discovery', J: 'Safety / trust' };
    console.log(`\n=== Agent Mode — Top-100 Assistant Task Battery ===`);
    console.log(`  model:    ${model}`);
    console.log(`  endpoint: ${LMS}`);
    console.log(`  workspace:${WS}`);
    console.log(`  tasks:    ${tasks.length}\n`);

    const results = [];
    let pass = 0, fail = 0, softFail = 0;
    const t0 = Date.now();
    for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        try { t.setup && t.setup(); } catch (e) { console.log(`   setup error: ${e.message}`); }
        const started = Date.now();
        process.stdout.write(`[${i + 1}/${tasks.length}] ${t.id} ${t.title} ... `);
        let r;
        try { r = await runTask({ model, prompt: t.prompt, check: t.check, maxSteps: t.maxSteps || defMax }); }
        catch (e) { r = { ok: false, why: 'crash: ' + e.message, usedTools: [], check: false }; }
        const sideOk = r.check !== false;
        const textOk = !t.judgeText || t.judgeText(r.lastText || '');
        const ok = r.ok && sideOk && textOk;
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        if (ok) { pass++; console.log(`PASS (${secs}s, ${r.steps || '?'} steps)`); }
        else if (t.soft) { softFail++; console.log(`soft-FAIL (${secs}s) [informational — ${r.why || 'web/search dependent'}]`); }
        else { fail++; console.log(`FAIL (${secs}s) [${r.why || (!sideOk ? 'side-effect' : 'recall-text')}; tools: ${r.usedTools.join(',') || 'none'}]`); }
        results.push({ id: t.id, cat: t.cat, title: t.title, ok, soft: !!t.soft, sideOk, textOk, secs: +secs, steps: r.steps, tools: r.usedTools, why: r.why || null, said: (r.lastText || '').replace(/\s+/g, ' ').slice(0, 160) });
    }
    const totalSecs = ((Date.now() - t0) / 1000).toFixed(0);

    // Per-category rollup
    console.log(`\n────────────────────────────────────────────────────────`);
    console.log(`Per-category results:`);
    for (const c of Object.keys(CATNAMES)) {
        const cr = results.filter(x => x.cat === c);
        if (!cr.length) continue;
        const p = cr.filter(x => x.ok).length;
        console.log(`  ${c} ${CATNAMES[c].padEnd(26)} ${p}/${cr.length}` + (cr.some(x => x.soft && !x.ok) ? '  (+soft fails informational)' : ''));
    }
    console.log(`────────────────────────────────────────────────────────`);
    console.log(`TOTAL: ${pass} passed, ${fail} failed${softFail ? `, ${softFail} soft-fail (informational)` : ''}  of ${tasks.length}  in ${totalSecs}s`);
    if (fail) {
        console.log(`\nHard failures:`);
        for (const x of results.filter(r => !r.ok && !r.soft)) console.log(`  ✗ ${x.id} ${x.title} — ${x.why || (!x.sideOk ? 'wrong side-effect' : 'recall text')} [tools: ${x.tools.join(',') || 'none'}]`);
    }

    if (process.env.OUT) {
        try { fs.writeFileSync(process.env.OUT, JSON.stringify({ model, endpoint: LMS, totalSecs: +totalSecs, pass, fail, softFail, results }, null, 2)); console.log(`\nWrote ${process.env.OUT}`); } catch (e) { console.log('OUT write failed: ' + e.message); }
    }

    try { fs.rmSync(WS, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch {}
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
