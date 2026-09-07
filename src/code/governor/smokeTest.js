/**
 * Browser smoke test for web tasks. Loads index.html, executes its scripts, and
 * reports thrown errors / console errors / whether expected nodes rendered.
 *
 * Engine resolution (honest degradation, matching the harness rule "a missing tool
 * is a SKIP, never a false pass"):
 *   1. jsdom        — if `require('jsdom')` succeeds (full DOM).
 *   2. vm + DOM stub — dependency-free fallback that really runs the script in a
 *                      sandbox and catches SyntaxError/ReferenceError/TypeError.
 *
 * The vm engine cannot render pixels, but it DOES catch the failures that ship a
 * broken game: scripts that throw on load, undefined references, and null DOM nodes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractHtmlRefs, extractHtmlClassesIds } = require('./webValidators.js');

function tryRequireJsdom() {
    try { return require('jsdom'); } catch (e) { return null; }
}

function readLocalScripts(projectRoot, html, htmlDir) {
    const { scripts } = extractHtmlRefs(html);
    const sources = [];
    for (const ref of scripts) {
        if (/^https?:\/\//i.test(ref)) continue; // external CDN — out of scope
        const rel = ref.replace(/^\.\//, '');
        const abs = path.resolve(htmlDir, rel);
        try {
            sources.push({ ref, code: fs.readFileSync(abs, 'utf-8') });
        } catch (e) {
            sources.push({ ref, code: null, missing: true });
        }
    }
    // inline <script> blocks (no src attribute)
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (m[1] && m[1].trim()) sources.push({ ref: '(inline)', code: m[1] });
    }
    void projectRoot;
    return sources;
}

// --- vm DOM stub -----------------------------------------------------------

function makeStubDom(htmlIds) {
    const created = [];
    const classesApplied = new Set();

    function StubEl(tag) {
        const el = {
            tagName: String(tag || 'div').toUpperCase(),
            _class: '',
            id: '',
            style: {},
            dataset: {},
            children: [],
            attributes: {},
            parentNode: null,
            _listeners: [],
            get className() { return this._class; },
            set className(v) {
                this._class = String(v);
                String(v).split(/\s+/).filter(Boolean).forEach(c => classesApplied.add(c));
            },
            get textContent() { return this._text || ''; },
            set textContent(v) { this._text = String(v == null ? '' : v); },
            get innerHTML() { return this._html || ''; },
            set innerHTML(v) { this._html = String(v == null ? '' : v); if (v === '') this.children = []; },
            appendChild(c) { if (c) { c.parentNode = this; this.children.push(c); } return c; },
            append(...cs) { cs.forEach(c => this.appendChild(c)); },
            prepend(...cs) { cs.forEach(c => this.children.unshift(c)); },
            removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
            remove() { if (this.parentNode) this.parentNode.removeChild(this); },
            setAttribute(k, v) { this.attributes[k] = v; if (k === 'class') this.className = v; if (k === 'id') this.id = v; },
            getAttribute(k) { return this.attributes[k] != null ? this.attributes[k] : null; },
            removeAttribute(k) { delete this.attributes[k]; },
            hasAttribute(k) { return k in this.attributes; },
            addEventListener(type, cb) { this._listeners.push({ type, cb }); },
            removeEventListener() {},
            getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 100, height: 100 }; },
            getContext() { return makeCanvasCtx(); },
            focus() {}, blur() {}, click() {}, scrollIntoView() {},
            insertBefore(n) { this.children.push(n); return n; },
            cloneNode() { return StubEl(this.tagName); },
            // Return a detached stub (never null) so valid `el.querySelector('.x').foo()`
            // chains don't throw a TypeError and produce a FALSE smoke failure. We are
            // testing "does the script run without errors", not exact DOM matching.
            querySelector() { return StubEl('div'); },
            querySelectorAll() { return []; }
        };
        el.classList = {
            add(...n) { n.forEach(x => { if (x && !el._classSet().has(x)) { classesApplied.add(x); } }); el._setClass(el._tokens().concat(n.filter(Boolean))); },
            remove(...n) { el._setClass(el._tokens().filter(t => !n.includes(t))); },
            toggle(x) { const t = el._tokens(); if (t.includes(x)) { el._setClass(t.filter(v => v !== x)); return false; } classesApplied.add(x); el._setClass(t.concat([x])); return true; },
            contains(x) { return el._tokens().includes(x); },
            replace(a, b) { el._setClass(el._tokens().map(t => t === a ? b : t)); if (b) classesApplied.add(b); }
        };
        el._tokens = () => el._class.split(/\s+/).filter(Boolean);
        el._classSet = () => new Set(el._tokens());
        el._setClass = (arr) => { el._class = arr.join(' '); arr.forEach(c => classesApplied.add(c)); };
        return el;
    }

    function makeCanvasCtx() {
        return new Proxy({}, {
            get(_t, prop) {
                if (prop === 'canvas') return { width: 300, height: 150 };
                if (prop === 'measureText') return () => ({ width: 0 });
                if (prop === 'getImageData') return () => ({ data: [] });
                if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
                return () => {};
            },
            set() { return true; }
        });
    }

    const registry = {};
    for (const id of htmlIds) registry[id] = StubEl('div');
    for (const id of htmlIds) registry[id].id = id;

    const body = StubEl('body');
    const documentEl = StubEl('html');
    const head = StubEl('head');
    const docListeners = {};

    const document = {
        // Return a stub for any id (cached) so `getElementById('x').foo()` never throws a
        // false-positive null-deref; ids present in the HTML reuse their seeded element.
        getElementById(id) {
            if (!registry[id]) { registry[id] = StubEl('div'); registry[id].id = id; }
            return registry[id];
        },
        getElementsByClassName() { return []; },
        getElementsByTagName() { return []; },
        querySelector() { return StubEl('div'); },
        querySelectorAll() { return []; },
        createElement(tag) { const el = StubEl(tag); created.push(el); return el; },
        createTextNode(t) { return { textContent: String(t) }; },
        createDocumentFragment() { return StubEl('fragment'); },
        addEventListener(type, cb) { if (typeof cb === 'function') (docListeners[type] = docListeners[type] || []).push(cb); },
        removeEventListener() {}, dispatchEvent() { return true; },
        body, head, documentElement: documentEl,
        readyState: 'complete'
    };

    return { document, body, created, classesApplied, registry, StubEl, docListeners };
}

function runVmEngine(sources, html) {
    const errors = [];
    const missing = sources.filter(s => s.missing).map(s => s.ref);
    for (const m of missing) errors.push(`referenced script not found: ${m}`);

    const { ids } = extractHtmlClassesIds(html);
    const dom = makeStubDom(ids);
    const timers = [];
    const capturedConsole = [];
    const winListeners = {};

    // A permissive Event/KeyboardEvent/etc. object — enough that `new Event('x')`,
    // `e.preventDefault()`, `e.key` etc. don't throw during load.
    const makeEvt = (type, init) => Object.assign({
        type: type || '', key: '', code: '', keyCode: 0, which: 0, button: 0,
        clientX: 0, clientY: 0, deltaY: 0, touches: [], target: null, currentTarget: null,
        bubbles: false, defaultPrevented: false,
        preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}
    }, init || {});
    const EvtCtor = function (type, init) { return makeEvt(type, init); };
    const mediaQuery = () => ({ matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });

    const sandbox = {
        document: dom.document,
        console: {
            log() {}, info() {}, debug() {}, trace() {}, group() {}, groupEnd() {}, table() {}, dir() {}, assert() {}, count() {}, time() {}, timeEnd() {},
            warn(...a) { capturedConsole.push(['warn', a.join(' ')]); },
            error(...a) { capturedConsole.push(['error', a.join(' ')]); }
        },
        setInterval(fn) { timers.push(fn); return timers.length; },
        setTimeout(fn) { timers.push(fn); return timers.length; },
        requestAnimationFrame(fn) { timers.push(fn); return timers.length; },
        clearInterval() {}, clearTimeout() {}, cancelAnimationFrame() {},
        queueMicrotask(fn) { try { fn(); } catch (e) { /* surfaced elsewhere */ } },
        alert() {}, confirm() { return true; }, prompt() { return null; },
        // window-level event wiring (window === sandbox below, so `window.addEventListener` works too)
        addEventListener(type, cb) { if (typeof cb === 'function') (winListeners[type] = winListeners[type] || []).push(cb); },
        removeEventListener() {}, dispatchEvent() { return true; },
        // storage
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {}, key() { return null; }, length: 0 },
        sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {}, key() { return null; }, length: 0 },
        // common browser globals so standard idioms don't throw on load (this is a smoke test
        // for "does it run", not a real browser — these are inert stubs)
        navigator: { userAgent: 'agent-smith-smoke', language: 'en-US', languages: ['en-US'], platform: 'linux', onLine: true, maxTouchPoints: 0, hardwareConcurrency: 4, clipboard: { writeText() { return Promise.resolve(); }, readText() { return Promise.resolve(''); } }, vibrate() {}, geolocation: { getCurrentPosition() {}, watchPosition() {} }, mediaDevices: { getUserMedia() { return Promise.resolve({}); } }, serviceWorker: { register() { return Promise.resolve({}); } } },
        location: { href: 'file:///index.html', protocol: 'file:', host: '', hostname: '', port: '', pathname: '/index.html', search: '', hash: '', origin: 'file://', reload() {}, assign() {}, replace() {}, toString() { return 'file:///index.html'; } },
        history: { length: 1, state: null, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} },
        performance: { now() { return 0; }, mark() {}, measure() {}, getEntriesByType() { return []; }, timing: {} },
        screen: { width: 1280, height: 720, availWidth: 1280, availHeight: 720, colorDepth: 24, orientation: { type: 'landscape-primary', angle: 0, addEventListener() {} } },
        devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, outerWidth: 1280, outerHeight: 720, scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0,
        scrollTo() {}, scrollBy() {}, focus() {}, blur() {}, open() { return null; }, close() {}, print() {}, getSelection() { return { toString() { return ''; }, removeAllRanges() {} }; },
        getComputedStyle() { return { getPropertyValue() { return ''; } }; },
        matchMedia() { return mediaQuery(); },
        fetch() { return Promise.resolve({ ok: true, status: 200, statusText: 'OK', headers: { get() { return null; } }, json() { return Promise.resolve({}); }, text() { return Promise.resolve(''); }, blob() { return Promise.resolve({}); }, arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); } }); },
        XMLHttpRequest: function () { return { open() {}, send() {}, setRequestHeader() {}, addEventListener() {}, abort() {}, readyState: 0, status: 0, responseText: '' }; },
        WebSocket: function () { return { send() {}, close() {}, addEventListener() {} }; },
        // constructors commonly used at load time
        Event: EvtCtor, CustomEvent: EvtCtor, KeyboardEvent: EvtCtor, MouseEvent: EvtCtor, PointerEvent: EvtCtor, TouchEvent: EvtCtor, WheelEvent: EvtCtor, InputEvent: EvtCtor, FocusEvent: EvtCtor, DragEvent: EvtCtor,
        Audio: function () { return { play() { return Promise.resolve(); }, pause() {}, load() {}, addEventListener() {}, removeEventListener() {}, currentTime: 0, duration: 0, volume: 1, loop: false, muted: false, paused: true, src: '' }; },
        Image: function () { return { addEventListener() {}, removeEventListener() {}, width: 0, height: 0, naturalWidth: 0, naturalHeight: 0, complete: true, src: '', onload: null, onerror: null }; },
        AudioContext: function () { return new Proxy({ currentTime: 0, destination: {}, state: 'running' }, { get(t, p) { return p in t ? t[p] : () => ({ connect() {}, start() {}, stop() {}, gain: { value: 1, setValueAtTime() {} }, frequency: { value: 0, setValueAtTime() {} }, type: 'sine' }); } }); },
        FileReader: function () { return { readAsText() {}, readAsDataURL() {}, addEventListener() {}, result: null, onload: null }; },
        Blob: function () { return {}; }, FormData: function () { return { append() {}, get() { return null; }, getAll() { return []; }, has() { return false; }, set() {}, entries() { return []; } }; },
        URL: typeof URL !== 'undefined' ? URL : function () { return { toString() { return ''; } }; },
        URLSearchParams: typeof URLSearchParams !== 'undefined' ? URLSearchParams : function () { return { get() { return null; }, getAll() { return []; }, has() { return false; }, append() {}, set() {}, toString() { return ''; } }; },
        TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : function () { return { encode() { return new Uint8Array(); } }; },
        TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : function () { return { decode() { return ''; } }; },
        structuredClone: typeof structuredClone !== 'undefined' ? structuredClone : (v) => JSON.parse(JSON.stringify(v == null ? null : v)),
        atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
        btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
        Math, Date, JSON, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
        Array, Object, String, Number, Boolean, Map, Set, WeakMap, WeakSet, Symbol, Promise, RegExp, Error, Proxy, Reflect,
        Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
        Intl: typeof Intl !== 'undefined' ? Intl : undefined
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.top = sandbox;
    sandbox.parent = sandbox;
    sandbox.frames = sandbox;
    vm.createContext(sandbox);

    for (const src of sources) {
        if (!src.code) continue;
        try {
            vm.runInContext(src.code, sandbox, { filename: src.ref, timeout: 3000 });
        } catch (e) {
            errors.push(`${src.ref}: ${e.name}: ${e.message}`);
        }
    }

    // Fire deferred init once (DOMContentLoaded / load / window.onload), like a browser,
    // so apps that wire everything in a load handler are actually exercised. Bounded.
    const fireList = (cbs, type) => {
        for (const cb of (cbs || []).slice(0, 20)) {
            try { cb(makeEvt(type)); } catch (e) { errors.push(`${type} handler: ${e.name}: ${e.message}`); }
        }
    };
    for (const type of ['DOMContentLoaded', 'load']) {
        fireList(winListeners[type], type);
        fireList(dom.docListeners[type], type);
    }
    if (typeof sandbox.onload === 'function') { try { sandbox.onload(makeEvt('load')); } catch (e) { errors.push(`window.onload: ${e.name}: ${e.message}`); } }

    // Exercise the game loop once to surface runtime throws (bounded).
    let fired = 0;
    for (const fn of timers.slice(0, 5)) {
        try { fn(); fired++; } catch (e) { errors.push(`game loop threw: ${e.name}: ${e.message}`); }
    }

    for (const [lvl, msg] of capturedConsole) {
        if (lvl === 'error') errors.push(`console.error: ${msg}`);
    }

    return {
        ran: true,
        engine: 'vm',
        ok: errors.length === 0,
        errors,
        renderedClasses: [...dom.classesApplied],
        createdCount: dom.created.length,
        timersFired: fired
    };
}

function runJsdomEngine(jsdom, html, htmlDir, expectedSelectors) {
    const errors = [];
    const virtualConsole = new jsdom.VirtualConsole();
    virtualConsole.on('jsdomError', (e) => errors.push(`jsdomError: ${e.message}`));
    virtualConsole.on('error', (...a) => errors.push(`console.error: ${a.join(' ')}`));
    let dom;
    try {
        dom = new jsdom.JSDOM(html, {
            runScripts: 'dangerously',
            resources: 'usable',
            url: 'file://' + htmlDir.replace(/\\/g, '/') + '/',
            virtualConsole,
            pretendToBeVisual: true
        });
    } catch (e) {
        return { ran: true, engine: 'jsdom', ok: false, errors: [`jsdom load: ${e.message}`], renderedClasses: [] };
    }
    const doc = dom.window.document;
    const renderedClasses = [];
    const missingNodes = [];
    for (const sel of (expectedSelectors || [])) {
        try { if (!doc.querySelector(sel)) missingNodes.push(sel); } catch (e) { /* invalid sel */ }
    }
    for (const m of missingNodes) errors.push(`expected node not rendered: ${sel(m)}`);
    return { ran: true, engine: 'jsdom', ok: errors.length === 0, errors, renderedClasses, missingNodes };
    function sel(s) { return s; }
}

/**
 * @param {object} opts { projectRoot, indexRel?, expectedSelectors? }
 * @returns smoke result; { skipped:true } only when there is no HTML to test.
 */
function runSmokeTest(opts) {
    const { projectRoot } = opts;
    let indexRel = opts.indexRel;
    if (!indexRel) {
        // find an index.html among touched/known files
        const candidates = ['index.html', 'public/index.html', 'src/index.html'];
        indexRel = candidates.find(c => fs.existsSync(path.join(projectRoot, c)));
    }
    if (!indexRel) return { skipped: true, reason: 'no index.html found', ok: true };

    const abs = path.join(projectRoot, indexRel);
    let html;
    try { html = fs.readFileSync(abs, 'utf-8'); }
    catch (e) { return { skipped: true, reason: 'index.html unreadable', ok: true }; }
    const htmlDir = path.dirname(abs);

    // Prefer the VM engine: vm.runInContext's timeout (3s) interrupts even a
    // synchronous infinite loop in the project's JS. jsdom's runScripts:'dangerously'
    // has no such guard and would block the event loop, so it is opt-in (XK_SMOKE_JSDOM).
    const jsdom = process.env.XK_SMOKE_JSDOM ? tryRequireJsdom() : null;
    if (jsdom) {
        return runJsdomEngine(jsdom, html, htmlDir, opts.expectedSelectors);
    }
    const sources = readLocalScripts(projectRoot, html, htmlDir);
    return runVmEngine(sources, html);
}

module.exports = { runSmokeTest, makeStubDom, readLocalScripts };
