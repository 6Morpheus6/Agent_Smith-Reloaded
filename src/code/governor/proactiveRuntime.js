'use strict';

// Proactive mid-build runtime verification. The completion gate verifies the app in a real
// browser, but only fires when the model declares "done" — and local models often grind to a
// turn/no-write limit without ever declaring done, so they never receive the runtime feedback.
//
// This runs the same real-browser check DURING the build: once the web project is structurally
// complete (index.html exists and every script it references is on disk), and its content has
// changed since the last check, load it and — if it throws — inject the exact errors as a nudge
// so the model fixes them in-flight. Throttled by a content signature and capped to avoid loops.

const fs = require('fs');
const path = require('path');
const wv = require('./webValidators.js');
const { normalizeWebProject } = require('./webModuleNormalize.js');

const MAX_CHECKS = Number(process.env.XK_CODE_MAX_RUNTIME_CHECKS) || 6;
const IGNORE_DIR = /(^|\/)(node_modules|\.git|\.agentsmith|release|dist)(\/|$)/;

/** Find an index.html: prefer a touched one, else scan root + immediate subdirs. */
function findIndexHtml(projectRoot, filesTouched) {
    for (const f of filesTouched || []) {
        if (/(^|\/)index\.html$/i.test(f) && !IGNORE_DIR.test(f) &&
            fs.existsSync(path.join(projectRoot, f))) return f.split(path.sep).join('/');
    }
    try {
        if (fs.existsSync(path.join(projectRoot, 'index.html'))) return 'index.html';
        for (const e of fs.readdirSync(projectRoot, { withFileTypes: true })) {
            if (e.isDirectory() && !IGNORE_DIR.test(e.name) &&
                fs.existsSync(path.join(projectRoot, e.name, 'index.html'))) return e.name + '/index.html';
        }
    } catch (e) { /* ignore */ }
    return null;
}

/** Local script files index.html references, resolved to absolute paths. */
function referencedScripts(htmlAbs) {
    const html = fs.readFileSync(htmlAbs, 'utf8');
    const dir = path.dirname(htmlAbs);
    const out = [];
    for (const ref of wv.extractHtmlRefs(html).scripts || []) {
        if (/^https?:/i.test(ref)) continue;
        out.push(path.resolve(dir, ref.replace(/^\.\//, '')));
    }
    return out;
}

/** A change signature over a set of files (size + mtime). */
function signatureOf(absPaths) {
    return absPaths.map(p => {
        try { const s = fs.statSync(p); return `${p}:${s.size}:${Math.round(s.mtimeMs)}`; }
        catch (e) { return `${p}:0`; }
    }).join('|');
}

/**
 * Run a proactive runtime check if warranted, and inject a fix-it nudge on failure.
 * Mutates session.messages / session.phase. Safe to call after every tool batch.
 */
async function maybeProactiveRuntimeCheck(session, execDeps, emit) {
    try {
        if (process.env.XK_CODE_NO_RUNTIME_VERIFY === '1') return;
        if (typeof (execDeps && execDeps.runtimeVerify) !== 'function') return;
        const projectRoot = session.projectRoot;
        const htmlRel = findIndexHtml(projectRoot, session.filesTouched);
        if (!htmlRel) return;
        const htmlAbs = path.join(projectRoot, htmlRel);

        const scripts = referencedScripts(htmlAbs);
        if (!scripts.length) return;                       // nothing to run yet
        if (scripts.some(p => !fs.existsSync(p))) return;  // not structurally complete — missingRefGuard owns this

        const st = session._rtState || (session._rtState = { lastSig: null, checks: 0 });
        const sig = signatureOf([htmlAbs, ...scripts]);
        if (sig === st.lastSig) return;                    // unchanged since last check
        if (st.checks >= MAX_CHECKS) return;               // cap to avoid loops
        st.lastSig = sig;
        st.checks++;

        // Auto-fix wiring first, then load it for real.
        try { await normalizeWebProject(projectRoot, htmlRel, { changeLedger: execDeps && execDeps.changeLedger, sessionId: session.id }); } catch (e) { /* non-fatal */ }
        const rt = await execDeps.runtimeVerify(projectRoot, htmlRel);
        if (!rt || rt.skipped || rt.ok) {
            emit({ type: 'runtime_check', ok: true, turn: session.turn });
            return;
        }

        const errs = (rt.errors || []).slice(0, 6);
        emit({ type: 'runtime_check', ok: false, errors: errs, turn: session.turn });
        session.messages.push({
            role: 'user',
            content:
                'BROWSER RUNTIME CHECK FAILED. The app was just loaded in a real browser and threw '
                + 'these errors:\n' + errs.map(e => '  • ' + e).join('\n')
                + '\n\nFix the ROOT CAUSE of each error in the code now: read the relevant file(s) and '
                + 'correct mismatched import/export names, undefined variables/functions, wrong element '
                + 'ids, or missing assignments. Then keep going. The build is NOT done until the page '
                + 'loads with zero errors.'
        });
        session.phase = 'implement';
    } catch (e) { /* never let verification break the run */ }
}

module.exports = { maybeProactiveRuntimeCheck, findIndexHtml, referencedScripts, signatureOf };
