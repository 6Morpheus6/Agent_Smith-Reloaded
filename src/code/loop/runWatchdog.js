'use strict';

/**
 * Run watchdog for Code Mode. Emits periodic liveness "heartbeat" events and converts
 * an ASYNC stall — the model going silent, or an unbounded await that never resolves —
 * into a clean onStall() callback instead of an invisible freeze.
 *
 * IMPORTANT: this is timer-based, so it can only catch ASYNC stalls. A *synchronous*
 * block (e.g. an infinite loop in vm/jsdom) freezes the event loop and this timer with
 * it. Synchronous operations are bounded at their source instead: vm.runInContext uses
 * a 3s timeout, runCmd a 2min timeout, and streamCompletion its own idle/hard timers.
 *
 * Activity is reported via touch() (call it on every real run event). The heartbeat
 * itself does NOT count as activity, so a truly silent run still trips the inactivity
 * guard.
 *
 * @param {object} o
 * @param {(ev:object)=>void} [o.emit]        heartbeat sink
 * @param {(reason:string)=>void} [o.onStall] called once when the run stalls
 * @param {()=>object} [o.meta]               extra fields merged into each heartbeat
 * @param {()=>number} [o.now]                clock (injectable for tests)
 * @param {number} [o.heartbeatMs]            heartbeat/poll interval
 * @param {number} [o.inactivityMs]           stall if no activity for this long
 * @param {number} [o.maxRuntimeMs]           hard wall-clock cap for the run (0 = unlimited; v52.7 default)
 */
function createRunWatchdog({
    emit,
    onStall,
    meta = () => ({}),
    now = Date.now,
    heartbeatMs = 20000,
    inactivityMs = 360000,   // 6 min (> streamCompletion's 5 min hard cap)
    maxRuntimeMs = 0         // v52.7: unlimited by default — active runs are never killed by elapsed time
} = {}) {
    const startedAt = now();
    let lastActivity = startedAt;
    let timer = null;
    let stalled = false;

    function touch() { lastActivity = now(); }

    function tick() {
        const t = now();
        const idleMs = t - lastActivity;
        const elapsedMs = t - startedAt;
        if (typeof emit === 'function') {
            try { emit({ type: 'heartbeat', elapsedMs, idleMs, ...meta() }); } catch (_) { /* sink failure is non-fatal */ }
        }
        if (stalled) return;
        let reason = null;
        if (idleMs >= inactivityMs) {
            reason = `stalled — no progress for ${Math.round(idleMs / 1000)}s (model not responding?)`;
        } else if (maxRuntimeMs > 0 && elapsedMs >= maxRuntimeMs) {
            // v52.7: the wall-clock cap is opt-in now (XK_CODE_MAX_RUNTIME_MS). The default run
            // has NO total-runtime ceiling — turns are infinite, and an ACTIVE build (deltas
            // touching the watchdog on every token) must never be killed by elapsed time alone.
            reason = `exceeded max runtime of ${Math.round(maxRuntimeMs / 1000)}s`;
        }
        if (reason) {
            stalled = true;
            if (typeof onStall === 'function') { try { onStall(reason); } catch (_) { /* non-fatal */ } }
        }
    }

    return {
        touch,
        start() {
            if (!timer) {
                timer = setInterval(tick, heartbeatMs);
                if (timer && typeof timer.unref === 'function') timer.unref();
            }
            return this;
        },
        stop() { if (timer) { clearInterval(timer); timer = null; } },
        get stalled() { return stalled; },
        // exposed for deterministic tests (drive the clock + call manually)
        _tick: tick
    };
}

module.exports = { createRunWatchdog };
