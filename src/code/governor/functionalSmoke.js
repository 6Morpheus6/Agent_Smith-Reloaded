'use strict';

// Functional smoke for interactive static web apps: actually DRIVE the app in jsdom — load the
// HTML, run the linked scripts, fill + submit the first form — and verify something happens.
// Static checks (acceptance, DOM-id consistency) verify the contract; this verifies behavior.
//
// jsdom is an OPTIONAL dependency. If it is absent the smoke reports `unavailable` (never
// silently skipped) so the gate can note that functional runtime verification did not run.
//
// Conservative by design (must not fail WORKING apps): it blocks only on (a) an uncaught error
// during load or interaction, or (b) a form submit that produces NO observable change at all
// (no DOM growth, no text change, no localStorage write). Both are strong "it doesn't work"
// signals for a CRUD app.

const fs = require('fs');
const path = require('path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* optional dependency */ }

const INTERACTIVE_RE = /\b(to-?do|todo|task|kanban|tracker|budget|expense|notes?|cart|checkout|inventory|crud|form|calculator|dashboard|playlist|reminder|habit|list)\b/i;
const PERSIST_RE = /\b(save|saved|persist|persistent|store|storage|localstorage|sessionstorage|remember|keep\s+track)\b/i;

function isAvailable() { return !!JSDOM; }
function isInteractiveGoal(goal) { return INTERACTIVE_RE.test(String(goal || '')); }
const tick = () => new Promise(r => setTimeout(r, 0));

function dedupe(arr) {
    const seen = new Set(); const out = [];
    for (const s of arr) { const v = String(s || '').trim(); if (v && !seen.has(v)) { seen.add(v); out.push(v); } }
    return out.slice(0, 6);
}

/** Inline local <script src> contents so they execute in order (jsdom won't fetch them). */
function inlineLocalScripts(html, htmlAbs) {
    const dir = path.dirname(htmlAbs);
    return String(html).replace(
        /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
        (m, pre, src, post) => {
            if (/^https?:\/\//i.test(src)) return m;
            try {
                const code = fs.readFileSync(path.resolve(dir, src.replace(/^\.\//, '')), 'utf8');
                return `<script>${code}\n</script>`;
            } catch (e) { return m; }
        }
    );
}

/** Pull inline <script> bodies out (in order) and return the HTML with them removed. */
function extractScripts(html) {
    const scripts = [];
    const stripped = String(html).replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, body) => {
        if (/\bsrc\s*=/i.test(attrs)) return '';        // unresolved external — skip
        scripts.push(body);
        return '';
    });
    return { stripped, scripts };
}

/**
 * jsdom supports `form.elements.name` but NOT the browser shorthand `form.name` — apps that use
 * `form.description` would false-fail. Patch each form so named/id'd controls are reachable as
 * `form.<name>`, matching real browsers, BEFORE the page scripts run.
 */
function patchFormNamedAccess(window) {
    for (const form of window.document.querySelectorAll('form')) {
        for (const ctrl of form.querySelectorAll('input,select,textarea,button')) {
            const key = ctrl.getAttribute('name') || ctrl.getAttribute('id');
            if (!key || (key in form)) continue;        // don't shadow real props (e.g. submit, value)
            try { Object.defineProperty(form, key, { get: () => ctrl, configurable: true, enumerable: false }); } catch (e) { /* ignore */ }
        }
    }
}

function observableState(window) {
    const doc = window.document;
    let ls = 0;
    try { ls = window.localStorage ? window.localStorage.length : 0; } catch (e) { /* ignore */ }
    return {
        els: doc.body ? doc.body.getElementsByTagName('*').length : 0,
        text: doc.body ? (doc.body.textContent || '').length : 0,
        ls
    };
}

function fillAndSubmitFirstForm(window, goal, errors, notes) {
    const doc = window.document;
    const form = doc.querySelector('form');
    if (!form) { notes.push('no <form> to exercise'); return; }

    const before = observableState(window);
    for (const inp of form.querySelectorAll('input, textarea')) {
        const type = (inp.getAttribute('type') || 'text').toLowerCase();
        if (['button', 'submit', 'reset', 'file', 'checkbox', 'radio', 'hidden'].includes(type)) continue;
        inp.value = type === 'number' ? '42' : type === 'date' ? '2024-01-01' : type === 'email' ? 'a@b.co' : 'Test value';
        inp.dispatchEvent(new window.Event('input', { bubbles: true }));
        inp.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
    for (const sel of form.querySelectorAll('select')) {
        if (sel.options.length) { sel.selectedIndex = sel.options.length - 1; sel.dispatchEvent(new window.Event('change', { bubbles: true })); }
    }

    const errBefore = errors.length;
    try {
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    } catch (e) { errors.push(`form submit threw: ${e.message}`.slice(0, 160)); return; }
    if (errors.length > errBefore) return; // window.onerror already captured a handler error

    const after = observableState(window);
    const changed = after.els > before.els || after.text !== before.text || after.ls > before.ls;
    if (!changed) {
        errors.push('submitting the form produced no change (no transaction rendered, no totals updated, no state saved)');
        return;
    }
    if (PERSIST_RE.test(goal) && after.ls === 0) {
        notes.push('goal implies persistence but localStorage is empty after submit');
    }
}

/**
 * @returns {Promise<{ok:boolean, skipped?:boolean, unavailable?:boolean, reason?:string, errors:string[], notes:string[]}>}
 */
async function runFunctionalSmoke({ projectRoot, htmlRel, goal }) {
    if (!isInteractiveGoal(goal)) return { ok: true, skipped: true, reason: 'non-interactive goal', errors: [], notes: [] };
    if (!htmlRel) return { ok: true, skipped: true, reason: 'no html', errors: [], notes: [] };
    if (!JSDOM) return { ok: true, unavailable: true, reason: 'jsdom not installed', errors: [], notes: [] };

    let scripts, strippedHtml;
    const htmlAbs = path.join(projectRoot, htmlRel);
    try {
        const inlined = inlineLocalScripts(fs.readFileSync(htmlAbs, 'utf8'), htmlAbs);
        ({ stripped: strippedHtml, scripts } = extractScripts(inlined));
    } catch (e) { return { ok: true, skipped: true, reason: 'html unreadable', errors: [], notes: [] }; }

    const errors = [];
    const notes = [];
    let dom;
    try {
        dom = new JSDOM(strippedHtml, {
            runScripts: 'outside-only',           // we run page scripts ourselves, after patching forms
            url: 'http://localhost/',
            pretendToBeVisual: true,
            beforeParse(window) {
                window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
                window.cancelAnimationFrame = () => {};
                window.alert = () => {}; window.confirm = () => true; window.prompt = () => '';
                window.scrollTo = () => {};
                if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
            }
        });
    } catch (e) {
        return { ok: false, errors: [`app failed to load: ${e.message}`.slice(0, 160)], notes: [] };
    }

    const { window } = dom;
    window.onerror = (msg) => { errors.push(`uncaught error: ${String(msg)}`.slice(0, 160)); return true; };
    patchFormNamedAccess(window);

    for (const code of scripts) {
        if (!code || !code.trim()) continue;
        try { window.eval(code); } catch (e) { errors.push(`script error: ${e.message}`.slice(0, 160)); }
    }
    try { window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true })); } catch (e) { /* ignore */ }
    await tick();
    patchFormNamedAccess(window); // catch forms rendered during init

    if (!errors.length) {
        try { fillAndSubmitFirstForm(window, goal, errors, notes); }
        catch (e) { errors.push(`interaction error: ${e.message}`.slice(0, 160)); }
        await tick();
    }

    try { window.close(); } catch (e) { /* ignore */ }
    return { ok: errors.length === 0, errors: dedupe(errors), notes: dedupe(notes) };
}

module.exports = { runFunctionalSmoke, isAvailable, isInteractiveGoal };
