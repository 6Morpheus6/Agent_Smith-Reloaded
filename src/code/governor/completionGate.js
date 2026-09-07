/**
 * Completion gate — the harness's "done means verified" enforcement. Nothing may be
 * reported as success until the touched files pass syntax, the web project is internally
 * consistent (HTML/CSS/JS parse, references resolve, selectors match, constants match
 * data), task-specific acceptance is satisfied, and a browser smoke test runs clean.
 *
 * The model is allowed to be weak. This gate is not.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { syntaxCheckFile, runCmd, runVerification, detectProjectCommands } = require('../../shared/verificationHarness.js');
const wv = require('./webValidators.js');
const { runAcceptance } = require('./acceptance.js');
const { runSmokeTest } = require('./smokeTest.js');
const { runFunctionalSmoke } = require('./functionalSmoke.js');
const { runProjectRulesForProject } = require('./projectRules.js');
const { buildNewArtifactBlock, goalWantsPreview, goalImpliesNewArtifacts, detectAppRepo, goalIsGame } = require('../context/artifactHints.js');
const { detectPartialDeliverableState } = require('../context/partialBuild.js');
const { parseDomGateItems } = require('../context/htmlContract.js');
const { normalizeWebProject } = require('./webModuleNormalize.js');
const { pickNextMissing } = require('../loop/missingRefGuard.js');
const { findFileDeep, findIndexHtmlDeep } = require('../context/fileScan.js');

const { isNonTrivialTask } = require('../context/planArtifacts.js');

const MAX_REFLECTIONS = 3;
const MAX_REFLECTIONS_MULTI_FILE = 6;

/** Multi-file web/game builds need more gate retries than a single-file fix. */
function maxReflectionsForSession(session) {
    const pending = session?.pendingMissingRefs;
    if (Array.isArray(pending) && pending.length > 0) return MAX_REFLECTIONS_MULTI_FILE;
    const g = String(session?.goal || '').toLowerCase();
    if (/\b(game|pac-?man|html|css|website|web[\s-]?based|web[\s-]?app)\b/.test(g)) {
        return MAX_REFLECTIONS_MULTI_FILE;
    }
    return MAX_REFLECTIONS;
}

/** Goals that require creating or modifying project files (not chat-only). */
function goalImpliesBuildWork(goal) {
    return isNonTrivialTask(goal);
}

function countChar(s, ch) {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
    return n;
}

/** Heuristics for model output that looks cut off mid-file. */
function detectContentIssues(relPath, content) {
    const issues = [];
    const ext = path.extname(relPath).toLowerCase();
    const trimmed = content.replace(/\s+$/, '');

    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        const open = countChar(content, '{');
        const close = countChar(content, '}');
        if (open > close) {
            issues.push(`unbalanced braces (${open} '{' vs ${close} '}') — file may be truncated`);
        }
        // Strip correctly-backticked template literals first so we only flag `${...}`
        // interpolation that appears OUTSIDE a template literal (the actual bug).
        const noTemplates = content.replace(/`(?:\\.|[^`\\])*`/g, '``');
        if (/[^`]\$\{/.test(noTemplates) && /\b(?:repeat|translate|rotate|scale|url|rgb|hsl)\s*\(\s*[^`)]*\$\{/.test(noTemplates)) {
            issues.push('broken template literal: use backticks, e.g. `repeat(${n}, 30px)` not repeat(${n}, 30px)');
        }
        if (/\bgetElementById\s*\(\s*cell-\$\{/.test(noTemplates) || /\bid\s*=\s*cell-\$\{/.test(noTemplates)) {
            issues.push('broken template literal in cell id — wrap in backticks: `cell-${x}-${y}`');
        }
        if (/^\s*(case|else|catch|finally)\s*$/.test(trimmed.split('\n').pop() || '')) {
            issues.push('file ends on incomplete control-flow keyword');
        }
    }

    if (ext === '.css') {
        if (countChar(content, '{') > countChar(content, '}')) {
            issues.push('unbalanced CSS braces — file may be truncated');
        }
    }

    if (ext === '.html') {
        const lower = content.toLowerCase();
        if (lower.includes('<script') && !lower.includes('</script>')) {
            issues.push('HTML missing closing </script> tag');
        }
    }

    return issues;
}

/** Legacy reference-existence hint (kept for callers); runValidation does the disk check. */
function webProjectHints(filesTouched, projectRoot) {
    const hints = [];
    const names = filesTouched.map(f => f.replace(/\\/g, '/').toLowerCase());
    const indexName = names.find(f => f.endsWith('index.html')) || names.find(f => f.endsWith('.html'));
    if (!indexName) return hints;
    let html = '';
    try { html = fs.readFileSync(path.join(projectRoot, indexName), 'utf-8'); } catch (e) { return hints; }
    const { scripts, styles } = wv.extractHtmlRefs(html);
    for (const ref of [...scripts, ...styles]) {
        if (/^https?:\/\//i.test(ref)) continue;
        const rel = ref.replace(/^\.\//, '');
        if (!names.some(f => f.endsWith(rel.toLowerCase()) || f.endsWith(path.basename(rel).toLowerCase()))) {
            hints.push(`index.html references "${ref}" but that file was not written in this run — create it or fix the link`);
        }
    }
    return hints;
}

function readSafe(abs) {
    try { return fs.readFileSync(abs, 'utf-8'); } catch (e) { return null; }
}

/**
 * Full validation pass over the project. Returns a structured report; pure w.r.t. the
 * model (reads disk only). This is the single source of truth for "is it done?".
 */
/** Run PLAN milestone verify command if applicable. */
async function runMilestoneVerify(projectRoot, planArtifacts, filesTouched) {
    if (!planArtifacts?.enabled) return { passed: false, skipped: true };
    const active = planArtifacts.activeMilestone();
    const cmd = active?.verify || active?.e2e;
    const milestoneId = active?.id;
    if (!cmd || !milestoneId) return { passed: false, skipped: true };

    const skipHarness = /harness completion gate|list_project once|syntax \+ references/i.test(cmd);
    if (skipHarness) {
        if (/list_project once/i.test(cmd)) return { passed: true, milestoneId, skipped: true };
        const r = await runValidation(projectRoot, filesTouched, '', { planArtifacts });
        if (r.status === 'done' || r.ranChecks > 0 && !r.messages.length) {
            return { passed: true, milestoneId };
        }
        return { passed: false, milestoneId, messages: r.messages };
    }

    const r = await runCmd(projectRoot, cmd);
    return { passed: r.ok, milestoneId, stdout: r.stdout, stderr: r.stderr };
}

async function runPlanTestVerify(projectRoot, planArtifacts) {
    if (!planArtifacts?.enabled) return null;
    const final = planArtifacts.milestones.find(m => /^Final/i.test(m.id) && m.verify);
    if (!final?.verify) return null;
    const cmd = final.verify;
    if (/harness completion gate/i.test(cmd)) return null;
    const r = await runCmd(projectRoot, cmd);
    return r.ok ? null : `[PLAN VERIFY FAILED] ${cmd}\n${r.stderr || r.stdout}`;
}

/** Find an index.html already on disk (root, then an immediate subdir). Lets a reused
 *  workspace's web entry still be validated even when it wasn't written this run. */
const SCAN_IGNORE = new Set(['node_modules', 'dist', 'build', '.git', '.agentsmith', 'release', 'coverage', '.cache']);

function findProjectIndexHtml(projectRoot) {
    try {
        return findIndexHtmlDeep(projectRoot, 4);
    } catch (e) { /* ignore */ }
    return null;
}

// Files the user prompt explicitly names as deliverables (README.md, index.html, …).
const ARTIFACT_EXT = 'md|markdown|html?|css|js|mjs|cjs|json|txt|ya?ml|tsx?|jsx|svg|xml';
function extractRequiredArtifacts(goal) {
    const found = new Set();
    const re = new RegExp(`(^|[^/\\w.])([A-Za-z0-9_-]+\\.(?:${ARTIFACT_EXT}))\\b`, 'gi');
    for (const m of String(goal || '').matchAll(re)) found.add(m[2]);
    return [...found];
}

// Files that are legitimately empty (so existence, not content, is enough).
const EMPTY_OK = /(?:^|\/)(?:\.gitkeep|__init__\.py|py\.typed|\.nojekyll|\.gitignore)$/i;

/** True if a NON-EMPTY file with this basename exists (touched, or anywhere a few levels deep).
 *  A required deliverable that is 0 bytes is not "done". */
function artifactExists(projectRoot, name, files) {
    const base = name.toLowerCase();
    const rel = findFileDeep(projectRoot, name, 4)
        || (files || []).map(f => String(f).replace(/\\/g, '/'))
            .find(f => f.toLowerCase() === base || f.toLowerCase().endsWith('/' + base));
    if (!rel) return false;
    if (EMPTY_OK.test(name)) return true;
    try {
        const abs = path.join(projectRoot, rel);
        return fs.existsSync(abs) && fs.readFileSync(abs, 'utf8').trim().length > 0;
    } catch (e) { return false; }
}

async function runValidation(projectRoot, filesTouched, goal, opts = {}) {
    const files = [...new Set((filesTouched || []).filter(Boolean))]
        .filter(rel => fs.existsSync(path.join(projectRoot, rel)));

    const messages = [];
    const missingRefs = [];
    let ranChecks = 0;

    // --- per-file: truncation heuristics + language syntax check ---
    for (const rel of files) {
        const abs = path.join(projectRoot, rel);
        const content = readSafe(abs);
        if (content == null) continue;
        for (const m of detectContentIssues(rel, content)) messages.push(`[CONTENT] ${rel}: ${m}`);
        const syn = await syntaxCheckFile(projectRoot, rel);
        if (!syn.skipped) { ranChecks++; if (!syn.ok) messages.push(`[SYNTAX] ${syn.file || rel}: ${syn.message}`); }
    }

    // --- required artifacts: files the prompt explicitly names must exist on disk ---
    const requiredArtifacts = extractRequiredArtifacts(goal);
    if (requiredArtifacts.length) {
        ranChecks++;
        for (const name of requiredArtifacts) {
            if (!artifactExists(projectRoot, name, files)) {
                messages.push(`[ARTIFACT] ${name} is required by the prompt but missing`);
            }
        }
    }

    // --- web layer ---
    let htmlRel = files.map(f => f.replace(/\\/g, '/'))
        .find(f => f.toLowerCase().endsWith('index.html')) ||
        files.map(f => f.replace(/\\/g, '/')).find(f => f.toLowerCase().endsWith('.html'));

    // Workspace reuse: index.html may already be on disk from an earlier turn/run even if
    // it wasn't (re)written this run. For a web-app goal we MUST still validate it against
    // disk — otherwise a run that only writes e.g. utils.js falsely passes while index.html
    // references files that were never created. Skip a host app's own index.html (an
    // Electron/main.js repo), which is not the deliverable.
    if (!htmlRel && goalImpliesNewArtifacts(goal) && !detectAppRepo(projectRoot)) {
        htmlRel = findProjectIndexHtml(projectRoot);
    }

    let acceptance = { applicable: false, checks: [], failed: [] };
    let smoke = { skipped: true, reason: 'no web project', ok: true };
    let functional = { skipped: true, reason: 'no web project' };
    let hasHtml = false;
    let combinedHtml = '', combinedJs = '', combinedCss = '';

    if (htmlRel) {
        hasHtml = true;
        // Deterministic repair of inconsistent multi-file wiring (the #1 reason a "built"
        // app doesn't run on local models): classic <script> + import/export, OR type="module"
        // + code that relies on window.* globals that module scope never sets. Make it actually
        // runnable before the reference/smoke checks evaluate it. Real ES-module apps untouched.
        try { await normalizeWebProject(projectRoot, htmlRel, { changeLedger: opts.changeLedger, sessionId: opts.sessionId }); } catch (e) { /* non-fatal */ }
        const htmlAbs = path.join(projectRoot, htmlRel);
        const htmlDir = path.dirname(htmlAbs);
        combinedHtml = readSafe(htmlAbs) || '';

        // HTML well-formedness
        for (const i of wv.parseHtmlWellFormed(combinedHtml)) {
            if (i.level !== 'info') { ranChecks++; if (i.level === 'error') messages.push(`[HTML] ${i.message}`); }
        }

        // referenced files exist (disk-accurate)
        const { scripts, styles } = wv.extractHtmlRefs(combinedHtml);
        for (const ref of [...scripts, ...styles]) {
            if (/^https?:\/\//i.test(ref)) continue;
            ranChecks++;
            const refAbs = path.resolve(htmlDir, ref.replace(/^\.\//, ''));
            if (!fs.existsSync(refAbs)) {
                // Report the path RELATIVE TO PROJECT ROOT, not the bare href. When
                // index.html lives in a subdir (e.g. pacman/index.html → "script.js"),
                // the file must be created at pacman/script.js. Telling the model to
                // create bare "script.js" makes it write to the root, leaving the
                // reference missing forever (an infinite reflection loop).
                const refRel = path.relative(projectRoot, refAbs).split(path.sep).join('/');
                messages.push(`[WEB] ${htmlRel} references "${ref}" — create the file at ${refRel} (it is missing on disk)`);
                missingRefs.push(refRel);
            }
        }

        // gather css/js bodies (referenced + touched)
        const cssAbs = new Set();
        const jsAbs = new Set();
        for (const ref of styles) if (!/^https?:\/\//i.test(ref)) cssAbs.add(path.resolve(htmlDir, ref.replace(/^\.\//, '')));
        for (const ref of scripts) if (!/^https?:\/\//i.test(ref)) jsAbs.add(path.resolve(htmlDir, ref.replace(/^\.\//, '')));
        for (const rel of files) {
            const abs = path.join(projectRoot, rel);
            if (rel.toLowerCase().endsWith('.css')) cssAbs.add(abs);
            if (/\.(js|mjs|cjs)$/i.test(rel)) jsAbs.add(abs);
        }
        for (const abs of cssAbs) { const c = readSafe(abs); if (c != null) combinedCss += '\n' + c; }
        for (const abs of jsAbs) { const c = readSafe(abs); if (c != null) combinedJs += '\n' + c; }

        // CSS parses
        if (combinedCss.trim()) {
            for (const i of wv.parseCssBalanced(combinedCss)) { ranChecks++; if (i.level === 'error') messages.push(`[CSS] ${i.message}`); }
        }

        // serialization-artifact leakage (tool-call JSON bled into a written file)
        if (combinedCss.trim()) {
            ranChecks++;
            for (const i of wv.detectSerializationArtifacts(combinedCss)) if (i.level === 'error') messages.push(`[CSS] ${i.message}`);
        }
        if (combinedJs.trim()) {
            ranChecks++;
            for (const i of wv.detectSerializationArtifacts(combinedJs)) if (i.level === 'error') messages.push(`[JS] ${i.message}`);
        }
        if (combinedHtml.trim()) {
            for (const i of wv.detectSerializationArtifacts(combinedHtml)) if (i.level === 'error') { ranChecks++; messages.push(`[HTML] ${i.message}`); }
        }

        // selector ↔ DOM/JS cross-check
        if (combinedCss.trim()) {
            ranChecks++;
            const cssSel = wv.classifyCssSelectors(wv.parseCssRules(combinedCss));
            const htmlCI = wv.extractHtmlClassesIds(combinedHtml);
            const jsCI = wv.extractJsClassesIds(combinedJs);
            for (const i of wv.validateSelectorsMatch({
                cssSelectors: cssSel,
                htmlClasses: htmlCI.classes, htmlIds: htmlCI.ids,
                jsClasses: jsCI.classes, jsIds: jsCI.ids
            })) {
                if (i.level === 'error') messages.push(`[SELECTOR] ${i.message}`);
            }
            // rendered-but-unstyled classes (the "invisible game" disconnect)
            for (const i of wv.validateRenderedClassesStyled({
                cssClasses: cssSel.classes,
                appliedClasses: wv.extractJsAppliedClasses(combinedJs),
                htmlClasses: htmlCI.classes
            })) {
                if (i.level === 'error') messages.push(`[SELECTOR] ${i.message}`);
            }
        }

        // JS: undefined constants + map/data dimension consistency
        if (combinedJs.trim()) {
            ranChecks++;
            for (const i of wv.findUndefinedConstants(combinedJs)) messages.push(`[UNDEF] ${i.message}`);
            for (const i of wv.validateConstantsMatchData(combinedJs)) messages.push(`[DATA] ${i.message}`);
        }

        // DOM contract: JS must not reference ids / form controls the HTML never defines
        // (the "selectors don't match, app silently does nothing" failure).
        if (combinedJs.trim() && combinedHtml.trim()) {
            ranChecks++;
            for (const i of wv.validateDomIdConsistency({ html: combinedHtml, js: combinedJs })) {
                if (i.level === 'error') messages.push(`[DOM] ${i.message}`);
            }
        }

        // task acceptance (games)
        acceptance = runAcceptance(goal, { html: combinedHtml, js: combinedJs });
        if (acceptance.applicable) {
            ranChecks++;
            for (const c of acceptance.failed) messages.push(`[ACCEPT] required capability missing: ${c.label}`);
        }

        // browser smoke test
        smoke = runSmokeTest({ projectRoot, indexRel: htmlRel });
        if (smoke && !smoke.skipped) {
            ranChecks++;
            if (!smoke.ok) for (const e of (smoke.errors || [])) messages.push(`[SMOKE] ${e}`);
        }

        // Real-browser runtime check (injected engine: Electron BrowserWindow in-app, Puppeteer
        // in the harness/tests). Serves the project over HTTP and loads it for real, surfacing
        // uncaught exceptions, module errors ("does not provide an export named X"), undefined
        // globals, and 404s as [RUNTIME] feedback — so the model fixes the actual failure
        // instead of the gate falsely passing an app that doesn't run. Fail-open on infra error.
        if (typeof opts.runtimeVerify === 'function') {
            try {
                const rt = await opts.runtimeVerify(projectRoot, htmlRel);
                if (rt && !rt.skipped) {
                    ranChecks++;
                    if (!rt.ok) for (const e of (rt.errors || [])) messages.push(`[RUNTIME] ${e}`);
                }
            } catch (e) { /* non-fatal */ }
        }

        // Functional smoke (jsdom, optional dep): for interactive/CRUD goals, drive the first
        // form and confirm it works. Errors block; if jsdom is unavailable it is RECORDED (not
        // silently skipped) but never blocks — you cannot fail a build over a missing dev dep.
        try {
            functional = await runFunctionalSmoke({ projectRoot, htmlRel, goal });
            if (!functional.skipped && !functional.unavailable) {
                ranChecks++;
                for (const e of (functional.errors || [])) messages.push(`[FUNCTIONAL] ${e}`);
            }
        } catch (e) { functional = { skipped: true, reason: 'functional smoke error' }; }
    }

    const planMsg = await runPlanTestVerify(projectRoot, opts.planArtifacts);
    if (planMsg) messages.push(planMsg);

    const rulesResult = await runProjectRulesForProject(projectRoot, filesTouched);
    if (!rulesResult.ok) {
        ranChecks++;
        messages.push(...rulesResult.messages);
    }

    if (opts.grindMode) {
        const meta = opts.projectMeta || detectProjectCommands(projectRoot);
        const plan = {
            lintCmd: meta.lintCmd,
            testCmd: meta.testCmd,
            e2eCmd: meta.e2eCmd,
            filesLedger: Object.fromEntries(files.map(f => [f, true]))
        };
        const grind = await runVerification(projectRoot, plan, { syntaxOnly: false });
        if (!grind.ok) {
            ranChecks++;
            messages.push(...grind.messages);
        } else if (grind.unverified && (meta.lintCmd || meta.testCmd || meta.e2eCmd)) {
            ranChecks++;
        }
    }

    // If nothing else produced a verification signal, but the agent itself ran its
    // code/test successfully (exit 0) since its last edit, count that as a real check
    // rather than stamping a runnable project "unverified".
    if (ranChecks === 0 && opts.agentRanOkAfterEdit) ranChecks++;

    const status = deriveStatus({ filesCount: files.length, ranChecks, messages, hasHtml });
    return { messages, missingRefs, ranChecks, status, acceptance, smoke, functional, hasHtml, allow: status === 'done' };
}

function deriveStatus({ filesCount, ranChecks, messages, hasHtml }) {
    if (messages.length) return 'incomplete';
    if (filesCount === 0) return 'unverified';
    if (ranChecks === 0 && !hasHtml) return 'unverified';
    return 'done';
}

/**
 * Backwards-compatible gate used by the reflection loop. allow=false blocks completion.
 */
async function checkCompletion(projectRoot, filesTouched, goal, opts = {}) {
    const files = [...new Set((filesTouched || []).filter(Boolean))];
    if (!files.length) {
        const smoke = { skipped: true, reason: 'no files touched', ok: true };
        if (goalImpliesBuildWork(goal)) {
            return {
                allow: false,
                ranChecks: 0,
                checked: 0,
                messages: [
                    'No project files were created or modified yet. You must use tools — do not reply with text only.',
                    'Create the files your task needs with write_file (or patch to edit existing files): for a web app that is typically index.html plus the CSS/JS it links; for a script, CLI, library, or service it is the source/module files the task describes.',
                    'Call write_file or patch now; list_project is optional because the bootstrap includes the tree.'
                ],
                status: 'incomplete',
                acceptance: { applicable: false, checks: [], failed: [] },
                smoke
            };
        }
        return {
            allow: true,
            ranChecks: 0,
            checked: 0,
            messages: [],
            status: 'unverified',
            acceptance: { applicable: false, checks: [] },
            smoke
        };
    }
    const r = await runValidation(projectRoot, filesTouched, goal, opts);
    const grindBlocked = (r.messages || []).some(m => /^\[(?:LINT|TEST|E2E) FAILED\]/i.test(m));
    return {
        allow: r.allow,
        ranChecks: r.ranChecks,
        checked: r.ranChecks,
        messages: r.messages,
        missingRefs: r.missingRefs || [],
        status: r.status,
        acceptance: r.acceptance,
        smoke: r.smoke,
        grindBlocked
    };
}

function formatBeforeDoneMessage(messages) {
    return [
        '[COMPLETION BLOCKED] Harness beforeDone hook rejected completion:',
        '',
        ...(messages || []).map(m => `- ${m}`),
        '',
        'Address the issues above, then continue with tool calls.'
    ].join('\n');
}

function formatGateMessage(result, goal, projectRoot) {
    const msgs = result.messages || [];
    const missing = result.missingRefs || [];
    const artifactMissing = msgs
        .map(m => /^\[ARTIFACT\]\s+(\S+)/i.exec(m)?.[1])
        .filter(Boolean);

    const domMsgs = msgs.filter(m => /^\[DOM\]/i.test(m));
    if (domMsgs.length) {
        const repairs = parseDomGateItems(domMsgs);
        const artifactOnly = msgs.filter(m => /^\[ARTIFACT\]/i.test(m));
        const other = msgs.filter(m => !/^\[(DOM|ARTIFACT)\]/i.test(m));
        const lines = [
            '[COMPLETION BLOCKED] JavaScript uses element ids that do not exist in index.html.',
            '',
            'Fix script.js with patch — rename getElementById calls to match the HTML (HTML is canonical):',
            ...repairs.slice(0, 10).map(({ wrong, right }) => right
                ? `  '${wrong}' → '${right}'`
                : `  remove/replace '${wrong}' (not in HTML)`),
            '',
            'Do NOT rewrite index.html. Do NOT re-explore — patch script.js now.',
            'Form fields: use ids from HTML (transaction-type, transaction-amount, etc.) or add name attributes and read via FormData correctly.'
        ];
        if (artifactOnly.length) {
            lines.push('', 'Also create missing prompt files:', ...artifactOnly.map(m => `  - ${m}`));
        }
        if (other.length) {
            lines.push('', 'Also failing:', ...other.slice(0, 6).map(m => `  - ${m}`));
        }
        return lines.join('\n');
    }

    // Missing referenced files are the #1 reason weak models stall (they keep rewriting
    // index.html). Lead with an explicit, single next action and forbid the rewrite.
    if (missing.length || artifactMissing.length) {
        const other = msgs.filter(m => !/missing on disk/i.test(m) && !/^\[ARTIFACT\]/i.test(m));
        const partial = projectRoot ? detectPartialDeliverableState(projectRoot, goal, []) : null;
        const nextFile = pickNextMissing(missing)
            || artifactMissing.find(n => /\.(js|mjs|cjs)$/i.test(n))
            || partial?.nextFile
            || artifactMissing[0]
            || null;
        const header = missing.length
            ? '[COMPLETION BLOCKED] Linked files from index.html are still missing on disk.'
            : '[COMPLETION BLOCKED] Required deliverable files from the prompt are still missing on disk.';
        const lines = [
            header,
            '',
            nextFile
                ? 'Your NEXT tool call MUST be exactly one write_file:'
                : 'Your NEXT tool call(s) MUST create these missing files with write_file (one per call):',
            nextFile
                ? `  write_file path="${nextFile}" — COMPLETE ${/\.css$/i.test(nextFile) ? 'CSS' : /\.(md|markdown)$/i.test(nextFile) ? 'README documentation' : 'JavaScript'} (not HTML)`
                : null,
            ...(nextFile ? [] : [...missing, ...artifactMissing].map(r => `  - ${r}`)),
            ...(nextFile && (missing.length + artifactMissing.length) > 1
                ? ['', `Also still needed (after ${nextFile}): ${[...missing, ...artifactMissing].filter(r => r !== nextFile).join(', ')}`]
                : []),
            '',
            'Do NOT rewrite index.html again — it already exists and is fine.',
            goalIsGame(goal)
                ? 'For a game: keyboard input, score updates, game loop (requestAnimationFrame/setInterval), win/lose state.'
                : 'Each .js must contain COMPLETE working app behavior (event handlers, state, persistence) — no placeholders.'
        ].filter(Boolean);
        if (artifactMissing.some(n => /readme/i.test(n))) {
            lines.push('', 'README.md: include project title, how to open index.html, and a short feature list.');
        }
        if (other.length) {
            lines.push('', 'Also still failing (fix after the files exist):', ...other.map(m => `  - ${m}`));
        }
        return lines.join('\n');
    }

    const noOutput = msgs.some(m => /no project files were created/i.test(m));
    const artifactHint = noOutput && goal
        ? buildNewArtifactBlock(goal, projectRoot || '')
        : '';
    const previewHint = noOutput && goalWantsPreview(goal)
        ? 'Once the files exist and load cleanly, call show_preview on your index.html.'
        : '';
    const lines = noOutput
        ? [
            '[COMPLETION BLOCKED] You stopped without writing any files. This task requires code on disk.',
            '',
            ...msgs.map(m => `- ${m}`),
            ...(artifactHint ? ['', artifactHint.trim()] : []),
            '',
            'Respond with tool calls only — use write_file to create files or patch to edit them.',
            'Do not summarize or plan in prose; execute the next tool call.',
            ...(previewHint ? [previewHint] : [])
        ]
        : [
            '[COMPLETION BLOCKED] The run cannot finish yet — these checks failed. Fix them on disk, then continue:',
            '',
            ...msgs.map(m => `- ${m}`),
            '',
            msgs.some(m => /^\[(DOM|ARTIFACT|FUNCTIONAL)\]/.test(m))
                ? 'Repair required: apply the SMALLEST patch that resolves each item above — rename the selector/control in index.html OR script.js so they match (not both), or create the missing file. Do NOT re-explore or rewrite from scratch; make the targeted edits now with patch.'
                : 'Use read_file to inspect broken files. Use patch or write_file to fix them.',
            ...(msgs.some(m => /^\[(WEB|SELECTOR|DOM|HTML|CSS|SMOKE|RUNTIME|UNDEF|DATA|ACCEPT|FUNCTIONAL)\]/.test(m))
                ? ['All files must parse, every referenced file must exist, CSS selectors must match the classes/ids',
                    'used in JS/HTML, constants must match map/array dimensions, and the page must load without errors.']
                : ['Every file must parse and the program must run without errors.'])
        ];
    return lines.join('\n');
}

module.exports = {
    MAX_REFLECTIONS,
    MAX_REFLECTIONS_MULTI_FILE,
    maxReflectionsForSession,
    detectContentIssues,
    webProjectHints,
    runValidation,
    runMilestoneVerify,
    deriveStatus,
    checkCompletion,
    findProjectIndexHtml,
    formatGateMessage,
    formatBeforeDoneMessage,
    goalImpliesBuildWork
};
