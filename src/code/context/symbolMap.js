/**
 * Lightweight "code map" for Code Mode — a ranked, signature-level index of the
 * project's key symbols, injected into the first-turn bootstrap so a small model can
 * locate relevant code WITHOUT reading the whole tree. Dependency-free (regex
 * extraction, local-heuristic ranking — no tree-sitter, no graph). Bounded and
 * synchronous so it's a fast one-time cost at session start.
 *
 * Greenfield projects (no source files yet) yield '' — additive, never harmful.
 * Code Mode only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set([
    'node_modules', 'dist', 'build', '.git', '__pycache__', '.agentsmith', 'release',
    'coverage', 'vendor', '.next', 'out', 'target', '.cache', 'bin', 'obj'
]);
const CODE_EXT = new Set([
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java',
    '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt'
]);

function collectFiles(root, maxFiles) {
    const out = [];
    const stack = [root];
    while (stack.length && out.length < maxFiles) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (out.length >= maxFiles) break;
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) stack.push(full); }
            else if (CODE_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
        }
    }
    return out;
}

/** Top-level definitions via regex. Conservative — favors precision over recall. */
function extractSymbols(code, ext) {
    const names = [];
    const add = (n) => { if (n && !names.includes(n)) names.push(n); };
    for (const line of String(code).split('\n')) {
        if (line.length > 400) continue;
        if (ext === '.py') {
            let m = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line); if (m) add(m[1]);
            m = /^\s*class\s+([A-Za-z_]\w*)/.exec(line); if (m) add(m[1]);
            continue;
        }
        // JS / TS / C-like
        let m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line); if (m) add(m[1]);
        m = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line); if (m) add(m[1]);
        m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(line); if (m) add(m[1]);
        m = /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line); if (m) add(m[1]);
    }
    return names;
}

function scoreSymbol(name, rel) {
    let s = 1;
    const base = path.basename(rel).toLowerCase();
    if (/^(index|main|app|server|cli|api|router|routes|core)\.[a-z]+$/.test(base)) s *= 4;
    if (name.length >= 8) s *= 1.5;
    if (/[a-z][A-Z]/.test(name) || name.includes('_')) s *= 1.2; // descriptive (camel/snake)
    if (name.startsWith('_')) s *= 0.3;                          // private/internal
    return s;
}

/**
 * @returns {string} a "[CODE MAP] ..." block, or '' if the project has no extractable
 *   symbols (e.g. greenfield).
 */
function buildSymbolMap(root, opts = {}) {
    const maxFiles = opts.maxFiles || 60;
    const maxFileBytes = opts.maxFileBytes || 80000;
    const maxChars = opts.maxChars || 1600;
    let files;
    try { files = collectFiles(root, maxFiles); } catch { return ''; }
    if (!files.length) return '';

    const perFile = [];
    for (const f of files) {
        let code;
        try {
            if (fs.statSync(f).size > maxFileBytes) continue;
            code = fs.readFileSync(f, 'utf-8');
        } catch { continue; }
        const rel = path.relative(root, f).replace(/\\/g, '/');
        const scored = extractSymbols(code, path.extname(f).toLowerCase())
            .map(n => ({ name: n, score: scoreSymbol(n, rel) }));
        if (scored.length) perFile.push({ rel, scored, fileScore: Math.max(...scored.map(n => n.score)) });
    }
    if (!perFile.length) return '';

    perFile.sort((a, b) => b.fileScore - a.fileScore);
    const out = ['[CODE MAP] Key symbols (use read_file for full definitions):'];
    let chars = out[0].length;
    for (const f of perFile) {
        const top = f.scored.sort((a, b) => b.score - a.score).slice(0, 8).map(n => n.name);
        const line = `${f.rel}: ${top.join(', ')}`;
        if (chars + line.length + 1 > maxChars) break;
        out.push(line);
        chars += line.length + 1;
    }
    return out.length > 1 ? out.join('\n') : '';
}

module.exports = { buildSymbolMap, extractSymbols, scoreSymbol };
