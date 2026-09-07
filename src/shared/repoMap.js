const fs = require('fs');
const path = require('path');
const { loadIgnoreFile, isIgnored } = require('./ignoreFilter.js');

const CHARS_PER_TOKEN = 3.5;
const DEFAULT_MAX_CHARS = 6000;

const SYMBOL_PATTERNS = [
    { re: /^(export\s+)?(async\s+)?function\s+(\w+)/m, kind: 'fn' },
    { re: /^export\s+class\s+(\w+)/m, kind: 'class' },
    { re: /^class\s+(\w+)/m, kind: 'class' },
    { re: /^def\s+(\w+)\s*\(/m, kind: 'fn' },
    { re: /^export\s+(?:const|let|var)\s+(\w+)/m, kind: 'var' }
];

function estimateChars(tokens) {
    return Math.floor(tokens * CHARS_PER_TOKEN);
}

function readManifestSummary(projectRoot) {
    const parts = [];
    const candidates = [
        ['package.json', p => {
            const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
            return `package.json: name=${j.name || '?'} scripts=${Object.keys(j.scripts || {}).join(', ')}`;
        }],
        ['pyproject.toml', p => `pyproject.toml present (${fs.statSync(p).size} bytes)`],
        ['Cargo.toml', p => `Cargo.toml present`],
        ['go.mod', p => `go.mod present`]
    ];
    for (const [name, fmt] of candidates) {
        const p = path.join(projectRoot, name);
        try {
            if (fs.existsSync(p)) parts.push(fmt(p));
        } catch (e) { /* skip */ }
    }
    return parts.join('\n');
}

function listTree(projectRoot, maxDepth = 4) {
    const ig = loadIgnoreFile(projectRoot);
    const lines = [];

    function walk(dir, depth, prefix) {
        if (depth > maxDepth) return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const ent of entries) {
            const rel = path.relative(projectRoot, path.join(dir, ent.name)).replace(/\\/g, '/');
            if (isIgnored(ig, rel)) continue;
            lines.push(`${prefix}${ent.isDirectory() ? '[D]' : '[F]'} ${rel}`);
            if (ent.isDirectory() && depth < maxDepth) {
                walk(path.join(dir, ent.name), depth + 1, prefix + '  ');
            }
        }
    }

    walk(projectRoot, 0, '');
    return lines.slice(0, 120).join('\n');
}

function extractSymbols(filePath, content) {
    const symbols = [];
    const lines = content.split('\n');
    const ext = path.extname(filePath).toLowerCase();
    if (!['.js', '.ts', '.tsx', '.jsx', '.py', '.mjs', '.cjs'].includes(ext)) return symbols;

    lines.forEach((line, i) => {
        for (const { re, kind } of SYMBOL_PATTERNS) {
            const m = line.match(re);
            if (m) {
                const name = m[m.length - 1] || m[1];
                symbols.push({ line: i + 1, kind, name });
                break;
            }
        }
    });
    return symbols.slice(0, 30);
}

function scoreFile(rel, boosts) {
    let score = 1;
    for (const b of boosts) {
        if (rel.includes(b) || b.includes(rel)) score += 5;
    }
    return score;
}

// The repo map is requested every execution turn and was rebuilt from scratch each
// time — a SYNCHRONOUS full-tree walk + 25 file reads in the main process, which
// froze the whole app briefly every turn. Within a step the boost terms are stable,
// so cache the assembled map keyed by root+boosts with a short TTL, and invalidate
// explicitly whenever the agent writes/edits/deletes a file (main.js).
const _mapCache = new Map(); // key -> { time, map }
const MAP_TTL_MS = 10000;
const MAP_CACHE_MAX = 12;
let _buildCount = 0; // test hook: counts real (uncached) builds

function invalidate(projectRoot) {
    if (!projectRoot) { _mapCache.clear(); return; }
    for (const k of _mapCache.keys()) {
        if (k.indexOf(projectRoot + '|') === 0) _mapCache.delete(k);
    }
}

function buildRepoMap(projectRoot, opts = {}) {
    const maxChars = opts.maxChars || estimateChars(opts.maxTokens || 1500);
    const boosts = opts.boostTerms || [];

    const cacheKeyStr = `${projectRoot}|${maxChars}|${boosts.join(',')}`;
    const hit = _mapCache.get(cacheKeyStr);
    const nowMs = Date.now();
    if (hit && (nowMs - hit.time) < MAP_TTL_MS) return hit.map;

    _buildCount++;
    const ig = loadIgnoreFile(projectRoot);

    const sections = [];
    sections.push(`# Repo map\nRoot: ${projectRoot}\n`);
    sections.push('## Manifest\n' + (readManifestSummary(projectRoot) || '(none)'));
    sections.push('## Tree (depth 4)\n' + listTree(projectRoot));

    const fileScores = [];
    function collectFiles(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const ent of entries) {
            const abs = path.join(dir, ent.name);
            const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
            if (isIgnored(ig, rel)) continue;
            if (ent.isDirectory()) collectFiles(abs);
            else if (ent.isFile() && /\.(js|ts|tsx|jsx|py|json|md)$/i.test(ent.name)) {
                fileScores.push({ rel, score: scoreFile(rel, boosts) });
            }
        }
    }
    collectFiles(projectRoot);
    fileScores.sort((a, b) => b.score - a.score);

    const symLines = [];
    for (const { rel } of fileScores.slice(0, 25)) {
        try {
            const abs = path.join(projectRoot, rel);
            const st = fs.statSync(abs);
            if (st.size > 100 * 1024) continue;
            const content = fs.readFileSync(abs, 'utf-8');
            const syms = extractSymbols(rel, content);
            if (syms.length) {
                symLines.push(`${rel}: ${syms.map(s => `${s.kind}:${s.name}@${s.line}`).join(', ')}`);
            }
        } catch (e) { /* skip */ }
    }
    if (symLines.length) sections.push('## Symbols (top files)\n' + symLines.join('\n'));

    let body = sections.join('\n\n');
    if (body.length > maxChars) {
        body = body.slice(0, maxChars) + '\n...[repo map truncated]';
    }

    _mapCache.set(cacheKeyStr, { time: nowMs, map: body });
    if (_mapCache.size > MAP_CACHE_MAX) {
        // Evict the oldest entry to bound memory.
        let oldestKey = null, oldestTime = Infinity;
        for (const [k, v] of _mapCache) { if (v.time < oldestTime) { oldestTime = v.time; oldestKey = k; } }
        if (oldestKey) _mapCache.delete(oldestKey);
    }
    return body;
}

module.exports = {
    buildRepoMap,
    estimateChars,
    invalidate,
    // test hooks
    __buildCount: () => _buildCount,
    __clearCache: () => _mapCache.clear(),
};
