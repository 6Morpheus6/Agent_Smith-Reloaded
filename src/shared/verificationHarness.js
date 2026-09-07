const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const MAX_REFLECTIONS = 3;

// Run one checker command. Distinguishes three outcomes so a missing tool is a
// SKIP (not a failure): { ran:false } = tool absent; { ran:true, ok:true } = passed;
// { ran:true, ok:false, message, raw } = real error.
function execCheck(cmd, timeout = 20000) {
    return new Promise((resolve) => {
        exec(cmd, { timeout }, (error, stdout, stderr) => {
            if (!error) return resolve({ ran: true, ok: true });
            const raw = (stderr || stdout || error.message || '').toString();
            // Tool not installed → treat as "couldn't check", never as a failure.
            if (error.code === 127 || /is not recognized|not recognized as|command not found|ENOENT|No such file/i.test(raw)) {
                return resolve({ ran: false });
            }
            if (error.killed) return resolve({ ran: true, ok: false, message: 'check timed out', raw });
            // Prefer the human-readable error line (e.g. "SyntaxError: ...") over the
            // node stack-trace frames that follow it; fall back to the last few lines.
            const lines = raw.trim().split('\n').map(l => l.trim()).filter(Boolean);
            const errLine = lines.find(l => /\b(?:Syntax|Reference|Type|Range)?Error\b\s*:/.test(l) || /error:/i.test(l));
            const message = errLine || lines.slice(-3).join(' ');
            resolve({ ran: true, ok: false, message, raw });
        });
    });
}

// Per-language syntax check for a single file, gated on the checker being installed
// (a missing checker is a skip, not a pass-claim). JS/JSON use the always-present
// bundled node runtime; other languages use their standard syntax checker if found.
async function syntaxCheckFile(projectRoot, relPath) {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
    const ext = path.extname(abs).toLowerCase();
    const q = JSON.stringify(abs);

    if (ext === '.json') {
        try { JSON.parse(fs.readFileSync(abs, 'utf-8')); return { ok: true }; }
        catch (e) { return { ok: false, file: relPath, message: e.message }; }
    }

    // TypeScript per-file checking is noisy (cross-file module resolution), so only
    // genuine SYNTAX errors (TS1xxx) are treated as failures; everything else (e.g.
    // TS2307 cannot-find-module) is ignored to avoid false build-blocking.
    if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
        const jsx = ext === '.tsx' ? '--jsx react ' : '';
        const r = await execCheck(`tsc --noEmit --skipLibCheck --isolatedModules ${jsx}${q}`);
        if (!r.ran) return { ok: true, skipped: true, toolMissing: true };
        if (r.ok) return { ok: true };
        if (/error TS1\d{3}/.test(r.raw || '')) return { ok: false, file: relPath, message: r.message };
        return { ok: true, skipped: true };
    }

    const CHECKS = {
        '.js': [`node --check ${q}`],
        '.cjs': [`node --check ${q}`],
        '.mjs': [`node --check ${q}`],
        '.py': [`python -m py_compile ${q}`, `python3 -m py_compile ${q}`],
        '.go': [`gofmt -e ${q}`],
        '.rb': [`ruby -c ${q}`],
        '.php': [`php -l ${q}`],
        // Pure single-file syntax checks; each is a no-side-effect flag and SKIPS when
        // the toolchain isn't installed (never a false failure).
        '.sh': [`bash -n ${q}`, `sh -n ${q}`],
        '.bash': [`bash -n ${q}`],
        '.pl': [`perl -c ${q}`],
        '.lua': [`luac -p ${q}`],
        '.c': [`gcc -fsyntax-only ${q}`, `clang -fsyntax-only ${q}`],
        '.h': [`gcc -fsyntax-only ${q}`, `clang -fsyntax-only ${q}`],
        '.cpp': [`g++ -fsyntax-only ${q}`, `clang++ -fsyntax-only ${q}`],
        '.cc': [`g++ -fsyntax-only ${q}`, `clang++ -fsyntax-only ${q}`],
        '.cxx': [`g++ -fsyntax-only ${q}`, `clang++ -fsyntax-only ${q}`],
        '.hpp': [`g++ -fsyntax-only ${q}`, `clang++ -fsyntax-only ${q}`],
        '.rs': [`rustc --edition 2021 --crate-type lib --emit=metadata -o ${process.platform === 'win32' ? 'NUL' : '/dev/null'} ${q}`],
    };
    const cmds = CHECKS[ext];
    if (!cmds) return { ok: true, skipped: true }; // unsupported extension

    for (const cmd of cmds) {
        const r = await execCheck(cmd);
        if (r.ran) return r.ok ? { ok: true } : { ok: false, file: relPath, message: r.message };
        // else tool missing → try the next candidate (e.g. python3)
    }
    return { ok: true, skipped: true, toolMissing: true }; // no checker installed
}

// Fallback gate when the project has no lint/test command: validate the syntax of
// the files this plan recently touched, so the agent can't "complete" a step that
// left broken code on disk.
async function syntaxCheckTouched(projectRoot, plan) {
    const rels = Object.keys(plan.filesLedger || {}).slice(-12);
    const messages = [];
    let ok = true, checked = 0;
    for (const rel of rels) {
        const r = await syntaxCheckFile(projectRoot, rel);
        if (r.skipped) continue;
        checked++;
        if (!r.ok) { ok = false; messages.push(`[SYNTAX] ${r.file}: ${r.message}`); }
    }
    return { ok, messages, checked };
}

function runCmd(cwd, command, timeoutMs = 120000) {
    return new Promise((resolve) => {
        exec(command, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                exitCode: error ? (error.code || 1) : 0,
                stdout: stdout || '',
                stderr: stderr || '',
                error: error ? error.message : null
            });
        });
    });
}

function truncateOutput(text, max = 500) {
    const s = String(text || '').trim();
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
}

/** Run project lint command. Missing toolchain → skip (not fail). */
async function runLint(projectRoot, lintCmd, opts = {}) {
    if (!lintCmd) return { skipped: true, ok: true, messages: [] };
    const timeoutMs = opts.timeoutMs || 120000;
    const r = await runCmd(projectRoot, lintCmd, timeoutMs);
    if (!r.ok) {
        const detail = truncateOutput(r.stderr || r.stdout || r.error);
        return {
            skipped: false,
            ok: false,
            messages: [`[LINT FAILED] ${lintCmd}${detail ? `\n${detail}` : ''}`],
            raw: r
        };
    }
    return { skipped: false, ok: true, messages: [], raw: r };
}

/** Run project test command. Missing toolchain → skip (not fail). */
async function runTest(projectRoot, testCmd, opts = {}) {
    if (!testCmd) return { skipped: true, ok: true, messages: [] };
    const timeoutMs = opts.timeoutMs || 120000;
    const r = await runCmd(projectRoot, testCmd, timeoutMs);
    if (!r.ok) {
        const detail = truncateOutput(r.stderr || r.stdout || r.error);
        return {
            skipped: false,
            ok: false,
            messages: [`[TEST FAILED] ${testCmd}${detail ? `\n${detail}` : ''}`],
            raw: r
        };
    }
    return { skipped: false, ok: true, messages: [], raw: r };
}

/** Run project e2e command (Playwright or test:e2e script). */
async function runE2e(projectRoot, e2eCmd, opts = {}) {
    if (!e2eCmd) return { skipped: true, ok: true, messages: [] };
    const timeoutMs = opts.timeoutMs || 180000;
    const r = await runCmd(projectRoot, e2eCmd, timeoutMs);
    if (!r.ok) {
        const detail = truncateOutput(r.stderr || r.stdout || r.error);
        return {
            skipped: false,
            ok: false,
            messages: [`[E2E FAILED] ${e2eCmd}${detail ? `\n${detail}` : ''}`],
            raw: r
        };
    }
    return { skipped: false, ok: true, messages: [], raw: r };
}

/** Single source of truth for lint/test command discovery (delegates to projectDetector). */
function detectProjectCommands(projectRoot) {
    const { detect } = require('../main/services/projectDetector.js');
    return detect(projectRoot);
}

async function runVerification(projectRoot, plan, opts = {}) {
    const results = { lint: null, test: null, ok: true, messages: [] };

    // Per-step gating: intermediate steps run only the cheap syntax check (a syntax
    // error is never legitimate mid-build), deferring the full lint/test suite to the
    // final step so half-finished code isn't tested early.
    if (opts.syntaxOnly) {
        const sc = await syntaxCheckTouched(projectRoot, plan);
        results.syntax = sc;
        if (sc.checked > 0) {
            if (!sc.ok) { results.ok = false; results.messages.push(...sc.messages); }
        } else {
            results.unverified = true;
            results.messages.push('[UNVERIFIED] No syntax checker available for the touched files. Confirm correctness manually.');
        }
        return results;
    }

    if (plan.lintCmd) {
        results.lint = await runLint(projectRoot, plan.lintCmd, opts);
        if (!results.lint.skipped && !results.lint.ok) {
            results.ok = false;
            results.messages.push(...results.lint.messages);
        }
    }

    if (plan.testCmd) {
        results.test = await runTest(projectRoot, plan.testCmd, opts);
        if (!results.test.skipped && !results.test.ok) {
            results.ok = false;
            results.messages.push(...results.test.messages);
        }
    }

    if (plan.e2eCmd && opts.includeE2e !== false) {
        results.e2e = await runE2e(projectRoot, plan.e2eCmd, opts);
        if (!results.e2e.skipped && !results.e2e.ok) {
            results.ok = false;
            results.messages.push(...results.e2e.messages);
        }
    }

    // No explicit verification configured → fall back to a syntax check of the
    // files this plan touched, so completion still has a real correctness signal.
    if (!plan.lintCmd && !plan.testCmd) {
        const sc = await syntaxCheckTouched(projectRoot, plan);
        results.syntax = sc;
        if (sc.checked > 0) {
            if (!sc.ok) {
                results.ok = false;
                results.messages.push(...sc.messages);
            }
        } else {
            // Nothing real could be checked (no test/lint command, and the touched
            // files are an unsupported language or their checker isn't installed).
            // Be HONEST: this is unverified, not verified. Callers must not stamp a
            // [verified] mark, but the step is still allowed through — we can't gate
            // on a check that can't run.
            results.unverified = true;
            results.messages.push('[UNVERIFIED] No automated verification available for the touched files (no test/lint command, and no syntax checker for their language). Confirm correctness manually.');
        }
    }

    return results;
}

function canMarkStepDone(plan, stepId) {
    const step = plan.steps?.find(s => s.id === stepId);
    if (!step) return false;
    if (plan.verifyPolicy === 'off') return true;
    return Boolean(step.verifiedAt);
}

function markStepVerified(plan, stepId) {
    const step = plan.steps?.find(s => s.id === stepId);
    if (step) step.verifiedAt = Date.now();
    return plan;
}

module.exports = {
    runVerification,
    runLint,
    runTest,
    runE2e,
    detectProjectCommands,
    canMarkStepDone,
    markStepVerified,
    MAX_REFLECTIONS,
    runCmd,
    syntaxCheckFile,
    syntaxCheckTouched,
    truncateOutput
};
