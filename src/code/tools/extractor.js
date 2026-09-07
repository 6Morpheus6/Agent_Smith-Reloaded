/**
 * Tool call extractor — recover structured tool_calls from prose/JSON replies.
 */
'use strict';

const { tryParseJson } = require('./jsonRepair.js');

const TOOL_CALL_TAG_RE = /<tool[_\-]?call>\s*([\s\S]*?)\s*<\/tool[_\-]?call>/gi;
const FENCED_RE = /```(?:json|tool_?call|tool|tool_code)?\s*\n?([\s\S]*?)\n?```/gi;

function scanJsonObjects(text) {
    const out = [];
    const opens = { '{': '}', '[': ']' };
    for (let i = 0; i < text.length; i++) {
        const open = text[i];
        if (open !== '{' && open !== '[') continue;
        const close = opens[open];
        let depth = 0, inStr = false, esc = false;
        for (let j = i; j < text.length; j++) {
            const c = text[j];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') inStr = true;
            else if (c === open) depth++;
            else if (c === close) {
                depth--;
                if (depth === 0) { out.push(text.slice(i, j + 1)); i = j; break; }
            }
        }
    }
    return out;
}

function normalizeToolCall(obj, validNames) {
    if (!obj || typeof obj !== 'object') return null;
    const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj;
    const name = fn.name || obj.name || obj.tool || obj.tool_name || obj.action;
    if (!name || !validNames.has(name)) return null;
    let args = fn.arguments !== undefined ? fn.arguments
        : (obj.arguments !== undefined ? obj.arguments
            : (obj.parameters !== undefined ? obj.parameters
                : (obj.args !== undefined ? obj.args : {})));
    if (typeof args === 'string') {
        const r = tryParseJson(args);
        if (r.ok) args = r.value;
    }
    if (typeof args !== 'object' || args === null) args = {};
    return {
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name, arguments: args }
    };
}

/** Decode the standard JSON string escapes; leave anything else (incl. bare ") intact. */
function unescapeJsonString(s) {
    return String(s).replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (m, g) => {
        switch (g[0]) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case 'b': return '\b';
        case 'f': return '\f';
        case '"': return '"';
        case '\\': return '\\';
        case '/': return '/';
        case 'u': return String.fromCharCode(parseInt(g.slice(1), 16));
        default: return m;
        }
    });
}

/**
 * Tolerant recovery for content-bearing calls (write_file/patch). Local models routinely
 * emit these with UNESCAPED quotes inside the content (e.g. id="x" in HTML), or several
 * calls concatenated in one reply — both of which make strict JSON.parse fail and silently
 * drop the write. We segment on each tool-call object, pull the (clean) path, and capture
 * the content greedily up to the object's closing quote. A call whose content has no proper
 * closing quote (truncated) is skipped so we never write a half-file.
 *
 * Field order matters: models emit both {"name","path","content"} and
 * {"name","content","path"}. The closing quote of `content` is found by walking back
 * from the END of the object — which is only correct when `content` is the LAST field.
 * When another key (e.g. "path") follows `content`, we must first cut the segment at that
 * trailing key, otherwise the walk-back lands on the LATER field's closing quote and the
 * `","path":"…"` tail is swallowed into the file (the classic `}\n","path":"style.css`
 * corruption). So: trim any recognised key that appears AFTER content before walking back.
 */
const TRAILING_KEY_AFTER_CONTENT_RE =
    /"\s*,\s*"(?:path|name|tool|tool_name|action|args|arguments|parameters|file|filename|filepath|target)"\s*:/;

function extractLenientWriteCalls(text, known) {
    const out = [];
    if (typeof text !== 'string' || !text.includes('"content"')) return out;
    const segs = text.split(/(?=\{\s*"name"\s*:)/);
    for (const seg of segs) {
        const nameM = seg.match(/"name"\s*:\s*"([^"]+)"/);
        if (!nameM) continue;
        const name = nameM[1];
        if (!known.has(name) || (name !== 'write_file' && name !== 'patch')) continue;
        const pathM = seg.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (!pathM) continue;
        const cm = seg.match(/"content"\s*:\s*"/);
        if (!cm) continue;
        let rest = seg.slice(cm.index + cm[0].length);
        // If a recognised key follows content in this object, the content value ends at
        // its OWN closing quote, right before that key. Cut there (keeping that closing
        // quote) so the walk-back below cannot run on into the later field's value.
        const tailKey = rest.match(TRAILING_KEY_AFTER_CONTENT_RE);
        if (tailKey) rest = rest.slice(0, tailKey.index + 1);
        // Walk back over the object/array closers + whitespace to find the content's
        // closing quote. No closing quote ⇒ the content was truncated ⇒ skip it.
        let k = rest.length - 1;
        while (k >= 0 && /[\s}\],]/.test(rest[k])) k--;
        if (k < 0 || rest[k] !== '"') continue;
        const content = unescapeJsonString(rest.slice(0, k));
        if (!content) continue;
        out.push({
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: { name, arguments: { path: unescapeJsonString(pathM[1]), content } }
        });
    }
    return out;
}

/** Salvage a truncated write_file for a specific pending path (weak models cut off mid-JS). */
function extractSalvageTruncatedPendingWrite(text, targetPath) {
    if (typeof text !== 'string' || !targetPath) return null;
    const normPath = String(targetPath).replace(/\\/g, '/');
    if (!/\.(js|mjs|cjs)$/i.test(normPath)) return null;

    const esc = normPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pathRe = new RegExp(`"path"\\s*:\\s*"${esc}"`);
    const idx = text.search(pathRe);
    if (idx < 0) return null;

    const tail = text.slice(idx);
    const cm = tail.match(/"content"\s*:\s*"/);
    if (!cm) return null;
    const start = cm.index + cm[0].length;
    let raw = tail.slice(start);
    // Truncated — no closing quote; take everything and balance delimiters.
    raw = unescapeJsonString(raw.replace(/"\s*,\s*"path"\s*:.*$/s, '').replace(/"\s*}\s*$/s, ''));

    if (raw.length < 120 || !/\b(const|let|function|document\.|addEventListener)\b/.test(raw)) {
        return null;
    }

    const balance = (s, open, close) => {
        let o = (s.match(new RegExp('\\' + open, 'g')) || []).length;
        let c = (s.match(new RegExp('\\' + close, 'g')) || []).length;
        while (o > c) { s += close; c++; }
        return s;
    };
    raw = balance(balance(balance(raw, '{', '}'), '[', ']'), '(', ')');

    return { path: normPath, content: raw };
}

function repairMalformedWriteCalls(message, salvagePath) {
    if (!salvagePath || !Array.isArray(message?.tool_calls) || !message.tool_calls.length) return 0;
    let fixed = 0;
    for (const tc of message.tool_calls) {
        const fn = tc.function;
        if (!fn) continue;
        const name = fn.name;
        if (name !== 'write_file' && name !== 'patch') continue;
        let args = fn.arguments;
        if (typeof args === 'string') {
            const r = tryParseJson(args);
            args = r.ok ? r.value : {};
        }
        if (!args || typeof args !== 'object') args = {};
        if (!args.path && args.content) {
            fn.arguments = { ...args, path: salvagePath };
            fixed++;
        }
    }
    return fixed;
}

function extractFromMessage(message, toolSchemas, opts = {}) {
    if (!message) return { patched: false, addedCalls: 0 };
    if (opts.salvagePath && Array.isArray(message.tool_calls) && message.tool_calls.length) {
        const repaired = repairMalformedWriteCalls(message, opts.salvagePath);
        if (repaired) return { patched: true, addedCalls: 0, repairedMalformed: repaired };
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        return { patched: false, addedCalls: 0 };
    }
    const primary = typeof message.content === 'string' ? message.content : '';
    const fallback = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    const content = primary && primary.trim().length > 0 ? primary : fallback;
    if (!content) return { patched: false, addedCalls: 0 };

    const known = new Set();
    if (Array.isArray(toolSchemas)) {
        for (const t of toolSchemas) {
            const n = t?.function?.name || t?.name;
            if (typeof n === 'string') known.add(n);
        }
    }

    const candidates = [];
    let m;
    TOOL_CALL_TAG_RE.lastIndex = 0;
    while ((m = TOOL_CALL_TAG_RE.exec(content)) !== null) candidates.push(m[1]);
    FENCED_RE.lastIndex = 0;
    while ((m = FENCED_RE.exec(content)) !== null) candidates.push(m[1]);
    candidates.push(content);

    const calls = [];
    const seen = new Set();
    const sigOf = (c) => {
        // For content-bearing tools, dedup by name+path (strict and lenient passes will
        // both surface the same write — keep one) instead of by full args.
        const a = c.function.arguments || {};
        if ((c.function.name === 'write_file' || c.function.name === 'patch') && a.path) {
            return `${c.function.name}:${a.path}`;
        }
        return c.function.name + JSON.stringify(a);
    };
    const push = (c) => {
        if (!c) return;
        const sig = sigOf(c);
        if (seen.has(sig)) return;
        seen.add(sig);
        calls.push(c);
    };

    for (const cand of candidates) {
        for (const blob of scanJsonObjects(cand)) {
            const r = tryParseJson(blob);
            if (!r.ok) continue;
            const parsed = r.value;
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const it of items) {
                if (it && Array.isArray(it.tool_calls)) {
                    it.tool_calls.forEach(t => push(normalizeToolCall(t, known)));
                } else {
                    push(normalizeToolCall(it, known));
                }
            }
        }
    }

    // Tolerant fallback for write_file/patch the strict pass couldn't parse (unescaped
    // quotes in content, concatenated calls). Dedup keeps strict results when both match.
    for (const c of extractLenientWriteCalls(content, known)) push(c);

    if (!calls.length && opts.salvagePath) {
        const salvaged = extractSalvageTruncatedPendingWrite(content, opts.salvagePath);
        if (salvaged) {
            push({
                id: `call_${Math.random().toString(36).slice(2, 10)}`,
                type: 'function',
                function: { name: 'write_file', arguments: salvaged }
            });
        }
    }

    if (!calls.length) return { patched: false, addedCalls: 0 };
    message.tool_calls = calls;
    message.content = '';
    return { patched: true, addedCalls: calls.length };
}

function extractToolCallsFromText(content, validNames) {
    const msg = { content };
    const schemas = [...validNames].map(n => ({ function: { name: n } }));
    const r = extractFromMessage(msg, schemas);
    return r.addedCalls ? msg.tool_calls : null;
}

module.exports = {
    extractFromMessage,
    extractToolCallsFromText,
    normalizeToolCall,
    scanJsonObjects,
    extractLenientWriteCalls,
    extractSalvageTruncatedPendingWrite,
    repairMalformedWriteCalls
};
