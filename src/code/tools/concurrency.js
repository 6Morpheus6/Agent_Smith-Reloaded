/**
 * v52.6 — concurrent tool-call scheduler (ported from the DeepSeek Harness,
 * `packages/core/tools` dispatch driver + agent-loop parallel scheduler).
 *
 * dsh's native loop executes a model's tool batch with ONE ordered lane:
 *   - starts are strictly submission-ordered (pre-execute never overlaps)
 *   - results commit in submission order through a head-of-line cursor
 *     (post-execute + settle run one at a time, in order)
 *   - only the around-dispatch/body stage runs concurrently: consecutive
 *     `parallel` calls overlap up to maxParallel; an `exclusive` call waits for
 *     the pool to drain, runs alone, and holds its barrier until its COMMIT
 *     completes — exactly like a native exclusive group.
 *   - classification is re-read immediately before each start (fail-closed).
 *
 * The lane supports DYNAMIC submission (`submit()`), which serves both consumers:
 * the turn loop's per-message batch, and run_code's in-program sub-dispatches.
 */
'use strict';

const { executionMode } = require('./pipeline.js');

/**
 * Create one ordered dispatch lane under the dsh concurrency contract.
 *
 * @param {object} [opts]
 *   maxParallel — overlap cap for parallel-classified calls (default 4)
 *   classify(name) — override classifier (defaults to pipeline.executionMode,
 *                    which is fail-closed: unknown/undeclared → exclusive)
 */
function createDispatchLane(opts = {}) {
    const maxParallel = Math.max(1, Number(opts.maxParallel) || 4);
    const classify = typeof opts.classify === 'function' ? opts.classify : executionMode;

    /** @typedef {{ start(): Promise<void>, classify(): string, commit(): Promise<void>, flight: Promise<void>, settled: boolean, mode?: string }} PendingDispatch */
    const pendingQueue = [];
    const inFlight = new Set();
    const commitQueue = [];
    let exclusiveActive = false;
    let driving = false;
    let driverRun = Promise.resolve();
    let wakeFn;

    function wakeup() {
        const release = wakeFn;
        wakeFn = undefined;
        if (release) release();
    }

    /** The single ordered lane. */
    function drive() {
        if (driving) return driverRun;
        driving = true;
        driverRun = (async () => {
            try {
                for (;;) {
                    // Create the wakeup promise BEFORE inspecting state so a settle or
                    // submission arriving between the checks and the await cannot be lost.
                    const signal = new Promise((resolve) => { wakeFn = resolve; });
                    const commitHead = commitQueue[0];
                    if (commitHead !== undefined && commitHead.settled) {
                        commitQueue.shift();
                        await commitHead.commit();
                        // The barrier covers post-execute: later starts wait for the
                        // exclusive call's full pipeline, as under the native loop.
                        if (commitHead.mode === 'exclusive') exclusiveActive = false;
                        continue;
                    }
                    const head = pendingQueue[0];
                    if (head !== undefined) {
                        // Reclassify at start time (fail-closed on registry changes).
                        const mode = head.classify();
                        const capacity = !exclusiveActive &&
                            (mode === 'exclusive' ? inFlight.size === 0 : inFlight.size < maxParallel);
                        if (capacity) {
                            if (mode === 'exclusive') exclusiveActive = true;
                            head.mode = mode;
                            pendingQueue.shift();
                            // Joined before start() so the commit cursor sees submission order.
                            commitQueue.push(head);
                            await head.start();
                            const flight = head.flight.finally(() => {
                                inFlight.delete(flight);
                                wakeup();
                            });
                            inFlight.add(flight);
                            // If nothing else is queued, wait for this body to settle before
                            // looping — the `continue` below would re-await an already-resolved
                            // signal (a no-op) and busy-spin until the body finishes.
                            if (pendingQueue.length === 0 && commitQueue.length === 1) {
                                await flight;
                            }
                            continue;
                        }
                    }
                    if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return;
                    await signal;
                }
            } finally {
                driving = false;
                wakeFn = undefined;
            }
        })();
        return driverRun;
    }

    /**
     * Submit one call. `body()` is the around-dispatch/body stage (the registered
     * execute, already wrapped by the caller's pipeline stages where applicable).
     * `onCommit(outcome)` — when provided — runs INSIDE the ordered commit stage: it is
     * awaited by the driver before the next submission-order commit begins, so any
     * shared-state bookkeeping it does (history pushes, session flags) can never
     * interleave with another commit. This is dsh's post-execute-in-commit contract.
     * @returns {{ promise: Promise<{ ok: boolean, result: object }> }} resolves in
     *   COMMIT order after onCommit completes; a throwing body becomes
     *   `{ ok:false, result:{ error, isError:true } }` (registry normalization —
     *   the lane itself never rejects).
     */
    function submit({ name, body, onCommit }) {
        let parked; // what commit() finalizes in submission order
        const entry = {
            classify: () => (classify(name).kind || 'exclusive'),
            mode: undefined,
            settled: false,
            flight: Promise.resolve(),
            promise: null,
            async start() {
                // dsh contract: start = append + prepare + LAUNCH THE BODY INTO FLIGHT — it does
                // NOT await the body. The driver must keep starting subsequent parallel calls
                // while this one runs; awaiting here would serialize everything (the bug that
                // made "parallel" reads take 3x wall-clock).
                entry.flight = (async () => {
                    try {
                        parked = { isError: false, value: await body() };
                    } catch (e) {
                        // Registry outer normalization: a throwing stage becomes isError.
                        parked = { isError: true, message: e && e.message ? e.message : String(e) };
                    } finally {
                        entry.settled = true;
                        wakeup();
                    }
                })();
            },
            async commit() {
                if (!parked) parked = { isError: true, message: 'tool call abandoned before start' };
                const outcome = parked.isError
                    ? { ok: false, result: { error: parked.message, isError: true } }
                    : { ok: !isOutcomeError(parked.value), result: parked.value };
                // Ordered post-execute: the driver awaits this whole stage before the next
                // commit starts — bookkeeping runs one-at-a-time in submission order.
                if (typeof onCommit === 'function') await onCommit(outcome);
                if (entry.resolveCommit) entry.resolveCommit(outcome);
            },
            async abandon() {
                entry.settled = true;
                const outcome = { ok: false, result: { error: 'tool call abandoned', isError: true } };
                // Abandoned calls still get their onCommit so the caller can record a valid
                // tool response for history (dsh: queued-unstarted dispatches are abandoned).
                if (typeof onCommit === 'function') {
                    try { await onCommit(outcome); } catch (_) { /* contain */ }
                }
                if (entry.resolveCommit) entry.resolveCommit(outcome);
            }
        };
        entry.promise = new Promise((resolve) => { entry.resolveCommit = resolve; });
        pendingQueue.push(entry);
        drive();
        return { promise: entry.promise };
    }

    /** Resolves once every submitted call has settled AND committed. */
    function drain() {
        return drive();
    }

    /**
     * Abort the run (dsh semantics): queued-unstarted dispatches are abandoned with an
     * isError outcome; in-flight bodies complete and commit normally — a teardown that
     * returns before the work stops would leave orphans, so drain() still settles all.
     */
    async function abort(reason) {
        const queued = pendingQueue.splice(0);
        for (const head of queued) {
            if (!head.settled) await head.abandon();
        }
        void reason;
        wakeup();
    }

    return { submit, drain, abort };
}

/**
 * Execute a batch of tool calls under the dsh concurrency contract (static form).
 *
 * @param {object[]} calls — in submission order: `{ name, args?, callId?, body() }`
 * @returns {Promise<object[]>} results in SUBMISSION order: `{ ok, result }`.
 */
async function executeToolBatch(calls, opts = {}) {
    const lane = createDispatchLane(opts);
    const promises = calls.map(call => lane.submit({ name: call.name, body: call.body }).promise);
    await lane.drain();
    return Promise.all(promises);
}

/** A body may resolve to `{ error }` (the executor's soft-failure shape) — that is not ok. */
function isOutcomeError(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value) && value.error);
}

module.exports = { createDispatchLane, executeToolBatch };
