#!/usr/bin/env node
/**
 * Agent Mode end-to-end harness (headless).
 *
 * Wires the REAL main-process agent IPC handlers (src/main/ipc/agent.js) to the
 * REAL renderer-side tool dispatcher (src/renderer/modes/agentTools.js) through a
 * mock `api.invoke` that calls the registered ipcMain handlers directly. This
 * exercises the exact path Agent Mode uses to "manage the computer":
 *
 *     executeAgentChatTool(name,args) -> api.invoke(channel,...) -> ipcMain handler -> OS
 *
 * No Electron, no LM Studio, no GUI. Pure tool-surface verification against a
 * scratch workspace. Exit code is non-zero if any check fails.
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
const { executeAgentChatTool, toolsForChatMode, AGENT_SYS_TOOLS } = require(path.join(ROOT, 'src/renderer/modes/agentTools.js'));

// --- Fake ipcMain: capture (channel -> handler) -----------------------------
const handlers = new Map();
const fakeIpcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
};

// --- Build deps exactly like main.js does -----------------------------------
const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-data-'));
const changeLedger = new ChangeLedger(userDataPath);
const editEngine = new EditEngine(changeLedger, projectContext);
const { createActionLog } = require(path.join(ROOT, 'src/main/services/actionLog.js'));
const actionLog = createActionLog({ userDataPath });
const state = { currentPlanId: null };
function relPathFromRoot(absPath) {
    const r = projectContext.getRootOrNull();
    return r ? path.relative(r, absPath) : absPath;
}

registerAgentIpc(fakeIpcMain, {
    fs, fsPromises, path, spawn, exec,
    projectContext, editEngine, changeLedger, verificationHarness,
    grepProject, hasRipgrep, globFiles, buildRepoMap, invalidateRepoMap,
    netGuard, relPathFromRoot, state, actionLog,
});

// --- Mock api.invoke -> registered handler ----------------------------------
const api = {
    async invoke(channel, ...args) {
        const fn = handlers.get(channel);
        if (!fn) throw new Error(`No IPC handler for channel: ${channel}`);
        return fn({}, ...args);
    },
};

// memory deps used by some agent tools (in-process fakes)
const memory = [];
const deps = {
    api,
    getSudoPassword: () => '',
    saveToMemory: async (text) => { memory.push({ text }); return { success: true }; },
    searchMemory: async (q) => memory.filter(m => m.text.includes(q)),
};

// --- Tiny assert harness ----------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ok  ${name}`); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const run = (name, args) => executeAgentChatTool(name, args, deps);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-ws-'));
    projectContext.setRoot(ws);
    console.log(`\nAgent Mode E2E — workspace: ${ws}\n`);

    // 1. Tool surface sanity: every advertised tool name must be dispatchable.
    const advertised = AGENT_SYS_TOOLS.map(t => t.function.name);
    check('agent tools advertised (>=10)', advertised.length >= 10, `got ${advertised.length}`);

    // 2. task_begin / task_complete
    check('task_begin', (await run('task_begin', { goal: 'g', plan: ['a'] })).includes('Task started'));
    check('task_complete', (await run('task_complete', { summary: 's' })).includes('completed'));

    // 3. write_file (full system control — create a file)
    const wf = await run('write_file', { filepath: 'hello.txt', content: 'hello world' });
    check('write_file', wf.includes('success') || wf.includes('written'), wf);
    check('write_file actually wrote', fs.existsSync(path.join(ws, 'hello.txt')));

    // 4. read_file
    const rf = await run('read_file', { filepath: 'hello.txt' });
    check('read_file returns content', rf === 'hello world', JSON.stringify(rf));

    // 5. list_directory
    const ld = await run('list_directory', { dirpath: '.' });
    check('list_directory lists hello.txt', ld.includes('hello.txt'), ld);

    // 6. grep_project
    await run('write_file', { filepath: 'sub/needle.js', content: 'const FINDME = 1;\nconst other = 2;\n' });
    const gp = await run('grep_project', { pattern: 'FINDME' });
    check('grep_project finds match', gp.includes('FINDME'), gp);

    // 7. glob_files
    const gf = await run('glob_files', { pattern: '**/*.js' });
    check('glob_files finds .js', gf.includes('needle.js'), gf);

    // 8. run_shell_command (foreground)
    const sc = await run('run_shell_command', { command: 'echo e2e_marker_123' });
    check('run_shell_command foreground stdout', sc.includes('e2e_marker_123'), sc);

    // 9. run_shell_command writes are visible to file tools (shell == full control)
    await run('run_shell_command', { command: 'echo from_shell > shellmade.txt' });
    check('shell-created file readable', (await run('read_file', { filepath: 'shellmade.txt' })).includes('from_shell'));

    // 10. background process + read_process_log + list/stop
    const bg = await run('run_shell_command', { command: 'for i in 1 2 3; do echo line_$i; sleep 0.3; done', is_background: true });
    const jobMatch = bg.match(/Job ID: (\d+)/);
    check('background job started', !!jobMatch, bg);
    if (jobMatch) {
        const jobId = jobMatch[1];
        await sleep(700);
        const log = await run('read_process_log', { job_id: jobId, lines: 50 });
        check('read_process_log captures output', log.includes('line_1'), log);
        const lp = await run('list_processes', {});
        check('list_processes shows job', lp.includes(`Job ${jobId}`), lp);
        const sp = await run('stop_process', { job_id: jobId });
        check('stop_process succeeds', sp.toLowerCase().includes('kill') || sp.toLowerCase().includes('stop'), sp);
    }

    // 11. send_input to an interactive background process
    const cat = await run('run_shell_command', { command: 'cat', is_background: true });
    const catJob = cat.match(/Job ID: (\d+)/);
    if (catJob) {
        await run('send_input', { job_id: catJob[1], input: 'echoed_input' });
        await sleep(300);
        const catLog = await run('read_process_log', { job_id: catJob[1] });
        check('send_input reaches process', catLog.includes('echoed_input'), catLog);
        await run('stop_process', { job_id: catJob[1] });
    }

    // 12. delete_file
    await run('delete_file', { filepath: 'hello.txt' });
    check('delete_file removes file', !fs.existsSync(path.join(ws, 'hello.txt')));

    // 13. provide_file_download_link
    const dl = await run('provide_file_download_link', { filepath: path.join(ws, 'shellmade.txt') });
    check('provide_file_download_link builds link', dl.includes('/download_remote?file='), dl);

    // 14. memory tools
    check('save_new_user_fact_only', (await run('save_new_user_fact_only', { text: 'user likes e2e' })).includes('stored'));
    check('memory_search recalls', (await run('memory_search', { query: 'e2e' })).includes('user likes e2e'));

    // 15. command policy still blocks catastrophic commands in agent mode
    const blocked = await run('run_shell_command', { command: 'rm -rf /' });
    check('catastrophic command blocked', blocked.toLowerCase().includes('blocked') || blocked.toLowerCase().includes('safety'), blocked);

    // 16. unknown tool returns guidance, not a throw
    const unk = await run('totally_made_up_tool', {});
    check('unknown tool handled gracefully', typeof unk === 'string' && unk.includes('Unknown tool'), unk);

    // 17. whole-host reach: can the agent read a file OUTSIDE the workspace?
    //     ("manage everything" expectation)
    const outside = path.join(os.tmpdir(), `agent-e2e-outside-${process.pid}.txt`);
    fs.writeFileSync(outside, 'outside_root_content');
    const ro = await run('read_file', { filepath: outside });
    check('read_file reaches outside project root', ro.includes('outside_root_content'), ro);
    try { fs.unlinkSync(outside); } catch {}

    // 18. whole-host WRITE then DELETE outside the workspace
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-host-'));
    const outFile = path.join(outDir, 'managed.conf');
    const ww = await run('write_file', { filepath: outFile, content: 'managed=1' });
    check('write_file reaches outside project root', fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8') === 'managed=1', ww);
    const lod = await run('list_directory', { dirpath: outDir });
    check('list_directory reaches outside project root', lod.includes('managed.conf'), lod);
    const wd = await run('delete_file', { filepath: outFile });
    check('delete_file reaches outside project root', !fs.existsSync(outFile), wd);
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}

    // 19. path-safety guard: refuse wiping a critical root, even with whole-host access
    const critical = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    const dblock = await run('delete_file', { filepath: critical });
    check('delete_file blocks critical system root', /safety policy/i.test(dblock) && fs.existsSync(critical), dblock);
    const dblockRoot = await run('delete_file', { filepath: process.platform === 'win32' ? 'C:\\' : '/' });
    check('delete_file blocks "/"', /safety policy/i.test(dblockRoot), dblockRoot);
    const wblock = await run('write_file', { filepath: critical, content: 'x' });
    check('write_file blocks critical system root', /safety policy/i.test(wblock), wblock);

    // 20. Action log (trust layer): writes/deletes are recorded and undoable.
    await run('write_file', { filepath: 'audit.txt', content: 'v1' });
    await run('write_file', { filepath: 'audit.txt', content: 'v2' });
    const acts = actionLog.list({ limit: 10 });
    check('action log recorded the writes', acts.some(a => /audit\.txt/.test(a.summary)), JSON.stringify(acts.slice(0, 3)));
    const overwrite = acts.find(a => a.type === 'write_file' && /audit\.txt/.test(a.summary) && a.reversible);
    check('overwrite is reversible', !!overwrite, JSON.stringify(acts.slice(0, 3)));
    if (overwrite) {
        actionLog.undo(overwrite.id);
        check('undo restored previous file content', fs.readFileSync(path.join(ws, 'audit.txt'), 'utf8') === 'v1', fs.readFileSync(path.join(ws, 'audit.txt'), 'utf8'));
    }
    const shellAct = actionLog.list({ limit: 50 }).find(a => a.type === 'shell');
    check('shell commands are audited', !!shellAct);

    console.log(`\n──────────────────────────────────────`);
    console.log(`Agent Mode E2E: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('');

    // cleanup
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch {}

    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
