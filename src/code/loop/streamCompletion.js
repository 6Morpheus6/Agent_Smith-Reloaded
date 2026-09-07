/**
 * LLM streaming completion for Code Mode (OpenAI /v1/chat/completions).
 */
'use strict';

const https = require('https');
const http = require('http');
const { normalizeLlmBaseUrl } = require('../../shared/netGuard.js');
const { pinTemperatureForModel, bodyOverridesFor } = require('../context/modelHarness.js');
const { isKimiK3Model } = require('../../shared/modelClassifier.js');
const { sanitizeToolPairing } = require('../../shared/toolPairing.js');
const { tryParseJson } = require('../tools/jsonRepair.js');
const { stripInlineReasoning } = require('./reasoningStrip.js');
const { buildToolResponseFormat, parseConstrainedContent } = require('./constrainTools.js');
const { classifyHttpError } = require('../../shared/streamSignals.js');

function apiBase(base) {
    return normalizeLlmBaseUrl(base);
}

function messagesForWire(messages) {
    return (messages || []).map(message => {
        if (!Array.isArray(message?.tool_calls)) return message;
        return {
            ...message,
            tool_calls: message.tool_calls.map(call => ({
                ...call,
                function: {
                    ...call.function,
                    arguments: typeof call.function?.arguments === 'string'
                        ? call.function.arguments
                        : JSON.stringify(call.function?.arguments || {})
                }
            }))
        };
    });
}

// Strict providers (Kimi/Moonshot, OpenAI) validate tool schemas; LM Studio ignores
// malformed ones. Normalize to the minimum valid shape so a plugin/builtin schema
// can never take down a run with a bare "Invalid request" 400.
function normalizeToolSchemas(tools) {
    if (!Array.isArray(tools)) return tools;
    return tools
        .filter(t => t && (t.function?.name || t.name))
        .map(t => {
            const fn = t.function || t;
            const params = (fn.parameters && typeof fn.parameters === 'object') ? fn.parameters : {};
            return {
                type: 'function',
                function: {
                    name: fn.name,
                    description: typeof fn.description === 'string' ? fn.description : '',
                    parameters: {
                        ...params,
                        type: 'object',
                        properties: (params.properties && typeof params.properties === 'object') ? params.properties : {}
                    }
                }
            };
        });
}

async function streamCompletion({
    apiBaseUrl, model, messages, tools, signal, onDelta, maxTokens, temperature,
    // Hosted-provider auth (Kimi K3 / Moonshot etc.). null/empty = no Authorization
    // header, which is what local LM Studio expects.
    apiKey = null,
    requestTimeoutMs = 1800000,
    // Between-token idle window (env-tunable). The FIRST token gets a more generous window
    // because heavy prompt-processing (large context + a big single write_file like script.js)
    // can legitimately take longer than the mid-stream gap before the model starts emitting.
    inactivityTimeoutMs = Math.max(Number(process.env.XK_CODE_STREAM_IDLE_MS) || 0, 600000),
    firstTokenTimeoutMs = Math.max(Number(process.env.XK_CODE_STREAM_FIRST_TOKEN_MS) || 0, inactivityTimeoutMs, 900000),
    constrain = false,
    // v52.7: live generation-state hook — 'waiting' when the request is sent (prompt
    // processing / first-token window), 'generating' on the FIRST SSE delta of any kind
    // (content, reasoning or tool_call). Model-agnostic: it fires from what arrives on the
    // wire, so every family reports its busy state identically. The UI uses this to show a
    // live "model is generating" indicator and to refuse actions that would cut the reply off.
    onState = null
}) {
    const url = `${apiBase(apiBaseUrl)}/v1/chat/completions`;
    // v52.7: UNBOUNDED output (max_tokens:-1). LM Studio honors -1 as "no cap" — verified
    // live: a 4k-token prompt + thinking model returns finish_reason:"stop", never "length".
    // The old explicit budget (4096–8192) was the cut-off source for thinking-by-default
    // models of ANY family: they spend most of the budget on internal reasoning, hit the
    // cap with zero content out, and the run dies on empty turns. With no per-reply cap a
    // reply is only ever "cut off" by the user stopping it or the engine dying — both of
    // which surface as explicit errors, never as silent truncation. (Hosted strict APIs are
    // not in scope: this app talks to LM Studio's OpenAI-compatible endpoint.)
    // v53.1: Kimi K3 / Moonshot is the exception — its API REJECTS max_tokens:-1 with HTTP
    // 400, which made EVERY Code Mode turn fail when a hosted Kimi key was configured (the
    // chat path already sends 8192 for it; mirror that here). The truncation-recovery path
    // in turnLoop handles the resulting 'length' finishes.
    const body = {
        model,
        // Strict hosted APIs (Kimi/Moonshot, OpenAI) 400 on any tool/tool_call
        // mismatch — sanitize the pairing so compacted/resumed/sliced histories
        // can never take down a run ("tool_call_id is not found").
        messages: sanitizeToolPairing(messagesForWire(messages)),
        stream: true,
        temperature: Number.isFinite(temperature) ? temperature : 0.2,
        max_tokens: isKimiK3Model(model) ? 8192 : -1,
        // v52.7: LM Studio only emits the `usage` block on STREAMING requests when this is set
        // (verified live: without it usage never arrives; with it the final chunk carries
        // prompt/completion/total + reasoning_tokens). This feeds the live "↓ N t" counter in
        // both Code Mode and chat. The usage chunk has an empty choices array — the parser
        // below skips delta-less chunks, so this is safe on every OpenAI-compatible server.
        stream_options: { include_usage: true }
    };
    // Family-mandated temperature pins (kimi-k3 rejects anything but 1, HTTP 400).
    // Routed by the table in modelHarness.js — no per-model ifs here.
    body.temperature = pinTemperatureForModel(model, body.temperature);
    // Family-mandated extra request-body fields (qwen3+: chat_template_kwargs to switch
    // thinking off so the budget reaches content/tool calls). The family wins over our
    // defaults; providers that don't know the key simply ignore it.
    Object.assign(body, bodyOverridesFor(model));
    // Constrained tool-call decoding (opt-in): instead of native function-calling, send the
    // tools as an LM Studio json_schema response_format so the model can only emit a valid
    // {name, arguments} object. The reply arrives as JSON content, parsed below.
    const responseFormat = constrain && tools && tools.length ? buildToolResponseFormat(tools) : null;
    if (responseFormat) {
        body.response_format = responseFormat;
    } else if (tools && tools.length) {
        body.tools = normalizeToolSchemas(tools);
    }

    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    return new Promise((resolve, reject) => {
        let hardTimer = null;
        let idleTimer = null;
        let settled = false;
        let onAbort = null;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(hardTimer);
            clearTimeout(idleTimer);
            // Remove the abort listener so it doesn't accumulate on the shared (per-run) signal
            // across every turn (MaxListenersExceededWarning + retained closures otherwise).
            if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch (e) { /* ignore */ } }
            fn(value);
        };
        const armIdleTimer = (req, ms = inactivityTimeoutMs) => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                req.destroy(new Error(`LM Studio response stalled for ${ms}ms. If your model is slow or reasoning, increase the timeout via XK_CODE_STREAM_IDLE_MS environment variable.`));
            }, ms);
        };
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers
        }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                let errorBody = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { errorBody += chunk; });
                res.on('end', () => {
                    let detail = errorBody.trim();
                    let meta = '';
                    try {
                        const parsedError = JSON.parse(errorBody);
                        const errObj = parsedError?.error || parsedError;
                        detail = errObj?.message || parsedError?.message || detail;
                        // Surface the validator's param/code/type when present — without
                        // it a strict-API 400 is just "Invalid request" with no clue which
                        // field was rejected.
                        const bits = [];
                        if (errObj?.param) bits.push(`param: ${errObj.param}`);
                        if (errObj?.code) bits.push(`code: ${errObj.code}`);
                        if (errObj?.type) bits.push(`type: ${errObj.type}`);
                        if (bits.length) meta = ` (${bits.join(', ')})`;
                    } catch (e) { /* keep raw body */ }
                    // v52.7: model-agnostic failure classification (streamSignals) — a
                    // context overflow gets an actionable message instead of raw engine text,
                    // and the same rules apply to every family LM Studio can serve.
                    const classified = classifyHttpError({ status: res.statusCode, body: detail });
                    if (classified.message) {
                        return finish(reject, new Error(`${classified.message}${meta}`));
                    }
                    finish(reject, new Error(`LM Studio HTTP ${res.statusCode}: ${detail || res.statusMessage || 'request failed'}${meta}`));
                });
                return;
            }
            let buffer = '';
            let content = '';
            let toolCalls = [];
            let finishReason = null;
            let sawReasoning = false;
            // v52.7: reasoning-channel char count — feeds the model-agnostic exhaustion
            // classifier (finish_reason:"length" + no content, with or without visible thinking).
            let reasoningChars = 0;
            // Token usage from the server (OpenAI-compatible `usage` on SSE chunks — LM Studio
            // sends it in the final chunk). Accumulated per run for the live status indicator.
            let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
            // True once ANY SSE delta (content / reasoning / tool_call) has flowed. A 200
            // response that ends with zero deltas, no finish_reason and no [DONE] is an
            // engine-level abort (LM Studio's predict runtime SIGABRTs under load — "Engine
            // protocol runtime exited unexpectedly" in its logs — and closes the stream right
            // after headers), not a normal empty reply. Without this check it surfaces as six
            // identical empty turns instead of the stall-retry path. A protocol-complete
            // stream always ends with a finish_reason chunk or [DONE], so those still resolve.
            let sawAnyDelta = false;
            let sawDone = false;
            // v52.7: 'generating' announced exactly once (on the first delta of any kind).
            let stateAnnounced = false;

            res.on('data', (chunk) => {
                // v52.7: data is flowing — the model IS generating, so the absolute hard cap no
                // longer applies to this request; only the between-token idle window guards it
                // from here on. This is what makes "nothing gets cut off while generating" true:
                // a 40-minute single reply that keeps emitting tokens can never be killed by a
                // wall-clock timer, for any model family.
                if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
                armIdleTimer(req, inactivityTimeoutMs); // data flowing — use the between-token window
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') { sawDone = true; continue; }
                    let json;
                    try { json = JSON.parse(data); } catch (e) { continue; }
                    // Server-reported token usage. MUST be read BEFORE the delta guard below:
                    // LM Studio's final chunk carries `usage` with an EMPTY choices array, so a
                    // delta-less skip would drop it (and the live "↓ N t" counter stays at 0).
                    const u = json.usage;
                    if (u && typeof u === 'object') {
                        for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
                            if (Number.isFinite(u[k])) usage[k] += u[k];
                        }
                    }
                    const delta = json.choices?.[0]?.delta;
                    if (!delta) continue;
                    if (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls) sawAnyDelta = true;
                    // v52.7: first token of ANY kind flips the live state to 'generating' —
                    // this is what "the model is still generating" means on the wire, for any family.
                    if (sawAnyDelta && !stateAnnounced) {
                        stateAnnounced = true;
                        try { if (onState) onState('generating'); } catch (e) { /* UI hook — never break the stream */ }
                    }
                    if (delta.content) {
                        content += delta.content;
                        if (onDelta) onDelta(delta.content);
                    }
                    // Surface reasoning-model thinking (delta.reasoning_content) to the
                    // timeline's "Reasoning" panel. Display-only — NOT added to `content`,
                    // so it isn't re-sent to the model. Without this, Code Mode looks frozen
                    // while a reasoning model (qwen3 etc.) thinks, and reasoning never traces.
                    // Some servers use `reasoning_content`, others `reasoning`.
                    const reasoningDelta = delta.reasoning_content || delta.reasoning;
                    if (reasoningDelta) {
                        sawReasoning = true;
                        reasoningChars += String(reasoningDelta).length;
                        if (onDelta) onDelta(reasoningDelta);
                    }
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!toolCalls[idx]) {
                                toolCalls[idx] = { id: tc.id || `call_${idx}`, type: 'function', function: { name: '', arguments: '' } };
                            }
                            if (tc.id) toolCalls[idx].id = tc.id;
                            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                        }
                    }
                    if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
                }
            });

            res.on('end', () => {
                // 200 but nothing came across the wire: the server's engine dropped the
                // request (see sawAnyDelta comment) and closed right after headers. Reject as
                // a stall so turnLoop's bounded retry path handles it instead of recording six
                // identical empty turns and dying on "no files written". Protocol-complete
                // streams always end with a finish_reason chunk or [DONE] — those resolve.
                if (!sawAnyDelta && !finishReason && !sawDone) {
                    // "stalled" in the message is load-bearing: turnLoop's bounded-retry path
                    // keys on /stalled|timed out/i — a dead engine is a stall, so retry it.
                    return finish(reject, new Error('LM Studio stream stalled right after headers with no output (engine may have crashed or the model failed to load mid-request). If this repeats, restart LM Studio or lower the context size.'));
                }
                toolCalls = toolCalls.filter(Boolean).map(tc => {
                    const r = tryParseJson(tc.function.arguments);
                    const args = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
                    return { id: tc.id, type: 'function', function: { name: tc.function.name, arguments: args } };
                });
                // Strip inline <think>...</think> reasoning that some small models emit
                // in content (vs the reasoning_content field) so it never reaches the
                // edit/tool parser. Flag it so the reasoning-truncation guard still fires.
                const stripped = stripInlineReasoning(content);
                if (stripped.hadReasoning) sawReasoning = true;

                // Constrained decoding: the reply IS the tool call (JSON content), not a
                // native tool_calls array. Parse it. A "finish" choice becomes a normal
                // no-tool-call turn (content = summary) so the completion gate runs.
                if (responseFormat) {
                    const c = parseConstrainedContent(stripped.text);
                    finish(resolve, {
                        message: {
                            role: 'assistant',
                            content: c.finish ? (c.summary || '') : '',
                            tool_calls: c.toolCalls.length ? c.toolCalls : undefined
                        },
                        finishReason,
                        sawReasoning,
                        usage,
                        // v52.7: model-agnostic end-of-stream facts for the caller's
                        // cut-off detection (streamSignals.classifyStreamEnd).
                        streamEnd: {
                            finishReason,
                            contentChars: String(c.finish ? (c.summary || '') : '').length,
                            reasoningChars,
                            toolCallCount: c.toolCalls.length,
                            sawAnyDelta
                        }
                    });
                    return;
                }

                finish(resolve, {
                    message: { role: 'assistant', content: stripped.text, tool_calls: toolCalls.length ? toolCalls : undefined },
                    finishReason,
                    sawReasoning,
                    usage,
                    // v52.7: model-agnostic end-of-stream facts for the caller's cut-off detection.
                    streamEnd: {
                        finishReason,
                        contentChars: String(stripped.text || '').length,
                        reasoningChars,
                        toolCallCount: toolCalls.length,
                        sawAnyDelta
                    }
                });
            });
        });

        hardTimer = setTimeout(() => {
            req.destroy(new Error(`LM Studio request timed out after ${requestTimeoutMs}ms (hard limit).`));
        }, requestTimeoutMs);
        armIdleTimer(req, firstTokenTimeoutMs); // generous window for prompt-processing / first token
        req.on('error', error => finish(reject, error));
        if (signal) {
            if (signal.aborted) {
                req.destroy();
                return finish(reject, new Error('Aborted'));
            }
            onAbort = () => {
                req.destroy();
                finish(reject, new Error('Aborted'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }
        // v52.7: 'waiting' — request is in flight, no token yet (prompt processing / first-token window).
        try { if (onState) onState('waiting'); } catch (e) { /* UI hook */ }
        req.write(payload);
        req.end();
    });
}

module.exports = { streamCompletion, apiBase };
