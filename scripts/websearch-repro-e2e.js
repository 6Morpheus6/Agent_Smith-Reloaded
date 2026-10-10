#!/usr/bin/env electron
/**
 * v55.5 repro: drive the REAL app (main.js + renderer) with gemma4-12b in AGENT mode,
 * ask it to use web_search, and capture what the tool actually returns.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const TMP_USERDATA = path.join(os.tmpdir(), 'agentsmith-websearch-userdata');
fs.mkdirSync(TMP_USERDATA, { recursive: true });
app.setPath('userData', TMP_USERDATA);
const INDEX_HTML = path.resolve(__dirname, '..', 'index.html');

const RESULT_FILE = process.env.RESULT_FILE || '/tmp/websearch_result.txt';
try { fs.writeFileSync(RESULT_FILE, ''); } catch {}
function logLine(...args) {
    const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    try { fs.writeSync(2, line + '\n'); } catch {}
    try { fs.appendFileSync(RESULT_FILE, line + '\n'); } catch {}
}

const LMS = process.env.LMS_URL || 'http://localhost:1234';
const MODEL = process.env.MODEL || 'gemma4-12b-qat-uncensored-hauhaucs-balanced';
const CREDS = { username: 'e2e', password: 'e2e-pass-1234' };

require(path.resolve(__dirname, '..', 'main.js'));

function ev(win, code, timeoutMs = 0) {
    const p = win.webContents.executeJavaScript(code, true);
    if (!timeoutMs) return p;
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('ev timeout')), timeoutMs))]);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForWindow() {
    for (let i = 0; i < 120; i++) {
        const { BrowserWindow } = require('electron');
        const w = BrowserWindow.getAllWindows()[0];
        if (w) { try { await w.loadFile(INDEX_HTML); } catch {} return w; }
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
    throw new Error('renderer DOM not ready');
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
        return JSON.stringify({ base:(typeof currentApiBase!=='undefined'?currentApiBase:'?'),
            opts:[...document.getElementById('model-select').options].map(o=>o.value) });
    })()`, 30000);
    logLine('[model diag]', diag);
    for (let i = 0; i < 60; i++) {
        const found = await ev(win, `(()=>{
            const s=document.getElementById('model-select');
            const opts=[...s.options].filter(o=>o.value && o.value!=='Scanning...' && !o.disabled);
            let opt = opts.find(o=>o.value===${JSON.stringify(MODEL)}) || opts.find(o=>!/embed/i.test(o.value)) || opts[0];
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

(async () => {
    try {
        const win = await waitForWindow();
        // capture renderer console (search errors land here)
        win.webContents.on('console-message', (e, level, message) => logLine('[renderer]', message.slice(0, 500)));
        await ensureReadyDom(win);
        await authenticate(win);
        const m = await selectModel(win);
        logLine('[websearch-e2e] model selected:', m);

        // ctx gate check: what does the app think about this model's context?
        const ctxInfo = await ev(win, `(async()=>{
            try {
                const st = await window.api.invoke('lmstudio-get-status');
                return JSON.stringify(st).slice(0, 400);
            } catch(e){ return 'status-err:'+e.message; }
        })()`, 15000);
        logLine('[ctx status]', ctxInfo);

        const agent = await enableAgentMode(win);
        logLine('[websearch-e2e] agent mode:', agent);

        // THE TEST: ask it to use the web tool.
        const prompt = 'Use your web_search tool right now to search for "latest news about the James Webb Space Telescope". Then tell me what you found in a few sentences.';
        logLine('[websearch-e2e] sending prompt…');
        await ev(win, `(()=>{
            const u=document.getElementById('user-input');
            u.value=${JSON.stringify(prompt)};
            document.getElementById('send-btn').click();
            return true;
        })()`);

        // poll until idle (web_search deep research can take minutes)
        const deadline = Date.now() + 600000;
        let lastBusy = false;
        while (Date.now() < deadline) {
            await sleep(3000);
            const busy = await ev(win, `!!(window.XKRunState && window.XKRunState.chatRunState && window.XKRunState.chatRunState.isBusy)`).catch(() => false);
            if (busy !== lastBusy) logLine('[websearch-e2e] busy:', busy);
            lastBusy = busy;
            if (!busy) break;
        }

        const transcript = await ev(win, `(document.getElementById('messages')||{}).innerText || ''`);
        fs.writeFileSync('/tmp/websearch_transcript.txt', transcript);
        logLine('[websearch-e2e] === TRANSCRIPT (tail 3000 chars) ===');
        logLine(transcript.slice(-3000));

        const failed = /Web search failed|backend could not be reached/i.test(transcript);
        const hasReport = /DEEP RESEARCH REPORT|Sources found/i.test(transcript);
        logLine('[websearch-e2e] RESULT: ' + (failed ? 'FAIL — web_search errored' : (hasReport ? 'PASS — deep research report produced' : 'UNKNOWN — check transcript')));
    } catch (e) {
        logLine('[websearch-e2e] HARNESS ERROR: ' + (e && e.stack || e));
    }
    app.quit();
    process.exit(0);
})();
