/**
 * Detect and recover partial web deliverables (HTML/CSS on disk, linked JS/README missing).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { goalImpliesNewArtifacts } = require('./artifactHints.js');
const {
    collectMissingRefsFromHtml,
    pickNextMissing,
    findDeliverableIndexHtml
} = require('../loop/missingRefGuard.js');

const ARTIFACT_EXT = 'md|markdown|html?|css|js|mjs|cjs|json|txt';

function extractNamedArtifacts(goal) {
    const found = new Set();
    const re = new RegExp(`(^|[^/\\w.])([A-Za-z0-9_-]+\\.(?:${ARTIFACT_EXT}))\\b`, 'gi');
    for (const m of String(goal || '').matchAll(re)) found.add(m[2]);
    return [...found];
}

const { fileExistsDeep } = require('./fileScan.js');
function artifactOnDisk(projectRoot, name) {
    return fileExistsDeep(projectRoot, name, 4);
}

/**
 * @returns {{ htmlRel: string, missingRefs: string[], missingArtifacts: string[], nextFile: string|null }|null}
 */
function detectPartialDeliverableState(projectRoot, goal, filesTouched) {
    if (!projectRoot || !goalImpliesNewArtifacts(goal)) return null;
    const htmlRel = findDeliverableIndexHtml(projectRoot, filesTouched || []);
    if (!htmlRel) return null;

    const missingRefs = collectMissingRefsFromHtml(projectRoot, htmlRel);
    const named = extractNamedArtifacts(goal);
    const missingArtifacts = named.filter(n => !artifactOnDisk(projectRoot, n));

    const nextFromRefs = pickNextMissing(missingRefs);
    const nextArtifact = missingArtifacts.find(n => /\.(js|mjs|cjs)$/i.test(n))
        || missingArtifacts[0]
        || null;
    const nextFile = nextFromRefs || nextArtifact;

    if (!missingRefs.length && !missingArtifacts.length) return null;

    return { htmlRel, missingRefs, missingArtifacts, nextFile };
}

function pickNextWriteTarget(session) {
    const pending = session?.pendingMissingRefs || [];
    if (pending.length) {
        return pickNextMissing(pending.filter(p => /\.(js|mjs|cjs)$/i.test(p)))
            || pickNextMissing(pending);
    }
    const state = detectPartialDeliverableState(
        session?.projectRoot,
        session?.goal,
        session?.filesTouched
    );
    return state?.nextFile || null;
}

function buildPartialBuildNudge(session, goal, projectRoot) {
    const state = detectPartialDeliverableState(
        projectRoot || session?.projectRoot,
        goal || session?.goal,
        session?.filesTouched
    );
    if (!state) return '';

    const lines = [
        '[HARNESS — PARTIAL BUILD — finish missing files only]',
        `${state.htmlRel} (and any CSS already written) are correct — do NOT rewrite them.`,
        'Your NEXT tool call(s) MUST create the missing deliverable(s) with write_file at the EXACT paths below.'
    ];

    if (state.nextFile) {
        const isJs = /\.(js|mjs|cjs)$/i.test(state.nextFile);
        lines.push(
            '',
            `NEXT: write_file path="${state.nextFile}" — COMPLETE ${isJs ? 'JavaScript app logic matching the existing HTML element ids' : 'file content'}.`
        );
    }
    if (state.missingRefs.length) {
        lines.push('', 'Still missing linked files:', ...state.missingRefs.map(r => `  - ${r}`));
    }
    if (state.missingArtifacts.length) {
        lines.push('', 'Prompt-required files still missing:', ...state.missingArtifacts.map(r => `  - ${r}`));
    }

    lines.push(
        '',
        'For a large script.js: you MAY write a minimal working skeleton first, then append_file or patch to add features — do NOT stall trying to emit 400+ lines in one reply.',
        'Respond with tool calls only — no list_project, grep, or read_file unless fixing a specific error.'
    );
    return lines.join('\n');
}

function buildStallExhaustionNudge(session, goal) {
    const next = pickNextWriteTarget(session);
    if (!next) return '';
    return [
        '[HARNESS — STALL RECOVERY]',
        'The model connection stalled while generating a large file. Do NOT rewrite index.html or style.css.',
        `Your NEXT reply MUST be a single write_file with path="${next}" and COMPLETE working content.`,
        'If the file is very large, write a minimal working version first (CRUD + localStorage), then patch/append — not one giant truncated file.',
        'Keep reasoning to one sentence; emit the tool call immediately.'
    ].join('\n');
}

function buildMalformedWriteRecoveryNudge(session, goal) {
    const next = pickNextWriteTarget(session);
    if (!next) {
        return 'write_file requires both "path" and "content". Retry with path set to the missing file from the repair plan.';
    }
    return [
        '[HARNESS — MALFORMED write_file]',
        `Your last write_file had content but no "path". Retry exactly: write_file path="${next}" with COMPLETE file content.`,
        'Do not rewrite index.html.'
    ].join('\n');
}

module.exports = {
    detectPartialDeliverableState,
    pickNextWriteTarget,
    buildPartialBuildNudge,
    buildStallExhaustionNudge,
    buildMalformedWriteRecoveryNudge
};
