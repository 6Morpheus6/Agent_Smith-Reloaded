/**
 * Task-specific acceptance checks. For a "game" request the harness must see PROOF
 * of the moving parts — not just that files parse. Static analysis over the combined
 * HTML + JS source. Pure; no DOM, no filesystem.
 *
 * These are deliberately permissive in HOW (any keydown handler counts as input) but
 * strict in WHETHER the capability exists at all. A weak model that ships a title +
 * score and nothing else will fail here.
 */
'use strict';

// Interactive/stateful app keywords — these get FUNCTIONAL acceptance like games do.
// Conservative on purpose: strong app signals only, never bare "page"/"site" (which may be
// a legitimate static page that should not be force-failed).
const CRUD_APP_RE = /\b(to-?do|todo\s*list|task\s*(?:list|manager|app)|kanban|tracker|budget|expense|calculator|notes?\s*app|note-taking|dashboard|shopping\s*list|grocery\s*list|reading\s*list|cart|checkout|inventory|crud\b|contact\s*form|sign[\s-]?up\s*form|reminder\s*app|habit\s*tracker|playlist\s*app|timer\s*app|stopwatch)\b/;
// Goals that manage a COLLECTION of items -> require list/state mutation.
const COLLECTION_RE = /\b(to-?do|task|kanban|tracker|budget|expense|notes?|cart|inventory|list|item|playlist|reminder|habit|transaction)\b/;
// Goals that ask to SAVE/PERSIST -> require localStorage/sessionStorage.
const PERSIST_RE = /\b(save|saved|persist|persistent|store\b|storage|localstorage|sessionstorage|remember|keep\s+track|don'?t\s+lose)\b/;

function classifyTask(goal) {
    const g = String(goal || '').toLowerCase();
    const isGame = /\b(game|pac-?man|snake|tetris|breakout|pong|platformer|arcade|maze|invaders|flappy|2048|minesweeper|playable|play)\b/.test(g);
    const isWeb = isGame || /\b(web|html|css|page|site|website|browser|frontend|front-end|webpage)\b/.test(g);
    const isCrudApp = !isGame && CRUD_APP_RE.test(g);
    return { isGame, isWeb, isCrudApp };
}

/**
 * Functional acceptance for non-game interactive web apps. Always require that the app
 * responds to input AND updates the DOM (distinguishes a working app from a static shell).
 * Require collection state-mutation and persistence ONLY when the goal clearly implies them,
 * so a calculator or simple form is not force-failed for lacking a list/localStorage.
 */
function webAppAcceptanceChecks({ html, js }, goal) {
    const J = String(js || '');
    const g = String(goal || '').toLowerCase();
    const hasJs = (re) => re.test(J);
    const checks = [];
    const add = (id, label, present, detail) => checks.push({ id, label, required: true, present: !!present, detail: detail || '' });

    add('interactivity', 'responds to user input',
        hasJs(/addEventListener\s*\(\s*['"](click|submit|input|change|keydown|keyup|keypress|pointerdown|touchstart|dblclick)['"]/i) ||
        hasJs(/\.on(click|submit|input|change|keydown|keyup)\s*=/i) ||
        hasJs(/\bon(click|submit|input|change)\s*=/i),
        'click/submit/input/keyboard listener');

    add('dynamic-dom', 'renders/updates the DOM from JS',
        hasJs(/\.(innerHTML|textContent|innerText|value)\s*=/i) ||
        hasJs(/\.(appendChild|append|prepend|insertAdjacentHTML|replaceChildren|remove)\s*\(/i) ||
        hasJs(/createElement\s*\(/i),
        'DOM created/updated in JS');

    if (COLLECTION_RE.test(g)) {
        add('state', 'manages a list of items (add/remove)',
            hasJs(/\.(push|splice|unshift|pop|shift)\s*\(/) ||
            hasJs(/\b\w+\s*=\s*\w+\.(filter|map|concat|slice)\s*\(/) ||
            hasJs(/\b\w+\[[^\]]+\]\s*=\s*[^=]/),
            'array/collection mutated (add/edit/delete)');
    }

    if (PERSIST_RE.test(g)) {
        add('persistence', 'saves & loads state',
            hasJs(/(local|session)Storage\s*\.\s*(setItem|getItem)/i) ||
            hasJs(/(local|session)Storage\s*\[/i),
            'localStorage/sessionStorage read+write');
    }

    return checks;
}

/**
 * @param {object} src { html, js } concatenated source strings for the project.
 * @returns {Array<{id,label,required,present,detail}>}
 */
function gameAcceptanceChecks({ html, js }) {
    const H = String(html || '');
    const J = String(js || '');
    const all = H + '\n' + J;

    const has = (re) => re.test(all);
    const hasJs = (re) => re.test(J);

    const checks = [];
    const add = (id, label, present, required, detail) => checks.push({ id, label, required: !!required, present: !!present, detail: detail || '' });

    // REQUIRED (universal across game types — only these BLOCK). They distinguish a real,
    // interactive build from a static title screen, without assuming a specific genre:
    //   1) it responds to input, and 2) it changes the screen (DOM, canvas, or a loop).
    add('input', 'responds to input',
        hasJs(/addEventListener\s*\(\s*['"](keydown|keyup|keypress|click|dblclick|mousedown|mouseup|mousemove|pointerdown|pointermove|pointerup|touchstart|touchmove|wheel)['"]/i) ||
        hasJs(/\b(?:window|document|canvas|body)?\.?on(keydown|keyup|keypress|click|mousedown|mousemove|pointerdown|touchstart)\s*=/i),
        true, 'keyboard/mouse/touch listener');

    add('dynamic', 'changes the screen (DOM / canvas / loop)',
        hasJs(/\.(innerHTML|textContent|innerText|value)\s*=/i) ||
        hasJs(/\.(appendChild|append|prepend|insertAdjacentHTML|replaceChildren|removeChild|remove|setAttribute|insertBefore)\s*\(/i) ||
        hasJs(/createElement\s*\(/i) ||
        hasJs(/\.style\b|\.classList\b/i) ||
        hasJs(/getContext\s*\(|\b(fillRect|clearRect|strokeRect|fillText|drawImage|beginPath|arc|lineTo|moveTo|putImageData)\s*\(/i) ||
        hasJs(/\b(setInterval|requestAnimationFrame|setTimeout)\s*\(/),
        true, 'DOM/canvas/loop drives visible change');

    // DIAGNOSTIC ONLY (not required) — common patterns, surfaced for context but never blocking,
    // because plenty of valid games lack a "player" element, a score, or an explicit end state.
    add('game-area', 'visible game area',
        /<canvas[\s>]/i.test(H) ||
        /id=["'][^"']*(board|game|maze|grid|canvas|stage|arena|playfield)[^"']*["']/i.test(H) ||
        /class=["'][^"']*(board|game|maze|grid|canvas|stage|arena|playfield)[^"']*["']/i.test(H) ||
        /getElementById\(['"][^'"]*(board|game|maze|grid|canvas|stage)[^'"]*['"]\)/i.test(J),
        false, 'board/canvas/maze container');

    add('player', 'player element',
        has(/\b(pacman|pac-?man|player|hero|paddle|snake|ship|bird|character|avatar)\b/i),
        false, 'player class/element present');

    const scoreMutated = hasJs(/\bscore\b\s*(\+\+|--|\+=|-=|=)/i) || hasJs(/\bscore\s*=\s*score\b/i);
    const scoreShown = hasJs(/score[A-Za-z]*\.(textContent|innerText|innerHTML)\s*=/i) ||
        hasJs(/\.(textContent|innerText|innerHTML)\s*=\s*[`'"][^`'"]*\$?\{?\s*score/i) ||
        /id=["'][^"']*score[^"']*["']/i.test(H);
    add('score', 'score updates', scoreMutated && scoreShown, false, 'score variable mutated and rendered');

    add('endstate', 'win/lose or completion state',
        has(/\b(you\s*win|game\s*over|you\s*lose|win|won|lose|lost|defeat|victory|caught|complete[d]?)\b/i) ||
        hasJs(/clearInterval\s*\(/),
        false, 'win/lose/end text or stop condition');

    return checks;
}

function runAcceptance(goal, src) {
    const { isGame, isWeb, isCrudApp } = classifyTask(goal);
    if (isGame) {
        const checks = gameAcceptanceChecks(src);
        return { applicable: true, isWeb, checks, failed: checks.filter(c => c.required && !c.present) };
    }
    if (isCrudApp) {
        const checks = webAppAcceptanceChecks(src, goal);
        return { applicable: true, isWeb, checks, failed: checks.filter(c => c.required && !c.present) };
    }
    return { applicable: false, isWeb, checks: [], failed: [] };
}

module.exports = { classifyTask, gameAcceptanceChecks, webAppAcceptanceChecks, runAcceptance };
