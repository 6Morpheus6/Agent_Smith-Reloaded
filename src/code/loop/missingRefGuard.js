/**
 * Block HTML rewrites while linked JS/CSS files from the completion gate are still missing.
 * Weak models loop on index.html instead of creating pacman/script.js, etc.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const wv = require('../governor/webValidators.js');
const { collectBadRefsFromHtml, buildRepairPlanLines } = require('../governor/repairPlan.js');

function normRel(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function pickNextMissing(pending) {
    const list = [...(pending || [])].filter(Boolean);
    if (!list.length) return null;
    return list.find(p => /\.(js|mjs|cjs)$/i.test(p))
        || list.find(p => /\.css$/i.test(p))
        || list[0];
}

function isHtmlPath(rel) {
    return /\.html?$/i.test(String(rel || ''));
}

function isAssetPath(rel) {
    return /\.(js|mjs|cjs|css)$/i.test(String(rel || ''));
}

/** Disk-accurate missing href/src siblings for an HTML file (project-root-relative paths). */
function collectMissingRefsFromHtml(projectRoot, htmlRelPath) {
    if (!projectRoot || !htmlRelPath) return [];
    const htmlAbs = path.join(projectRoot, htmlRelPath);
    let html = '';
    try { html = fs.readFileSync(htmlAbs, 'utf8'); } catch (e) { return []; }
    const htmlDir = path.dirname(htmlAbs);
    const { scripts, styles } = wv.extractHtmlRefs(html);
    const missing = [];
    for (const ref of [...scripts, ...styles]) {
        if (/^https?:\/\//i.test(ref)) continue;
        const refAbs = path.resolve(htmlDir, ref.replace(/^\.\//, ''));
        if (!fs.existsSync(refAbs)) {
            missing.push(path.relative(projectRoot, refAbs).split(path.sep).join('/'));
        }
    }
    return [...new Set(missing)];
}

const SCAN_IGNORE = new Set(['node_modules', 'dist', 'build', '.git', '.agentsmith', 'release', 'coverage', '.cache']);

/**
 * The DELIVERABLE index.html (disk truth), host-aware: prefer one the model wrote this run, and
 * in an Electron/app host repo never treat the host's ROOT index.html as the deliverable — only
 * a subfolder index counts. Mirrors the completion gate's detectAppRepo guard.
 */
function findDeliverableIndexHtml(projectRoot, filesTouched) {
    const touched = (filesTouched || []).find(f => /(^|\/)index\.html$/i.test(String(f)));
    if (touched && fs.existsSync(path.join(projectRoot, touched))) {
        return String(touched).replace(/\\/g, '/');
    }
    const { detectAppRepo } = require('../context/artifactHints.js');
    if (!detectAppRepo(projectRoot)) {
        const { findProjectIndexHtml } = require('../governor/completionGate.js');
        return findProjectIndexHtml(projectRoot); // non-host repo: root-first is fine
    }
    // Host repo: the root index.html belongs to the host app — only a subfolder index is ours.
    try {
        for (const e of fs.readdirSync(projectRoot, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name.startsWith('.') || SCAN_IGNORE.has(e.name)) continue;
            if (fs.existsSync(path.join(projectRoot, e.name, 'index.html'))) return `${e.name}/index.html`;
        }
    } catch (e) { /* ignore */ }
    return null;
}

/** Seed pending refs when HTML already exists on disk (brownfield / resumed runs). */
function seedPendingMissingRefs(session, goal) {
    if (!session?.projectRoot) return [];
    const { goalImpliesNewArtifacts } = require('../context/artifactHints.js');
    if (!goalImpliesNewArtifacts(goal || session.goal)) return [];
    // Disk truth, host-aware: the deliverable index.html — never the host root in an app repo.
    // If none exists yet, seed nothing — syncPendingAfterHtmlWrite picks it up on the HTML write.
    const htmlRel = findDeliverableIndexHtml(session.projectRoot, session.filesTouched);
    if (!htmlRel) return [];
    const missing = collectMissingRefsFromHtml(session.projectRoot, htmlRel);
    if (missing.length) {
        session.pendingMissingRefs = missing;
    }
    return missing;
}

/** After an HTML write, refresh pending missing refs immediately (don't wait for gate). */
function syncPendingAfterHtmlWrite(session, htmlRelPath) {
    if (!session?.projectRoot || !htmlRelPath || !isHtmlPath(htmlRelPath)) return [];
    const missing = collectMissingRefsFromHtml(session.projectRoot, htmlRelPath);
    if (missing.length) {
        session.pendingMissingRefs = missing;
        session._injectMissingRefsNudge = true;
    } else {
        delete session.pendingMissingRefs;
    }
    return missing;
}

/**
 * @returns {{ error: string, blockedReason: string } | null}
 */
function checkMissingRefRead(session, toolName, args) {
    if (toolName !== 'read_file') return null;
    const pending = session?.pendingMissingRefs;
    if (!Array.isArray(pending) || !pending.length) return null;
    const target = normRel(args?.path);
    if (!target) return null;
    const pendingNorm = pending.map(normRel);
    if (!pendingNorm.includes(target)) return null;
    const next = pickNextMissing(pending);
    return {
        error: [
            `BLOCKED: "${args.path}" does not exist yet — do not read missing files.`,
            `Your NEXT tool call MUST be: write_file path="${next}" with COMPLETE file content.`
        ].join(' '),
        blockedReason: 'read_missing_ref'
    };
}

/**
 * @returns {{ error: string, blockedReason: string } | null}
 */
function checkPrematurePreview(session, toolName, args) {
    if (toolName !== 'show_preview') return null;
    const pending = session?.pendingMissingRefs;
    if (Array.isArray(pending) && pending.length) {
        const next = pickNextMissing(pending);
        return {
            error: [
                'BLOCKED: Preview not ready — linked files are still missing.',
                `Create files first. NEXT: write_file path="${next}" with COMPLETE content.`,
                'Do not call show_preview again until validation passes.'
            ].join(' '),
            blockedReason: 'preview_before_refs_exist'
        };
    }
    const target = String(args?.target || args?.path || '').replace(/^\.\//, '');
    if (!target || !session?.projectRoot) return null;
    if (!/\.html?$/i.test(target)) return null;
    const missing = collectMissingRefsFromHtml(session.projectRoot, target);
    if (missing.length) {
        session.pendingMissingRefs = missing;
        session._injectMissingRefsNudge = true;
        const next = pickNextMissing(missing);
        return {
            error: [
                `BLOCKED: "${target}" is not ready to preview — missing on disk: ${missing.join(', ')}.`,
                `NEXT: write_file path="${next}" with COMPLETE content.`
            ].join(' '),
            blockedReason: 'preview_with_missing_refs'
        };
    }
    return null;
}

/**
 * @returns {{ error: string, blockedReason: string } | null}
 */
function checkMissingRefWrite(session, toolName, args) {
    if (toolName !== 'write_file' && toolName !== 'append_file' && toolName !== 'patch') return null;
    const pending = session?.pendingMissingRefs;
    if (!Array.isArray(pending) || !pending.length) return null;

    const target = normRel(args?.path);
    if (!target) return null;

    const pendingNorm = pending.map(normRel);
    const pendingSet = new Set(pendingNorm);
    const next = pickNextMissing(pending);

    // Already writing the file the gate asked for — allow.
    if (pendingSet.has(target)) return null;

    const assetStillMissing = pendingNorm.some(isAssetPath);

    // Block rewriting HTML while script/style siblings are missing — but hand back a STRUCTURED
    // repair plan (create the missing files, fix any existing-but-broken ones) instead of forcing
    // one exact path, and arm the next-turn "repair, do not restart" nudge so the model doesn't
    // loop on index.html.
    if (assetStillMissing && isHtmlPath(target)) {
        session._injectMissingRefsNudge = true;
        const bad = collectBadRefsFromHtml(session.projectRoot, args.path);
        if (bad.length) session.pendingBadRefs = bad;
        const planLines = buildRepairPlanLines(pending, bad);
        return {
            error: [
                `BLOCKED: "${args.path}" is already correct — rewriting it will not fix anything and only wastes this turn.`,
                'REPAIR PLAN — do these, do NOT rewrite the HTML again:',
                ...planLines,
                'You MAY create/fix several files in THIS one turn (one file per call) at each EXACT path. '
                    + 'Use write_file for new files and patch (or write_file) to repair existing ones. '
                    + 'Put ONLY the correct content for each type — never HTML inside a .js or .css file.'
            ].join('\n'),
            blockedReason: 'html_rewrite_while_refs_missing'
        };
    }

    // Block writing bare script.js when gate needs pacman/script.js.
    for (const needed of pendingNorm) {
        const base = path.basename(needed);
        if (target !== needed && target.endsWith('/' + base) === false && path.basename(target) === base) {
            const orig = pending[pendingNorm.indexOf(needed)] || needed;
            return {
                error: `BLOCKED: wrong path "${args.path}". Create "${orig}" (full path from project root, as linked in index.html).`,
                blockedReason: 'wrong_path_for_missing_ref'
            };
        }
        if (target === base && needed.includes('/')) {
            const orig = pending[pendingNorm.indexOf(needed)] || needed;
            return {
                error: `BLOCKED: path "${args.path}" is too short. Create "${orig}" not "${base}" at project root.`,
                blockedReason: 'wrong_path_for_missing_ref'
            };
        }
    }

    // Block HTML content typed into a .js/.css path (common model mistake).
    if (isAssetPath(target)) {
        const content = String(args?.content || args?.replace || '');
        if (/<(?:!doctype|html|head|body)\b/i.test(content)) {
            return {
                error: `BLOCKED: content looks like HTML but path is "${args.path}". Use write_file path="${next}" with JavaScript or CSS only.`,
                blockedReason: 'html_content_on_asset_path'
            };
        }
    }

    return null;
}

function clearPendingIfCreated(session, relPath) {
    if (!session?.pendingMissingRefs?.length || !relPath) return;
    const written = normRel(relPath);
    session.pendingMissingRefs = session.pendingMissingRefs.filter(p => normRel(p) !== written);
    if (!session.pendingMissingRefs.length) {
        delete session.pendingMissingRefs;
    } else {
        // Assets are STILL missing after this write. Re-arm the high-priority repair nudge so
        // the next turn is told to create the remaining file(s) — otherwise the model drifts
        // back to rewriting the HTML (and only then hits the block). Keeps recovery proactive.
        session._injectMissingRefsNudge = true;
    }
}

module.exports = {
    normRel,
    pickNextMissing,
    collectMissingRefsFromHtml,
    findDeliverableIndexHtml,
    seedPendingMissingRefs,
    syncPendingAfterHtmlWrite,
    checkMissingRefRead,
    checkPrematurePreview,
    checkMissingRefWrite,
    clearPendingIfCreated
};
