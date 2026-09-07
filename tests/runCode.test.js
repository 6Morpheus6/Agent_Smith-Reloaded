/**
 * v52.6 — run_code (dsh Code Mode transport, tools/runCode.js).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    RUN_CODE_NAME, RUN_CODE_SCHEMA, buildRunCodeSdkSection, createRunCodeExecutor
} = require('../src/code/tools/runCode.js');

function makeDeps({ session = {}, offeredToolNames = ['read_file', 'grep', 'write_file'], executeTool } = {}) {
    return { session, offeredToolNames, executeTool };
}

test('schema is a valid OpenAI function tool with required code + description', () => {
    assert.equal(RUN_CODE_SCHEMA.function.name, RUN_CODE_NAME);
    assert.deepEqual(RUN_CODE_SCHEMA.function.parameters.required.sort(), ['code', 'description']);
});

test('SDK section lists exactly the offered tools and states the program rules', () => {
    const sdk = buildRunCodeSdkSection(['read_file', 'grep', 'write_file']);
    assert.match(sdk, /- read_file\(args\)/);
    assert.match(sdk, /RUN_CODE SDK/);
    assert.ok(!sdk.includes('- run_code('), 'no recursion: run_code is not offered to itself');
});

test('SDK section is empty when no tools are offered', () => {
    assert.equal(buildRunCodeSdkSection([]), '');
});

test('program can loop over tools and curate output (print + return)', async () => {
    const calls = [];
    const executeTool = async (name, args) => {
        calls.push({ name, args });
        if (name === 'read_file') return { path: args.path, content: `content of ${args.path}` };
        throw new Error(`unexpected tool ${name}`);
    };
    const runCode = createRunCodeExecutor(makeDeps({ executeTool }));
    const out = await runCode({
        code: [
            'const files = ["a.js", "b.js", "c.js"];',
            'let total = 0;',
            'for (const f of files) {',
            '  const r = await tools.read_file({ path: f });',
            '  total += r.content.length;',
            '}',
            'print("read", files.length, "files");',
            'return { files: files.length, totalChars: total };'
        ].join('\n'),
        description: 'Read three files and count chars'
    }, 'call_1');

    assert.equal(out.success, true);
    assert.equal(out.subCalls, 3);
    assert.deepEqual(calls.map(c => c.args.path), ['a.js', 'b.js', 'c.js']);
    assert.match(out.output, /read 3 files/);
    assert.equal(out.result.totalChars, totalOf(['a.js', 'b.js', 'c.js']));
});

function totalOf(files) {
    return files.reduce((n, f) => n + `content of ${f}`.length, 0);
}

test('denials are binding rejections — the program can try/catch them', async () => {
    const executeTool = async (name) => {
        if (name === 'write_file') return { error: 'phase blocked' };
        return { ok: true };
    };
    const runCode = createRunCodeExecutor(makeDeps({ executeTool }));
    const out = await runCode({
        code: [
            'let caught = null;',
            'try { await tools.write_file({ path: "x.js", content: "" }); } catch (e) { caught = e.message; }',
            'return { caught };'
        ].join('\n'),
        description: 'Catch a write denial'
    }, 'call_2');
    assert.equal(out.success, true);
    assert.match(out.result.caught, /phase blocked/);
});

test('a program exception is a model-facing failure with captured logs', async () => {
    const executeTool = async () => ({ ok: true });
    const runCode = createRunCodeExecutor(makeDeps({ executeTool }));
    const out = await runCode({
        code: 'print("before crash"); throw new Error("kaboom");',
        description: 'Crash on purpose'
    }, 'call_3');
    assert.equal(out.success, undefined);
    assert.match(out.error, /run_code failed/);
    assert.match(out.error, /kaboom/);
    assert.deepEqual(out.logs, ['before crash']);
});

test('missing description is rejected before any dispatch', async () => {
    let called = false;
    const executeTool = async () => { called = true; return {}; };
    const runCode = createRunCodeExecutor(makeDeps({ executeTool }));
    const out = await runCode({ code: 'return 1;', description: '   ' }, 'call_4');
    assert.match(out.error, /description/);
    assert.equal(called, false);
});

test('sub-call budget is enforced (XK_RUNCODE_MAX_SUBCALLS)', async () => {
    const prev = process.env.XK_RUNCODE_MAX_SUBCALLS;
    process.env.XK_RUNCODE_MAX_SUBCALLS = '3';
    try {
        let n = 0;
        const executeTool = async () => { n++; return { i: n }; };
        const runCode = createRunCodeExecutor(makeDeps({ executeTool }));
        const out = await runCode({
            code: [
                'let caught = null;',
                'try {',
                '  for (let i = 0; i < 10; i++) { await tools.read_file({ path: "f" }); }',
                '} catch (e) { caught = e.message; }',
                'return { caught };'
            ].join('\n'),
            description: 'Exhaust the sub-call budget'
        }, 'call_5');
        assert.equal(out.success, true);
        assert.match(out.result.caught, /budget exhausted/);
        assert.ok(n <= 3 + 1, `only ~budget calls may dispatch (got ${n})`);
    } finally {
        if (prev === undefined) delete process.env.XK_RUNCODE_MAX_SUBCALLS;
        else process.env.XK_RUNCODE_MAX_SUBCALLS = prev;
    }
});

test('phase gates are binding for programs — explore cannot write through run_code', async () => {
    const session = { phase: 'explore' };
    let wrote = false;
    const executeTool = async (name) => { if (name === 'write_file') wrote = true; return {}; };
    const runCode = createRunCodeExecutor(makeDeps({ session, executeTool }));
    const out = await runCode({
        code: [
            'let caught = null;',
            'try { await tools.write_file({ path: "x.js", content: "" }); } catch (e) { caught = e.message; }',
            'return { caught };'
        ].join('\n'),
        description: 'Try to write in explore phase'
    }, 'call_6');
    assert.equal(wrote, false);
    assert.match(out.result.caught, /explore phase/);
});

test('sub-call bookkeeping: writes reset testRunsSinceEdit and record filesTouched', async () => {
    // verify phase: run_command is offered there (implement keeps the surface small).
    const session = { phase: 'verify', filesTouched: [], testRunsSinceEdit: true };
    const executeTool = async (name, args) => {
        if (name === 'write_file') return { success: true, relPath: args.path };
        if (name === 'run_command') return { stdout: '', stderr: '', exit_code: 0 };
        return {};
    };
    const runCode = createRunCodeExecutor(makeDeps({
        session, executeTool, offeredToolNames: ['read_file', 'grep', 'write_file', 'run_command']
    }));
    await runCode({
        code: [
            'await tools.write_file({ path: "a.js", content: "// x" });',
            'await tools.run_command({ command: "node --check a.js" });'
        ].join('\n'),
        description: 'Write then verify in-program'
    }, 'call_7');
    assert.deepEqual(session.filesTouched, ['a.js']);
    // The write reset the flag; the passing verification set it again.
    assert.equal(session.testRunsSinceEdit, true);
});

test('sub-call ids are parent-linked (<callId>:code:<n>)', async () => {
    const seen = [];
    const executeTool = async (name, args, deps) => { seen.push(deps.callId); return {}; };
    const runCode = createRunCodeExecutor(makeDeps({ executeTool }));
    await runCode({ code: 'await tools.read_file({path:"a"}); await tools.grep({pattern:"x"});', description: 'Two sub-calls' }, 'call_9');
    assert.deepEqual(seen, ['call_9:code:1', 'call_9:code:2']);
});

test('programs cannot recurse into run_code (not offered to themselves)', async () => {
    const dispatched = [];
    const executeTool = async (name) => { dispatched.push(name); return {}; };
    const runCode = createRunCodeExecutor(makeDeps({ executeTool }));
    // v53.7 — run_code is not in the offered set, so tools.run_code must NOT dispatch a real
    // recursive sub-call; it resolves to an actionable rejection (not a TypeError) instead.
    const out = await runCode({
        code: 'try { await tools.run_code({code:"x",description:"y"}); return "no-error"; } catch (e) { return e.message; }',
        description: 'Attempt recursion'
    }, 'call_10');
    assert.equal(out.success, true);
    assert.match(out.result, /not available to this program/);
    assert.ok(!dispatched.includes('run_code'), 'no real run_code sub-call dispatched (no recursion)');
});

test('Promise.all parallelizes independent reads inside a program', async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const executeTool = async (name) => {
        if (name === 'read_file') {
            inFlight++;
            maxSeen = Math.max(maxSeen, inFlight);
            await new Promise(r => setTimeout(r, 40));
            inFlight--;
            return { content: 'x' };
        }
        return {};
    };
    const runCode = createRunCodeExecutor(makeDeps({ executeTool }));
    const out = await runCode({
        code: [
            'const rs = await Promise.all([',
            '  tools.read_file({ path: "a" }),',
            '  tools.read_file({ path: "b" })',
            ']);',
            'return { n: rs.length };'
        ].join('\n'),
        description: 'Parallel reads in-program'
    }, 'call_11');
    assert.equal(out.result.n, 2);
    // The dsh lane must actually overlap the two parallel-classified sub-calls.
    assert.ok(maxSeen >= 2, `expected concurrent sub-dispatches (max seen ${maxSeen})`);
});

test('v53.2: a catch-all retry loop after budget exhaustion PARKS — run_code settles via timeout instead of spinning', async () => {
    // The classic model "retry until it works" pattern: while(true){ try{ await tools.x() }catch{} }.
    // Before v53.2 every over-budget call REJECTED, and such a loop resolves only through
    // microtasks — starving the event loop so withTimeout's timer could never fire (measured:
    // 30+ minutes at full CPU). Now the first rejection is delivered (self-correction contract)
    // and every further call parks; the program freezes at its next await and the timeout bound
    // settles run_code with a bounded error.
    const prevCalls = process.env.XK_RUNCODE_MAX_SUBCALLS;
    const prevTimeout = process.env.XK_RUNCODE_TIMEOUT_MS;
    process.env.XK_RUNCODE_MAX_SUBCALLS = '2';
    process.env.XK_RUNCODE_TIMEOUT_MS = '1500'; // small bound so the test stays fast
    try {
        let n = 0;
        const executeTool = async () => { n++; return {}; };
        const runCode = createRunCodeExecutor(makeDeps({ executeTool }));
        const t0 = Date.now();
        const out = await runCode({
            code: 'while (true) { try { await tools.read_file({ path: "f" }); } catch (e) {} }',
            description: 'Pathological retry loop'
        }, 'call_12');
        const elapsed = Date.now() - t0;
        assert.ok(out.error, 'must settle with an error, not hang');
        assert.match(out.error, /timed out/i);
        // Settled by the 1.5s bound (± slack), NOT after minutes of spinning.
        assert.ok(elapsed < 10_000, `parked loop must let the timeout fire quickly (took ${elapsed}ms)`);
        // Only the budget's worth of calls actually dispatched — no unbounded fan-out.
        assert.ok(n <= 3, `only ~budget sub-calls may dispatch (got ${n})`);
    } finally {
        if (prevCalls === undefined) delete process.env.XK_RUNCODE_MAX_SUBCALLS; else process.env.XK_RUNCODE_MAX_SUBCALLS = prevCalls;
        if (prevTimeout === undefined) delete process.env.XK_RUNCODE_TIMEOUT_MS; else process.env.XK_RUNCODE_TIMEOUT_MS = prevTimeout;
    }
});

test('v53.2: a well-behaved program that catches the budget error once still settles normally', async () => {
    // The dsh self-correction contract is preserved: catch the FIRST rejection, stop, return.
    const prevCalls = process.env.XK_RUNCODE_MAX_SUBCALLS;
    process.env.XK_RUNCODE_MAX_SUBCALLS = '2';
    try {
        let n = 0;
        const executeTool = async () => { n++; return {}; };
        const runCode = createRunCodeExecutor(makeDeps({ executeTool }));
        const out = await runCode({
            code: [
                'let caught = null;',
                'try {',
                '  for (let i = 0; i < 10; i++) { await tools.read_file({ path: "f" }); }',
                '} catch (e) { caught = e.message; }',
                'return { caught };'
            ].join('\n'),
            description: 'Catch budget error and stop'
        }, 'call_13');
        assert.equal(out.success, true);
        assert.match(out.result.caught, /budget exhausted/);
        assert.ok(n <= 3);
    } finally {
        if (prevCalls === undefined) delete process.env.XK_RUNCODE_MAX_SUBCALLS; else process.env.XK_RUNCODE_MAX_SUBCALLS = prevCalls;
    }
});

// v53.7 — regression: a program calling a tool NOT offered this turn used to die with the
// cryptic `tools.run_command is not a function` (undefined property), which small models
// could not self-correct from. It must now be an actionable rejection naming what IS available,
// and try/catch programs can recover (dsh denial contract).
test('v53.7: calling a non-offered tool throws an actionable error, not "is not a function"', async () => {
    const executeTool = async () => ({ ok: true });
    const runCode = createRunCodeExecutor(makeDeps({ offeredToolNames: ['read_file', 'write_file'], executeTool }));
    // 1) uncaught — the error text must be actionable, not a TypeError.
    const out = await runCode({
        code: 'await tools.run_command({ command: "node x.js" });',
        description: 'Call a tool that was not offered'
    }, 'call_v537');
    assert.ok(out.error);
    assert.match(out.error, /run_code failed/);
    assert.doesNotMatch(out.error, /is not a function/i);
    assert.match(out.error, /not available to this program/);
    assert.match(out.error, /read_file.*write_file|write_file.*read_file/s);
});

test('v53.7: try/catch around a non-offered tool lets the program recover', async () => {
    const calls = [];
    const executeTool = async (name) => { calls.push(name); return {}; };
    const runCode = createRunCodeExecutor(makeDeps({ offeredToolNames: ['read_file'], executeTool }));
    const out = await runCode({
        code: [
            'let err = null;',
            'try { await tools.run_command({ command: "ls" }); } catch (e) { err = e.message; }',
            'const r = await tools.read_file({ path: "a.js" });',
            'return { recovered: true, err };'
        ].join('\n'),
        description: 'Catch non-offered tool and continue'
    }, 'call_v537b');
    assert.equal(out.success, true);
    assert.equal(out.result.recovered, true);
    assert.match(out.result.err, /not available to this program/);
    assert.deepEqual(calls, ['read_file'], 'only the offered tool actually dispatched');
});
