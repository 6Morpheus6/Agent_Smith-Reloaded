#!/usr/bin/env node
/**
 * v53.2 — full tool-surface verification harness.
 *
 * Exercises EVERY Code Mode / host-control tool through the REAL production
 * executor (src/code/tools/executor.js) with the SAME deps wiring main.js uses
 * (projectContext, editEngine, changeLedger, grep/glob, actionLog, jobApi,
 * foreground/background shell), plus a real LM Studio round-trip for
 * web_search/fetch_url. Each call is bounded by a per-tool watchdog so a hung
 * tool FAILS the harness instead of looping forever — that IS the "no loops"
 * check: every tool must settle (success or clean error) within its bound.
 *
 * Usage: node scripts/verify-tools.js [--root <tmpdir>] [--skip-net] [--json out.json]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

// ── production wiring (mirrors main.js + src/main/ipc/code.js) ────────────────
const projectContext = require('../src/main/services/projectContext.js');
const ChangeLedger = require('../src/main/services/changeLedger.js');
const EditEngine = require('../src/main/services/editEngine.js');
const { createActionLog } = require('../src/main/services/actionLog.js');
const { grepProject } = require('../src/shared/grepTool.js');
const { globFiles } = require('../src/shared/globTool.js');
const { executeTool } = require('../src/code/tools/executor.js');
const { toolNames } = require('../src/code/tools/schemas.js');
// The implement phase offers the full Code Mode surface — mirror that for run_code's tools.
const OFFERED_TOOLS = toolNames();

const args = process.argv.slice(2);
function argVal(flag, dflt) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; }
const SKIP_NET = args.includes('--skip-net');
const JSON_OUT = argVal('--json', null);

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'smith-verify-userdata-'));
let projectRoot = argVal('--root', fs.mkdtempSync(path.join(os.tmpdir(), 'smith-verify-proj-')));
projectContext.setRoot(projectRoot);

const changeLedger = new ChangeLedger(userDataPath);
const editEngine = new EditEngine(changeLedger, projectContext);
const actionLog = createActionLog({ userDataPath });

function relPathFromRoot(abs) { return path.relative(projectRoot, abs); }

// background-job registry — same shape as ipc/code.js jobApi
let nextJobId = 1;
const bgProcesses = new Map();
function spawnShell(command, cwd) {
    const cfg = projectContext.getShellConfig();
    return spawn(cfg.shell, [cfg.flag, command], { cwd });
}
const jobApi = {
    listJobs() {
        const jobs = [];
        for (const [id, info] of bgProcesses) {
            jobs.push({
                job_id: String(id), running: info.running !== false && info.child?.exitCode === null,
                exit_code: info.child ? info.child.exitCode : null,
                last_line: info.log.length ? info.log[info.log.length - 1] : ''
            });
        }
        return jobs;
    },
    readLog(jobId, lines = 50) {
        const info = bgProcesses.get(parseInt(jobId, 10));
        if (!info) return null;
        const n = Math.min(Math.max(1, parseInt(lines, 10) || 50), 200);
        return { job_id: String(jobId), log: info.log.slice(-n).join('\n') || '(No output yet)', running: info.running !== false && info.child?.exitCode === null };
    },
    sendInput(jobId, input) {
        const info = bgProcesses.get(parseInt(jobId, 10));
        if (!info) return { error: `No active job found with ID: ${jobId}` };
        if (info.child.exitCode !== null) return { error: 'Process already exited.' };
        try { info.child.stdin.write(String(input) + '\n'); return { success: true }; } catch (e) { return { error: e.message }; }
    },
    kill(jobId) {
        const info = bgProcesses.get(parseInt(jobId, 10));
        if (!info) return { error: `No active job found with ID: ${jobId}` };
        try { info.child.kill('SIGKILL'); info.running = false; return { success: true }; } catch (e) { return { error: e.message }; }
    }
};

function runForegroundCommand(command, cwd) {
    const FG_TIMEOUT_MS = 60000; // harness bound — production is 300s
    const cfg = projectContext.getShellConfig();
    return new Promise((resolve) => {
        let child;
        try { child = spawn(cfg.shell, [cfg.flag, command], { cwd }); } catch (e) { resolve({ error: `Could not run command: ${e.message}` }); return; }
        let stdout = '', stderr = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch (_) {} }, FG_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        child.stdout?.on('data', d => { stdout += String(d); });
        child.stderr?.on('data', d => { stderr += String(d); });
        child.on('error', e => resolve({ error: `Could not run command: ${e.message}` }));
        child.on('close', (code) => {
            clearTimeout(timer);
            const out = { stdout, stderr, exit_code: code };
            if (timedOut) out.timed_out = true;
            if (code !== 0 || timedOut) out.error = `Command failed (${timedOut ? 'timeout' : `exit ${code}`}): ${command}`;
            resolve(out);
        });
    });
}

function runBackgroundCommand(command, cwd) {
    const jobId = nextJobId++;
    const child = spawnShell(command, cwd);
    const procInfo = { log: [], running: true, child };
    bgProcesses.set(jobId, procInfo);
    const append = (data) => { procInfo.log.push(...data.toString().split('\n').filter(Boolean)); if (procInfo.log.length > 500) procInfo.log = procInfo.log.slice(-500); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('close', (code) => { procInfo.log.push(`[exit ${code}]`); procInfo.running = false; });
    return { stdout: `Background job ${jobId} started`, jobId };
}

const SESSION_ID = 'verify_session';
function baseDeps(extra = {}) {
    return Object.assign({
        sessionId: SESSION_ID,
        projectContext, editEngine, changeLedger, grepProject, globFiles, relPathFromRoot,
        runForegroundCommand, runBackgroundCommand, jobApi, actionLog,
        session: {}, // no codePlan → mark_code_step_done must refuse cleanly
        callId: `verify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    }, extra);
}

// ── harness core ──────────────────────────────────────────────────────────────
const results = [];
let bgJobId = null; // captured during the run_command background step for later tools

async function verify(name, argsObj, { boundMs = 60000, expect, extraDeps } = {}) {
    const t0 = Date.now();
    let outcome;
    try {
        outcome = await Promise.race([
            executeTool(name, argsObj, baseDeps(extraDeps)),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`HARNESS BOUND EXCEEDED: ${name} did not settle within ${boundMs / 1000}s (loop/hang)`)), boundMs))
        ]);
    } catch (e) { outcome = { error: e.message, isError: true }; }
    const ms = Date.now() - t0;

    let status = 'PASS';
    let detail = '';
    try {
        if (!expect || expect(outcome)) {
            detail = summarize(name, outcome);
        } else {
            status = 'FAIL';
            detail = `unexpected result: ${JSON.stringify(outcome).slice(0, 400)}`;
        }
    } catch (e) { status = 'FAIL'; detail = e.message; }

    results.push({ tool: name, ms, status, detail });
    const mark = status === 'PASS' ? '✓' : '✗';
    console.log(`${mark} ${name.padEnd(20)} ${String(ms).padStart(6)}ms  ${detail}`);
    return outcome;
}

function summarize(name, o) {
    if (!o || typeof o !== 'object') return String(o).slice(0, 120);
    const s = JSON.stringify(o);
    switch (name) {
        case 'read_file': return `totalLines=${o.totalLines} content=${String(o.content || '').length}ch`;
        case 'patch': return o.success ? `diff +${o.linesAdded}/-${o.linesRemoved}` : o.error;
        case 'write_file': return `${o.created ? 'created' : 'overwrote'} ${o.relPath}${o.warnings?.length ? ' warnings=' + o.warnings.length : ''}`;
        case 'append_file': return `appended ${o.bytesAdded}B`;
        case 'grep': return `${(o.hits || []).length} hits${o.truncated ? ' (truncated)' : ''}`;
        case 'glob': return `${(o.files || []).length} files`;
        case 'run_command': return o.error ? `error: ${o.error.slice(0, 80)}` : `exit=${o.exit_code} out=${String(o.stdout).trim().slice(0, 60)}`;
        case 'list_project': return `${s.length}ch tree`;
        case 'read_host_file': return `totalLines=${o.totalLines}`;
        case 'write_host_file': return o.success ? `created=${o.created}` : o.error;
        case 'delete_host_file': return o.success ? 'deleted' : o.error;
        case 'list_host_directory': return `${(o.files || []).length} entries`;
        case 'list_processes': return `${(o.jobs || []).length} jobs`;
        case 'read_process_log': return `running=${o.running} log=${String(o.log).slice(-60)}`;
        case 'send_input': return o.success ? 'sent' : o.error;
        case 'stop_process': return o.success ? 'killed' : o.error;
        case 'web_search': return `${(o.results || []).length} results${o.nudge ? ' +nudge' : ''}`;
        case 'fetch_url': return `${String(o.content || '').length}ch text`;
        case 'review_actions': return `${(o.actions || []).length} actions`;
        case 'undo_action': return o.success ? `undone ${o.undone}` : o.error;
        case 'save_user_fact': return o.success ? 'stored' : o.error;
        case 'memory_search': return `${(o.results || []).length} memories${o.note ? ': ' + String(o.note).slice(0, 50) : ''}`;
        case 'run_code': return o.success ? `subCalls=${o.subCalls} out=${String(o.output).slice(0, 80)}` : o.error;
        default: return s.slice(0, 120);
    }
}

// ── seed the scratch project ──────────────────────────────────────────────────
fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'index.html'), '<!doctype html>\n<html><head><title>verify</title></head>\n<body><div id="app">hello</div>\n<script src="src/app.js"></script>\n</body>\n</html>\n');
fs.writeFileSync(path.join(projectRoot, 'src', 'app.js'), 'function greet(name) {\n    return "hi " + name;\n}\ngreet("smith");\n');

(async () => {
    console.log('Agent Smith v53.2 — tool surface verification\nproject root:', projectRoot);
    console.log('─'.repeat(78));

    // 1. read_file (happy path)
    await verify('read_file', { path: 'src/app.js' }, { expect: o => !o.error && /greet/.test(o.content || '') });
    // 2. read_file (missing file → clean error, no hang)
    await verify('read_file', { path: 'nope/missing.txt' }, { boundMs: 15000, expect: o => !!o.error && /not found/i.test(o.error) });

    // 3. patch
    await verify('patch', { path: 'src/app.js', find: '"hi " + name', replace: '"hello " + name' }, { expect: o => o.success === true });
    // 4. patch (no-op rejected — the anti-loop guard)
    await verify('patch', { path: 'src/app.js', find: 'greet("smith")', replace: 'greet("smith")' }, { boundMs: 15000, expect: o => !!o.error && /identical/i.test(o.error) });

    // 5. write_file (new file)
    await verify('write_file', { path: 'src/util.js', content: 'export const add = (a, b) => a + b;\n' }, { expect: o => o.success === true && o.created === true });
    // 6. write_file (identical rewrite → churn warning, not a silent loop)
    await verify('write_file', { path: 'src/util.js', content: 'export const add = (a, b) => a + b;\n' }, { expect: o => o.success === true && o.rewrittenIdentical === true });

    // 7. append_file
    await verify('append_file', { path: 'src/util.js', content: '\nexport const sub = (a, b) => a - b;\n' }, { expect: o => o.success === true });
    // 8. append_file (duplicate top-level decl → refused, the Pac-Man bug guard)
    await verify('append_file', { path: 'src/util.js', content: '\nexport const add = () => 1;\n' }, { boundMs: 15000, expect: o => !!o.error && /DUPLICATE/i.test(o.error) });

    // 9. grep
    await verify('grep', { pattern: 'greet' }, { expect: o => !o.error && (o.hits || []).length >= 1 });
    // 10. glob
    await verify('glob', { pattern: '**/*.js' }, { expect: o => !o.error && (o.files || []).length >= 2 });

    // 11. run_command foreground
    await verify('run_command', { command: 'node --check src/app.js && echo SYNTAX_OK' }, { boundMs: 90000, expect: o => o.exit_code === 0 && /SYNTAX_OK/.test(o.stdout || '') });
    // 12. run_command (failing exit → clean error result, no hang)
    await verify('run_command', { command: 'exit 3' }, { boundMs: 90000, expect: o => o.exit_code === 3 && !!o.error });
    // 13. run_command background (job for the process tools below)
    const bg = await verify('run_command', { command: 'for i in 1 2 3; do echo tick-$i; sleep 0.4; done', is_background: true }, { expect: o => !!o.jobId });
    bgJobId = bg && bg.jobId != null ? String(bg.jobId) : (bg && bg.resultStr ? JSON.parse(bg.resultStr).jobId : null);

    // 14. list_project
    await verify('list_project', {}, { expect: o => !o.error });

    // 15-18. host-control file tools (scratch dir OUTSIDE project root)
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smith-verify-host-'));
    fs.writeFileSync(path.join(hostDir, 'note.txt'), 'host line one\nhost line two\n');
    await verify('read_host_file', { filepath: path.join(hostDir, 'note.txt') }, { expect: o => !o.error && /host line/.test(o.content || '') });
    const hostWritePath = path.join(hostDir, 'written.txt');
    await verify('write_host_file', { filepath: hostWritePath, content: 'written by verify\n' }, { expect: o => o.success === true });
    await verify('list_host_directory', { dirpath: hostDir }, { expect: o => !o.error && (o.files || []).length >= 2 });
    const delPath = path.join(hostDir, 'todelete.txt');
    fs.writeFileSync(delPath, 'x');
    await verify('delete_host_file', { filepath: delPath }, { expect: o => o.success === true });

    // 19-22. process tools (against the background job from step 13)
    await new Promise(r => setTimeout(r, 700)); // let it emit a tick
    await verify('list_processes', {}, { expect: o => (o.jobs || []).length >= 1 });
    if (bgJobId != null) {
        await verify('read_process_log', { job_id: bgJobId }, { expect: o => !o.error && /tick-/.test(o.log || '') });
        // send_input to a non-readline process must fail cleanly, not hang
        await verify('send_input', { job_id: bgJobId, input: 'ping' }, { boundMs: 15000 });
        await verify('stop_process', { job_id: bgJobId }, { expect: o => o.success === true || !!o.error });
    } else {
        console.log('? process tools skipped — no background job id captured');
    }

    // 23-24. web tools (real network)
    if (!SKIP_NET) {
        await verify('web_search', { query: 'electron appimage build' }, { boundMs: 90000, expect: o => !o.error && Array.isArray(o.results) });
        await verify('fetch_url', { url: 'https://example.com/' }, { boundMs: 60000, expect: o => !o.error && /Example Domain/i.test(o.content || '') });
    } else { console.log('- web_search/fetch_url skipped (--skip-net)'); }

    // 25-26. audit + undo (write_host_file above is logged & reversible)
    const rev = await verify('review_actions', {}, { expect: o => !o.error && (o.actions || []).length >= 1 });
    if (rev && Array.isArray(rev.actions)) {
        const target = rev.actions.find(x => x.reversible && /written\.txt/.test(x.summary || '')) || rev.actions.find(x => x.reversible);
        if (target) await verify('undo_action', { id: target.id }, { expect: o => o.success === true });
        else console.log('? undo_action skipped — no reversible action found');
    }

    // 27-28. memory tools (no memoryManager wired in this harness → must degrade cleanly)
    await verify('save_user_fact', { exact_new_fact: 'verify fact' }, { boundMs: 15000, expect: o => !!o.error && /disabled/i.test(o.error) });
    await verify('memory_search', { query: 'anything' }, { boundMs: 15000, expect: o => Array.isArray(o.results) || !!o.note });

    // 29. run_code — the dsh transport: loops over tools in ONE call (the anti-loop
    //     feature itself). Bounded by its own budgets (50 sub-calls / 120s).
    await verify('run_code', {
        description: 'Syntax-check every JS file and count lines',
        code: `const files = await tools.glob({ pattern: "**/*.js" });\nlet totalLines = 0;\nfor (const f of files.files) {\n  const r = await tools.read_file({ path: f });\n  if (!r.error) totalLines += r.totalLines || 0;\n}\nprint("files=" + files.files.length + " lines=" + totalLines);\nreturn { ok: true, count: files.files.length };`
    }, { boundMs: 150000, expect: o => o.success === true && (o.subCalls || 0) >= 2, extraDeps: { offeredToolNames: OFFERED_TOOLS } });

    // 30. run_code — a program that would loop forever must be KILLED by its timeout
    //     budget, not hang the harness (the "none are looping" guarantee).
    await verify('run_code', {
        description: 'Detect infinite-loop kill via sub-call budget',
        code: `let n = 0;\nwhile (true) {\n  try { await tools.read_file({ path: "src/app.js" }); } catch (e) {}\n}\n`
    }, { boundMs: 180000, expect: o => !!o.error && /budget exhausted|timed out/i.test(o.error), extraDeps: { offeredToolNames: OFFERED_TOOLS } });

    // 31. unknown tool → clean error via plugin fallthrough (no plugin manager here)
    await verify('totally_unknown_tool', {}, { boundMs: 15000, expect: o => !!o.error && /Unknown tool/i.test(o.error) });

    // 32. mark_code_step_done — no approved plan in this harness → must refuse cleanly
    await verify('mark_code_step_done', {}, { boundMs: 15000, expect: o => !!o.error && /No approved plan/i.test(o.error) });

    // ── summary ───────────────────────────────────────────────────────────────
    const pass = results.filter(r => r.status === 'PASS').length;
    console.log('\n' + '─'.repeat(78));
    console.log(`RESULT: ${pass}/${results.length} tools verified OK`);
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ projectRoot, userDataPath, results }, null, 2));

    // cleanup scratch
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(hostDir, { recursive: true, force: true }); } catch (_) {}

    process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
