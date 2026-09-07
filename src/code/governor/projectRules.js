/**
 * Project-local harness rules — .agentsmith/rules/*.js with agent-readable remediation.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const cache = new Map();

function rulesDir(projectRoot) {
    return path.join(projectRoot, '.agentsmith', 'rules');
}

function loadRules(projectRoot) {
    const key = projectRoot;
    if (cache.has(key)) return cache.get(key);

    const dir = rulesDir(projectRoot);
    const rules = [];
    if (!fs.existsSync(dir)) {
        cache.set(key, rules);
        return rules;
    }

    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.js')) continue;
        const abs = path.join(dir, name);
        try {
            delete require.cache[require.resolve(abs)];
            const mod = require(abs);
            if (mod && typeof mod.check === 'function') {
                rules.push({
                    id: mod.id || name.replace(/\.js$/, ''),
                    match: typeof mod.match === 'function' ? mod.match : () => true,
                    check: mod.check
                });
            }
        } catch (e) {
            rules.push({
                id: name,
                match: () => false,
                check: async () => ({ ok: true }),
                loadError: e.message
            });
        }
    }
    cache.set(key, rules);
    return rules;
}

function clearRulesCache(projectRoot) {
    if (projectRoot) cache.delete(projectRoot);
    else cache.clear();
}

async function readFileContent(projectRoot, relPath) {
    try {
        return fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
    } catch (e) {
        return null;
    }
}

async function runProjectRulesForFile(projectRoot, relPath, opts = {}) {
    const rules = loadRules(projectRoot);
    const violations = [];
    const content = await readFileContent(projectRoot, relPath);
    if (content == null) return { violations, ok: true };

    for (const rule of rules) {
        if (rule.loadError) continue;
        let matched = false;
        try {
            matched = rule.match(relPath, content);
        } catch (e) {
            violations.push({ id: rule.id, message: `rule match error: ${e.message}`, fix: null });
            continue;
        }
        if (!matched) continue;

        try {
            const ctx = { projectRoot, relPath, content, advisory: opts.advisory !== false };
            const r = await rule.check(ctx);
            if (r && r.ok === false) {
                violations.push({
                    id: rule.id,
                    message: r.message || `Rule ${rule.id} failed`,
                    fix: r.fix || null
                });
            }
        } catch (e) {
            violations.push({ id: rule.id, message: `rule check error: ${e.message}`, fix: null });
        }
    }

    return { violations, ok: violations.length === 0 };
}

async function runProjectRulesForProject(projectRoot, filesTouched) {
    const files = [...new Set((filesTouched || []).filter(Boolean))];
    const violations = [];
    for (const rel of files) {
        const r = await runProjectRulesForFile(projectRoot, rel, { advisory: false });
        violations.push(...r.violations);
    }
    return {
        ok: violations.length === 0,
        violations,
        messages: violations.map(v => {
            const fix = v.fix ? ` Fix: ${v.fix}` : '';
            return `[RULE:${v.id}] ${v.message}${fix}`;
        })
    };
}

module.exports = {
    loadRules,
    clearRulesCache,
    runProjectRulesForFile,
    runProjectRulesForProject,
    rulesDir
};
