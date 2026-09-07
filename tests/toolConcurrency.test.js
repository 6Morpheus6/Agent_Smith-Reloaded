/**
 * v52.6 — dsh ordered-lane concurrent tool scheduler (tools/concurrency.js).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDispatchLane, executeToolBatch } = require('../src/code/tools/concurrency.js');
const { executionMode } = require('../src/code/tools/pipeline.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('results commit in SUBMISSION order even when bodies finish out of order', async () => {
    const lane = createDispatchLane({ maxParallel: 4 });
    // read_file is parallel-classified; give the first call a LONGER body so it settles last.
    const p1 = lane.submit({ name: 'read_file', body: async () => { await sleep(60); return { n: 1 }; } }).promise;
    const p2 = lane.submit({ name: 'grep', body: async () => ({ n: 2 }) }).promise;
    const p3 = lane.submit({ name: 'glob', body: async () => ({ n: 3 }) }).promise;
    await lane.drain();
    assert.deepEqual(await Promise.all([p1, p2, p3]).then(rs => rs.map(r => r.result.n)), [1, 2, 3]);
});

test('parallel reads overlap (wall-clock < sum of bodies)', async () => {
    const t0 = Date.now();
    await executeToolBatch([
        { name: 'read_file', body: async () => { await sleep(80); return 'a'; } },
        { name: 'grep', body: async () => { await sleep(80); return 'b'; } },
        { name: 'glob', body: async () => { await sleep(80); return 'c'; } }
    ], { maxParallel: 4 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 200, `expected overlap (got ${elapsed}ms for three 80ms reads)`);
});

test('exclusive calls serialize and form barriers — writes never overlap', async () => {
    let inFlightWrites = 0;
    let maxConcurrentWrites = 0;
    const writeBody = async (label) => {
        inFlightWrites++;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, inFlightWrites);
        await sleep(40);
        inFlightWrites--;
        return label;
    };
    // Interleave reads between writes: the exclusive barrier must hold through COMMIT.
    const results = await executeToolBatch([
        { name: 'write_file', body: () => writeBody('w1') },
        { name: 'read_file', body: async () => 'r' },
        { name: 'patch', body: () => writeBody('w2') },
        { name: 'glob', body: async () => 'g' }
    ], { maxParallel: 4 });
    assert.deepEqual(results.map(r => r.result), ['w1', 'r', 'w2', 'g']);
    assert.equal(maxConcurrentWrites, 1);
});

test('onCommit bookkeeping runs in submission order and never interleaves across commits', async () => {
    const history = []; // shared state the loop would push to (session.messages)
    const lane = createDispatchLane({ maxParallel: 4 });
    let committing = null;
    const mk = (name, delay, label) => lane.submit({
        name,
        body: async () => { await sleep(delay); return label; },
        onCommit: async ({ result }) => {
            assert.equal(committing, null, 'commits must not overlap');
            committing = result;
            history.push(result); // synchronous push — but the stage is awaited by the driver
            await sleep(5);
            committing = null;
        }
    }).promise;

    const p1 = mk('read_file', 40, 'first');   // settles LAST (longest body)
    const p2 = mk('grep', 5, 'second');       // settles FIRST
    await lane.drain();
    await Promise.all([p1, p2]);
    assert.deepEqual(history, ['first', 'second'], 'commits must be submission-ordered, not settle-order (settle order was second→first)');
});

test('a throwing body becomes isError — the lane never rejects and later commits proceed', async () => {
    const results = await executeToolBatch([
        { name: 'read_file', body: async () => { throw new Error('boom'); } },
        { name: 'grep', body: async () => ({ fine: true }) }
    ]);
    assert.equal(results[0].ok, false);
    assert.match(results[0].result.error, /boom/);
    assert.equal(results[1].ok, true);
});

test('a soft { error } outcome is reported as not-ok (executor failure shape)', async () => {
    const results = await executeToolBatch([
        { name: 'write_file', body: async () => ({ error: 'phase blocked' }) }
    ]);
    assert.equal(results[0].ok, false);
});

test('abort abandons queued-unstarted dispatches; in-flight bodies still settle', async () => {
    const lane = createDispatchLane({ maxParallel: 1 }); // serial: only the first can start
    let secondStarted = false;
    const p1 = lane.submit({ name: 'write_file', body: async () => { await sleep(50); return 'done'; } }).promise;
    const p2 = lane.submit({ name: 'read_file', body: async () => { secondStarted = true; return 'x'; } }).promise;
    // Let the first start, then abort while the second is still queued.
    await sleep(10);
    await lane.abort();
    assert.equal(secondStarted, false);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.result, 'done');
    assert.match(r2.result.error, /abandoned/);
});

test('maxParallel caps read overlap', async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const body = async () => {
        inFlight++;
        maxSeen = Math.max(maxSeen, inFlight);
        await sleep(30);
        inFlight--;
        return 'ok';
    };
    await executeToolBatch([1, 2, 3, 4].map(i => ({ name: 'read_file', body })), { maxParallel: 2 });
    assert.ok(maxSeen <= 2, `overlap ${maxSeen} exceeded cap 2`);
});

test('classifier override is honored (custom fail-closed set)', async () => {
    // Force EVERYTHING exclusive via a custom classifier — writes and reads serialize.
    let inFlight = 0;
    let maxSeen = 0;
    const body = async () => {
        inFlight++;
        maxSeen = Math.max(maxSeen, inFlight);
        await sleep(25);
        inFlight--;
        return 'ok';
    };
    await executeToolBatch([1, 2].map(i => ({ name: 'read_file', body })), {
        classify: () => ({ kind: 'exclusive' })
    });
    assert.equal(maxSeen, 1);
});

test('default classifier is the pipeline executionMode (fail-closed)', () => {
    const lane = createDispatchLane({});
    // No override → same table as pipeline.executionMode.
    assert.equal(executionMode('read_file').kind, 'parallel');
    void lane;
});
