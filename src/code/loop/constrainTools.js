'use strict';

// Constrained tool-call decoding for Code Mode (local models via LM Studio).
//
// Local/reasoning models frequently narrate ("I'll write index.html") or emit malformed
// tool calls instead of calling a tool — which stalls multi-file builds. LM Studio supports
// response_format:{type:'json_schema'} (structured output / constrained decoding). By sending
// the advertised tools AS a json_schema union, the model can ONLY emit a valid
// {name, arguments} tool call (or a finish signal) — it physically cannot malform or narrate.
//
// A synthetic "attempt_completion" branch is added so the model can still signal "done" under
// the constraint (otherwise it could never stop emitting tool calls). The turn loop treats it
// as a no-tool-call turn, which runs the completion gate as usual.
//
// Opt-in (env XK_CODE_CONSTRAIN_TOOLS=1); default off, so normal behavior is unchanged.

const FINISH_TOOL = 'attempt_completion';

/** Build the LM Studio response_format value from OpenAI-format tool schemas. */
function buildToolResponseFormat(tools) {
    const oneOf = [];
    const seen = new Set();
    for (const t of tools || []) {
        const name = t && t.function && t.function.name;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        oneOf.push({
            type: 'object',
            properties: {
                name: { type: 'string', const: name },
                arguments: t.function.parameters || { type: 'object', properties: {} }
            },
            required: ['name', 'arguments'],
            additionalProperties: false
        });
    }
    if (!oneOf.length) return null;
    // Finish branch — lets the model stop under the constraint.
    oneOf.push({
        type: 'object',
        properties: {
            name: { type: 'string', const: FINISH_TOOL },
            arguments: { type: 'object', properties: { summary: { type: 'string' } } }
        },
        required: ['name', 'arguments'],
        additionalProperties: false
    });
    return {
        type: 'json_schema',
        json_schema: { name: 'code_tool_call', strict: true, schema: { type: 'object', oneOf } }
    };
}

/**
 * Parse the model's constrained content (a JSON {name,arguments}) into a tool_calls array.
 * @returns {{ toolCalls: Array, finish: boolean, summary?: string }}
 *   finish=true means the model chose attempt_completion (stop).
 */
function parseConstrainedContent(content) {
    const text = String(content || '').trim();
    if (!text) return { toolCalls: [], finish: false };
    let obj = null;
    try { obj = JSON.parse(text); } catch (e) {
        const m = text.match(/\{[\s\S]*\}/); // tolerant: first {...} block
        if (m) { try { obj = JSON.parse(m[0]); } catch (_) { obj = null; } }
    }
    if (!obj || typeof obj !== 'object' || !obj.name) return { toolCalls: [], finish: false };
    if (obj.name === FINISH_TOOL) {
        return { toolCalls: [], finish: true, summary: (obj.arguments && obj.arguments.summary) || '' };
    }
    const args = (obj.arguments && typeof obj.arguments === 'object') ? obj.arguments : {};
    return {
        toolCalls: [{ id: 'call_c0', type: 'function', function: { name: obj.name, arguments: args } }],
        finish: false
    };
}

module.exports = { buildToolResponseFormat, parseConstrainedContent, FINISH_TOOL };
