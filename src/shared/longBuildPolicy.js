/**
 * v54.5 — Long-build policy: the packaging-reliability module.
 *
 * Why this exists: tasks like "package this app into an AppImage / .deb" run commands
 * (electron-builder, npm run dist, pyinstaller, make) that legitimately take 10–60+
 * minutes on a modest machine. Three harness bounds used to kill exactly those runs:
 *   - the pipeline's exclusive-call bound (5 min) rejected `run_command` mid-build,
 *   - the foreground shell timeout (5 min) SIGTERM'd the builder,
 *   - and TEST-BEFORE-DONE didn't count a successful build as verification.
 * This module is the single source of truth for: which commands are long builds,
 * what bound each call should get, and what counts as a verification run.
 */
'use strict';

// Commands that are builds/packaging by nature — expected to run far past the default
// foreground timeout. Matched against the whole command string (case-insensitive).
const LONG_BUILD_RES = [
    /\belectron-builder\b/i,
    /\bnpx\s+electron-builder\b/i,
    /\bappimagetool\b|\blinuxdeploy\b|--appimage\b/i,
    /\bdpkg-deb\b|\bfakeroot\b|\bdebmake\b/i,
    /\bpyinstaller\b|\bcx_Freeze\b|\bpy2exe\b/i,
    /\bnpm\s+(?:run\s+)?(?:dist|build|package|rebuild)\b/,
    /\bpnpm\s+(?:run\s+)?(?:dist|build|package|rebuild)\b/,
    /\byarn\s+(?:run\s+)?(?:dist|build|package)\b/,
    /\bnpx\s+electron-forge\b/i,
    /\bmake\b(?!\s+install)/i,
    /\bcargo\s+build\b/i,
    /\bgo\s+build\b/i,
    /\bdotnet\s+(?:publish|build)\b/i,
    /\bgradle(?:w)?\b|\bmvn\s+package\b/i,
    /\bdocker\s+(?:build|compose\s+build)\b/i,
    /\bnpm\s+(?:install|i)(?:\s|$)/,          // cold installs pull the whole tree
    /\bpnpm\s+install\b|\byarn\s+install\b|\bpip\s+install\b/,
    /\bpython3?\s+-m\s+build\b/i,
    // v55.2: system package-manager operations (usually run via the SUDO OVERRIDE) —
    // `apt update && apt upgrade -y` on a full system can easily exceed the 5-min default.
    /\bsudo\b[^\n]*\b(?:apt|dpkg)\b/i,
    /\b(?:apt-get|aptitude)\s+(?:update|upgrade|install|full-upgrade)\b/i,
    /\bdpkg\s+(?:-i|-r|--install|--remove)\b/i,
    /\b(?:yum|dnf)\s+(?:update|upgrade|install)\b/i,
    /\bpacman\s+-[Sy][u]\b|\bpacman\s+-S\b/i
];

// Verification commands — a passing run of one of these since the last edit is real
// evidence the code works (TEST BEFORE DONE). v54.5 adds build/package commands: for a
// packaging task, `electron-builder` exiting 0 IS the verification.
const VERIFICATION_RES = [
    /(?:^|[\s;&|])(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint|check|e2e|verify)\b/,
    /\b(?:jest|vitest|mocha|pytest|unittest|rspec|phpunit|cargo\s+test|go\s+test)\b/,
    /(?:^|[\s;&|])(?:tsc|mypy|eslint|flake8|py_compile|ruff)(?:\s|$)/,
    /\bnode\s+--check\b/,
    /\bpython3?\s+-m\s+py_compile\b/,
    // v54.5: a successful build/package run counts as verification of the build itself.
    /\belectron-builder\b/i,
    /\bnpm\s+(?:run\s+)?(?:dist|build|package)\b/,
    /\bpnpm\s+(?:run\s+)?(?:dist|build|package)\b/,
    /\byarn\s+(?:run\s+)?(?:dist|build|package)\b/,
    /\bpyinstaller\b/i,
    /(?:^|[\s;&|])make(?:\s|$)/i
];

function isLongBuildCommand(command) {
    const cmd = String(command || '');
    return LONG_BUILD_RES.some(re => re.test(cmd));
}

function isVerificationCommand(command) {
    const cmd = String(command || '');
    return VERIFICATION_RES.some(re => re.test(cmd));
}

const DEFAULT_EXCLUSIVE_BOUND_MS = 300000;                 // 5 min (unchanged default)
const MAX_CMD_MS = Number(process.env.XK_CODE_MAX_CMD_MS) || 4 * 3600000; // 4 h ceiling

/** Requested timeout from the model, clamped into [1s, MAX_CMD_MS]. 0/invalid → null. */
function clampRequestedTimeout(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(Math.max(1000, n), MAX_CMD_MS);
}

/**
 * Effective around-dispatch bound for an exclusive `run_command` call. The pipeline and
 * the foreground shell must agree (shell kills slightly BEFORE the pipeline rejects so
 * the model gets a real exit report instead of an orphaned process):
 *   - explicit args.timeout_ms → that value (+ small slack on the outer bound)
 *   - recognized long build    → XK_CODE_BUILD_TIMEOUT_MS (default 60 min)
 *   - anything else            → the default exclusive bound.
 */
function exclusiveBoundFor(name, args, baseMs = DEFAULT_EXCLUSIVE_BOUND_MS) {
    if (name !== 'run_command' || (args && args.is_background)) return baseMs;
    const requested = clampRequestedTimeout(args && args.timeout_ms);
    if (requested != null) return Math.min(requested + 15000, MAX_CMD_MS + 30000);
    if (isLongBuildCommand(args && args.command)) {
        return Math.max(baseMs, Number(process.env.XK_CODE_BUILD_TIMEOUT_MS) || 3600000);
    }
    return baseMs;
}

/** Timeout handed to the foreground shell for this call (kills before the outer bound). */
function foregroundTimeoutFor(name, args, baseMs = DEFAULT_EXCLUSIVE_BOUND_MS) {
    if (name !== 'run_command' || (args && args.is_background)) return baseMs;
    const requested = clampRequestedTimeout(args && args.timeout_ms);
    if (requested != null) return Math.min(requested, MAX_CMD_MS);
    if (isLongBuildCommand(args && args.command)) {
        return Math.max(baseMs, Number(process.env.XK_CODE_BUILD_TIMEOUT_MS) || 3600000);
    }
    return baseMs;
}

/** Guidance appended to a blocked/timed-out build so the model switches strategy. */
function longBuildGuidance(command) {
    return `Command "${String(command || '').slice(0, 120)}" is a long build/package step. `
        + 'Either re-run it with run_command is_background:true and poll with read_process_log '
        + '(preferred — the run stays responsive), or pass timeout_ms (milliseconds) sized to '
        + 'the expected build time. NEVER assume the build failed because one attempt hit a '
        + 'timeout: check the output directory (e.g. release/, dist/) before retrying.';
}

module.exports = {
    DEFAULT_EXCLUSIVE_BOUND_MS,
    MAX_CMD_MS,
    isLongBuildCommand,
    isVerificationCommand,
    clampRequestedTimeout,
    exclusiveBoundFor,
    foregroundTimeoutFor,
    longBuildGuidance
};
