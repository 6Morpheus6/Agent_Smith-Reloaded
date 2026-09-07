/**
 * First-turn project bootstrap — runtime, test command, tree summary.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { detectProjectCommands } = require('../../shared/verificationHarness.js');
const { buildNewArtifactBlock } = require('./artifactHints.js');
const { buildSymbolMap } = require('./symbolMap.js');
const { detectPartialDeliverableState, buildPartialBuildNudge } = require('./partialBuild.js');

function detectRuntime(root) {
    const meta = detectProjectCommands(root);
    return {
        type: meta.language === 'node' ? 'node'
            : meta.language === 'python' ? 'python'
                : meta.language === 'rust' ? 'rust'
                    : meta.language === 'go' ? 'go'
                        : 'unknown',
        testCmd: meta.testCmd,
        lintCmd: meta.lintCmd,
        name: path.basename(root)
    };
}

function buildBootstrapBlock(root, treeSummary, goal) {
    const rt = detectRuntime(root);
    const lines = [
        '[PROJECT BOOTSTRAP]',
        `Root: ${root}`,
        `Runtime: ${rt.type}${rt.name ? ` (${rt.name})` : ''}`,
    ];
    if (rt.testCmd) lines.push(`Test command: ${rt.testCmd}`);
    if (rt.lintCmd) lines.push(`Lint command: ${rt.lintCmd}`);
    if (treeSummary) lines.push('', 'Project tree (abbreviated):', treeSummary.slice(0, 2000));
    // Ranked code map — helps the model locate relevant symbols in an EXISTING project
    // without reading everything. Empty (skipped) for greenfield. Non-fatal.
    try {
        const symbolMap = buildSymbolMap(root);
        if (symbolMap) lines.push('', symbolMap);
    } catch (e) { /* non-fatal */ }
    lines.push(
        '',
        'Use read_file before editing. Prefer patch over write_file for changes.',
        'DATA PARSING: read_file the data file first and split on a delimiter you can SEE in it — never assume one. A CSV like "name,age" is split on "," only (no "|" stage).',
        'list_project is optional — tree is above. Do not call it repeatedly.',
        'Long-lived task state: .agentsmith/PLAN.md and .agentsmith/IMPLEMENT.md (created for non-trivial runs).',
    );
    if (rt.type === 'unknown' && !treeSummary?.includes('package.json')) {
        lines.push(
            '',
            'Static web project hints: typical files are index.html, style.css, script.js.',
            'Link them in HTML; ensure JS uses backticks for template literals; CSS classes must match JS.'
        );
    }
    const artifactBlock = buildNewArtifactBlock(goal, root);
    if (artifactBlock) lines.push(artifactBlock);
    const partial = detectPartialDeliverableState(root, goal, []);
    if (partial) {
        lines.push('', buildPartialBuildNudge({ projectRoot: root, goal, filesTouched: [] }, goal, root));
    }
    return lines.join('\n');
}

module.exports = { detectRuntime, buildBootstrapBlock };
