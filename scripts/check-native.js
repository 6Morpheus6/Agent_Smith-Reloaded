#!/usr/bin/env node
'use strict';

// Native-binary doctor.
//
// node_modules holds platform-specific native binaries (the esbuild compiler and the
// Electron runtime). Copying a project folder between Linux and Windows — or any install
// that pulled the wrong platform — leaves binaries that don't match THIS OS, which fails
// hard at startup:
//   * esbuild: "Host version X does not match binary version Y" (prestart build dies)
//   * Electron: loads a wrong-platform/version V8 snapshot and crashes with 0x80000003
//     (STATUS_BREAKPOINT) BEFORE the 'ready' event — the window never opens, no JS error.
//
// This runs before `npm start`/`npm run dist` and repairs ONLY when it detects a mismatch,
// so it is a fast no-op on a correctly-installed machine (Linux included — its behavior is
// unchanged). Repairs touch only node_modules; package.json / package-lock.json are never
// modified, so the other OS's checkout is unaffected.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const platform = process.platform; // 'win32' | 'linux' | 'darwin'
const arch = process.arch;          // 'x64' | 'arm64' | ...
const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');
const npmCmd = platform === 'win32' ? 'npm.cmd' : 'npm';

const log = (m) => console.log('[check-native] ' + m);
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// Run node directly (execPath may contain spaces — array form, no shell, handles it).
const runNode = (args) => {
    const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`node ${args.join(' ')} exited with ${r.status}`);
};
// Run npm. On Windows npm is npm.cmd, which Node 22 refuses to spawn without a shell, so use
// shell:true with a single command string (our args have no spaces/quoting hazards).
const runNpm = (args) => {
    const r = spawnSync(`${npmCmd} ${args.join(' ')}`, { cwd: root, stdio: 'inherit', env: process.env, shell: true });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`npm ${args.join(' ')} exited with ${r.status}`);
};

// esbuild ships its native compiler as a per-platform optional dependency. The top-level
// "host" package version must exactly equal the installed @esbuild/<platform>-<arch> binary.
function checkEsbuild() {
    const hostPkg = readJSON(path.join(nm, 'esbuild', 'package.json'));
    if (!hostPkg) return; // esbuild not installed
    const platPkg = `@esbuild/${platform === 'win32' ? 'win32' : platform}-${arch}`;
    const binPkg = readJSON(path.join(nm, platPkg, 'package.json'));
    if (binPkg && binPkg.version === hostPkg.version) return; // healthy
    log(`esbuild mismatch: host ${hostPkg.version} vs ${platPkg} ${binPkg ? binPkg.version : 'MISSING'} — repairing`);
    runNpm(['install', `${platPkg}@${hostPkg.version}`, '--no-save', '--no-package-lock', '--force']);
    log('esbuild binary repaired');
}

// Electron's launcher reads dist/path.txt to pick the binary. On a healthy install that is
// 'electron.exe' (win32) or 'electron' (linux/mac) and the matching binary exists in dist.
// A win32 dist that still contains a Linux ELF named 'electron' is a poisoned mixed install.
function checkElectron() {
    // Only win32/linux use a plain binary name in path.txt; macOS uses an .app bundle path,
    // so scope repair to the platforms we verify here and never false-trigger on darwin.
    if (platform !== 'win32' && platform !== 'linux') return;
    const elDir = path.join(nm, 'electron');
    if (!fs.existsSync(elDir)) return; // electron not installed
    const expected = platform === 'win32' ? 'electron.exe' : 'electron';
    const pathTxt = path.join(elDir, 'path.txt');
    let healthy = false;
    try {
        const pt = fs.readFileSync(pathTxt, 'utf8').trim();
        healthy = pt === expected && fs.existsSync(path.join(elDir, 'dist', expected));
        // stray wrong-platform binary alongside the right one = mixed/poisoned dist
        if (healthy && platform === 'win32' && fs.existsSync(path.join(elDir, 'dist', 'electron'))) healthy = false;
    } catch { healthy = false; }
    if (healthy) return;
    log(`electron dist invalid for ${platform}-${arch} — reinstalling correct build`);
    try { fs.rmSync(path.join(elDir, 'dist'), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(pathTxt, { force: true }); } catch {}
    runNode([path.join(elDir, 'install.js')]); // downloads the matching platform build
    log('electron repaired');
}

for (const [name, fn] of [['esbuild', checkEsbuild], ['electron', checkElectron]]) {
    try { fn(); } catch (e) { console.error(`[check-native] ${name} repair failed: ${e.message}`); }
}

// node_modules symlink guard (the v51.3 launch-killer). electron-builder collects production
// dependencies from a real directory tree and does NOT follow a top-level node_modules
// symlink — with one in place, only the packages npm can resolve through its own metadata
// make it into app.asar, and entire subtrees (fast-glob's glob-parent/micromatch/@nodelib…)
// are silently dropped. The packaged app then dies at startup with "Cannot find module" for
// a package that is present in the source tree. Detection + a loud warning here costs zero;
// the failure it prevents costs an entire release cycle (v51.3 shipped exactly this way).
(function checkNodeModulesSymlink() {
    let st;
    try { st = fs.lstatSync(nm); } catch { return; } // not installed at all — nothing to guard
    if (!st.isSymbolicLink()) return;
    const target = (() => { try { return fs.readlinkSync(nm); } catch { return '?'; } })();
    console.error(`[check-native] WARNING: node_modules is a SYMLINK -> ${target}`);
    console.error('[check-native] electron-builder will NOT follow it when packaging, so transitive');
    console.error("[check-native] dependencies (e.g. glob-parent for fast-glob) get dropped from app.asar and");
    console.error('[check-native] the packaged app crashes at launch with "Cannot find module". Replace the');
    console.error(`[check-native] symlink with a real copy before 'npm run dist' — e.g.: rm node_modules && cp -a "${target}" node_modules`);
})();

// Always exit 0: a repair error (e.g. offline) shouldn't block the build — the downstream
// step (build-renderer / electron) will surface the real problem with its own clearer message.
process.exit(0);
