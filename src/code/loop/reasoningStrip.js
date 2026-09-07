'use strict';

// Strip inline reasoning from a model's CONTENT (Code Mode only).
//
// Some small "reasoning" models don't use the OpenAI reasoning_content field — they
// emit their thinking inline in the content as <think>...</think> (or <thinking>...).
// If that reaches the edit/tool parser it pollutes the output (the model's real tool
// call or file body is buried in, or confused with, the reasoning), so Code Mode
// strips the reasoning tag from content before parsing edits/tool calls.
//
// Returns { text, hadReasoning }:
//   - complete <think>...</think> blocks are removed
//   - an UNCLOSED opening tag (model truncated mid-thought) drops everything from the
//     tag onward, and reports hadReasoning so the turn loop's reasoning-truncation
//     guard can react.
const OPEN_TAGS = ['think', 'thinking', 'thought', 'reason', 'reasoning'];

function stripInlineReasoning(input) {
    let text = String(input || '');
    let hadReasoning = false;

    for (const tag of OPEN_TAGS) {
        const block = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi');
        if (block.test(text)) {
            hadReasoning = true;
            text = text.replace(block, '');
        }
        // Orphaned closing tag: keep only what follows it (content after reasoning).
        const close = new RegExp(`[\\s\\S]*</${tag}>`, 'i');
        if (close.test(text)) {
            hadReasoning = true;
            text = text.replace(close, '');
        }
        // Unclosed opening tag (truncated mid-reasoning): drop from the tag onward.
        const open = new RegExp(`<${tag}>[\\s\\S]*$`, 'i');
        if (open.test(text)) {
            hadReasoning = true;
            text = text.replace(open, '');
        }
    }

    return { text: text.trim(), hadReasoning };
}

module.exports = { stripInlineReasoning };
