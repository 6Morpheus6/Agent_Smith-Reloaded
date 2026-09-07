/**
 * v51.2 — Per-message task classifier + mode router.
 *
 * The v50 "unified harness" hard-routed EVERY message through the Code engine,
 * so plain chat and ordinary agent tasks (organize files, check disk space,
 * read a log) all ran the project-build pipeline: plan phases, build tools,
 * test-before-done gate. This module decides per message which run type fits:
 *
 *   code  — Code Mode engine (project build: phases, ledger, verify-before-done)
 *   agent — Agent Mode chat path (full host-control tool surface: shell, files
 *           anywhere, web, memory) — also the plain-chat destination.
 *
 * Routing order in `routeMessage`:
 *   1. explicit override tokens (`code:` / `agent:` prefix) — strip + honor
 *   2. scoring heuristics — strong coding signals outweigh file-management
 *      negatives; ambiguous input goes to agent (chat stays chat).
 */
'use strict';

const OVERRIDE_RE = /^\s*(?:\/)?(code|build|agent)\s*:\s*/i;

// Strong coding signals: a project is being made or repaired. +2 each.
const STRONG_CODING_RES = [
    /\b(build|create|make|develop|implement|write|code|program|scaffold|generate)\b.{0,70}\b(app|application|cli|web\s*site|website|webpage|web\s?page|landing\s?page|dashboard|api|server|bot|game|extension|addon|add-on|plugin|script|package|library|module|tool|program|service|crawler|scraper)\b/i,
    /\bbuilt[- ]?(in)?\s+[a-z0-9._+-]+\b/, // "built in python", "built-in node app"
    /using\s+(?:the\s+)?(?:python|javascript|typescript|node(\.js|-js)?|react|vue|svelte|django|flask|fastapi|express|rust|golang?|java(script)?|c\+\+|c#|php|ruby|swift|kotlin)\b/i,
    /\bin\s+(?:python|javascript|typescript|node(\.js|-js)?|react|vue|svelte|django|flask|fastapi|express|rust|golang?|java(script)?|c\+\+|c#|php|ruby|swift|kotlin)\b/i,
    /with\s+(?:python|javascript|typescript|node(\.js|-js)?|react|vue|svelte|django|flask|fastapi|express|rust|golang?|java(script)?|c\+\+|c#|php|ruby|swift|kotlin)\b/i,
    /\b(convert|port|migrate|refactor|rewrite|translate)\b.{0,60}\b(to|into)\s+[a-z0-9.+#_-]{2,24}\b/i,
    /\b(add|fix|patch|update|improve|debug|extend|optimize|implement|create|write|make|build)\b.{0,70}\b(bug|bugs|error|errors|exception|crash|crashes|stack\s?trace|regression|issue|failing|broken)\b/i,
    /\b(debug|fix|patch|resolve)\b.{0,50}(?:\b(this\b|\bmy\b|\bour\b|\bthe\b).{0,30}\b(code|app|script|project|module|function|class|component|endpoint)\b)/i,
    /\btest\s*[- ]?(suite|runner|coverage)\b/i,
    /\bnpm (?:install|i|run|test|build|start)\b|\bpnpm (?:install|run)\b|\byarn (?:add|install|run)\b|\bpip install\b|\bgit init\b/i,
    /package\.json|requirements\.txt|pyproject\.toml|cargo\.toml|go\.mod|tsconfig\.json/i,
];

// Medium coding signals: programming context present. +1 each.
const MEDIUM_CODING_RES = [
    /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|rs|go|java|cs|cpp|cc|h|hpp|php|swift|kt|sh)\b/i,
    /\bfunction\b.{0,60}\b(parameter|argument|return|error|exception)/i,
    /\b(refactor|restructure)\b/i,
    /\bgit (?:commit|branch|merge|push|pull|clone|init)\b/i,
    /\b(compile|compilation|type\s?check|linter|linting|minify|transpile)\b/i,
    /stack ?trace/i,
];

// Negative signals: the ask is file/host management or research, not code authorship. -2 each.
const NEGATIVE_RES = [
    /\b(move|rename|copy|delete|remove|clean up|tidy|organize|organise|archive|back ?up)\b.{0,70}\b(files?|folders?|directories?)\b/i,
    /\b(what|how much)\s+(is the |size of )?(disk|hard drive|hdd|ssd)\b|\bdisk (usage|space)\b|\bfree space\b/i,
    /\b(check|look at|read|show me|list|find|search for|open)\b.{0,50}\b(logs?|process(es)?|service(s)?|folder|directory|file)s?\b/i,
    /\b(translate|summarize|summarise|explain|compare|research|look up|what is|who is|when did|why does)\b/i,
];

const CODE_THRESHOLD = 3; // e.g. one strong signal + one context signal, or three mediums

// Decision rule — a message is a CODING task when EITHER:
//   - cumulative score >= CODE_THRESHOLD (strong signals stack), OR
//   - there is at least ONE strong coding signal and NO file-management/research
//     negative at all ("write a CLI tool" alone must not be diluted by chat noise).
function isCodingTask(text) {
    const t = String(text || '');
    let score = 0;
    let strong = 0;
    let negs = 0;
    for (const re of STRONG_CODING_RES) if (re.test(t)) { score += 2; strong++; }
    for (const re of MEDIUM_CODING_RES) if (re.test(t)) score += 1;
    for (const re of NEGATIVE_RES) if (re.test(t)) { score -= 2; negs++; }
    return score >= CODE_THRESHOLD || (strong > 0 && negs === 0);
}

/** Score breakdown for a message — exposed for tests and future tuning. */
function analyze(text) {
    const t = String(text || '');
    let strong = 0, medium = 0, negs = 0;
    for (const re of STRONG_CODING_RES) if (re.test(t)) strong++;
    for (const re of MEDIUM_CODING_RES) if (re.test(t)) medium++;
    for (const re of NEGATIVE_RES) if (re.test(t)) negs++;
    const score = strong * 2 + medium - negs * 2;
    return { score, strong, medium, negatives: negs, coding: isCodingTask(text) };
}

function scoreText(text) {
    return analyze(text).score;
}

/**
 * Route one user message to its run type.
 * @param {string} text raw user input (before attachment appending).
 * @returns {{ mode: 'code'|'agent', prompt: string, override: boolean }}
 */
function routeMessage(text) {
    const t = String(text == null ? '' : text);
    const m = OVERRIDE_RE.exec(t);
    if (m) {
        return { mode: m[1].toLowerCase() === 'agent' ? 'agent' : 'code', prompt: t.slice(m[0].length), override: true };
    }
    return { mode: isCodingTask(t) ? 'code' : 'agent', prompt: t, override: false };
}

const api = { scoreText, isCodingTask, routeMessage, analyze, CODE_THRESHOLD };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XKTaskClassifier = api;
