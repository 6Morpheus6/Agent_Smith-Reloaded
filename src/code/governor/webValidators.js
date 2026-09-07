/**
 * Web validators — dependency-free static analysis for HTML/CSS/JS projects.
 *
 * Every function is PURE (takes strings, returns issue arrays). No filesystem, no
 * DOM, no network. The harness reads files and feeds the contents here. The whole
 * point: catch the failure modes a weak model produces (broken selectors, missing
 * files, mismatched map dimensions, undefined constants) WITHOUT trusting the model.
 *
 * Issue shape: { level: 'error'|'warn'|'info', code, message }
 */
'use strict';

// Generous list of real HTML tag names. A bare CSS selector that is NOT one of
// these is almost always a class/id the model forgot to prefix with . or #.
const HTML_TAGS = new Set([
    'html', 'head', 'body', 'title', 'meta', 'link', 'style', 'script', 'base', 'noscript',
    'header', 'footer', 'main', 'nav', 'section', 'article', 'aside', 'div', 'span', 'p',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup',
    'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'label', 'fieldset',
    'legend', 'datalist', 'output', 'progress', 'meter', 'details', 'summary', 'dialog',
    'canvas', 'svg', 'path', 'g', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'audio', 'video', 'source', 'track', 'iframe', 'embed', 'object', 'param',
    'figure', 'figcaption', 'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's',
    'small', 'sub', 'sup', 'mark', 'br', 'hr', 'wbr', 'abbr', 'address', 'cite', 'q', 'time',
    'data', 'kbd', 'samp', 'var', 'del', 'ins', 'picture', 'template', 'slot'
]);

// Identifiers that look like UPPER_SNAKE constants but are actually globals.
const KNOWN_GLOBAL_CONSTS = new Set([
    'NaN', 'Infinity', 'JSON', 'Math', 'Date', 'Array', 'Object', 'String', 'Number',
    'Boolean', 'RegExp', 'Map', 'Set', 'Promise', 'Symbol', 'BigInt', 'Error', 'TypeError',
    'DOCTYPE', 'URL', 'API', 'DOM', 'CSS', 'HTML', 'UTF', 'RGB', 'RGBA', 'HSL', 'PI', 'E',
    'MAX_SAFE_INTEGER', 'MIN_SAFE_INTEGER', 'EPSILON'
]);

function stripCssComments(css) {
    return String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripJsCommentsAndStrings(js) {
    // Crude scrubber so regex scans don't trip on commented-out or string content.
    // Keeps template-literal interpolations' identifiers visible enough for our
    // narrow checks while removing string bodies. Not a parser; intentionally simple.
    let out = '';
    const s = String(js || '');
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        const n = s[i + 1];
        if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
        if (c === '"' || c === "'") {
            const q = c; i++;
            while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
            i++; out += '""'; continue;
        }
        if (c === '`') {
            // Template literal: drop the literal TEXT (so e.g. `GAME OVER` isn't read as
            // constants) but KEEP the `${...}` interpolation expressions so the identifiers
            // inside them are still scanned.
            i++;
            while (i < s.length && s[i] !== '`') {
                if (s[i] === '\\') { i += 2; continue; }
                if (s[i] === '$' && s[i + 1] === '{') {
                    out += ' '; i += 2;
                    let depth = 1;
                    while (i < s.length && depth > 0) {
                        if (s[i] === '{') depth++;
                        else if (s[i] === '}') { depth--; if (depth === 0) { i++; break; } }
                        out += s[i]; i++;
                    }
                    out += ' '; continue;
                }
                i++; // drop one char of literal text
            }
            i++; out += '``'; continue;
        }
        out += c; i++;
    }
    return out;
}

/** Walk a string from an opening bracket char to its matching close (string-aware). */
function sliceBalanced(text, openIdx) {
    const open = text[openIdx];
    const close = open === '[' ? ']' : open === '{' ? '}' : ')';
    let depth = 0, inStr = false, q = '', esc = false;
    for (let j = openIdx; j < text.length; j++) {
        const c = text[j];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === q) inStr = false;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue; }
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) return text.slice(openIdx, j + 1); }
    }
    return text.slice(openIdx);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function extractHtmlRefs(html) {
    const h = String(html || '');
    const scripts = [...h.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
    const styles = [...h.matchAll(/<link[^>]+href=["']([^"']+\.css)["']/gi)].map(m => m[1]);
    return { scripts, styles };
}

function extractHtmlClassesIds(html) {
    const h = String(html || '');
    const classes = new Set();
    const ids = new Set();
    for (const m of h.matchAll(/class=["']([^"']+)["']/gi)) {
        m[1].split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
    }
    for (const m of h.matchAll(/id=["']([^"']+)["']/gi)) {
        ids.add(m[1].trim());
    }
    return { classes, ids };
}

/** Tag-balance check for non-void elements; flags the classic missing </script>. */
function parseHtmlWellFormed(html) {
    const issues = [];
    const h = String(html || '');
    const lower = h.toLowerCase();
    for (const tag of ['script', 'style', 'head', 'body', 'html']) {
        const opens = (lower.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
        const closes = (lower.match(new RegExp(`</${tag}>`, 'g')) || []).length;
        if (opens > closes) {
            issues.push({ level: 'error', code: 'html-unclosed', message: `<${tag}> is missing a closing </${tag}> (${opens} open, ${closes} close)` });
        }
    }
    if (!/<html[\s>]/i.test(h) && !/<!doctype/i.test(h) && !/<body[\s>]/i.test(h)) {
        issues.push({ level: 'warn', code: 'html-no-root', message: 'no <html>/<body>/<!DOCTYPE> root element found' });
    }
    return issues;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/** Return depth-0, non-at-rule selector preludes (skips @keyframes/@media bodies). */
function parseCssRules(css) {
    const text = stripCssComments(css);
    const selectors = [];
    let i = 0, depth = 0, prelude = '';
    let skipDepth = -1; // depth at which we entered an at-rule whose inner blocks we ignore
    while (i < text.length) {
        const c = text[i];
        if (c === '{') {
            const pre = prelude.trim();
            if (depth === 0) {
                if (pre.startsWith('@')) {
                    // at-rule: ignore its inner rule selectors (keyframe %s, media queries)
                    skipDepth = depth;
                } else if (pre) {
                    selectors.push(pre);
                }
            }
            depth++;
            prelude = '';
            i++;
            continue;
        }
        if (c === '}') {
            depth--;
            if (depth <= skipDepth) skipDepth = -1;
            prelude = '';
            i++;
            continue;
        }
        prelude += c;
        i++;
    }
    return selectors;
}

function parseCssBalanced(css) {
    const text = stripCssComments(css);
    const open = (text.match(/{/g) || []).length;
    const close = (text.match(/}/g) || []).length;
    if (open !== close) {
        return [{ level: 'error', code: 'css-unbalanced', message: `unbalanced CSS braces (${open} '{' vs ${close} '}')` }];
    }
    return [];
}

/** Pull class/id/bare-tag tokens out of a CSS selector list. */
function classifyCssSelectors(selectorList) {
    const classes = new Set();
    const ids = new Set();
    const bareIdents = new Set(); // simple identifiers treated as element/tag selectors
    for (const group of selectorList) {
        for (const sel of group.split(',')) {
            // split into compound tokens on combinators / whitespace
            const tokens = sel.trim().split(/[\s>+~]+/).filter(Boolean);
            for (const tok of tokens) {
                for (const m of tok.matchAll(/\.([A-Za-z_][\w-]*)/g)) classes.add(m[1]);
                for (const m of tok.matchAll(/#([A-Za-z_][\w-]*)/g)) ids.add(m[1]);
                // bare leading identifier (a tag-style selector) — strip any trailing
                // .class / #id / [attr] / :pseudo to isolate the element name.
                const bare = tok.match(/^([A-Za-z_][\w-]*)/);
                if (bare && !tok.startsWith('.') && !tok.startsWith('#')) {
                    bareIdents.add(bare[1]);
                }
            }
        }
    }
    return { classes, ids, bareIdents };
}

// ---------------------------------------------------------------------------
// JS class / id usage + constants
// ---------------------------------------------------------------------------

function extractJsClassesIds(js) {
    const s = stripJsCommentsAndStrings(js);
    const raw = String(js || '');
    const classes = new Set();
    const ids = new Set();

    // classList.add/remove/toggle/contains('x', 'y')
    for (const m of raw.matchAll(/classList\.(?:add|remove|toggle|contains|replace)\s*\(([^)]*)\)/g)) {
        for (const lit of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
            lit[1].split(/\s+/).filter(Boolean).forEach(c => { if (!c.includes('${')) classes.add(c); });
        }
    }
    // element.className = '...'  OR  = `pacman ${dir}`  (drop interpolations)
    for (const m of raw.matchAll(/\.className\s*=\s*([`'"])([\s\S]*?)\1/g)) {
        m[2].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
    }
    // setAttribute('class', '...')
    for (const m of raw.matchAll(/setAttribute\s*\(\s*['"]class['"]\s*,\s*([`'"])([\s\S]*?)\1/g)) {
        m[2].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
    }
    // querySelector / querySelectorAll('.a, #b .c')
    for (const m of raw.matchAll(/querySelector(?:All)?\s*\(\s*([`'"])([\s\S]*?)\1/g)) {
        for (const cm of m[2].matchAll(/\.([A-Za-z_][\w-]*)/g)) classes.add(cm[1]);
        for (const im of m[2].matchAll(/#([A-Za-z_][\w-]*)/g)) ids.add(im[1]);
    }
    // getElementById('x')
    for (const m of raw.matchAll(/getElementById\s*\(\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
    // getElementsByClassName('x')
    for (const m of raw.matchAll(/getElementsByClassName\s*\(\s*['"]([^'"]+)['"]/g)) {
        m[1].split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
    }
    void s;
    return { classes, ids };
}

/**
 * Narrow, high-precision: UPPER_SNAKE constants REFERENCED as bare identifiers but never
 * declared. Tuned to avoid false positives that would wrongly block correct code —
 * member access (`Config.MAX_SPEED`), destructuring, object keys, enum members, and
 * assignment targets all count as "declared".
 */
function findUndefinedConstants(js) {
    const s = stripJsCommentsAndStrings(js);
    const declared = new Set();
    const ID = '[A-Z][A-Z0-9_]{2,}';

    // const/let/var NAME
    for (const m of s.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${ID})\\b`, 'g'))) declared.add(m[1]);
    // destructuring:  const { A, B: C } = ...   /   const [ A, B ] = ...
    for (const m of s.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]+)[}\]]\s*=/g)) {
        for (const part of m[1].split(',')) {
            for (const t of part.split(':')) {
                const mm = t.trim().match(/^([A-Z][A-Z0-9_]{2,})/);
                if (mm) declared.add(mm[1]);
            }
        }
    }
    // assignment target (globals assigned without a keyword):  NAME = ...
    for (const m of s.matchAll(new RegExp(`\\b(${ID})\\s*=(?!=)`, 'g'))) declared.add(m[1]);
    // object keys / case labels / enum members:  NAME:
    for (const m of s.matchAll(new RegExp(`\\b(${ID})\\s*:`, 'g'))) declared.add(m[1]);
    // function / arrow parameters:  function f(WIDTH, HEIGHT){}  /  (WIDTH, HEIGHT) =>  /  WIDTH =>
    const addParams = (list) => {
        for (const part of String(list).split(',')) {
            const mm = part.trim().match(new RegExp(`^(?:\\.\\.\\.)?(${ID})`));
            if (mm) declared.add(mm[1]);
        }
    };
    for (const m of s.matchAll(/\bfunction\b[\w$\s*]*\(([^)]*)\)/g)) addParams(m[1]);
    for (const m of s.matchAll(/\(([^()]*)\)\s*=>/g)) addParams(m[1]);
    for (const m of s.matchAll(new RegExp(`(?:^|[^.\\w$])(${ID})\\s*=>`, 'g'))) declared.add(m[1]);

    // used as a BARE identifier (not preceded by '.', so not a member access)
    const used = new Set();
    for (const m of s.matchAll(new RegExp(`(^|[^.\\w$])(${ID})\\b`, 'g'))) used.add(m[2]);

    const issues = [];
    for (const name of used) {
        if (declared.has(name) || KNOWN_GLOBAL_CONSTS.has(name)) continue;
        issues.push({ level: 'error', code: 'undef-const', message: `uses constant \`${name}\` which is never declared (typo or missing definition)` });
    }
    return issues;
}

/** Parse a 2D map/grid literal and compare its dimensions to declared constants. */
function validateConstantsMatchData(js) {
    const s = String(js || '');
    const issues = [];

    // numeric UPPER_SNAKE consts
    const consts = {};
    for (const m of s.matchAll(/\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\b/g)) {
        consts[m[1]] = parseInt(m[2], 10);
    }

    // find a map-like 2D array literal
    const nameRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g;
    let match;
    let map = null;
    while ((match = nameRe.exec(s)) !== null) {
        if (!/maze|map|grid|board|level|layout|tiles|cells/i.test(match[1])) continue;
        const openIdx = s.indexOf('[', match.index);
        const literal = sliceBalanced(s, openIdx);
        const rows = parseArrayRows(literal);
        if (rows.length >= 2) { map = { name: match[1], rows }; break; }
    }
    if (!map) return issues;

    const widths = map.rows.map(r => r.width);
    const rowCount = map.rows.length;
    const uniform = widths.every(w => w === widths[0]);
    if (!uniform) {
        issues.push({ level: 'error', code: 'map-ragged', message: `\`${map.name}\` rows have inconsistent lengths (${widths.join(', ')}) — maze rows must all be the same width` });
    }
    const width = widths[0];

    const pick = (names) => { for (const n of names) if (consts[n] != null) return { n, v: consts[n] }; return null; };
    const rowsC = pick(['ROWS', 'NUM_ROWS', 'HEIGHT', 'GRID_ROWS', 'MAP_HEIGHT', 'BOARD_HEIGHT']);
    const colsC = pick(['COLS', 'COLUMNS', 'NUM_COLS', 'WIDTH', 'GRID_COLS', 'MAP_WIDTH', 'BOARD_WIDTH']);
    const sizeC = pick(['GRID_SIZE', 'BOARD_SIZE', 'SIZE', 'GRID_DIM', 'MAP_SIZE']);

    if (rowsC && rowsC.v !== rowCount) {
        issues.push({ level: 'error', code: 'map-rows', message: `${rowsC.n} = ${rowsC.v} but \`${map.name}\` has ${rowCount} rows` });
    }
    if (colsC && uniform && colsC.v !== width) {
        issues.push({ level: 'error', code: 'map-cols', message: `${colsC.n} = ${colsC.v} but \`${map.name}\` rows are ${width} wide` });
    }
    if (sizeC) {
        if (sizeC.v !== rowCount) {
            issues.push({ level: 'error', code: 'map-size', message: `${sizeC.n} = ${sizeC.v} but \`${map.name}\` has ${rowCount} rows` });
        } else if (uniform && sizeC.v !== width) {
            issues.push({ level: 'error', code: 'map-size', message: `${sizeC.n} = ${sizeC.v} but \`${map.name}\` rows are ${width} wide` });
        }
    }
    return issues;
}

/** Split a top-level array literal into rows, returning each row's "width". */
function parseArrayRows(literal) {
    // literal includes the outer [ ... ]
    const inner = literal.slice(1, literal.length - 1);
    const rows = [];
    let i = 0;
    while (i < inner.length) {
        const c = inner[i];
        if (c === '"' || c === "'" || c === '`') {
            const q = c; let j = i + 1; let body = '';
            while (j < inner.length && inner[j] !== q) { if (inner[j] === '\\') { body += inner[j + 1] || ''; j += 2; continue; } body += inner[j]; j++; }
            rows.push({ width: body.length });
            i = j + 1;
            continue;
        }
        if (c === '[') {
            const sub = sliceBalanced(inner, i);
            const cells = sub.slice(1, sub.length - 1).split(',').map(x => x.trim()).filter(x => x.length);
            rows.push({ width: cells.length });
            i += sub.length;
            continue;
        }
        i++;
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Selector ↔ DOM/JS cross-check
// ---------------------------------------------------------------------------

function validateSelectorsMatch({ cssSelectors, htmlClasses, htmlIds, jsClasses, jsIds }) {
    const issues = [];
    const usedClasses = new Set([...(htmlClasses || []), ...(jsClasses || [])]);
    const usedIds = new Set([...(htmlIds || []), ...(jsIds || [])]);

    const { classes: cssClasses, ids: cssIds, bareIdents } = cssSelectors;

    // The headline bug: a bare identifier selector (`pacman {}`) that is actually a
    // class the JS/HTML applies — should have been `.pacman`.
    for (const ident of bareIdents) {
        if (ident === '*' || HTML_TAGS.has(ident.toLowerCase())) continue;
        if (usedClasses.has(ident)) {
            issues.push({ level: 'error', code: 'selector-missing-dot', message: `CSS selector \`${ident}\` matches no HTML tag, but \`${ident}\` is used as a class in JS/HTML — write \`.${ident}\`` });
        } else if (usedIds.has(ident)) {
            issues.push({ level: 'error', code: 'selector-missing-hash', message: `CSS selector \`${ident}\` matches no HTML tag, but \`${ident}\` is used as an id — write \`#${ident}\`` });
        } else {
            issues.push({ level: 'warn', code: 'selector-unknown-tag', message: `CSS selector \`${ident}\` is not a known HTML tag and matches no class/id — likely a missing \`.\` or \`#\`` });
        }
    }

    // Class referenced in JS/HTML but styled nowhere → info only (not every class needs CSS).
    void cssClasses; void cssIds;
    return issues;
}

// ---------------------------------------------------------------------------
// Rendered-but-unstyled classes (the "invisible game" failure mode)
// ---------------------------------------------------------------------------

/**
 * Classes the JS ATTACHES to elements (not merely reads via querySelector). These are the
 * classes that decide how rendered DOM looks, so they are the ones that must line up with
 * the stylesheet. Reads (querySelector('.x')) are deliberately excluded — selecting a class
 * is not the same as rendering with it.
 */
function extractJsAppliedClasses(js) {
    const raw = String(js || '');
    const applied = new Set();
    for (const m of raw.matchAll(/classList\.(?:add|toggle|replace)\s*\(([^)]*)\)/g)) {
        for (const lit of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
            lit[1].split(/\s+/).filter(Boolean).forEach(c => { if (!c.includes('${')) applied.add(c); });
        }
    }
    for (const m of raw.matchAll(/\.className\s*=\s*([`'"])([\s\S]*?)\1/g)) {
        m[2].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean).forEach(c => applied.add(c));
    }
    for (const m of raw.matchAll(/setAttribute\s*\(\s*['"]class['"]\s*,\s*([`'"])([\s\S]*?)\1/g)) {
        m[2].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean).forEach(c => applied.add(c));
    }
    return applied;
}

/**
 * Catch the case the Pac-Man build hit: the script renders elements with classes
 * (`cell`, `pellet`, `pacman`, `ghost`) that the stylesheet never defines, while the CSS
 * styles a DIFFERENT vocabulary (`character`, `dot`, `powerup`). Every check passes in
 * isolation — braces balance, selectors are well-formed — yet the game renders invisible.
 *
 * High precision by construction: only fires when a stylesheet EXISTS (so it is a styled
 * project), at least two applied classes are unstyled, and unstyled classes are the MAJORITY
 * of what the script renders. Classes also present in the static HTML markup are treated as
 * intentional, and id-only CSS matches do not count as styling a class.
 */
function validateRenderedClassesStyled({ cssClasses, appliedClasses, htmlClasses }) {
    const issues = [];
    const css = cssClasses || new Set();
    if (css.size === 0) return issues; // unstyled project: nothing to disagree with
    const html = htmlClasses || new Set();
    const applied = [...(appliedClasses || [])].filter(Boolean);
    if (applied.length < 2) return issues;

    const unstyled = applied.filter(c => !css.has(c) && !html.has(c));
    if (unstyled.length >= 2 && unstyled.length / applied.length > 0.5) {
        const shown = unstyled.slice(0, 6).join(', ');
        issues.push({
            level: 'error',
            code: 'render-unstyled',
            message: `script renders elements with classes [${shown}] that the stylesheet never defines — rendered DOM will be unstyled (the script and CSS are using different class names)`
        });
    }
    return issues;
}

// ---------------------------------------------------------------------------
// Serialization-artifact leakage (tool-call JSON bleeding into a written file)
// ---------------------------------------------------------------------------

/**
 * When a write is recovered from malformed/truncated tool-call JSON, the carrier JSON can
 * bleed into the file: a trailing `","path":"…"` tail, or backslash-escaped braces (`\}`)
 * from over-escaped content. Neither is ever valid CSS/JS/HTML, so finding one means the
 * file is corrupt regardless of whether braces happen to balance. Cheap, near-zero false
 * positives, runs on any text file.
 */
/** Blank out strings, template literals, comments, and regex literals so a structural
 *  scan doesn't trip on legitimate content (e.g. a regex `/^\{.*\}$/`). */
function blankLiteralsAndRegex(src) {
    const s = String(src || '');
    let out = '', i = 0, prev = '';
    const regexCanFollow = (p) => p === '' || '([{,;:=!&|?'.includes(p);
    while (i < s.length) {
        const c = s[i], n = s[i + 1];
        if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; out += ' '; continue; }
        if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; out += ' '; continue; }
        if (c === '"' || c === "'" || c === '`') {
            const q = c; i++;
            while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
            i++; out += '""'; prev = '"'; continue;
        }
        if (c === '/' && regexCanFollow(prev)) {
            let j = i + 1, inClass = false, closed = false;
            while (j < s.length) {
                const ch = s[j];
                if (ch === '\\') { j += 2; continue; }
                if (ch === '\n') break;
                if (ch === '[') inClass = true;
                else if (ch === ']') inClass = false;
                else if (ch === '/' && !inClass) { j++; closed = true; break; }
                j++;
            }
            if (closed) { while (j < s.length && /[a-z]/i.test(s[j])) j++; i = j; out += ' '; prev = ')'; continue; }
        }
        if (!/\s/.test(c)) prev = c;
        out += c; i++;
    }
    return out;
}

function detectSerializationArtifacts(text) {
    const issues = [];
    const s = String(text || '');
    if (!s) return issues;
    // Leaked tool-call key boundary, e.g.  ...}\n","path":"style.css
    const keyLeak = s.match(/"\s*,\s*"(?:path|content|name|arguments|parameters|tool|tool_name)"\s*:/);
    if (keyLeak) {
        issues.push({ level: 'error', code: 'leaked-toolcall', message: `file contains a leaked tool-call fragment (\`${keyLeak[0].trim()}…\`) — the write captured part of its own JSON envelope` });
    }
    // Backslash-escaped brace OUTSIDE strings/regex/comments — a JSON over-escape artifact,
    // never valid in real code structure. Scrub literals first so a valid regex like
    // /^\{.*\}$/ or a string "\{" is not mistaken for corruption.
    if (/\\[{}]/.test(blankLiteralsAndRegex(s))) {
        issues.push({ level: 'error', code: 'escaped-brace', message: 'file contains a backslash-escaped brace (`\\{` or `\\}`) — a JSON-escaping artifact that is not valid source' });
    }
    return issues;
}

// ---------------------------------------------------------------------------
// DOM contract: JS references an id/form-control that the HTML must actually define
// ---------------------------------------------------------------------------

/** IDs the JS CREATES dynamically — so a getElementById for them is legitimate. */
function extractJsCreatedIds(js) {
    const raw = String(js || '');
    const ids = new Set();
    for (const m of raw.matchAll(/\.id\s*=\s*['"]([A-Za-z_][\w-]*)['"]/g)) ids.add(m[1]);            // el.id = 'x'
    for (const m of raw.matchAll(/setAttribute\s*\(\s*['"]id['"]\s*,\s*['"]([A-Za-z_][\w-]*)['"]/g)) ids.add(m[1]);
    for (const m of raw.matchAll(/\bid\s*=\s*["']([A-Za-z_][\w-]*)["']/g)) ids.add(m[1]);            // id="x" inside template/innerHTML strings
    return ids;
}

// Standard HTMLFormElement / DOM members — accessing these on a form var is never a control.
const STD_FORM_PROPS = new Set([
    'addEventListener', 'removeEventListener', 'dispatchEvent', 'submit', 'reset', 'requestSubmit',
    'checkValidity', 'reportValidity', 'elements', 'length', 'name', 'method', 'action', 'target',
    'enctype', 'acceptCharset', 'autocomplete', 'noValidate', 'value', 'id', 'className', 'classList',
    'dataset', 'style', 'parentNode', 'parentElement', 'children', 'childNodes', 'querySelector',
    'querySelectorAll', 'appendChild', 'removeChild', 'insertBefore', 'remove', 'closest', 'matches',
    'getAttribute', 'setAttribute', 'removeAttribute', 'hasAttribute', 'innerHTML', 'outerHTML',
    'textContent', 'innerText', 'focus', 'blur', 'scrollIntoView', 'getBoundingClientRect', 'disabled',
    'hidden', 'title', 'tagName', 'nodeName', 'nodeType', 'attributes', 'contains', 'cloneNode',
    'onsubmit', 'onreset', 'onchange', 'oninput', 'onclick', 'checked', 'files', 'append', 'prepend'
]);

// `getElementById('a') || getElementById('b') || ...` is a legitimate fallback: the model
// tries several ids and uses whichever exists. Group their ids so a missing alternative is
// NOT flagged when at least one in the chain is present.
function fallbackIdGroups(js) {
    // A chain term is any element lookup (by id OR class) — a class term keeps the chain intact
    // (e.g. getElementById('a') || querySelector('.b') || getElementById('c')).
    const term = String.raw`(?:document\.)?(?:getElementById\s*\(\s*['"][\w-]+['"]\s*\)|querySelector(?:All)?\s*\(\s*['"][.#][\w-]+['"]\s*\))`;
    const chainRe = new RegExp(`${term}(?:\\s*\\|\\|\\s*${term})+`, 'g');
    const idRe = /getElementById\s*\(\s*['"]([\w-]+)['"]|querySelector(?:All)?\s*\(\s*['"]#([\w-]+)['"]/g;
    const groups = [];
    for (const m of String(js || '').matchAll(chainRe)) {
        const ids = [...m[0].matchAll(idRe)].map(x => x[1] || x[2]).filter(Boolean);
        if (ids.length > 1) groups.push(ids);
    }
    return groups;
}

function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

function stem(tok) {
    const t = String(tok).toLowerCase();
    return t.endsWith('s') && t.length > 3 ? t.slice(0, -1) : t;
}

/** Closest existing id to a missing one — same token set (filter-type ↔ type-filter) wins. */
function closestId(target, known) {
    const tl = String(target).toLowerCase();
    const toksKey = (s) => String(s).toLowerCase().split(/[-_]+/).filter(Boolean).sort().join('|');
    const tKey = toksKey(target);
    for (const k of known) {
        if (toksKey(k) === tKey) return k;
    }
    for (const k of known) {
        const kl = String(k).toLowerCase();
        if (kl.includes(tl) || tl.includes(kl)) return k;
    }
    const tTokens = tl.split(/[-_]+/).filter(Boolean);
    let bestStem = null;
    let bestStemScore = 0;
    for (const k of known) {
        const kTokens = String(k).toLowerCase().split(/[-_]+/).filter(Boolean);
        const score = tTokens.filter(t => kTokens.some(kt => t === kt || stem(t) === stem(kt))).length;
        if (score > bestStemScore) {
            bestStemScore = score;
            bestStem = k;
        }
    }
    if (bestStemScore >= Math.min(2, tTokens.length)) return bestStem;

    let best = null;
    let bestDist = Infinity;
    for (const k of known) {
        const d = levenshtein(tl, String(k).toLowerCase());
        if (d < bestDist) {
            bestDist = d;
            best = k;
        }
    }
    const limit = Math.max(4, Math.ceil(tl.length * 0.45));
    return bestDist <= limit ? best : null;
}

/** name= and id= of the form controls present in the HTML. */
function extractFormControlNames(html) {
    const names = new Set();
    for (const m of String(html || '').matchAll(/<(?:input|select|textarea|button)\b[^>]*>/gi)) {
        const n = m[0].match(/\bname\s*=\s*["']([^"']+)["']/i);
        if (n) names.add(n[1]);
        const id = m[0].match(/\bid\s*=\s*["']([^"']+)["']/i);
        if (id) names.add(id[1]); // form.X resolves by control name OR (for getElementById flows) id
    }
    return names;
}

/**
 * The headline failure: JS reads a DOM contract the HTML never fulfills. Two cases:
 *   1. getElementById('x') / querySelector('#x') where no id="x" exists (and JS never creates it).
 *   2. form.<field> where the <form> has no control named/id'd <field>.
 * Precision: ids the JS creates dynamically are excluded; form access only on form-named vars,
 * non-standard non-method props, and only when a <form> exists.
 */
function validateDomIdConsistency({ html, js }) {
    const issues = [];
    const H = String(html || '');
    const J = String(js || '');
    if (!J.trim() || !H.trim()) return issues;

    const refIds = extractJsClassesIds(J).ids;
    if (refIds.size) {
        const htmlIds = extractHtmlClassesIds(H).ids;
        const known = new Set([...htmlIds, ...extractJsCreatedIds(J)]);
        // Fallback chains (a || b || c): if any exists, none of the alternatives is "missing".
        const satisfied = new Set();
        for (const g of fallbackIdGroups(J)) {
            if (g.some(id => known.has(id))) g.forEach(id => satisfied.add(id));
        }
        for (const id of refIds) {
            if (!known.has(id) && !satisfied.has(id)) {
                const hint = closestId(id, htmlIds);
                issues.push({ level: 'error', code: 'dom-id-missing', id, suggestion: hint,
                    message: `script references #${id} but no element with id="${id}" exists in the HTML`
                        + (hint ? ` — did you mean #${hint}? Fix index.html or the script (smallest patch).` : '') });
            }
        }
    }

    if (/<form\b/i.test(H)) {
        const controls = extractFormControlNames(H);
        const seen = new Set();
        for (const m of J.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\b(?!\s*\()/g)) {
            const varName = m[1], prop = m[2];
            if (!/form$/i.test(varName)) continue;          // only a form-named variable
            if (STD_FORM_PROPS.has(prop) || seen.has(prop)) continue;
            seen.add(prop);
            if (!controls.has(prop)) {
                issues.push({ level: 'error', code: 'form-control-missing', id: prop,
                    message: `script references form.${prop} but the form has no control named "${prop}"` });
            }
        }
    }
    return issues;
}

module.exports = {
    HTML_TAGS,
    stripCssComments,
    stripJsCommentsAndStrings,
    sliceBalanced,
    extractHtmlRefs,
    extractHtmlClassesIds,
    parseHtmlWellFormed,
    parseCssRules,
    parseCssBalanced,
    classifyCssSelectors,
    extractJsClassesIds,
    extractJsCreatedIds,
    extractFormControlNames,
    extractJsAppliedClasses,
    findUndefinedConstants,
    validateConstantsMatchData,
    parseArrayRows,
    validateSelectorsMatch,
    validateDomIdConsistency,
    validateRenderedClassesStyled,
    detectSerializationArtifacts
};
