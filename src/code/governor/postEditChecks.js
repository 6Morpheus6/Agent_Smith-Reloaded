/**
 * Post-edit computational sensors — fast lint/format checks after each write.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { runCmd, syntaxCheckFile, truncateOutput } = require('../../shared/verificationHarness.js');
const { assessCommand } = require('../../shared/commandPolicy.js');
const { runProjectRulesForFile } = require('./projectRules.js');

const LINTABLE = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue']);
const PRETTIABLE = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.css', '.html', '.md']);

function hasEslintConfig(projectRoot) {
    const names = [
        'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
        '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml'
    ];
    return names.some(n => fs.existsSync(path.join(projectRoot, n)));
}

function hasPrettierConfig(projectRoot) {
    const names = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js', '.prettierrc.yaml'];
    return names.some(n => fs.existsSync(path.join(projectRoot, n))) ||
        (() => {
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
                return Boolean(pkg.prettier);
            } catch (e) {
                return false;
            }
        })();
}

function buildScopedLintCommand(projectRoot, relPath) {
    const ext = path.extname(relPath).toLowerCase();
    const q = JSON.stringify(relPath.replace(/\\/g, '/'));
    if (LINTABLE.has(ext) && hasEslintConfig(projectRoot)) {
        return `npx eslint --no-error-on-unmatched-pattern ${q}`;
    }
    if (PRETTIABLE.has(ext) && hasPrettierConfig(projectRoot)) {
        return `npx prettier --check ${q}`;
    }
    return null;
}

async function runScopedCommand(projectRoot, command) {
    const assessment = assessCommand(command);
    if (!assessment.allowed) {
        return { skipped: true, ok: true, reason: assessment.reason };
    }
    const r = await runCmd(projectRoot, command, 45000);
    if (r.exitCode === 127 || /not recognized|command not found|ENOENT/i.test(r.stderr || r.stdout || '')) {
        return { skipped: true, ok: true, toolMissing: true };
    }
    return { skipped: false, ok: r.ok, output: r.stderr || r.stdout || r.error };
}

/**
 * Run fast deterministic checks after a file edit.
 * @returns {{ warnings: string[], errors: string[], remediation: string[] }}
 */
async function runPostEditChecks(projectRoot, relPath, projectMeta, opts = {}) {
    const warnings = [];
    const errors = [];
    const remediation = [];

    const abs = path.join(projectRoot, relPath);
    if (!fs.existsSync(abs)) {
        return { warnings, errors, remediation };
    }

    const scoped = buildScopedLintCommand(projectRoot, relPath);
    if (scoped) {
        const r = await runScopedCommand(projectRoot, scoped);
        if (!r.skipped && !r.ok) {
            const msg = `[LINT] ${relPath}: ${truncateOutput(r.output, 400)}`;
            warnings.push(msg);
            remediation.push(`Fix lint issues in ${relPath} — run: ${scoped}`);
        }
    }

    const rules = await runProjectRulesForFile(projectRoot, relPath, { advisory: true });
    for (const v of rules.violations) {
        const line = `[RULE:${v.id}] ${v.message}`;
        warnings.push(line);
        if (v.fix) remediation.push(v.fix);
    }

    void projectMeta;
    void opts;
    return { warnings, errors, remediation };
}

module.exports = {
    runPostEditChecks,
    buildScopedLintCommand,
    hasEslintConfig,
    hasPrettierConfig
};
