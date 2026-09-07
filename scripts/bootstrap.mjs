#!/usr/bin/env node
/**
 * Cross-platform bootstrap: makes "unzip the whole project and run it" work on BOTH
 * Linux/macOS and Windows — even if node_modules was zipped from the other OS.
 *
 * An Electron app's node_modules contains NATIVE, single-platform binaries (the
 * `electron` runtime and `esbuild`). A node_modules built on Windows cannot run on
 * Linux and vice-versa. This script runs under plain Node (no dependencies), detects
 * that mismatch, reinstalls for the current platform when needed, then launches the app.
 *
 * Run it directly so it works even when node_modules is missing/broken:
 *   node scripts/bootstrap.mjs            (or: ./run.sh  /  run.cmd)
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const marker = join(nm, '.platform');
const current = `${process.platform}-${process.arch}`;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const read = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };

// The decisive cross-platform signal: which electron binary is on disk.
function electronMismatch() {
    if (!existsSync(join(nm, 'electron'))) return false; // nothing installed yet
    if (process.platform === 'win32') return !existsSync(join(nm, 'electron', 'dist', 'electron.exe'));
    if (process.platform === 'darwin') return !existsSync(join(nm, 'electron', 'dist', 'Electron.app'));
    return !existsSync(join(nm, 'electron', 'dist', 'electron')); // linux + others
}

function run(cmd, args) {
    const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
    if (r.error) { console.error(`[bootstrap] failed to run ${cmd}: ${r.error.message}`); process.exit(1); }
    return r.status ?? 0;
}

let needInstall = false;
let needClean = false;

if (!existsSync(nm)) {
    console.log('[bootstrap] node_modules missing — installing for ' + current + '…');
    needInstall = true;
} else if (electronMismatch()) {
    console.log(`[bootstrap] node_modules was built for a different OS (this is ${current}) — reinstalling…`);
    needInstall = true;
    needClean = true;
} else if (read(marker) !== current) {
    // Looks correct for this platform already; just stamp the marker.
    try { writeFileSync(marker, current); } catch { /* non-fatal */ }
}

if (needInstall) {
    if (needClean) rmSync(nm, { recursive: true, force: true });
    const code = run(npm, ['install']);
    if (code !== 0) { console.error('[bootstrap] npm install failed.'); process.exit(code); }
    try { writeFileSync(marker, current); } catch { /* non-fatal */ }
}

// `npm start` runs prestart (build-renderer) then electron.
process.exit(run(npm, ['start']));
