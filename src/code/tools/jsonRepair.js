/**
 * Minimal, conservative repair for LLM-emitted tool-call JSON.
 *
 * Local models routinely paste source code into a "content" string without
 * escaping it, producing JSON that is byte-for-byte invalid even though the
 * intent is unambiguous (raw newlines/tabs inside a string value). When that
 * JSON is the carrier for a write_file call, JSON.parse failing means the write
 * is silently dropped — the completion gate then reports "No project files were
 * created" and the run spins through reflections it can never satisfy.
 *
 * We repair ONLY raw control characters that appear INSIDE a string literal.
 * Everything outside strings, and every already-valid byte, is left exactly as
 * it was — so this never changes the meaning of valid JSON, and never tries to
 * guess at ambiguous damage (e.g. unescaped quotes or truncation).
 */
'use strict';

function repairJsonControlChars(text) {
    if (typeof text !== 'string' || !text) return text;
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) { out += c; esc = false; continue; }
            if (c === '\\') { out += c; esc = true; continue; }
            if (c === '"') { out += c; inStr = false; continue; }
            const code = c.charCodeAt(0);
            if (code < 0x20) {
                if (c === '\n') out += '\\n';
                else if (c === '\r') out += '\\r';
                else if (c === '\t') out += '\\t';
                else if (c === '\b') out += '\\b';
                else if (c === '\f') out += '\\f';
                else out += '\\u' + code.toString(16).padStart(4, '0');
                continue;
            }
            out += c;
            continue;
        }
        if (c === '"') { inStr = true; out += c; continue; }
        out += c;
    }
    return out;
}

/**
 * Parse JSON, falling back to a control-char repair pass. Returns
 * { ok, value } so callers never have to wrap in try/catch.
 */
function tryParseJson(text) {
    if (typeof text !== 'string') return { ok: false, value: undefined };
    try { return { ok: true, value: JSON.parse(text) }; }
    catch (e) { /* fall through to repair */ }
    try { return { ok: true, value: JSON.parse(repairJsonControlChars(text)) }; }
    catch (e) { return { ok: false, value: undefined }; }
}

module.exports = { repairJsonControlChars, tryParseJson };
