#!/usr/bin/env electron
/**
 * Agent Mode IN-APP end-to-end — drives the REAL Electron app.
 *
 * This is NOT a reimplementation of the agent loop (that's agent-live-e2e.js).
 * It boots the actual app by require('./main.js') — real main process, real IPC,
 * real auth — then drives the real renderer (src/renderer/app.js) through its DOM
 * exactly as a user would: log in, point at the model server, pick a model, flip
 * AGENT mode on, type a task, hit send. The genuine renderer agent loop runs
 * (pruneChatHistory, extractTextToolCalls incl. the Qwen-XML fix, anti-loop guard,
 * native streaming, tool dispatch through real IPC to the real OS). Success is
 * judged by side effects on disk + the rendered transcript.
 *
 * Run:  LMS_URL=http://127.0.0.1:11434 MODEL=qwen3-coder:30b \
 *         node_modules/.bin/electron scripts/agent-inapp-e2e.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// Use a throwaway userData so we control auth/model state and never touch the
// user's real profile. MUST be set before main.js reads app.getPath('userData').
const { app } = require('electron');
// Stable throwaway userData so cloudflared (downloaded by main.js's web UI) and
// auth state are cached across runs instead of re-downloaded every time.
const TMP_USERDATA = path.join(os.tmpdir(), 'agentsmith-inapp-userdata');
fs.mkdirSync(TMP_USERDATA, { recursive: true });
app.setPath('userData', TMP_USERDATA);
const INDEX_HTML = path.resolve(__dirname, '..', 'index.html');

// Synchronous write to stderr (fd 2): survives process.exit() truncation and is
// captured by the background task's output pipe even when the sandbox FS is
// ephemeral. Plain console.log/error to a pipe gets truncated on exit.
const RESULT_FILE = process.env.RESULT_FILE || '/tmp/inapp_result.txt';
function logLine(...args) {
    const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    try { fs.writeSync(2, line + '\n'); } catch {}
    try { fs.appendFileSync(RESULT_FILE, line + '\n'); } catch {}
}

const LMS = process.env.LMS_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.MODEL || 'qwen3-coder:30b';
const CREDS = { username: 'e2e', password: 'e2e-pass-1234' };
const BASE_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmith-inapp-ws-'));

// Boot the real application (registers IPC, creates the BrowserWindow on ready).
require(path.resolve(__dirname, '..', 'main.js'));

// ---- driver helpers --------------------------------------------------------
function ev(win, code, timeoutMs = 0) {
    // executeJavaScript resolves to whatever the (async) expression returns.
    const p = win.webContents.executeJavaScript(code, true);
    if (!timeoutMs) return p;
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('ev timeout')), timeoutMs))]);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForWindow() {
    for (let i = 0; i < 120; i++) {
        const { BrowserWindow } = require('electron');
        const w = BrowserWindow.getAllWindows()[0];
        if (w) {
            // main.js resolves loadFile('index.html') relative to this script's dir
            // (wrong appPath) → ERR_FILE_NOT_FOUND. Force the correct absolute file.
            try { await w.loadFile(INDEX_HTML); } catch (e) {}
            return w;
        }
        await sleep(250);
    }
    throw new Error('app window never created');
}

async function ensureReadyDom(win) {
    for (let i = 0; i < 80; i++) {
        const ok = await ev(win, `!!(document.getElementById('send-btn') && document.getElementById('model-select') && typeof checkAuth==='function' && window.XKRunState)`);
        if (ok) return;
        await sleep(250);
    }
    const diag = await ev(win, `JSON.stringify({
        url: location.href,
        sendBtn: !!document.getElementById('send-btn'),
        modelSelect: !!document.getElementById('model-select'),
        checkAuth: typeof checkAuth,
        XKRunState: !!window.XKRunState,
        XKAgentTools: !!window.XKAgentTools,
        bodyLen: (document.body && document.body.innerHTML.length) || 0
    })`).catch(e => 'diag-failed: ' + e.message);
    throw new Error('renderer DOM not ready — ' + diag);
}

async function authenticate(win) {
    await ev(win, `(async()=>{
        try { await window.api.invoke('auth-register', ${JSON.stringify(CREDS)}); } catch(e){}
        const r = await window.api.invoke('auth-login', ${JSON.stringify(CREDS)});
        if(!r||!r.success) return 'login-failed:'+(r&&r.error);
        authToken = r.token; localStorage.setItem('auth_token', r.token);
        await checkAuth();
        return 'ok';
    })()`, 30000);
    // wait until login overlay hidden
    for (let i = 0; i < 40; i++) {
        const hidden = await ev(win, `getComputedStyle(document.getElementById('login-overlay')).display === 'none'`);
        if (hidden) return;
        await sleep(250);
    }
    throw new Error('login overlay did not hide');
}

async function selectModel(win) {
    const diag = await ev(win, `(async()=>{
        const inp=document.getElementById('lms-server-input');
        inp.value=${JSON.stringify(LMS)};
        try { if(typeof updateApiBase==='function') updateApiBase(); else inp.dispatchEvent(new Event('change')); } catch(e){}
        try { if(typeof fetchModels==='function') await fetchModels(); } catch(e){}
        let probe='';
        try { const r=await fetch((typeof currentApiBase!=='undefined'?currentApiBase:'')+'/v1/models',{headers:{Authorization:'Bearer lm-studio'}}); probe=r.status+' ok='+r.ok; }
        catch(e){ probe='ERR '+e.message; }
        return JSON.stringify({ base:(typeof currentApiBase!=='undefined'?currentApiBase:'?'), probe,
            opts:[...document.getElementById('model-select').options].map(o=>o.value) });
    })()`, 30000);
    logLine('[model diag]', diag);
    for (let i = 0; i < 60; i++) {
        const found = await ev(win, `(()=>{
            const s=document.getElementById('model-select');
            const opts=[...s.options].filter(o=>o.value && o.value!=='Scanning...' && !o.disabled);
            // exact match first, then any non-embedding model, then first option
            let opt = opts.find(o=>o.value===${JSON.stringify(MODEL)})
                   || opts.find(o=>!/embed/i.test(o.value))
                   || opts[0];
            if(opt){ s.value=opt.value; s.dispatchEvent(new Event('change')); return s.value; }
            return '';
        })()`);
        if (found) return found;
        await sleep(500);
    }
    throw new Error('model not available in dropdown: ' + MODEL);
}

async function enableAgentMode(win) {
    return ev(win, `(()=>{
        const c=document.getElementById('code-mode-toggle'); if(c&&c.checked){c.checked=false;c.dispatchEvent(new Event('change'));}
        const a=document.getElementById('agent-toggle');
        if(!a) return 'no-toggle';
        if(a.disabled) return 'agent-disabled';
        if(!a.checked){ a.checked=true; a.dispatchEvent(new Event('change')); }
        return a.checked ? 'agent-on' : 'agent-off';
    })()`);
}

async function setWorkspace(win, dir) {
    return ev(win, `window.api.invoke('project-set-root', ${JSON.stringify(dir)})`);
}

async function sendAndWait(win, prompt, maxMs) {
    await ev(win, `(()=>{
        const u=document.getElementById('user-input');
        u.value=${JSON.stringify(prompt)};
        document.getElementById('send-btn').click();
        return true;
    })()`);
    // give it a moment to flip busy, then poll until idle
    await sleep(1500);
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const busy = await ev(win, `!!(window.XKRunState && window.XKRunState.chatRunState && window.XKRunState.chatRunState.isBusy)`);
        if (!busy) break;
        await sleep(1500);
    }
    const transcript = await ev(win, `(document.getElementById('messages')||{}).innerText || ''`);
    return transcript;
}

// ---- tasks (hard, real-world Agent-Mode asks; judged by side effects) -------
function makeTasks() {
    const t = (name, setup, prompt, check, maxMs = 300000) => ({ name, setup, prompt, check, maxMs });
    return [
        t('T1 scaffold+run a node project',
            (ws) => {},
            'Create a new Node project inside a subfolder called app: write app/package.json with name "demo", and app/index.js that prints the sum of 2 and 3. Then run it with node and show me the output. Verify the program prints 5.',
            (ws) => {
                try {
                    const pkg = JSON.parse(fs.readFileSync(path.join(ws, 'app/package.json'), 'utf8'));
                    const out = execSync('node app/index.js', { cwd: ws, timeout: 8000 }).toString();
                    return pkg.name === 'demo' && /(^|\D)5(\D|$)/.test(out.trim());
                } catch { return false; }
            }),

        t('T2 find+fix a broken shell script',
            (ws) => {
                fs.writeFileSync(path.join(ws, 'run.sh'), '#!/bin/bash\n# should print 1 2 3 4 5\nfor i in 1 2 3 4 5; do\n  echo -n "$j "\ndone\necho\n');
                try { execSync('chmod +x run.sh', { cwd: ws }); } catch {}
            },
            'The script run.sh in this folder is supposed to print the numbers 1 2 3 4 5 but it prints blanks. Find the bug, fix run.sh, and run it to prove it now prints 1 2 3 4 5.',
            (ws) => {
                try { const out = execSync('bash run.sh', { cwd: ws, timeout: 8000 }).toString().replace(/\s+/g, ' ').trim(); return out === '1 2 3 4 5'; }
                catch { return false; }
            }),

        t('T3 largest-file triage',
            (ws) => {
                fs.writeFileSync(path.join(ws, 'small.txt'), 'x'.repeat(100));
                fs.writeFileSync(path.join(ws, 'medium.txt'), 'y'.repeat(5000));
                fs.writeFileSync(path.join(ws, 'BIG.dat'), 'z'.repeat(50000));
                fs.writeFileSync(path.join(ws, 'tiny.md'), '# hi\n');
            },
            'Find which file in this directory is the largest and what its size is. Then write the name of that largest file to a new file called answer.txt.',
            (ws) => {
                try { return /BIG\.dat/.test(fs.readFileSync(path.join(ws, 'answer.txt'), 'utf8')); }
                catch { return false; }
            }),

        t('T4 organize files into folders by extension',
            (ws) => {
                ['a.txt', 'b.txt', 'notes.md', 'readme.md', 'data.json'].forEach(f => fs.writeFileSync(path.join(ws, f), f));
            },
            'Organize the files in this directory into subfolders by their extension: put all .txt files into a folder named txt/, all .md files into md/, and all .json files into json/. Move them, do not copy. Then list the directory to confirm.',
            (ws) => {
                try {
                    const ok = (p) => fs.existsSync(path.join(ws, p));
                    return ok('txt/a.txt') && ok('txt/b.txt') && ok('md/notes.md') && ok('md/readme.md') && ok('json/data.json')
                        && !ok('a.txt') && !ok('notes.md') && !ok('data.json');
                } catch { return false; }
            }),

        t('T5 log analysis: count ERROR lines',
            (ws) => {
                const lines = [];
                for (let i = 0; i < 40; i++) lines.push(i % 7 === 0 ? `ERROR something failed ${i}` : `INFO ok ${i}`);
                fs.writeFileSync(path.join(ws, 'app.log'), lines.join('\n') + '\n'); // ERRORs at 0,7,14,21,28,35 => 6
            },
            'The file app.log contains log lines. Count exactly how many lines contain the word ERROR, then write just that number to a file called error_count.txt.',
            (ws) => {
                try { return fs.readFileSync(path.join(ws, 'error_count.txt'), 'utf8').replace(/\D/g, '') === '6'; }
                catch { return false; }
            }),
    ];
}

(async () => {
    const results = [];
    try {
        const win = await waitForWindow();
        win.webContents.on('console-message', () => {}); // keep quiet
        await ensureReadyDom(win);
        await authenticate(win);
        logLine('[inapp] authenticated; selecting model…');
        let m = null;
        try { m = await selectModel(win); logLine('[inapp] model selected:', m); }
        catch (e) { logLine('[inapp] selectModel failed: ' + e.message); }
        if (process.env.INAPP_PROBE_ONLY) {
            logLine('[inapp] PROBE DONE');
            if (process.env.INAPP_PROBE_HOLD) { await sleep(Number(process.env.INAPP_PROBE_HOLD) * 1000); }
            app.quit(); process.exit(0);
        }
        if (!m) throw new Error('no model selected');

        const tasks = makeTasks();
        for (const task of tasks) {
            const ws = fs.mkdtempSync(path.join(BASE_WS, 'task-'));
            try { task.setup(ws); } catch (e) { console.log('  setup error', e.message); }
            // fresh chat per task: reload renderer, re-auth (token persists), re-config
            await win.loadFile(INDEX_HTML);
            await sleep(800);
            await ensureReadyDom(win);
            await authenticate(win);
            await selectModel(win);
            await setWorkspace(win, ws);
            const agent = await enableAgentMode(win);
            logLine(`\n▶ ${task.name}  [agent:${agent}]`);

            let transcript = '';
            try { transcript = await sendAndWait(win, task.prompt, task.maxMs); }
            catch (e) { transcript = 'SEND ERROR: ' + e.message; }

            let pass = false;
            try { pass = !!task.check(ws); } catch (e) { pass = false; }
            results.push({ name: task.name, pass });
            const tail = transcript.replace(/\s+/g, ' ').trim().slice(-260);
            logLine(`   transcript tail: …${tail}`);
            logLine(`   => ${pass ? 'PASS' : 'FAIL'}`);
        }
    } catch (e) {
        logLine('[inapp] HARNESS ERROR: ' + (e && e.stack || e));
    }

    const pass = results.filter(r => r.pass).length;
    logLine('\n──────────────────────────────────────');
    logLine(`Agent Mode IN-APP E2E: ${pass}/${results.length} passed  (model: ${MODEL})`);
    results.forEach(r => logLine(`   ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`));
    try { fs.rmSync(BASE_WS, { recursive: true, force: true }); } catch {}
    app.quit();
    process.exit(results.length && pass === results.length ? 0 : 1);
})();
