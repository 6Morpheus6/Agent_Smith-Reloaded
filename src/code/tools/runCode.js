/**
 * v52.6 — run_code: the DeepSeek Harness' Code Mode transport, ported to Agent Smith.
 *
 * In dsh (packages/core/tools/src/code-mode.ts) `run_code` is THE coding tool: the model
 * writes a small program whose BODY is an async function; inside it, every registered
 * agent tool is available as `await tools.name(args)`. The program can loop, branch,
 * filter and aggregate over tool results — work that would take 10+ sequential model
 * turns becomes ONE. Only what the program prints or returns enters model history
 * ("curate it"), so a 40-file grep-and-summarize costs one round trip instead of forty.
 *
 * This port keeps dsh's contract:
 *   - sub-dispatches go through the SAME registry pipeline as native calls (pre/post
 *     hooks, normalization) and are logged with parent-linked ids `<callId>:code:<n>`;
 *   - denials come back as binding REJECTIONS — `await tools.x(...)` throws, so a
 *     program can try/catch and self-correct instead of reading error strings;
 *   - sub-calls run under the dsh concurrency contract (createDispatchLane): reads
 *     overlap up to maxParallel, writes stay exclusive and ordered;
 *   - phase gates still apply: a program cannot write in explore phase or bypass any
 *     guard — sub-call denials are binding rejections too;
 *   - session bookkeeping the turn loop would normally do for top-level calls
 *     (filesTouched, testRunsSinceEdit) is applied to sub-calls here, so the
 *     completion gate and TEST-BEFORE-DONE see work done inside run_code.
 */
'use strict';

const { createDispatchLane } = require('./concurrency.js');
const { executionMode } = require('./pipeline.js');
const { WRITE_TOOLS } = require('../loop/phases.js');

const RUN_CODE_NAME = 'run_code';

/** Per-run budgets (env-overridable; local-model friendly defaults). */
function runCodeBudgets() {
    return {
        maxSubCalls: Math.max(1, Number(process.env.XK_RUNCODE_MAX_SUBCALLS) || 50),
        timeoutMs: Math.max(5000, Number(process.env.XK_RUNCODE_TIMEOUT_MS) || 120000),
        maxParallel: Math.max(1, Number(process.env.XK_CODE_MAX_PARALLEL) || 4)
    };
}

/** The model-facing schema (OpenAI function format — matches Agent Smith's tool set). */
const RUN_CODE_SCHEMA = {
    type: 'function',
    function: {
        name: RUN_CODE_NAME,
        description:
            'Execute a program against the available tools. `code` is the BODY of an async ' +
            'JavaScript function (top-level await and return work); call any tool as ' +
            '`await tools.name(args)` — e.g. `const r = await tools.read_file({ path: "src/app.js" })`. ' +
            'Use it for WORK THAT LOOPS OVER TOOLS: read many files, grep-then-filter, run a check ' +
            'per file, aggregate results — one call instead of dozens of turns. Use `print(...)` and/or ' +
            '`return <value>` for output; ONLY what you print or return reaches the model (curate it — ' +
            'summarize, don\'t dump). A tool denial THROWS: wrap in try/catch to handle it. ' +
            'For writing a single file, prefer write_file directly.',
        parameters: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'The program: the body of an async JavaScript function.' },
                description: {
                    type: 'string',
                    description: 'Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: "Syntax-check every changed JS file"; "Collect test output per module".'
                }
            },
            required: ['code', 'description']
        }
    }
};

/**
 * Build the system-prompt SDK section for run_code — dsh keeps one source of truth
 * between the tool schema and its prompt guidance; this is that section.
 * @param {string[]} toolNames — tools available to programs (the turn's offered set)
 */
function buildRunCodeSdkSection(toolNames) {
    const names = (toolNames || []).filter(Boolean);
    if (!names.length) return '';
    return [
        'RUN_CODE SDK — the run_code tool executes a program with access to these tools as `await tools.<name>(args)`:',
        ...names.map(n => `- ${n}(args)`),
        '',
        'Program rules:',
        '- The code is the BODY of an async function: top-level await and return work. No import/require, no DOM — only tools + print.',
        '- `await tools.name(args)` resolves to that tool\'s result object (e.g. { path, content } for read_file). A denial or error THROWS — use try/catch.',
        '- Independent reads may run concurrently: `const [a, b] = await Promise.all([tools.read_file({path:"x"}), tools.read_file({path:"y"})]);`',
        '- Writes and commands are serialized automatically (exclusive) — do not parallelize them; order is preserved.',
        '- Curate output: print() summaries/counts/diffs, return a compact value. Never print whole file contents unless the task needs it verbatim.',
        '- Budgets: at most ' + runCodeBudgets().maxSubCalls + ' tool calls per program; the whole program has a time limit. For bigger work, split across multiple run_code calls.'
    ].join('\n');
}

/** Render one printed/returned value for model-facing text (dsh's renderValue). */
function renderValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
        const s = JSON.stringify(value, null, 2);
        return s && s !== 'undefined' ? s : String(value);
    } catch (e) {
        return String(value);
    }
}

/**
 * Create the run_code executor bound to one run's deps.
 * @param {object} deps — executor deps (executeTool, session, projectContext, …)
 */
function createRunCodeExecutor(deps) {
    const { executeTool, session } = deps;

    return async function runCode(args, callId) {
        const code = String((args && args.code) || '');
        const description = String((args && args.description) || '').trim();
        if (!description) {
            return { error: 'run_code requires a non-empty "description" (5-10 words, active voice).' };
        }
        if (!code.trim()) {
            return { error: 'run_code requires non-empty "code".' };
        }

        const budgets = runCodeBudgets();
        const logs = [];
        let dispatches = 0;
        let aborted = false;
        // v53.2 — set when the FIRST over-budget rejection has been delivered to the program.
        // The first throw is the dsh self-correction contract (the model reads it and splits
        // its work); every call AFTER that must PARK, not reject — see bindTool below.
        let budgetExhausted = false;
        let abortedThrown = false;

        /**
         * A promise that never settles. Used to PARK a program whose run is over: a
         * `while(true){ try { await tools.x(...) } catch {} }` loop (the classic model
         * "retry until it works" pattern) would otherwise spin on the rejection forever —
         * such a loop resolves only through microtasks, so the event loop never services
         * timers: withTimeout's 120s bound can NEVER fire and an outer abort can't kill it.
         * (Measured: 30+ minutes at full CPU before the process was killed by hand.)
         * Parking freezes the program at its next await with ZERO cpu; the event loop is
         * free, so withTimeout fires and settles run_code with a bounded error result.
         */
        function park() { return new Promise(() => {}); }

        // The run-scoped abort follows the outer signal, so stopping the run also
        // abandons queued sub-dispatches instead of orphaning them.
        const outerSignal = deps.signal || (session && session.abortSignal);
        if (outerSignal) {
            if (outerSignal.aborted) aborted = true;
            else outerSignal.addEventListener('abort', () => { aborted = true; }, { once: true });
        }

        // Session bookkeeping the turn loop does for top-level calls — sub-calls are
        // invisible to it, so apply the same invariants inside bindTool below (dsh logs
        // these as tool-owned session events; Agent Smith keeps them on the session object).

        const lane = createDispatchLane({ maxParallel: budgets.maxParallel });

        /** One bound tool: dispatch through the registry with a parent-linked id. */
        function bindTool(name) {
            return async (rawArgs) => {
                if (aborted) {
                    // v53.2 — first abort rejection lets well-behaved programs catch and stop;
                    // any FURTHER call PARKS instead of throwing, so a `while(true){try{await…}catch{}}`
                    // retry loop cannot spin the event loop (see park()).
                    if (!abortedThrown) { abortedThrown = true; throw new Error(`run_code run is over; ${name} not dispatched`); }
                    return park();
                }
                if (++dispatches > budgets.maxSubCalls) {
                    // v53.2 — same throw-once-then-park for the sub-call budget: the first
                    // rejection is the dsh self-correction signal; a program that calls AGAIN
                    // after it is in a retry loop and must be frozen, not fed more rejections.
                    if (!budgetExhausted) { budgetExhausted = true; throw new Error(`run_code sub-call budget exhausted (${budgets.maxSubCalls}). Split the work across multiple run_code calls.`); }
                    return park();
                }
                const subCallId = `${callId || 'code'}:code:${dispatches}`;
                // Phase gate is binding for programs too — no bypassing explore/verify.
                if (session && session.phase) {
                    const { isToolAllowed } = require('../loop/phases.js');
                    if (!isToolAllowed(session.phase, name)) {
                        throw new Error(`"${name}" is not available in ${session.phase} phase — the program cannot bypass phase gates.`);
                    }
                }
                const subArgs = (rawArgs && typeof rawArgs === 'object') ? rawArgs : {};
                // Parent-linked id (`<callId>:code:<n>`): dsh logs every sub-dispatch under it
                // for reconstruction; here it also anchors the sub-call's spill file.
                const { promise } = lane.submit({
                    name,
                    body: async () => executeTool(name, subArgs, Object.assign({}, deps, { callId: subCallId }))
                });
                const outcome = await promise;
                // Sub-call bookkeeping with the SUB-call's own args (run_command cmd etc.).
                if (session && outcome.ok) {
                    const r = outcome.result || {};
                    const rel = r.relPath || (name === 'read_file' ? r.path : null);
                    if (WRITE_TOOLS.has(name)) {
                        session.agentRanOkAfterEdit = false;
                        session.testRunsSinceEdit = false;
                        if (rel && !session.filesTouched.includes(rel)) session.filesTouched.push(rel);
                    } else if (name === 'run_command' && !subArgs.is_background) {
                        const cmd = String(subArgs.command || '');
                        const isVerification = /(test|lint|check|compile|tsc|py_compile|mypy|eslint|jest|vitest|pytest|npm run test|npm run lint)/.test(cmd);
                        if (!r.error && isVerification) session.testRunsSinceEdit = true;
                        if (!r.error) session.agentRanOkAfterEdit = true;
                    }
                }
                // Denials are binding rejections (dsh contract): the program sees a throw.
                if (!outcome.ok || (outcome.result && outcome.result.error)) {
                    const msg = outcome.result && outcome.result.error ? String(outcome.result.error) : 'tool call failed';
                    throw new Error(`${name}: ${msg}`);
                }
                return outcome.result;
            };
        }

        // The `tools` surface: only the tools offered this turn (deps.offeredToolNames),
        // so a program can never reach a tool the phase router withheld.
        const offered = new Set(deps.offeredToolNames || []);
        const boundTools = {};
        for (const name of offered) {
            if (name === RUN_CODE_NAME) continue; // no recursion
            boundTools[name] = bindTool(name);
        }
        // v53.7 — a program that calls a tool NOT offered this turn (hallucinated from the
        // SDK section, or stale knowledge of another phase) used to die with
        // `tools.run_command is not a function` — cryptic and unrecoverable for small models:
        // they then stall re-reading plan artifacts instead of self-correcting. The Proxy
        // fallback turns it into an actionable rejection naming what IS available, so
        // try/catch programs can recover (dsh denial contract).
        const tools = new Proxy(boundTools, {
            get(target, key) {
                if (typeof key !== 'string') return undefined;
                if (key in target) return target[key];
                const avail = Object.keys(target).join(', ');
                return async () => {
                    throw new Error(`Tool "${key}" is not available to this program — it was not offered by the phase router. Available tools: ${avail || '(none)'}.`);
                };
            }
        });

        function print(...vals) {
            logs.push(vals.map(renderValue).join(' '));
        }

        let resultValue;
        try {
            const fn = new Function('tools', 'print', `"use strict";\nreturn (async () => {\n${code}\n})();`);
            resultValue = await withTimeout(fn(tools, print), budgets.timeoutMs);
        } catch (e) {
            if (/timed out/i.test(e.message)) {
                return { error: `run_code timed out after ${Math.round(budgets.timeoutMs / 1000)}s. Split the program into smaller ones.`, logs };
            }
            // A program exception is a model-facing failure with its captured logs —
            // dsh's CodeRunFailedError → structured isError result, so it can self-correct.
            return { error: `run_code failed: ${e.message}`, isError: true, logs };
        }

        await lane.drain();

        const rendered = renderValue(resultValue);
        const parts = [logs.join('\n'), rendered].filter(p => p.length > 0);
        return {
            success: true,
            description,
            subCalls: dispatches,
            logs: logs.slice(0, 200),
            result: resultValue === undefined ? null : resultValue,
            output: parts.length ? parts.join('\n') : '(run_code completed with no output)'
        };
    };
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`program timed out after ${ms}ms`)), ms);
        // v53.2 — do NOT unref: while a program is PARKED (see park()) this timer is the ONLY
        // pending handle that can settle run_code. Unref'd, it never fires in any context where
        // nothing else keeps the event loop alive (node --test, isolated workers) and the bound
        // silently stops existing — "Promise resolution is still pending but the event loop has
        // already resolved". The timer is cleared on normal settle, so a running program pins
        // nothing beyond its own time limit.
        promise.then(
            v => { clearTimeout(timer); resolve(v); },
            e => { clearTimeout(timer); reject(e); }
        );
    });
}

module.exports = { RUN_CODE_NAME, RUN_CODE_SCHEMA, buildRunCodeSdkSection, createRunCodeExecutor };
