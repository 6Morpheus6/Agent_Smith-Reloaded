/**
 * Two-stage tool router — pick a subset of schemas under context budget.
 * Per-turn: respects workflow phase when provided.
 */
'use strict';

const { TOOL_CATEGORIES, schemasForNames, toolNames } = require('./schemas.js');
const { allowedToolsForPhase, WRITE_OR_HOST } = require('../loop/phases.js');

// v50: host tools survive the write-only (empty-workspace) filter — even a greenfield
// build may need web_search / process inspection on turn one. Single source in phases.js.

const ALL = toolNames();

function categorizePrompt(text) {
    const t = String(text || '').toLowerCase();
    const cats = new Set(['read']);
    if (/\b(edit|fix|patch|write|create|add|update|change|replace|implement)\b/.test(t)) cats.add('write');
    if (/\b(run|test|npm|build|install|command|shell|execute)\b/.test(t)) cats.add('shell');
    if (/\b(find|grep|search|glob|list|read|show|open)\b/.test(t)) cats.add('read');
    return cats;
}

// Append plugin tool schemas, skipping any that collide with a core tool name.
function withPlugins(coreSchemas, pluginToolSchemas) {
    const have = new Set(coreSchemas.map(s => s.function && s.function.name));
    const extra = (pluginToolSchemas || []).filter(s => s && s.function && s.function.name && !have.has(s.function.name));
    return coreSchemas.concat(extra);
}

function selectToolsForTurn({ userPrompt, turnIndex, maxTools = 7, phase, writeOnly = false, pluginToolNames = [], pluginToolSchemas = [] }) {
    // Plugin tools are real, schema-backed tools (pluginManager.getEnabledToolSchemas).
    // They are offered in implement/verify phases (they may write/run), but NOT during
    // explore, which is read-only. Phase gating restricts writes — not a tool-count cap.
    const pluginAllowed = phase ? phase !== 'explore' : true;
    const pluginExtra = (pluginAllowed && !writeOnly) ? pluginToolSchemas : [];

    // Phase-driven path (the default in the live loop): the phase tool set is small and
    // intentional, so core tools are NEVER truncated. writeOnly (empty workspace, nothing
    // written yet) drops the read/search/preview tools so the model writes immediately
    // instead of burning turns exploring an empty folder.
    if (phase) {
        let names = allowedToolsForPhase(phase).slice();
        if (writeOnly) names = names.filter(n => WRITE_OR_HOST.has(n));
        return withPlugins(schemasForNames(names), pluginExtra);
    }

    let names;
    if (turnIndex === 0) {
        names = ALL.slice(0, maxTools);
    } else {
        const cats = categorizePrompt(userPrompt);
        const set = new Set();
        for (const cat of cats) {
            for (const n of (TOOL_CATEGORIES[cat] || [])) set.add(n);
        }
        if (!set.size) ALL.forEach(n => set.add(n));
        names = [...set];
    }

    names = names.slice(0, maxTools);
    void pluginToolNames; // retained for back-compat callers; schemas are authoritative now
    return withPlugins(schemasForNames(names), pluginExtra);
}

module.exports = { selectToolsForTurn, categorizePrompt };
