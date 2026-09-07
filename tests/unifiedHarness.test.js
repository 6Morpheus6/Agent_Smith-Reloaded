/**
 * v50 unified-harness engine tests — the Agent Mode host-control tools now execute
 * INSIDE the Code Mode engine (one tool set, one loop). Proves with real fs + a fake
 * job registry:
 *   - host file read/write/delete/list run through executeTool (outside root),
 *   - pathPolicy still refuses catastrophic targets for host writes/deletes,
 *   - process tools drive the shared background-job registry via deps.jobApi,
 *   - audit tools (review_actions/undo_action) round-trip through a fake actionLog,
 *   - memory tools degrade gracefully without a memory adapter,
 *   - phases/router offer the host surface in every phase incl. write-only turn 1.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsNode = require('fs');
const fs = fsNode.promises;
const os = require('os');
const path = require('path');

const realpath = (p) => fsNode.realpathSync(p);

const { executeTool } = require('../src/code/tools/executor.js');
const { toolNames, HOST_TOOLS } = require('../src/code/tools/schemas.js');
const { allowedToolsForPhase, isToolAllowed } = require('../src/code/loop/phases.js');
const { selectToolsForTurn } = require('../src/code/tools/router.js');

// ── test doubles for the engine deps the host tools consume ────────────────────────
function makeActionLog() {
    const actions = new Map();
    let nextId = 1;
    return {
        MAX_UNDO_BYTES: 1024 * 64,
        entries: [],
        record(e) {
            const id = `a${nextId++}`;
            this.entries.push({ id, ...e });
            actions.set(id, { id, ...e });
            return id;
        },
        captureWriteUndo(absPath, existed, prevContent) {
            return { op: existed ? 'write' : 'create', path: absPath, content: prevContent };
        },
        list({ limit = 20 } = {}) {
            const all = [...actions.values()];
            return all.slice(-limit).reverse();
        },
        async undo(id) {
            const a = actions.get(id);
            if (!a) return { error: `No action ${id}` };
            if (a.undo && a.undo.op === 'write') {
                await fs.writeFile(a.path, a.undo.content ?? '', 'utf-8');
            } else if (a.undo && a.undo.op === 'create') {
                try { await fs.unlink(a.path); } catch (e) {}
            } else if (a.undo && a.undo.op === 'delete' && !a.undo.isDir) {
                await fs.writeFile(a.path, a.undo.content ?? '', 'utf-8');
            } else if (a.undo && a.undo.op === 'delete' && a.undo.isDir) {
                // dir deletes are undoable only via re-create; mark undone without content
            }
            return { success: true, summary: `${a.type} ${a.summary || ''}` };
        },
        actions() { return [...actions.values()]; }
    };
}

function makeJobApi() {
    const jobs = new Map();
    let nextId = 1;
    return {
        _spawn(cmd) {
            const id = nextId++;
            // fake child: emits a line then "exits" after one tick (no real process)
            const log = [`${cmd} started`];
            jobs.set(id, { log, running: true, exitCode: null, stdin: { write() {} }, kill() { this.exitCode = 9; } });
            return id;
        },
        listJobs() {
            const out = [];
            for (const [id, j] of jobs) {
                out.push({ job_id: String(id), running: j.running && j.exitCode === null, exit_code: j.exitCode, last_line: j.log[j.log.length - 1] || '' });
            }
            return out;
        },
        readLog(jobId, lines = 50) {
            const j = jobs.get(parseInt(jobId, 10));
            if (!j) return null;
            return { job_id: String(jobId), log: j.log.slice(-lines).join('\n'), running: j.running && j.exitCode === null, exit_code: j.exitCode };
        },
        sendInput(jobId, input) {
            const j = jobs.get(parseInt(jobId, 10));
            if (!j) return { error: `No active job found with ID: ${jobId}` };
            j.log.push(`input:${input}`);
            return { success: true };
        },
        kill(jobId) {
            const j = jobs.get(parseInt(jobId, 10));
            if (!j) return { error: `No active job found with ID: ${jobId}` };
            j.kill();
            j.running = false;
            return { success: true, stdout: `Job ${jobId} killed.` };
        }
    };
}

async function makeDeps(rootDir) {
    const projectContext = require('../src/main/services/projectContext.js');
    projectContext.setRoot(rootDir);
    const jobApi = makeJobApi();
    const actionLog = makeActionLog();
    return {
        sessionId: 'test_v50',
        projectContext,
        editEngine: null,
        changeLedger: { snapshotBefore: async () => null, recordCreate: async () => {} },
        grepProject: async () => ({ hits: [] }),
        globFiles: async () => ({ files: [] }),
        relPathFromRoot: (p) => p,
        fireHook: null,
        invokePluginTool: async () => ({ __notFound: true }),
        jobApi,
        actionLog,
        registerDownload: null,
        invalidateRepoMap: null,
        recallMemory: null,
        rememberMemory: null
    };
}

test('host tools are part of the unified tool surface', () => {
    const names = new Set(toolNames());
    for (const t of HOST_TOOLS) assert.ok(names.has(t), `missing ${t}`);
});

test('phases offer host tools in every phase; write-only turn keeps them too', () => {
    for (const phase of ['explore', 'implement', 'verify']) {
        const allowed = allowedToolsForPhase(phase);
        for (const t of HOST_TOOLS) assert.ok(allowed.includes(t), `${t} missing in ${phase}`);
        assert.equal(isToolAllowed('explore', 'web_search'), true, 'web available turn 1');
    }
    const n = selectToolsForTurn({ phase: 'implement', writeOnly: true }).map(s => s.function.name);
    assert.ok(n.includes('write_file'));
    assert.ok(n.includes('read_host_file'), 'host read survives write-only filter');
    assert.ok(!n.includes('read_file'), 'project read stays filtered on empty workspace turn 1');
});

test('executeTool: host file read/write/delete/list round-trip outside the project root', async () => {
    const proj = realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'v50-proj-')));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v50-outside-'));
    const deps = await makeDeps(proj);

    // write OUTSIDE root (the whole point of the merge)
    const target = path.join(outsideDir, 'note.txt');
    let r = await executeTool('write_host_file', { filepath: target, content: 'hello host' }, deps);
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(r.created, true);

    // read it back
    r = await executeTool('read_host_file', { filepath: target }, deps);
    assert.match(r.content, /1\|hello host/);

    // list the outside dir
    r = await executeTool('list_host_directory', { dirpath: outsideDir }, deps);
    assert.ok((r.files || []).join('\n').includes('note.txt'));

    // delete it
    r = await executeTool('delete_host_file', { filepath: target }, deps);
    assert.equal(r.error, undefined, JSON.stringify(r));
    let gone;
    try { await fs.access(target); gone = false; } catch (e) { gone = true; }
    assert.equal(gone, true);

    // audit recorded the mutations
    const acts = deps.actionLog.actions();
    assert.ok(acts.some(a => a.type === 'create_file'), 'create logged');
    assert.ok(acts.some(a => a.type === 'delete_file'), 'delete logged');

    await fs.rm(proj, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
});

test('executeTool: host writes are audited and undoable', async () => {
    const proj = realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'v50-undo-')));
    const deps = await makeDeps(proj);
    const target = path.join(proj, '..', `v50-undo-file-${process.pid}.txt`);

    await executeTool('write_host_file', { filepath: target, content: 'first' }, deps);
    await fs.appendFile(target, '\nsecond'); // mutate on disk so undo matters
    const id = deps.actionLog.list({ limit: 1 })[0].id;
    const r = await executeTool('undo_action', { id }, deps);
    assert.equal(r.success, true, JSON.stringify(r));

    await fs.rm(proj, { recursive: true, force: true });
    try { await fs.unlink(target); } catch (e) {}
});

test('executeTool: catastrophic host targets refused by pathPolicy', async () => {
    const proj = realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'v50-cat-')));
    const deps = await makeDeps(proj);
    const home = os.homedir();

    // writing the HOME root itself is catastrophic (matches v48 Agent Mode guard)
    let r = await executeTool('write_host_file', { filepath: home, content: 'x' }, deps);
    assert.ok(r.error, 'home-root write should be refused');
    r = await executeTool('delete_host_file', { filepath: '/' }, deps);
    assert.ok(r.error, 'fs-root delete should be refused');

    await fs.rm(proj, { recursive: true, force: true });
});

test('executeTool: process tools drive the shared job registry (jobApi)', async () => {
    const proj = realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'v50-job-')));
    const deps = await makeDeps(proj);
    const jobId = deps.jobApi._spawn('npm run dev');

    let r = await executeTool('list_processes', {}, deps);
    assert.equal(r.jobs.length, 1);
    assert.equal(r.jobs[0].job_id, String(jobId));

    r = await executeTool('read_process_log', { job_id: jobId }, deps);
    assert.match(r.log, /npm run dev/);

    r = await executeTool('send_input', { job_id: jobId, input: 'q' }, deps);
    assert.equal(r.success, true);

    r = await executeTool('stop_process', { job_id: jobId }, deps);
    assert.equal(r.success, true);

    r = await executeTool('list_processes', {}, deps);
    assert.equal(r.jobs[0].running, false);

    await fs.rm(proj, { recursive: true, force: true });
});

test('executeTool: audit + memory tools degrade gracefully without adapters', async () => {
    const proj = realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'v50-deg-')));
    const deps = await makeDeps(proj);

    let r = await executeTool('review_actions', {}, deps);
    assert.ok(Array.isArray(r.actions)); // empty, not an error

    r = await executeTool('save_user_fact', { exact_new_fact: 'user likes dark mode' }, deps);
    assert.match(String(r.error), /memory.*disabled/i, JSON.stringify(r));

    r = await executeTool('memory_search', { query: 'dark mode' }, deps);
    assert.ok(Array.isArray(r.results));

    // with a memory adapter wired in, both work
    const stored = [];
    deps.rememberMemory = async (t) => { stored.push(t); };
    deps.recallMemory = async () => [{ text: 'user likes dark mode' }];
    r = await executeTool('save_user_fact', { exact_new_fact: 'fact' }, deps);
    assert.equal(r.success, true);
    r = await executeTool('memory_search', { query: 'x' }, deps);
    assert.ok(r.results.includes('user likes dark mode'));

    await fs.rm(proj, { recursive: true, force: true });
});
