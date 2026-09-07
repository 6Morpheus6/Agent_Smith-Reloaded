'use strict';

const COLS = 19;
const ROWS = 21;
const CELL = 24;

// 1 = wall, 0 = path with pellet, 2 = empty path (spawn / ghost house)
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

const boardEl = document.getElementById('game-board');
const scoreEl = document.getElementById('score');
const statusEl = document.getElementById('status');

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

function isWall(x, y) {
    return cellAt(x, y) === 1;
}

function canMove(x, y) {
    return !isWall(x, y);
}

function initBoard() {
    boardEl.style.gridTemplateColumns = `repeat(${COLS}, ${CELL}px)`;
    boardEl.style.gridTemplateRows = `repeat(${ROWS}, ${CELL}px)`;
    boardEl.innerHTML = '';
    pelletsLeft = 0;

    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            const cell = document.createElement('div');
            cell.className = 'cell';
            cell.dataset.x = String(x);
            cell.dataset.y = String(y);
            const v = cellAt(x, y);
            if (v === 1) {
                cell.classList.add('wall');
            } else if (v === 0) {
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
    return boardEl.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
}

function renderActors() {
    boardEl.querySelectorAll('.pacman, .ghost').forEach(el => el.remove());

    const pCell = getCellEl(pacman.x, pacman.y);
    if (pCell) {
        const p = document.createElement('div');
        p.className = `pacman ${pacman.dir}`;
        pCell.appendChild(p);
    }

    for (const g of ghosts) {
        const gCell = getCellEl(g.x, g.y);
        if (gCell) {
            const el = document.createElement('div');
            el.className = `ghost ${g.color}`;
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
        scoreEl.textContent = `Score: ${score}`;
        if (pelletsLeft <= 0) {
            statusEl.textContent = 'You win! Refresh to play again.';
            clearInterval(tick);
        }
    }
}

function randomDir(x, y) {
    const dirs = ['up', 'down', 'left', 'right'].filter(d => {
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
            statusEl.textContent = 'Caught by a ghost! Refresh to retry.';
            clearInterval(tick);
        }
    }
}

function gameLoop() {
    if (tryMove(pacman, pacman.nextDir) || tryMove(pacman, pacman.dir)) {
        eatPellet();
    }
    moveGhosts();
    renderActors();
}

function setupControls() {
    document.addEventListener('keydown', (e) => {
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
}

initBoard();
setupControls();
tick = setInterval(gameLoop, 140);
