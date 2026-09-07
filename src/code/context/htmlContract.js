/**
 * HTML ↔ JS id contract — keep models from inventing element ids that don't match index.html.
 *
 * READ-ONLY by design. The harness DETECTS DOM-id/form-control mismatches and tells the model
 * exactly which id to rename (so it fixes script.js itself via patch — a ledger-tracked edit).
 * It does NOT rewrite the model's source on disk: an earlier version auto-edited script.js with
 * fuzzy heuristics (rename/prune/dedupe) that could delete valid code and bypassed Revert All.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const wv = require('../governor/webValidators.js');

function readHtml(projectRoot, htmlRel) {
    try {
        return fs.readFileSync(path.join(projectRoot, htmlRel), 'utf8');
    } catch (e) {
        return '';
    }
}

/** @returns {string[]} sorted element ids from HTML */
function extractHtmlElementIds(projectRoot, htmlRel) {
    const html = readHtml(projectRoot, htmlRel);
    if (!html.trim()) return [];
    return [...wv.extractHtmlClassesIds(html).ids].sort();
}

function captureHtmlIdContract(session, htmlRel) {
    if (!session?.projectRoot || !htmlRel) return [];
    const ids = extractHtmlElementIds(session.projectRoot, htmlRel);
    if (!ids.length) return [];
    session.htmlIdContract = { htmlRel, ids };
    return ids;
}

function buildDomContractNudge(session) {
    const c = session?.htmlIdContract;
    if (!c?.ids?.length) return '';
    const sample = c.ids.slice(0, 24);
    const more = c.ids.length > sample.length ? `\n  … and ${c.ids.length - sample.length} more` : '';
    return [
        '[HARNESS — DOM CONTRACT]',
        `${c.htmlRel} defines the canonical element ids. script.js MUST use getElementById/querySelector with ONLY these ids:`,
        ...sample.map(id => `  #${id}`),
        ...(more ? [more] : []),
        '',
        'Do NOT invent ids that are not in the HTML above.',
        'Use name attributes on form controls OR read values via getElementById on the ids listed in the HTML.'
    ].join('\n');
}

/** Parse [DOM] gate lines into { wrong, right } rename hints. */
function parseDomGateItems(messages) {
    const out = [];
    const seen = new Set();
    for (const m of messages || []) {
        if (!/^\[DOM\]/i.test(m)) continue;
        const wrong = /references #([^\s]+)/i.exec(m)?.[1];
        const right = /did you mean #([^?\s]+)/i.exec(m)?.[1];
        if (!wrong || seen.has(wrong)) continue;
        seen.add(wrong);
        out.push({ wrong, right: right || null });
    }
    return out;
}

function readProjectScript(projectRoot) {
    for (const rel of ['script.js', 'app.js', 'main.js']) {
        try {
            const p = path.join(projectRoot, rel);
            if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
        } catch (e) { /* ignore */ }
    }
    return '';
}

function readProjectHtml(projectRoot) {
    try {
        const p = path.join(projectRoot, 'index.html');
        if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch (e) { /* ignore */ }
    return '';
}

function findProjectScriptRel(projectRoot) {
    for (const rel of ['script.js', 'app.js', 'main.js']) {
        try {
            if (fs.existsSync(path.join(projectRoot, rel))) return rel;
        } catch (e) { /* ignore */ }
    }
    return null;
}

/** Live DOM mismatch list from disk (read-only; never writes). */
function collectDomRepairsFromDisk(projectRoot) {
    const html = readProjectHtml(projectRoot);
    const js = readProjectScript(projectRoot);
    if (!html.trim() || !js.trim()) return [];
    return wv.validateDomIdConsistency({ html, js })
        .filter(i => i.level === 'error' && i.id)
        .map(i => ({ wrong: i.id, right: i.suggestion || null }));
}

/** Refresh session.pendingDomRepairs from disk truth (read-only). */
function refreshPendingDomRepairs(session) {
    if (!session?.projectRoot) return [];
    const repairs = collectDomRepairsFromDisk(session.projectRoot);
    if (repairs.length) session.pendingDomRepairs = repairs;
    else {
        delete session.pendingDomRepairs;
        delete session.domRepairReadCount;
    }
    return repairs;
}

function buildDomRepairNudge(session, gateMessages) {
    const fromDisk = collectDomRepairsFromDisk(session?.projectRoot);
    const fromGate = gateMessages?.length ? parseDomGateItems(gateMessages) : [];
    const repairs = fromDisk.length ? fromDisk : fromGate;
    if (!repairs.length) return '';
    session.pendingDomRepairs = repairs;
    const lines = [
        '[HARNESS — DOM REPAIR — patch script.js, do NOT rewrite index.html]',
        'The HTML ids are correct. Your script.js uses wrong element ids. Apply patch to script.js NOW:',
        '',
        ...repairs.slice(0, 12).map(({ wrong, right }) => right
            ? `  getElementById('${wrong}') → getElementById('${right}')`
            : `  remove or replace #${wrong} (no matching element in HTML)`),
        '',
        'Match form field reads to the ids/names that exist in index.html.',
        'read_file script.js is OK if a patch find-text did not match. Prefer patch over rewriting the whole file.'
    ];
    if (repairs.length > 12) {
        lines.push('', `(${repairs.length - 12} more id mismatches — fix all listed in the gate message.)`);
    }
    return lines.join('\n');
}

/**
 * Safe guardrail (read-only check): while DOM mismatches are pending, the bug is in script.js
 * and the HTML ids are canonical — so block a rewrite of index.html (weak models loop on it).
 * Everything else (patch/rewrite script.js, read, explore) stays allowed — no hard repair "mode".
 */
function checkDomRepairWrite(session, toolName, args) {
    if (!(session?.pendingDomRepairs?.length)) return null;
    if (toolName !== 'write_file' && toolName !== 'append_file') return null;
    const target = String(args?.path || '').replace(/\\/g, '/').toLowerCase();
    if (/\.html?$/.test(target)) {
        return {
            error: [
                'BLOCKED: DOM mismatches are in script.js — index.html ids are already correct.',
                'Use patch on script.js to rename getElementById calls to match the HTML. Do not rewrite index.html.'
            ].join(' '),
            blockedReason: 'html_rewrite_during_dom_repair'
        };
    }
    return null;
}

function domContractClean(projectRoot) {
    const html = readProjectHtml(projectRoot);
    const js = readProjectScript(projectRoot);
    if (!html.trim() || !js.trim()) return true;
    return wv.validateDomIdConsistency({ html, js }).every(i => i.level !== 'error');
}

function clearDomRepairsIfScriptPatched(session, relPath) {
    if (!session?.pendingDomRepairs?.length || !relPath) return;
    if (!/\.(js|mjs|cjs)$/i.test(String(relPath))) return;
    refreshPendingDomRepairs(session);
}

/** Half-built web app: all linked files exist but script.js ids don't match HTML. */
function detectDomMismatchState(projectRoot, goal, filesTouched) {
    const { goalImpliesNewArtifacts } = require('./artifactHints.js');
    const { findDeliverableIndexHtml, collectMissingRefsFromHtml } = require('../loop/missingRefGuard.js');
    if (!projectRoot || !goalImpliesNewArtifacts(goal)) return null;
    const htmlRel = findDeliverableIndexHtml(projectRoot, filesTouched || []);
    if (!htmlRel || !findProjectScriptRel(projectRoot)) return null;
    if (collectMissingRefsFromHtml(projectRoot, htmlRel).length) return null;
    const repairs = collectDomRepairsFromDisk(projectRoot);
    if (!repairs.length) return null;
    return { htmlRel, scriptRel: findProjectScriptRel(projectRoot), repairs };
}

function buildDomMismatchResumeNudge(session, state) {
    if (!state?.repairs?.length) return '';
    const renameHints = state.repairs.filter(r => r.right).slice(0, 10);
    const orphans = state.repairs.filter(r => !r.right);
    const lines = [
        '[HARNESS — RESUME HALF-BUILD — fix script.js DOM contract]',
        `${state.htmlRel} and linked assets are on disk. ${state.scriptRel} uses wrong element ids — do NOT rewrite HTML/CSS.`,
        'Fix them with patch on script.js only.',
        ''
    ];
    if (renameHints.length) {
        lines.push('Rename in script.js:', ...renameHints.map(r => `  '${r.wrong}' → '${r.right}'`));
    }
    if (orphans.length) {
        lines.push('', 'Remove or guard refs with no HTML element:', ...orphans.map(r => `  #${r.wrong}`));
    }
    lines.push('', 'read_file script.js is OK if patch find-text did not match. Prefer patch over a full rewrite.');
    return lines.join('\n');
}

/** Capture the id contract and, if the deliverable already mismatches, inject a repair nudge. */
function bootstrapDomRepair(session, { pushMessages = true } = {}) {
    if (!session?.projectRoot) return { state: null };
    captureHtmlIdContract(session, 'index.html');
    const state = detectDomMismatchState(session.projectRoot, session.goal, session.filesTouched);
    if (pushMessages && state && !session._domMismatchNudgeInjected && Array.isArray(session.messages)) {
        session._domMismatchNudgeInjected = true;
        const nudge = buildDomMismatchResumeNudge(session, state);
        if (nudge) session.messages.push({ role: 'system', content: nudge });
    }
    return { state };
}

module.exports = {
    extractHtmlElementIds,
    captureHtmlIdContract,
    buildDomContractNudge,
    parseDomGateItems,
    buildDomRepairNudge,
    checkDomRepairWrite,
    domContractClean,
    clearDomRepairsIfScriptPatched,
    collectDomRepairsFromDisk,
    refreshPendingDomRepairs,
    detectDomMismatchState,
    buildDomMismatchResumeNudge,
    bootstrapDomRepair
};
