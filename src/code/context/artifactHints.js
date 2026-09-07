/**
 * Hints for "create new app/game in an existing repo" — avoid editing the host app's index.html.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { collectBadRefsFromHtml, buildRepairPlanLines, htmlRelForRefs } = require('../governor/repairPlan.js');

/** Task asks for a new deliverable (game, site, app) rather than editing the host project. */
function goalImpliesNewArtifacts(goal) {
    const t = String(goal || '').toLowerCase();
    if (!/\b(create|build|scaffold|make|write|develop)\b/.test(t)) return false;
    return /\b(game|app|website|web[\s-]?based|web[\s-]?app|pac-?man|site|page|demo|preview|tracker|todo|dashboard|kanban|calculator|planner|budget)\b/.test(t);
}

function suggestArtifactSubdir(goal) {
    const t = String(goal || '').toLowerCase();
    if (/pac-?man/.test(t)) return 'pacman';
    if (/\bgame\b/.test(t)) return 'game';
    if (/\b(site|website|page)\b/.test(t)) return 'site';
    return 'app';
}

/** Workspace looks like Electron / desktop host (not a static web game root). */
function detectAppRepo(projectRoot) {
    try {
        const pkgPath = path.join(projectRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            if (deps.electron) return true;
            if (pkg.main && /main\.js|electron/i.test(String(pkg.main))) return true;
        }
        if (fs.existsSync(path.join(projectRoot, 'main.js'))
            && fs.existsSync(path.join(projectRoot, 'index.html'))) {
            return true;
        }
    } catch (e) { /* non-fatal */ }
    return false;
}

function goalWantsPreview(goal) {
    return /\b(show|open|display|launch)\b.*\bpreview\b|\bpreview\b/i.test(String(goal || ''));
}

/** Bootstrap / gate nudge when building a new web deliverable. Model chooses the layout. */
function buildNewArtifactBlock(goal, projectRoot) {
    if (!goalImpliesNewArtifacts(goal)) return '';
    const isAppRepo = detectAppRepo(projectRoot);
    const lines = ['', '[NEW DELIVERABLE]'];
    if (isAppRepo) {
        lines.push(
            'This workspace is an existing app/Electron repo — the root index.html belongs to the host app; do NOT edit it.',
            'Create your deliverable as self-contained files in a NEW subfolder of your choice (name it for the task).'
        );
    } else {
        lines.push(
            'Create the files your task needs as SEPARATE FILES — for a static web app that is an index.html plus its own style.css and script.js (plus any extra modules you need). Do NOT inline all CSS/JS into one giant HTML file; separate files are easier to patch, diff and verify.'
        );
    }
    lines.push(
        'Link CSS/JS from the HTML with paths relative to the HTML (same-folder files link as href="style.css" / src="script.js"). '
            + 'CSS class names must match JS classList usage; use backticks for JS template literals.'
    );
    if (goalWantsPreview(goal)) {
        lines.push('After the files exist and load cleanly, call show_preview on your index.html.');
    }
    lines.push('Start with write_file now.');
    return lines.join('\n');
}

/** True only when the goal is actually a game (so game-specific hints stay scoped). */
function goalIsGame(goal) {
    return /\b(game|pac-?man|snake|tetris|breakout|pong|arcade|maze|invaders|flappy|platformer|playable)\b/i.test(String(goal || ''));
}

/** Urgent system nudge after the completion gate blocks with zero writes. */
function buildWriteNudge(goal, projectRoot) {
    const preview = goalWantsPreview(goal) ? ' Then call show_preview on your index.html.' : '';
    const jsDesc = goalIsGame(goal)
        ? 'the complete game (state, input, loop, win/lose)'
        : 'the complete app logic (state, event handlers, rendering, and persistence if the task needs it)';
    const where = detectAppRepo(projectRoot)
        ? 'Put them in a NEW subfolder of your choice — do NOT touch the host root index.html.'
        : 'Use whatever paths fit the task.';
    return [
        '[HARNESS — WRITE REQUIRED]',
        'You stopped without creating any files. Respond with write_file tool calls ONLY (no prose).',
        `Create the files your task needs — for a static web app that is an index.html plus the CSS and JS it links (${jsDesc}). ${where}`,
        'Link each asset from the HTML with a relative path, and create every linked file before stopping.' + preview
    ].join('\n');
}

/** Urgent nudge when HTML exists but linked CSS/JS files are missing. */
function buildMissingRefsNudge(missingRefs, goal, projectRoot) {
    const refs = [...new Set((missingRefs || []).filter(Boolean))].map(r => String(r).replace(/\\/g, '/'));
    if (!refs.length) return '';
    const dir = path.posix.dirname(refs[0]);
    const dirHint = dir && dir !== '.' ? `${dir}/` : '';
    // Existing-but-broken linked files (e.g. a .css that contains HTML) need FIX, not CREATE.
    const bad = projectRoot ? collectBadRefsFromHtml(projectRoot, htmlRelForRefs(refs)) : [];
    const planLines = buildRepairPlanLines(refs, bad);
    const preview = goalWantsPreview(goal) ? `\nAfter every file exists and the page loads with no errors: show_preview path="${dirHint}index.html".` : '';
    const gameHint = goalIsGame(goal)
        ? '\nFor a game .js: include keyboard input, score updates, a game loop, and win/lose logic.'
        : '';
    return [
        '[HARNESS — REPAIR, DO NOT RESTART]',
        'index.html is already correct — do NOT rewrite any .html file. Build/fix the files it links so the page works. '
            + 'You MAY emit several write_file/patch calls in THIS one turn:',
        ...planLines,
        // The common failure is putting the file in a different folder or under a bare
        // name. The referenced files must be siblings of the HTML that links them.
        `Write each at EXACTLY its path${dirHint ? ` (same folder \`${dirHint}\` as the HTML)` : ''} with COMPLETE working code — `
            + 'no placeholders or stubs, never a bare filename or another directory, and never HTML inside a .js/.css file.'
            + gameHint,
        'Respond with tool calls only — no prose.',
        preview
    ].filter(Boolean).join('\n');
}

/**
 * One-shot nudge when a web build is landing as ONE giant index.html (inline CSS + JS).
 * Multi-file builds are the target: easier to patch, diff, revert and verify per file.
 * Never blocks — if the model keeps inlining, plan auto-advance still accepts it (v52.4).
 */
function buildMultiFileNudge(goal) {
    return [
        '[HARNESS — MULTI-FILE BUILD]',
        'You are writing everything into index.html. Split the app into separate files instead:',
        '  - index.html  → markup only, plus <link rel="stylesheet" href="style.css"> and <script src="script.js"></script>',
        '  - style.css   → ALL of your CSS (move it out of any inline <style> block)',
        '  - script.js   → ALL of your JavaScript (move it out of any inline <script> block)',
        'Use write_file for each file — you MAY emit all three in this one turn. Keep the HTML ids/classes identical to what the CSS and JS use.',
        goalWantsPreview(goal) ? 'After the files exist, call show_preview on index.html.' : ''
    ].filter(Boolean).join('\n');
}

/** After harness recovery — keep the run going (preview / verify), do not treat as done. */
function buildContinueAfterRecoveryNudge(goal, htmlRel, previewOpened) {
    const noun = goalIsGame(goal) ? 'game' : 'app';
    const lines = [
        '[CONTINUE — run still active]',
        'Recovery finished. Do not stop or replan from scratch.',
        'Do NOT rewrite existing files unless fixing a validation error.'
    ];
    if (goalWantsPreview(goal) && !previewOpened && htmlRel) {
        lines.push(`NEXT (one tool call): show_preview kind=project_file target="${htmlRel}"`);
    } else if (goalWantsPreview(goal)) {
        lines.push(`Preview was opened. Reply briefly that the ${noun} is ready.`);
    } else {
        lines.push(`Reply briefly that the ${noun} is ready — no further writes needed.`);
    }
    return lines.join('\n');
}

module.exports = {
    goalImpliesNewArtifacts,
    goalIsGame,
    suggestArtifactSubdir,
    detectAppRepo,
    goalWantsPreview,
    buildNewArtifactBlock,
    buildWriteNudge,
    buildMissingRefsNudge,
    buildMultiFileNudge,
    buildContinueAfterRecoveryNudge
};
