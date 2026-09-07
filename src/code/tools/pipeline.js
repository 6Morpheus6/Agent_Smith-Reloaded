/**
 * v52.6 — dsh-style tool execution pipeline (ported from the DeepSeek Harness,
 * `packages/core/tools` + docs/tool-execution-pipeline.md).
 *
 * The old executor was a bare switch: model call → body → result string. This module
 * wraps every dispatch in the harness's staged pipeline so policy, guards, and
 * normalization run WITHOUT changing the loop:
 *
 *   1. pre-execute waterfall   — hooks + permission (plugin beforeToolCall)
 *   2. monotonic guards        — deny or abstain; identity-protected (phase gate,
 *                                missing-ref guard, DOM-repair write block)
 *   3. around-dispatch         — timeout wrapper (exclusive calls run alone)
 *   4. tool body               — the registered execute() (executor.dispatch)
 *   5. post-execute waterfall  — accept / replace / add context (plugin afterToolCall,
 *                                quality sensors)
 *   6. registry normalization  — a pipeline/result snapshot that throws becomes isError;
 *                                every outcome is one lossless-JSON model-facing result
 *   7. finalize                — content-only invariant: oversized payloads are spilled
 *                                to .agentsmith/tool-results/<callId>.json and replaced
 *                                by a head+tail window + the file path (the model can
 *                                read_file it) instead of blowing the context budget
 *
 * Concurrency classification lives here too (`executionMode`): `parallel` calls may
 * overlap with siblings, `exclusive` calls run alone and form an ordering barrier.
 * Unknown / undeclared / throwing classifiers are exclusive (fail-closed), exactly as
 * in dsh — a tool that has not declared itself concurrency-safe must never race.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── Concurrency classification ────────────────────────────────────────────────
// `parallel` (read-only, no shared mutable state) may overlap with siblings up to
// the run's maxParallel cap. Everything else is exclusive: writes mutate files and
// the change ledger, shell commands touch processes/env, previews drive the UI —
// they must not interleave with each other or with reads of what they are changing.

const PARALLEL_SAFE_TOOLS = new Set([
    'read_file', 'grep', 'glob', 'list_project', 'query_run_trace',
    'list_processes', 'read_process_log', 'review_actions', 'memory_search'
]);

/**
 * Classify one pending call. Mirrors dsh's `executionMode()`: an exact `true`
 * is parallel; unknown, hidden, undeclared, invalid, or throwing classifiers
 * are exclusive.
 */
function executionMode(name) {
    try {
        if (typeof name !== 'string' || !name) return { kind: 'exclusive' };
        return PARALLEL_SAFE_TOOLS.has(name) ? { kind: 'parallel' } : { kind: 'exclusive' };
    } catch (e) {
        return { kind: 'exclusive' };
    }
}

// ── Result normalization + spill (finalize stage) ─────────────────────────────

const SPILL_DIR_NAME = '.agentsmith/tool-results';
/** Above this, a tool result is spilled to disk and replaced by a window. */
const RESULT_SPILL_CHARS = 24000;
/** Head/tail window kept inline for the model when spilling (chars each). */
const SPILL_WINDOW_CHARS = 6000;

function losslessJson(value) {
    // The registry's outer normalization: a result that cannot be serialized as
    // lossless JSON becomes an isError outcome instead of corrupting history.
    try {
        return JSON.stringify(value);
    } catch (e) {
        throw new Error(`tool result is not lossless JSON: ${e.message}`);
    }
}

/**
 * The finalize stage — the last content-only invariant. Oversized results are
 * written to a private per-run file and replaced by head + tail + the path, so
 * one chatty `grep` or 50KB of stdout can never eat the context budget (the old
 * loop stuffed the full string into history verbatim).
 */
function finalizeResult(callId, resultStr, { projectRoot } = {}) {
    if (!resultStr || resultStr.length <= RESULT_SPILL_CHARS) return resultStr;

    let spilledPath = null;
    try {
        const dir = path.join(projectRoot || process.cwd(), SPILL_DIR_NAME);
        fs.mkdirSync(dir, { recursive: true });
        const safeId = String(callId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(-80) || 'call';
        spilledPath = path.join(dir, `${safeId}.json`);
        fs.writeFileSync(spilledPath, resultStr, { mode: 0o600 });
    } catch (e) { /* spill is best-effort — fall back to the inline window */ }

    const head = resultStr.slice(0, SPILL_WINDOW_CHARS);
    const tail = resultStr.slice(-SPILL_WINDOW_CHARS);
    const omitted = resultStr.length - head.length - tail.length;
    return [
        '[RESULT TRUNCATED — full output spilled to disk]',
        spilledPath ? `Full result: ${spilledPath} (read it with read_file if you need the middle)` : '(spill unavailable)',
        `Omitted ${omitted} chars of ${resultStr.length}.`,
        '── head ──',
        head,
        '── tail ──',
        tail
    ].join('\n');
}

// ── The pipeline ──────────────────────────────────────────────────────────────

/**
 * Run one tool call through the full staged pipeline.
 *
 * @param {object} opts
 *   name, args, callId — identity of the call
 *   body()              — the registered execute() (returns a result object or string)
 *   deps                — executor deps (sessionId, session, fireHook, …)
 *   signal              — AbortSignal for the around-dispatch timeout stage
 * @returns {Promise<object>} normalized model-facing outcome:
 *   - on success: the body's result (possibly post-execute-replaced), with
 *     `resultStr` = the lossless-JSON text that enters history (post-spill)
 *   - on failure: `{ error, isError: true }` — a thrown stage never rejects the
 *     pipeline; it is normalized into an outcome the model can self-correct from.
 */
async function runToolPipeline({ name, args, callId, body, deps = {}, signal }) {
    const ctx = { name, args: args || {}, callId };

    // 1. pre-execute waterfall — hooks + permission (plugin beforeToolCall).
    if (deps.fireHook) {
        try {
            const hook = await deps.fireHook('beforeToolCall', { tool: name, name, args: ctx.args });
            if (hook && hook.blocked) {
                return { error: hook.reason || 'Blocked by plugin hook', pluginBlocked: true };
            }
        } catch (e) { /* a throwing pre-hook must not kill the call — contain it */ }
    }

    // 2+3. guards + around-dispatch + body. Guards are identity-protected: they run
    // before the body and their denials skip it entirely. The around stage bounds
    // exclusive (state-mutating) calls with a timeout so one hung command cannot
    // wedge the ordered lane forever; read-only parallel calls get no wrapper —
    // they are bounded at their source (fs reads, in-memory scans).
    let result;
    try {
        const mode = executionMode(name);
        if (mode.kind === 'exclusive') {
            result = await withTimeout(body(), deps.exclusiveTimeoutMs || 300000, name, signal);
        } else {
            result = await body();
        }
    } catch (e) {
        // Registry outer normalization: a throwing stage becomes isError.
        return { error: e.message || String(e), isError: true };
    }

    // 5. post-execute waterfall — accept / replace / add context. A plugin may
    // replace the result outright; anything else is accepted as-is.
    if (deps.fireHook && result !== undefined) {
        try {
            const out = await deps.fireHook('afterToolCall', { tool: name, name, args: ctx.args, result });
            if (out && typeof out === 'object' && !Array.isArray(out) && out.__replaceResult !== undefined) {
                result = out.__replaceResult;
            }
        } catch (e) { /* contain — one bad subscriber never breaks the pipeline */ }
    }

    // 6+7. normalization + finalize: exactly ONE lossless-JSON model-facing outcome.
    let resultStr;
    try {
        resultStr = typeof result === 'string' ? result : losslessJson(result);
    } catch (e) {
        return { error: e.message || String(e), isError: true };
    }
    const finalized = finalizeResult(callId, resultStr, { projectRoot: deps.projectContext?.getRoot() });

    if (result && typeof result === 'object' && !Array.isArray(result)) {
        // Attach the history text for the loop; keep the structured object for UI.
        return Object.assign({}, result, { resultStr: finalized });
    }
    return { resultStr: finalized };
}

/** Around-dispatch timeout wrapper (exclusive calls only). */
function withTimeout(promise, ms, name, signal) {
    if (!ms || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Tool "${name}" timed out after ${Math.round(ms / 1000)}s (exclusive call bound).`));
        }, ms);
        // v53.2 — do NOT unref: this is the exclusive-call settle boundary; if the wrapped tool
        // promise has no live handles of its own, an unref'd timer would never fire in isolated
        // contexts and the bound would silently stop existing (same class as run_code's park()).
        let onAbort = null;
        if (signal) {
            onAbort = () => reject(new Error(`Tool "${name}" aborted.`));
            signal.addEventListener('abort', onAbort, { once: true });
        }
        promise.then(
            (v) => { cleanup(); resolve(v); },
            (e) => { cleanup(); reject(e); }
        );
        function cleanup() {
            clearTimeout(timer);
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        }
    });
}

module.exports = {
    PARALLEL_SAFE_TOOLS,
    RESULT_SPILL_CHARS,
    SPILL_WINDOW_CHARS,
    executionMode,
    finalizeResult,
    losslessJson,
    runToolPipeline
};
