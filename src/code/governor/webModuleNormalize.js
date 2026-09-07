'use strict';

// Repair the single most common local-model web mistake (seen even on coder models):
// writing ES-module syntax (import/export) in .js files that index.html loads as CLASSIC
// <script src> (no type="module"). That throws "Unexpected token 'export'" /
// "Cannot use import statement outside a module" and the app doesn't run.
//
// Rather than hope the model fixes it, Code Mode strips the module syntax so each file is
// a valid classic script that shares state via the global lexical scope (top-level
// function/const/let/class are visible to later <script> tags in the same document).
// Only acts when index.html is classic; proper ES-module apps (type="module") are untouched.

const fs = require('fs');
const path = require('path');
const wv = require('./webValidators.js');

/**
 * Write a harness repair to disk THROUGH the change ledger so "Revert All" can undo it.
 * The ledger snapshot reads the current (pre-write) content, so it must be awaited before
 * the write. When no ledger is provided (tests, non-run callers) it writes directly.
 */
async function ledgerWrite(abs, content, opts) {
    const cl = opts && opts.changeLedger;
    const id = opts && opts.sessionId;
    if (cl && id && typeof cl.snapshotBefore === 'function') {
        const snap = await cl.snapshotBefore(id, abs, 'edit');
        if (snap && snap.error) {
            throw new Error(`Could not snapshot ${abs}: ${snap.error}`);
        }
    }
    fs.writeFileSync(abs, content, 'utf8');
}

/** Strip ES-module syntax, turning a module file into a valid classic script. Pure. */
function stripEsModuleSyntax(code) {
    const before = String(code);
    let s = before;
    // `import ... from '...';` and bare `import '...';`  (whole line)
    s = s.replace(/^[ \t]*import\b[^\n]*?from\s*['"][^'"]+['"][ \t]*;?[ \t]*$/gm, '');
    s = s.replace(/^[ \t]*import\s*['"][^'"]+['"][ \t]*;?[ \t]*$/gm, '');
    // standalone `export { ... };` or `export { ... } from '...';`
    s = s.replace(/^[ \t]*export\s*\{[^}]*\}[ \t]*(?:from\s*['"][^'"]+['"])?[ \t]*;?[ \t]*$/gm, '');
    // `export default function|class` -> declaration ; `export <decl>` -> <decl>
    s = s.replace(/^([ \t]*)export\s+default\s+(?=(?:async\s+)?(?:function|class)\b)/gm, '$1');
    s = s.replace(/^([ \t]*)export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '$1');
    return { code: s, changed: s !== before };
}

/** True when index.html loads a script via classic <script src> with no type="module". */
function htmlIsClassic(html) {
    const h = String(html || '');
    if (!/<script\b[^>]*\bsrc\s*=/i.test(h)) return false;
    return !/<script\b[^>]*\btype\s*=\s*["']module["']/i.test(h);
}

/**
 * If index.html uses classic scripts, strip module syntax from its referenced local .js
 * files so the app runs. Returns the list of repaired file paths (relative to root).
 */
async function normalizeClassicScriptModules(projectRoot, htmlRel, opts) {
    const fixed = [];
    try {
        const htmlAbs = path.join(projectRoot, htmlRel);
        const html = fs.readFileSync(htmlAbs, 'utf8');
        if (!htmlIsClassic(html)) return fixed;
        const { scripts } = wv.extractHtmlRefs(html);
        const htmlDir = path.dirname(htmlAbs);
        for (const ref of scripts || []) {
            if (/^https?:/i.test(ref)) continue;
            const abs = path.resolve(htmlDir, String(ref).replace(/^\.\//, ''));
            if (!/\.m?js$/i.test(abs) || !fs.existsSync(abs)) continue;
            const orig = fs.readFileSync(abs, 'utf8');
            if (!/^[ \t]*(import|export)\b/m.test(orig)) continue; // nothing to strip
            const { code, changed } = stripEsModuleSyntax(orig);
            if (changed) {
                await ledgerWrite(abs, code, opts);
                fixed.push(path.relative(projectRoot, abs).split(path.sep).join('/'));
            }
        }
    } catch (e) { /* non-fatal */ }
    return fixed;
}

/** Names referenced as `window.NAME` across the given text blobs. */
function collectWindowRefs(texts) {
    const refs = new Set();
    const re = /\bwindow\.([A-Za-z_$][\w$]*)/g;
    for (const t of texts) {
        let m;
        while ((m = re.exec(String(t || '')))) refs.add(m[1]);
    }
    return refs;
}

/** Top-level (column-0) declaration names in a classic script. */
function topLevelDecls(code) {
    const names = new Set();
    const src = String(code || '');
    let m;
    const fnCls = /^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = fnCls.exec(src))) names.add(m[1]);
    const vars = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm;
    while ((m = vars.exec(src))) names.add(m[1]);
    return names;
}

/** Remove `type="module"` from every <script src> tag (downgrade to classic). */
function downgradeModuleTags(html) {
    return String(html).replace(
        /(<script\b[^>]*?)\s+type\s*=\s*["']module["']([^>]*>)/gi,
        '$1$2'
    );
}

/** Add type="module" to local <script src> tags that lack a type (upgrade to module). */
function upgradeModuleTags(html) {
    return String(html).replace(
        /<script\b([^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*)>/gi,
        (m, attrs) => (/\btype\s*=/.test(attrs) || /\bsrc\s*=\s*["']https?:/i.test(attrs))
            ? m : '<script type="module"' + attrs + '>'
    );
}

/** Append `window.NAME = NAME;` for each top-level decl referenced as window.NAME but unset. */
function exposeWindowGlobals(code, windowRefs) {
    const decls = topLevelDecls(code);
    const already = collectAssignedWindow(code);
    const expose = [...decls].filter(n => windowRefs.has(n) && !already.has(n));
    if (!expose.length) return { code, changed: false };
    const out = code.replace(/\s*$/, '\n')
        + expose.map(n => `window.${n} = ${n};`).join('\n') + '\n';
    return { code: out, changed: true };
}

/**
 * Make a multi-file vanilla web app reliably runnable, regardless of how the model wired it,
 * by forcing ONE consistent strategy across the whole project (the gate may run several times
 * as the model edits, so this must converge, not flip-flop):
 *
 *   - MODULE-INTENT app (any file uses import/export): ensure every local <script> is
 *     type="module" (a prior pass may have downgraded a tag while files still use import/export,
 *     which throws "Unexpected token 'export'"). Also expose any window.* globals the code relies
 *     on (valid inside a module). ES modules work over HTTP (Agent Smith's preview serves HTTP).
 *   - GLOBALS-BASED app (no import/export anywhere): downgrade tags to classic, strip any stray
 *     module syntax, and expose window.* globals (e.g. `const App = {}` used as `window.App`,
 *     which module scope would otherwise leave undefined -> "Cannot read properties of undefined").
 *
 * Returns the list of repaired files (relative paths). Pure I/O; idempotent.
 */
async function normalizeWebProject(projectRoot, htmlRel, opts) {
    const fixed = [];
    try {
        const htmlAbs = path.join(projectRoot, htmlRel);
        let html = fs.readFileSync(htmlAbs, 'utf8');
        const { scripts } = wv.extractHtmlRefs(html);
        const htmlDir = path.dirname(htmlAbs);

        const jsAbs = [];
        for (const ref of scripts || []) {
            if (/^https?:/i.test(ref)) continue;
            const abs = path.resolve(htmlDir, String(ref).replace(/^\.\//, ''));
            if (/\.m?js$/i.test(abs) && fs.existsSync(abs)) jsAbs.push(abs);
        }
        if (!jsAbs.length) return fixed;

        const sources = jsAbs.map(a => fs.readFileSync(a, 'utf8'));
        const windowRefs = collectWindowRefs([html, ...sources]);
        // Module-intent = real module wiring (a file imports another). A lone `export` with no
        // imports is treated as globals-based (strip -> classic) so it also works over file://.
        const moduleIntent = sources.some(s =>
            /^[ \t]*import\b[^\n]*from\s*['"]\.{0,2}\/[^'"]+['"]/m.test(s));

        const newHtml = moduleIntent ? upgradeModuleTags(html) : downgradeModuleTags(html);
        const htmlChanged = newHtml !== html;
        if (htmlChanged) html = newHtml;

        for (let i = 0; i < jsAbs.length; i++) {
            const orig = sources[i];
            // Globals-based: strip stray module syntax first. Module-intent: keep import/export.
            let code = moduleIntent ? orig : stripEsModuleSyntax(orig).code;
            code = exposeWindowGlobals(code, windowRefs).code;
            if (code !== orig) {
                await ledgerWrite(jsAbs[i], code, opts);
                fixed.push(path.relative(projectRoot, jsAbs[i]).split(path.sep).join('/'));
            }
        }
        if (htmlChanged) await ledgerWrite(htmlAbs, html, opts);
    } catch (e) { /* non-fatal */ }
    return fixed;
}

/** Names already assigned via `window.NAME = ...` in a file (avoid duplicate exposure). */
function collectAssignedWindow(code) {
    const set = new Set();
    const re = /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g;
    let m;
    while ((m = re.exec(String(code || '')))) set.add(m[1]);
    return set;
}

module.exports = {
    stripEsModuleSyntax, htmlIsClassic, normalizeClassicScriptModules,
    normalizeWebProject, collectWindowRefs, topLevelDecls,
    downgradeModuleTags, upgradeModuleTags, exposeWindowGlobals
};
