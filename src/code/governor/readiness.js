/**
 * Workspace readiness scorer — agent-ready checklist before Code Mode runs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { detect } = require('../../main/services/projectDetector.js');

function scorePillar(name, score, note) {
    return { name, score, max: 5, note };
}

function hasFile(root, rel) {
    try { return fs.existsSync(path.join(root, rel)); } catch (e) { return false; }
}

function hasDir(root, rel) {
    try { return fs.statSync(path.join(root, rel)).isDirectory(); } catch (e) { return false; }
}

function countFiles(root, maxDepth = 2) {
    let n = 0;
    function walk(dir, depth) {
        if (depth > maxDepth || n > 50) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
            if (['node_modules', '.git', 'dist'].includes(e.name)) continue;
            n++;
            if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
        }
    }
    walk(root, 0);
    return n;
}

/**
 * @returns {{ score, maxScore, pillars, recommendations }}
 */
function scoreReadiness(projectRoot) {
    const root = projectRoot || process.cwd();
    const pillars = [];
    const recommendations = [];
    const meta = detect(root);

    // docs
    let docsScore = 0;
    if (hasFile(root, 'README.md')) docsScore += 3;
    if (hasDir(root, 'docs')) docsScore += 2;
    if (docsScore < 3) recommendations.push('Add a README.md describing setup and test commands.');
    pillars.push(scorePillar('docs', Math.min(5, docsScore), 'README and docs folder'));

    // tests
    let testScore = 0;
    if (meta.testCmd) testScore += 4;
    if (hasFile(root, 'tests') || hasDir(root, 'tests')) testScore += 1;
    if (testScore < 3) recommendations.push('Add npm test or pytest so grind mode can verify changes.');
    pillars.push(scorePillar('tests', Math.min(5, testScore), meta.testCmd || 'no test command'));

    // lint
    let lintScore = meta.lintCmd ? 4 : 1;
    if (hasFile(root, '.eslintrc') || hasFile(root, 'eslint.config.js')) lintScore = 5;
    if (lintScore < 3) recommendations.push('Configure lint (eslint, ruff) for early feedback.');
    pillars.push(scorePillar('lint', Math.min(5, lintScore), meta.lintCmd || 'no lint command'));

    // rules
    let rulesScore = hasDir(root, '.agentsmith/rules') ? 4 : 0;
    if (rulesScore && fs.readdirSync(path.join(root, '.agentsmith', 'rules')).some(f => f.endsWith('.js'))) {
        rulesScore = 5;
    } else {
        recommendations.push('Optional: add .agentsmith/rules/*.js for project-specific harness checks.');
    }
    pillars.push(scorePillar('rules', rulesScore, 'custom harness rules'));

    // git
    let gitScore = hasDir(root, '.git') ? 5 : 0;
    if (!gitScore) recommendations.push('Initialize git for Revert All and change tracking.');
    pillars.push(scorePillar('git', gitScore, '.git present'));

    // structure
    const fileCount = countFiles(root);
    let structScore = fileCount > 0 ? 2 : 0;
    if (hasDir(root, 'src') || hasFile(root, 'package.json')) structScore += 2;
    if (fileCount > 5) structScore += 1;
    pillars.push(scorePillar('structure', Math.min(5, structScore), `${fileCount} top-level entries`));

    // AGENTS.md
    let agentsScore = hasFile(root, 'AGENTS.md') ? 5 : (hasFile(root, 'agents.md') ? 4 : 0);
    if (agentsScore < 3) recommendations.push('Add AGENTS.md with tool permissions and verification commands.');
    pillars.push(scorePillar('AGENTS.md', agentsScore, 'agent orientation doc'));

    // harness artifacts
    let harnessScore = 0;
    if (hasDir(root, '.agentsmith')) harnessScore += 2;
    if (hasFile(root, '.agentsmith/PLAN.md')) harnessScore += 2;
    if (meta.e2eCmd) harnessScore += 1;
    pillars.push(scorePillar('harness', Math.min(5, harnessScore), 'plan artifacts + e2e'));

    const score = pillars.reduce((s, p) => s + p.score, 0);
    const maxScore = pillars.length * 5;

    return { score, maxScore, pillars, recommendations };
}

module.exports = { scoreReadiness };
