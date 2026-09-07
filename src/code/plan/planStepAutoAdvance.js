/**
 * Auto-advance approved plan steps when deliverables land on disk (models rarely
 * call mark_code_step_done). Heuristics require DOM contract clean for JS-heavy steps.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wv = require('../governor/webValidators.js');
const { advanceStep, currentStep } = require('./codePlan.js');
const { fileExistsDeep, findFileDeep } = require('../context/fileScan.js');

function fileExists(projectRoot, name) {
    if (!projectRoot || !name) return false;
    return fileExistsDeep(projectRoot, name, 4);
}

/**
 * v52.5 — freshness of ONE project-relative path: true when the run produced it (touched),
 * or it is absent from the run-start snapshot, or its content changed since the snapshot.
 * A pre-existing UNCHANGED file is not evidence for any plan step — that is what let v52.4
 * mark every "create" step done instantly on a workspace left over from an earlier attempt.
 */
function fileIsFresh(projectRoot, relPath, filesTouched, preExisting) {
    const lower = String(relPath || '').replace(/\\/g, '/').toLowerCase();
    if ((filesTouched || []).some(f => String(f).replace(/\\/g, '/').toLowerCase() === lower)) return true;
    if (!preExisting || !preExisting.files.has(lower)) return true; // new file (or no snapshot) → fresh
    const h = preExisting.hashes.get(lower);
    if (!h) return true; // unhashable at snapshot time — can't prove stale, allow progress
    try {
        const cur = crypto.createHash('sha1').update(fs.readFileSync(path.join(projectRoot, lower))).digest('hex');
        return cur !== h;
    } catch (_) { return false; } // vanished since snapshot → not evidence
}

/**
 * v52.5 — a file only counts as step evidence when THIS run produced it: either the model
 * wrote it since run start (filesTouched), or it exists on disk but was absent from / changed
 * after the run-start snapshot (`preExisting`). When no snapshot is available (null/undefined)
 * it falls back to plain disk existence so tests and legacy callers keep working.
 */
function isNewFile(projectRoot, name, filesTouched, preExisting) {
    const target = String(name || '').toLowerCase();
    if ((filesTouched || []).some(f => String(f).replace(/\\/g, '/').toLowerCase() === target)) return true;
    if (!preExisting) return fileExists(projectRoot, name);
    const rel = findFileDeep(projectRoot, name, 4);
    if (!rel) return false;
    return fileIsFresh(projectRoot, rel, filesTouched, preExisting);
}

function resolveHtmlPath(projectRoot) {
    try {
        const p = path.join(projectRoot, 'index.html');
        if (fs.existsSync(p)) return p;
    } catch (_) { /* ignore */ }
    try {
        for (const e of fs.readdirSync(projectRoot, { withFileTypes: true })) {
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
                const p = path.join(projectRoot, e.name, 'index.html');
                if (fs.existsSync(p)) return p;
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

function readHtml(projectRoot) {
    try {
        const abs = resolveHtmlPath(projectRoot);
        return abs ? fs.readFileSync(abs, 'utf8') : '';
    } catch (_) { return ''; }
}

/** v52.5 — true when the deliverable HTML was created or modified by THIS run. */
function htmlIsFresh(projectRoot, filesTouched, preExisting) {
    if (!preExisting) return true;
    try {
        const abs = resolveHtmlPath(projectRoot);
        if (!abs) return false; // no html at all → nothing fresh to credit
        const rel = path.relative(projectRoot, abs).replace(/\\/g, '/').toLowerCase();
        return fileIsFresh(projectRoot, rel, filesTouched, preExisting);
    } catch (_) { return true; } // undecidable → allow progress rather than block it
}

/**
 * Combined project JavaScript for plan-step heuristics + DOM validation.
 * Reads the canonical root-level script(s), every local .js the deliverable index.html
 * references, AND inline <script> bodies in the HTML — so a multi-file build and a
 * single-file (inline) build are BOTH detected instead of only root-level script.js.
 * This is what stops a run from hard-looping on a JS step when the model inlined its code.
 * v52.5: also returns `fresh` — only the parts THIS run created/modified — so feature
 * evidence (localStorage, filters, forms...) can't come from pre-existing unchanged files.
 */
function collectScripts(projectRoot, filesTouched = [], preExisting = null) {
    const seen = new Set();
    const allParts = [];
    const freshParts = [];
    const addFile = (abs, relLabel) => {
        try {
            if (!abs || seen.has(abs)) return;
            seen.add(abs);
            const content = fs.readFileSync(abs, 'utf8');
            allParts.push(content);
            let fresh = true;
            if (preExisting) {
                const rel = String(relLabel || path.relative(projectRoot, abs)).replace(/\\/g, '/').toLowerCase();
                fresh = fileIsFresh(projectRoot, rel, filesTouched, preExisting);
            }
            if (fresh) freshParts.push(content);
        } catch (_) { /* ignore */ }
    };
    for (const rel of ['script.js', 'app.js', 'main.js']) addFile(path.join(projectRoot, rel), rel);
    try {
        const { findDeliverableIndexHtml } = require('../loop/missingRefGuard.js');
        const htmlRel = findDeliverableIndexHtml(projectRoot, []);
        if (htmlRel) {
            const htmlAbs = path.join(projectRoot, htmlRel);
            const htmlDir = path.dirname(htmlAbs);
            const { scripts } = wv.extractHtmlRefs(fs.readFileSync(htmlAbs, 'utf8'));
            for (const ref of scripts || []) {
                if (/^https?:/i.test(ref)) continue;
                const abs = path.resolve(htmlDir, String(ref).replace(/^\.\//, ''));
                addFile(abs, path.relative(projectRoot, abs));
            }
        }
    } catch (_) { /* ignore */ }
    try {
        const html = readHtml(projectRoot);
        const htmlFresh = !preExisting || htmlIsFresh(projectRoot, filesTouched, preExisting);
        for (const m of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
            if (m[1] && m[1].trim()) {
                allParts.push(m[1]);
                if (htmlFresh) freshParts.push(m[1]);
            }
        }
    } catch (_) { /* ignore */ }
    return { all: allParts.join('\n'), fresh: freshParts.join('\n') };
}

function readScript(projectRoot) {
    return collectScripts(projectRoot, [], null).all;
}

/** True when the deliverable HTML carries a substantive inline <script> body THIS run wrote. */
function htmlHasInlineJs(projectRoot, filesTouched = [], preExisting = null) {
    if (preExisting && !htmlIsFresh(projectRoot, filesTouched, preExisting)) return false;
    const html = readHtml(projectRoot);
    for (const m of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (m[1] && m[1].trim().length > 40) return true;
    }
    return false;
}

/** True when the deliverable HTML carries a substantive inline <style> block THIS run wrote. */
function htmlHasInlineCss(projectRoot, filesTouched = [], preExisting = null) {
    if (preExisting && !htmlIsFresh(projectRoot, filesTouched, preExisting)) return false;
    const html = readHtml(projectRoot);
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
        if (m[1] && m[1].trim().length > 40) return true;
    }
    return false;
}

/** True when the deliverable HTML references at least one local .js file THIS run produced. */
function htmlHasLinkedJs(projectRoot, filesTouched = [], preExisting = null) {
    try {
        const { findDeliverableIndexHtml } = require('../loop/missingRefGuard.js');
        const htmlRel = findDeliverableIndexHtml(projectRoot, []);
        if (!htmlRel) return false;
        const htmlAbs = path.join(projectRoot, htmlRel);
        const htmlDir = path.dirname(htmlAbs);
        const { scripts } = wv.extractHtmlRefs(fs.readFileSync(htmlAbs, 'utf8'));
        for (const ref of scripts || []) {
            if (/^https?:/i.test(ref)) continue;
            const clean = String(ref).replace(/^\.\//, '');
            if (!/\.(m?js)$/i.test(clean)) continue;
            const abs = path.resolve(htmlDir, clean);
            if (!fs.existsSync(abs)) continue; // referenced but missing → not evidence (missingRefGuard reports it)
            const rel = path.relative(projectRoot, abs).replace(/\\/g, '/').toLowerCase();
            if (!preExisting || fileIsFresh(projectRoot, rel, filesTouched, preExisting)) return true;
        }
    } catch (_) { /* ignore */ }
    return false;
}

function goalRequiresReadme(goal) {
    return /\bREADME\.md\b/i.test(String(goal || ''));
}

/** True when index.html + script.js exist and every getElementById target is in HTML. */
function domContractClean(projectRoot) {
    const html = readHtml(projectRoot);
    const js = readScript(projectRoot);
    if (!html.trim() || !js.trim()) return true;
    return wv.validateDomIdConsistency({ html, js })
        .every(i => i.level !== 'error');
}

function domMismatchMessages(projectRoot) {
    const html = readHtml(projectRoot);
    const js = readScript(projectRoot);
    if (!html.trim() || !js.trim()) return [];
    return wv.validateDomIdConsistency({ html, js })
        .filter(i => i.level === 'error')
        .map(i => `[DOM] ${i.message}`);
}

function touchedMatches(filesTouched, extRe) {
    return (filesTouched || []).some(f => extRe.test(String(f).replace(/\\/g, '/')));
}

function stepNeedsDomClean(title) {
    const t = String(title || '').toLowerCase();
    return /\blocalstorage\b|\bpersist|\bfilter|\bform\b|\btransaction|\binteractions?\b|\bcrud\b|add\/edit\/delete|edit.*delete|\bimport\b|\bexport\b|\bcategor|\btheme\b/.test(t);
}

function planAllStepsDone(plan) {
    return !!plan?.steps?.length && plan.steps.every(s => s.status === 'done');
}

/**
 * Lightweight blocker scan for plan UI + nudges (cheap static checks — not the full gate's
 * smoke/functional/acceptance). The authoritative blocker count still comes from the real
 * completion gate via verify_blocked; this just keeps the plan UI from reading "complete"
 * while files are missing or selectors mismatch.
 */
function collectPlanBlockers(projectRoot, goal, filesTouched) {
    const messages = [];
    if (goalRequiresReadme(goal) && !fileExists(projectRoot, 'README.md')) {
        messages.push('[ARTIFACT] README.md is required by the prompt but missing');
    }
    // Linked files index.html references but that don't exist on disk yet.
    try {
        const { findDeliverableIndexHtml, collectMissingRefsFromHtml } = require('../loop/missingRefGuard.js');
        const htmlRel = findDeliverableIndexHtml(projectRoot, filesTouched || []);
        if (htmlRel) {
            for (const ref of collectMissingRefsFromHtml(projectRoot, htmlRel)) {
                messages.push(`[WEB] index.html references "${ref}" but it is missing on disk`);
            }
        }
    } catch (e) { /* ignore */ }
    messages.push(...domMismatchMessages(projectRoot));
    return { count: messages.length, messages };
}

function planProgressPayload(plan, projectRoot, goal, filesTouched) {
    const allDone = planAllStepsDone(plan);
    const blockers = collectPlanBlockers(projectRoot, goal, filesTouched);
    return {
        codePlan: plan,
        complete: allDone && blockers.count === 0,
        gateBlockerCount: blockers.count,
        gateBlockers: blockers.messages.slice(0, 5)
    };
}

/**
 * Heuristic: is this plan step's deliverable satisfied on disk?
 * File-structure agnostic by design — a step counts as done whether the model built it
 * multi-file (index.html + style.css + script.js) or inlined CSS/JS into index.html.
 * The harness steers toward separate files via nudge; it must never hard-loop on layout.
 * v52.5: "on disk" means produced BY THIS RUN — pre-existing files are not evidence (see isNewFile).
 */
function isStepSatisfied(title, projectRoot, filesTouched, goal, preExisting) {
    const t = String(title || '').toLowerCase();
    const touched = filesTouched || [];

    if (/\bindex\.html\b|\bhtml structure\b|\bhtml file\b|\bbasic structure\b|\bui elements\b/.test(t)) {
        if (isNewFile(projectRoot, 'index.html', touched, preExisting) || touchedMatches(touched, /\.html?$/i)) return true;
    }
    if (/\bstyle\.css\b|\bcss file\b|\bstyling\b|\bresponsive design\b|\blayout and theme\b/.test(t)) {
        // Separate stylesheet OR a substantive inline <style> in the deliverable HTML.
        if (isNewFile(projectRoot, 'style.css', touched, preExisting) || touchedMatches(touched, /\.css$/i)
            || htmlHasInlineCss(projectRoot, touched, preExisting)) return true;
    }
    if (/\bscript\.js\b|\bjavascript\b|\bapp logic\b|\bcore logic\b|\bjs file\b/.test(t)) {
        // Linked .js file(s), a canonical root script, OR substantive inline <script>.
        if (isNewFile(projectRoot, 'script.js', touched, preExisting) || touchedMatches(touched, /\.(js|mjs|cjs)$/i)
            || htmlHasLinkedJs(projectRoot, touched, preExisting) || htmlHasInlineJs(projectRoot, touched, preExisting)) return true;
    }
    if (/\breadme\.md\b|\breadme\b|\bdocumentation\b/.test(t)) {
        if (isNewFile(projectRoot, 'README.md', touched, preExisting)) return true;
    }

    if (/create required files|html.*css.*js/i.test(t)) {
        const hasHtml = isNewFile(projectRoot, 'index.html', touched, preExisting) || touchedMatches(touched, /\.html?$/i);
        const hasCss = isNewFile(projectRoot, 'style.css', touched, preExisting) || touchedMatches(touched, /\.css$/i)
            || htmlHasInlineCss(projectRoot, touched, preExisting);
        const hasJs = isNewFile(projectRoot, 'script.js', touched, preExisting) || touchedMatches(touched, /\.(js|mjs|cjs)$/i)
            || htmlHasLinkedJs(projectRoot, touched, preExisting) || htmlHasInlineJs(projectRoot, touched, preExisting);
        return hasHtml && hasCss && hasJs;
    }

    if (/html structure and responsive styling/i.test(t)) {
        const hasHtml = isNewFile(projectRoot, 'index.html', touched, preExisting) || touchedMatches(touched, /\.html?$/i);
        const hasCss = isNewFile(projectRoot, 'style.css', touched, preExisting) || touchedMatches(touched, /\.css$/i)
            || htmlHasInlineCss(projectRoot, touched, preExisting);
        return hasHtml && hasCss;
    }

    if (/\bverif|\bpreview\b|\btest\b|\bfinal\b/i.test(t)) {
        if (goalRequiresReadme(goal) && !isNewFile(projectRoot, 'README.md', touched, preExisting)) return false;
        const hasJs = isNewFile(projectRoot, 'script.js', touched, preExisting) || htmlHasLinkedJs(projectRoot, touched, preExisting) || htmlHasInlineJs(projectRoot, touched, preExisting);
        if (!fileExists(projectRoot, 'index.html') || !hasJs) return false;
        if (!domContractClean(projectRoot)) return false;
        return true;
    }

    if (stepNeedsDomClean(t) && !domContractClean(projectRoot)) {
        return false;
    }

    // JS-feature steps: require evidence the feature is actually IMPLEMENTED, not that an
    // incidental keyword appears (e.g. a stray `.filter()` for totals is not a filter UI; the
    // ES `import`/`export` keywords are not a data import/export feature). The DOM-clean gate
    // above already blocks these when selectors don't match. v52.5: evidence must come from
    // code THIS run wrote — pre-existing unchanged files can't satisfy a feature step.
    const js = collectScripts(projectRoot, touched, preExisting).fresh;
    if (js) {
        // Persistence: localStorage read or write.
        if (/\blocalstorage\b|\bpersist/i.test(t)
            && /\blocalStorage\s*\.\s*(setItem|getItem)/i.test(js)) {
            return true;
        }
        // Filter/search: a real input/select wired to a handler AND an actual .filter() call.
        if (/\bfilter|\bsearch\b/i.test(t)
            && /\.filter\s*\(/.test(js)
            && /addEventListener\s*\(\s*['"](input|change|keyup|keydown|search|click)['"]/i.test(js)) {
            return true;
        }
        // Form/transactions: a submit handler that actually mutates state or the DOM.
        if (/\bform\b|\btransaction|\badd\b/i.test(t)
            && /addEventListener\s*\(\s*['"]submit['"]/i.test(js)
            && /(\.push\s*\(|\.unshift\s*\(|\.appendChild\s*\(|\.innerHTML\s*=|insertAdjacentHTML)/.test(js)) {
            return true;
        }
        // Import/export DATA — NOT the ES module import/export keywords. Needs JSON + a
        // blob/download/file-read path.
        if (/\bimport\b|\bexport\b/i.test(t)
            && /JSON\.stringify/.test(js)
            && /(Blob|createObjectURL|download|FileReader|type\s*=\s*['"]file|accept\s*=\s*['"][^'"]*json)/i.test(js)) {
            return true;
        }
        // Categories: a category list actually rendered/used (not just the word).
        if (/\bcategor/i.test(t)
            && /\bcategor/i.test(js)
            && /(createElement|<option|appendChild|\.push\s*\(|\.map\s*\(|getElementById)/i.test(js)) {
            return true;
        }
        // Theme: an actual toggle action, not just the word "theme".
        if (/\btheme\b|\bdark mode\b|\blight mode\b/i.test(t)
            && /(classList\s*\.\s*(toggle|add|remove)\s*\([^)]*\b(theme|dark|light)|data-theme|setAttribute\s*\(\s*['"]data-theme)/i.test(js)) {
            return true;
        }
        // CRUD/interactions: a handler that mutates a list (add/remove/replace).
        if (/\binteractions?\b|\bcrud\b|add\/edit\/delete|edit.*delete/i.test(t)
            && /addEventListener/.test(js)
            && /(\.push\s*\(|\.splice\s*\(|\.unshift\s*\(|=\s*\w+\.filter\s*\(|\.findIndex\s*\()/.test(js)) {
            return true;
        }
    }

    return false;
}

/**
 * Advance every consecutive satisfied step (current step first).
 * @param {Set|null} preExisting run-start file snapshot — files in it are not evidence.
 * @returns {{ advanced: number, complete: boolean }}
 */
function autoAdvancePlanSteps(plan, projectRoot, filesTouched, goal, preExisting) {
    if (!plan?.steps?.length) return { advanced: 0, complete: false };
    let advanced = 0;
    let complete = false;
    const maxBurst = 12;
    while (advanced < maxBurst) {
        const cur = currentStep(plan);
        if (!cur || cur.status === 'done') break;
        if (!isStepSatisfied(cur.title, projectRoot, filesTouched, goal, preExisting)) break;
        const r = advanceStep(plan);
        if (!r.advanced) break;
        advanced++;
        complete = !!r.complete;
    }
    return { advanced, complete };
}

/** Nudge when disk shows progress but the active step hasn't auto-advanced for 2+ turns. */
function buildStalePlanStepNudge(plan, projectRoot, filesTouched, goal, turnsOnStep, preExisting) {
    if (!plan?.steps?.length || (turnsOnStep || 0) < 2) return '';
    const cur = currentStep(plan);
    if (!cur || cur.status !== 'active') return '';
    const idx = (plan.currentStepIndex ?? 0) + 1;
    const hints = [];
    if ((isNewFile(projectRoot, 'index.html', filesTouched, preExisting)) && /\bhtml\b/i.test(cur.title)) {
        hints.push('index.html is on disk');
    }
    if ((isNewFile(projectRoot, 'script.js', filesTouched, preExisting)) && /\bscript|javascript|logic/i.test(cur.title)) {
        hints.push('script.js is on disk');
    }
    if (!hints.length && !isStepSatisfied(cur.title, projectRoot, filesTouched, goal, preExisting)) return '';
    return [
        '[HARNESS — PLAN STEP]',
        `Step ${idx} ("${cur.title}") looks complete or stalled (${turnsOnStep} turns on this step).`,
        hints.length ? `Detected: ${hints.join('; ')}.` : 'Move on to the next deliverable.',
        'Continue with the NEXT file or feature — or call mark_code_step_done if this step is finished.'
    ].join(' ');
}

/** Nudge when all plan steps are done but gate blockers remain — stop read loops. */
function buildPlanCompleteGateNudge(goal, projectRoot, gateMessages) {
    const blockers = gateMessages?.length
        ? gateMessages
        : collectPlanBlockers(projectRoot, goal).messages;
    if (!blockers.length) return '';
    const dom = blockers.filter(m => /^\[DOM\]/i.test(m)).slice(0, 6);
    const artifact = blockers.filter(m => /^\[ARTIFACT\]/i.test(m));
    const lines = [
        '[HARNESS — PLAN COMPLETE, VERIFICATION BLOCKED]',
        'All plan steps are checked off but the app is NOT ready. Fix these blockers — do NOT read_file in a loop:',
        '',
        ...blockers.slice(0, 8).map(m => `  ${m}`),
        ''
    ];
    if (dom.length) {
        lines.push('Patch script.js so every getElementById id matches index.html (kebab-case). Do NOT rewrite index.html.');
    }
    if (artifact.some(m => /README/i.test(m))) {
        lines.push('Write README.md with title, how to open index.html, and feature list.');
    }
    lines.push('Use patch or write_file — one targeted fix per turn, not repeated reads.');
    return lines.join('\n');
}

module.exports = {
    isStepSatisfied,
    isNewFile,
    autoAdvancePlanSteps,
    buildStalePlanStepNudge,
    buildPlanCompleteGateNudge,
    collectPlanBlockers,
    planProgressPayload,
    planAllStepsDone,
    domContractClean,
    goalRequiresReadme,
    fileExists,
    htmlHasInlineJs,
    htmlHasInlineCss,
    htmlHasLinkedJs
};
