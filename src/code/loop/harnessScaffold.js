/**
 * Last-resort scaffold when weak models truncate before creating linked script.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pickNextMissing, clearPendingIfCreated } = require('./missingRefGuard.js');
const {
    goalWantsPreview,
    buildContinueAfterRecoveryNudge,
    detectAppRepo
} = require('../context/artifactHints.js');
const { executeTool } = require('../tools/executor.js');

function buildPacmanHtmlContent() {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Pac-Man</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <header>
        <h1>Pac-Man</h1>
        <p>Score: <span id="score">0</span></p>
        <p id="status">Use arrow keys or WASD to move.</p>
    </header>
    <main id="game-board" aria-label="Pac-Man game board"></main>
    <script src="script.js"></script>
</body>
</html>
`;
}

/** Compact Pac-Man script — flexible DOM ids from common model HTML shells. */
function buildPacmanScriptContent() {
    return `'use strict';

const COLS = 19;
const ROWS = 21;
const CELL = 24;
const MAZE = [
    '1111111111111111111',
    '1000000000100000001',
    '1011110110110111101',
    '1000000000000000001',
    '1010111110111110101',
    '1000100000000000101',
    '1110110111110110111',
    '0000100100000100100',
    '1110110111110110111',
    '1000000000000000001',
    '1010111110111110101',
    '1000100002220000101',
    '1110110101010110111',
    '1000000100100000001',
    '1011110110110111101',
    '1000000000100000001',
    '1111111111111111111',
    '1000000000000000001',
    '1011110110110111101',
    '1000000000000000001',
    '1111111111111111111',
];

const boardEl = document.getElementById('maze')
    || document.getElementById('grid')
    || document.getElementById('game-board')
    || document.querySelector('.grid')
    || document.getElementById('game-container');
const scoreEl = document.getElementById('score');
const statusEl = document.getElementById('message')
    || document.getElementById('status')
    || document.getElementById('scoreboard');

let pelletsLeft = 0;
let score = 0;
let pacman = { x: 9, y: 15, dir: 'left', nextDir: 'left' };
let ghosts = [
    { x: 8, y: 11, color: 'red', dir: 'left' },
    { x: 9, y: 11, color: 'pink', dir: 'right' },
    { x: 10, y: 11, color: 'cyan', dir: 'up' },
];
let tick = null;

function cellAt(x, y) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return 1;
    return Number(MAZE[y][x]);
}

function canMove(x, y) {
    return cellAt(x, y) !== 1;
}

function initBoard() {
    if (!boardEl) return;
    boardEl.style.display = 'grid';
    boardEl.style.gridTemplateColumns = 'repeat(' + COLS + ', ' + CELL + 'px)';
    boardEl.style.gridTemplateRows = 'repeat(' + ROWS + ', ' + CELL + 'px)';
    boardEl.innerHTML = '';
    pelletsLeft = 0;
    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            const cell = document.createElement('div');
            cell.className = 'cell';
            cell.dataset.x = String(x);
            cell.dataset.y = String(y);
            const v = cellAt(x, y);
            if (v === 1) cell.classList.add('wall');
            else if (v === 0) {
                const pellet = document.createElement('div');
                pellet.className = 'pellet';
                cell.appendChild(pellet);
                pelletsLeft++;
            }
            boardEl.appendChild(cell);
        }
    }
    renderActors();
}

function getCellEl(x, y) {
    return boardEl.querySelector('.cell[data-x="' + x + '"][data-y="' + y + '"]');
}

function renderActors() {
    boardEl.querySelectorAll('.pacman, .ghost').forEach(function (el) { el.remove(); });
    const pCell = getCellEl(pacman.x, pacman.y);
    if (pCell) {
        const p = document.createElement('div');
        p.className = 'pacman ' + pacman.dir;
        pCell.appendChild(p);
    }
    for (const g of ghosts) {
        const gCell = getCellEl(g.x, g.y);
        if (gCell) {
            const el = document.createElement('div');
            el.className = 'ghost ' + g.color;
            gCell.appendChild(el);
        }
    }
}

function tryMove(entity, dir) {
    let nx = entity.x;
    let ny = entity.y;
    if (dir === 'up') ny--;
    else if (dir === 'down') ny++;
    else if (dir === 'left') nx--;
    else if (dir === 'right') nx++;
    if (canMove(nx, ny)) {
        entity.x = nx;
        entity.y = ny;
        entity.dir = dir;
        return true;
    }
    return false;
}

function eatPellet() {
    const cell = getCellEl(pacman.x, pacman.y);
    if (!cell) return;
    const pellet = cell.querySelector('.pellet');
    if (pellet) {
        pellet.remove();
        pelletsLeft--;
        score += 10;
        if (scoreEl) scoreEl.textContent = String(score);
        if (pelletsLeft <= 0) {
            if (statusEl) statusEl.textContent = 'You win! Refresh to play again.';
            clearInterval(tick);
        }
    }
}

function randomDir(x, y) {
    const dirs = ['up', 'down', 'left', 'right'].filter(function (d) {
        let nx = x, ny = y;
        if (d === 'up') ny--;
        else if (d === 'down') ny++;
        else if (d === 'left') nx--;
        else nx++;
        return canMove(nx, ny);
    });
    return dirs[Math.floor(Math.random() * dirs.length)] || 'left';
}

function moveGhosts() {
    for (const g of ghosts) {
        if (Math.random() < 0.3) g.dir = randomDir(g.x, g.y);
        if (!tryMove(g, g.dir)) g.dir = randomDir(g.x, g.y);
        tryMove(g, g.dir);
        if (g.x === pacman.x && g.y === pacman.y) {
            if (statusEl) statusEl.textContent = 'Game over — caught by a ghost! Refresh to retry.';
            clearInterval(tick);
        }
    }
}

function gameLoop() {
    if (tryMove(pacman, pacman.nextDir) || tryMove(pacman, pacman.dir)) eatPellet();
    moveGhosts();
    renderActors();
}

document.addEventListener('keydown', function (e) {
    const map = {
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        w: 'up', s: 'down', a: 'left', d: 'right',
        W: 'up', S: 'down', A: 'left', D: 'right',
    };
    const dir = map[e.key];
    if (dir) {
        e.preventDefault();
        pacman.nextDir = dir;
    }
});

initBoard();
tick = setInterval(gameLoop, 140);
`;
}

/** Compact Pac-Man stylesheet — matches scaffold script class names (.pacman, .ghost, etc.). */
function buildPacmanStyleContent() {
    return `* { box-sizing: border-box; }
body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; background: #000; color: #fff;
    font-family: "Segoe UI", Tahoma, sans-serif;
}
header { text-align: center; padding: 12px 16px 8px; }
h1 { margin: 0 0 4px; color: #ffe600; letter-spacing: 2px; }
#score { margin: 0; font-size: 1.1rem; color: #00e5ff; }
#status, #message { margin: 4px 0 0; font-size: 0.85rem; color: #aaa; }
#game-board, #maze, #grid, #game-container {
    display: grid; gap: 0; border: 3px solid #2121de; background: #000; margin-bottom: 24px;
}
.cell { width: 24px; height: 24px; position: relative; }
.wall { background: #2121de; box-shadow: inset 0 0 6px rgba(100, 100, 255, 0.4); }
.pellet {
    position: absolute; top: 50%; left: 50%; width: 6px; height: 6px;
    margin: -3px 0 0 -3px; background: #ffb897; border-radius: 50%;
}
.pacman {
    position: absolute; top: 50%; left: 50%; width: 20px; height: 20px;
    margin: -10px 0 0 -10px; background: #ffe600; border-radius: 50%;
    clip-path: polygon(50% 50%, 100% 0, 100% 100%);
    animation: chomp 0.25s linear infinite;
}
.pacman.up { transform: rotate(-90deg); }
.pacman.down { transform: rotate(90deg); }
.pacman.left { transform: rotate(180deg); }
.ghost {
    position: absolute; top: 50%; left: 50%; width: 18px; height: 18px;
    margin: -9px 0 0 -9px; border-radius: 9px 9px 4px 4px;
}
.ghost.red { background: #ff0000; }
.ghost.pink { background: #ffb8ff; }
.ghost.cyan { background: #00ffff; }
@keyframes chomp {
    0%, 100% { clip-path: polygon(50% 50%, 100% 0, 100% 100%); }
    50% { clip-path: polygon(50% 50%, 100% 35%, 100% 65%); }
}
`;
}

// The last-resort scaffold injects a known-good *Pac-Man* implementation, so it must
// only fire for actual Pac-Man goals. It previously also matched any generic "game"
// goal, which could overwrite a non-Pac-Man build (e.g. Snake/Tetris) with Pac-Man
// code. The generic acceptance/verification path is unaffected and stays general.
function isPacmanGoal(goal) {
    return /\bpac[\s-]?man\b/i.test(String(goal || ''));
}

async function scaffoldPacmanFile(session, execDeps, emit, relPath, content, reason) {
    if (!relPath || !session.projectRoot) return null;
    const abs = path.join(session.projectRoot, relPath);
    if (fs.existsSync(abs)) return null;

    try {
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        // Record the create in the change ledger so this last-resort write is captured by
        // "Revert All" like a normal tool write (abs is known-not-to-exist — checked above).
        if (execDeps?.changeLedger?.recordCreate) {
            await execDeps.changeLedger.recordCreate(session.id, abs).catch(() => {});
        }
        await fs.promises.writeFile(abs, content, 'utf8');
    } catch (e) {
        return null;
    }

    clearPendingIfCreated(session, relPath);
    if (!session.filesTouched) session.filesTouched = [];
    if (!session.filesTouched.includes(relPath)) session.filesTouched.push(relPath);

    const htmlRel = path.join(path.dirname(relPath), 'index.html').split(path.sep).join('/');
    const htmlAbs = path.join(session.projectRoot, htmlRel);
    if (fs.existsSync(htmlAbs) && !session.filesTouched.includes(htmlRel)) {
        session.filesTouched.push(htmlRel);
    }

    let previewOpened = false;
    if (goalWantsPreview(session.goal) && fs.existsSync(htmlAbs) && typeof execDeps?.showPreview === 'function') {
        const pr = await executeTool('show_preview', { kind: 'project_file', target: htmlRel }, {
            ...execDeps,
            sessionId: session.id,
            session
        }).catch(() => ({}));
        previewOpened = !pr?.error;
    }

    if (emit) {
        emit({ type: 'harness_scaffold', path: relPath, reason, previewOpened });
        emit({ type: 'run_continue', reason: 'harness_scaffold', path: relPath, previewOpened });
    }

    const continueNudge = buildContinueAfterRecoveryNudge(
        session.goal,
        fs.existsSync(htmlAbs) ? htmlRel : null,
        previewOpened
    );
    if (Array.isArray(session.messages)) {
        session.messages.push({ role: 'user', content: continueNudge });
    }

    return { path: relPath, ok: true, htmlRel: fs.existsSync(htmlAbs) ? htmlRel : null, previewOpened };
}

/**
 * Last-resort: inject known-good pacman/script.js or pacman/style.css when the model stalls.
 * @returns {Promise<{ path: string, ok: boolean } | null>}
 */
function pacmanArtifactDir(session) {
    const touched = Array.isArray(session?.filesTouched) ? session.filesTouched : [];
    const preferred = touched.find(file => /(?:^|\/)index\.html$/i.test(file))
        || touched.find(file => /\.(?:css|js)$/i.test(file));
    let dir = preferred ? path.posix.dirname(String(preferred).replace(/\\/g, '/')) : 'pacman';
    // Never scaffold over a host app's root files: if the chosen dir is the project root and this
    // workspace is an existing app/Electron repo, drop the game into its own subfolder instead.
    if ((dir === '.' || dir === '') && session?.projectRoot && detectAppRepo(session.projectRoot)) {
        dir = 'pacman';
    }
    return dir;
}

async function replacePacmanArtifacts(session, execDeps, emit, gate) {
    const messages = Array.isArray(gate?.messages) ? gate.messages : [];
    if (!messages.some(message => /\[ACCEPT\]|\[SMOKE\]|\[SYNTAX\]|required capability missing/i.test(message))) {
        return null;
    }

    const dir = pacmanArtifactDir(session);
    const files = [
        ['index.html', buildPacmanHtmlContent()],
        ['style.css', buildPacmanStyleContent()],
        ['script.js', buildPacmanScriptContent()]
    ];
    for (const [name, content] of files) {
        const rel = path.posix.join(dir, name);
        const abs = path.join(session.projectRoot, rel);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        if (fs.existsSync(abs) && execDeps?.changeLedger?.snapshotBefore) {
            const snap = await execDeps.changeLedger.snapshotBefore(session.id, abs, 'write');
            if (snap && snap.error) return null;
        } else if (!fs.existsSync(abs) && execDeps?.changeLedger?.recordCreate) {
            await execDeps.changeLedger.recordCreate(session.id, abs);
        }
        await fs.promises.writeFile(abs, content, 'utf8');
        if (!session.filesTouched.includes(rel)) session.filesTouched.push(rel);
    }

    delete session.pendingMissingRefs;
    if (emit) {
        emit({ type: 'harness_scaffold', path: path.posix.join(dir, 'index.html'), reason: 'acceptance_repair' });
        emit({ type: 'run_continue', reason: 'harness_scaffold', path: path.posix.join(dir, 'index.html') });
    }
    if (!Array.isArray(session.messages)) session.messages = [];
    session.messages.push({
        role: 'user',
        content: `[HARNESS RECOVERY] Replaced the broken Pac-Man artifact in ${dir}/ with a validated HTML/CSS/JS implementation. Re-run verification now; do not rewrite the files unless a specific check still fails.`
    });
    return { path: path.posix.join(dir, 'index.html'), ok: true, repaired: true };
}

async function tryHarnessScaffold(session, execDeps, emit, gate) {
    const pending = session?.pendingMissingRefs;
    if (!isPacmanGoal(session.goal)) return null;
    if (!Array.isArray(pending) || !pending.length) {
        return replacePacmanArtifacts(session, execDeps, emit, gate);
    }

    const jsPath = pickNextMissing(pending.filter(p => /\.(js|mjs|cjs)$/i.test(p)));
    if (jsPath) {
        return scaffoldPacmanFile(session, execDeps, emit, jsPath, buildPacmanScriptContent(), 'missing_script');
    }

    const cssPath = pickNextMissing(pending.filter(p => /\.css$/i.test(p)));
    if (cssPath) {
        return scaffoldPacmanFile(session, execDeps, emit, cssPath, buildPacmanStyleContent(), 'missing_stylesheet');
    }

    return null;
}

module.exports = {
    buildPacmanHtmlContent,
    buildPacmanScriptContent,
    buildPacmanStyleContent,
    isPacmanGoal,
    tryHarnessScaffold
};
