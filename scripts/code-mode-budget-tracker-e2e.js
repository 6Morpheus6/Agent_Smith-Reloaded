#!/usr/bin/env node
/**
 * Code Mode E2E — Personal Budget Tracker (full prompt battery).
 *
 * Drives the REAL Code Mode entry point (runCodeTask) — same path as ipc/code.js.
 * Does NOT touch Agent mode or Chat mode.
 *
 * Usage:
 *   LMS_URL=http://127.0.0.1:1234 node scripts/code-mode-budget-tracker-e2e.js [model-id]
 *
 * Env:
 *   MAXTURNS=40     turn cap (default 40)
 *   KEEP=1          keep workspace dir for inspection
 *   OUT=path.json   write machine-readable report
 *   WORKSPACE=path  use fixed workspace instead of temp dir (default: isolated greenfield)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const projectContext = require(path.join(ROOT, 'src/main/services/projectContext.js'));
const ChangeLedger = require(path.join(ROOT, 'src/main/services/changeLedger.js'));
const EditEngine = require(path.join(ROOT, 'src/main/services/editEngine.js'));
const { grepProject } = require(path.join(ROOT, 'src/shared/grepTool.js'));
const { globFiles } = require(path.join(ROOT, 'src/shared/globTool.js'));
const { runCodeTask } = require(path.join(ROOT, 'src/code/loop/runCodeTask.js'));
const { checkCompletion } = require(path.join(ROOT, 'src/code/governor/completionGate.js'));
const { runAcceptance } = require(path.join(ROOT, 'src/code/governor/acceptance.js'));
const { runSmokeTest } = require(path.join(ROOT, 'src/code/governor/smokeTest.js'));

const LMS = process.env.LMS_URL || 'http://127.0.0.1:1234';

const PROMPT = `Build a complete **Personal Budget Tracker** web app from scratch in this workspace. This should be a polished offline app, but keep it simpler than a full Kanban system. Core requirements: 1. Files Create or update these files: * \`index.html\` * \`style.css\` * \`script.js\` * \`README.md\` Do not create unnecessary extra folders unless needed. 2. App features The app should let the user: * Add income transactions * Add expense transactions * Edit a transaction * Delete a transaction * Categorize transactions * Filter by income, expense, category, and month * Search transactions by description * See total income * See total expenses * See current balance * See spending by category 3. Transaction fields Each transaction should have: * Unique ID * Type: income or expense * Description * Amount * Category * Date * Created timestamp * Updated timestamp 4. Categories Include default categories: * Paycheck * Freelance * Food * Bills * Transportation * Shopping * Entertainment * Health * Other Allow the user to add a custom category. 5. Persistence Use \`localStorage\`. The app must save: * Transactions * Categories * Theme preference * Last selected filters After refreshing the page, data should still be there. 6. UI requirements Build a clean responsive interface with: * Dark theme by default * Light theme toggle * Summary cards for income, expenses, balance * Transaction form * Transaction list/table * Filter/search bar * Category summary section * Empty state when there are no transactions * Toast or visible messages for add/edit/delete actions 7. Validation Handle: * Empty description * Invalid amount * Missing category * Invalid date * Negative numbers * Delete confirmation Do not let invalid transactions be saved. 8. Import / Export Add: * Export data to JSON * Import data from JSON * Validate imported JSON before replacing current data 9. Verification Before claiming done, verify: * App loads with no missing linked files * Add income works * Add expense works * Totals update correctly * Edit transaction works * Delete transaction works * Filters work * Search works * localStorage persistence works after refresh * Theme toggle persists * Export creates valid JSON * Import restores transactions and categories 10. Final response When finished, report: * Files created or changed * How to run/open the app * What features were verified * Any known limitations Important: Do not write HTML into CSS files. Do not leave missing \`script.js\` or \`style.css\`. Do not claim success unless every linked file exists and the app runs. Do not restart from scratch if a file already exists and only needs a small fix.`;

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-e2e-data-'));
const changeLedger = new ChangeLedger(userDataPath);
const editEngine = new EditEngine(changeLedger, projectContext);

const bgProcesses = new Map();
let nextJobId = 1;

function spawnShell(command, cwd) {
    const cfg = projectContext.getShellConfig();
    if (projectContext.isWindows()) {
        return spawn(cfg.shell, [cfg.flag, cfg.commandFlag, command], { cwd, shell: false });
    }
    return spawn(cfg.shell, [cfg.flag, command], { cwd });
}

function buildExecDeps(sessionId) {
    return {
        sessionId, projectContext, editEngine, changeLedger, grepProject, globFiles,
        relPathFromRoot: (p) => {
            const r = projectContext.getRootOrNull();
            return r ? path.relative(r, p) : p;
        },
        fireHook: async () => null,
        invokePluginTool: async () => ({ __notFound: true }),
        showPreview: null,
        browserVerify: null,
        runForegroundCommand: (command, cwd) => new Promise((resolve) => {
            exec(command, { cwd, timeout: 120000 }, (error, stdout, stderr) =>
                resolve({ error: error ? error.message : null, stdout: stdout || '', stderr: stderr || '' }));
        }),
        runBackgroundCommand: (command, cwd) => {
            const jobId = nextJobId++;
            const child = spawnShell(command, cwd);
            const procInfo = { log: [], running: true };
            bgProcesses.set(jobId, procInfo);
            const append = (d) => {
                procInfo.log.push(...d.toString().split('\n').filter(Boolean));
                if (procInfo.log.length > 500) procInfo.log = procInfo.log.slice(-500);
            };
            child.stdout?.on('data', append);
            child.stderr?.on('data', append);
            child.on('close', (code) => { procInfo.log.push(`[exit ${code}]`); procInfo.running = false; });
            return { stdout: `Background job ${jobId} started`, jobId };
        }
    };
}

function readSafe(root, rel) {
    try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

function listFiles(root) {
    const out = [];
    function walk(dir) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === '.git' || e.name === '.agentsmith') continue;
                walk(p);
            } else {
                out.push(path.relative(root, p).split(path.sep).join('/'));
            }
        }
    }
    walk(root);
    return out;
}

/** Post-run artifact checks (deterministic; complements completion gate). */
function verifyArtifacts(projectRoot, filesTouched) {
    const checks = [];
    const pass = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });
    const all = listFiles(projectRoot);
    const combined = all.map(f => readSafe(projectRoot, f) || '').join('\n');
    const html = readSafe(projectRoot, 'index.html') || '';
    const css = readSafe(projectRoot, 'style.css') || '';
    const js = readSafe(projectRoot, 'script.js') || '';
    const readme = readSafe(projectRoot, 'README.md') || '';

    pass('file:index.html', fs.existsSync(path.join(projectRoot, 'index.html')));
    pass('file:style.css', fs.existsSync(path.join(projectRoot, 'style.css')));
    pass('file:script.js', fs.existsSync(path.join(projectRoot, 'script.js')));
    pass('file:README.md', fs.existsSync(path.join(projectRoot, 'README.md')));
    pass('html:links-css', /href\s*=\s*["']style\.css["']/i.test(html));
    pass('html:links-js', /src\s*=\s*["']script\.js["']/i.test(html));
    pass('css:not-html', !/<(?:!doctype|html|body)\b/i.test(css), 'CSS must not contain HTML');
    pass('js:not-html', !/<(?:!doctype|html|body)\b/i.test(js), 'JS must not contain HTML');
    pass('js:localStorage', /localStorage\s*\.\s*(setItem|getItem)/i.test(js));
    pass('js:income-expense', /\bincome\b/i.test(js) && /\bexpense\b/i.test(js));
    pass('js:categories', /\b(Paycheck|Food|Bills|Transportation|Other)\b/i.test(combined));
    pass('js:import-export', /\bexport\b/i.test(combined) && /\bimport\b/i.test(combined));
    pass('js:filter-or-search', /(filter|search)/i.test(js));
    pass('js:theme', /(theme|dark|light)/i.test(combined));
    pass('readme:nonempty', readme.trim().length > 40);

    return checks;
}

async function postVerify(projectRoot, session) {
    const filesTouched = session?.filesTouched || listFiles(projectRoot);
    const gate = await checkCompletion(projectRoot, filesTouched, PROMPT, {
        grindMode: false,
        planArtifacts: session?.planArtifacts
    });
    const html = readSafe(projectRoot, 'index.html') || '';
    const js = readSafe(projectRoot, 'script.js') || '';
    const acceptance = runAcceptance(PROMPT, { html, js });
    const smoke = runSmokeTest({ projectRoot, indexRel: 'index.html' });
    const artifacts = verifyArtifacts(projectRoot, filesTouched);
    const artifactFails = artifacts.filter(c => !c.ok);
    return { gate, acceptance, smoke, artifacts, artifactFails };
}

async function pickModel(argvModel) {
    if (argvModel) return argvModel;
    const r = await fetch(`${LMS}/v1/models`).then(x => x.json()).catch(() => null);
    const ids = (r?.data || []).map(d => d.id).filter(id => !/embed/i.test(id));
    return ids.find(id => /qwen.*coder|gemma|llama|mistral/i.test(id)) || ids[0];
}

(async () => {
    const model = await pickModel(process.argv[2]);
    if (!model) {
        console.error('No model at ' + LMS + ' — start LM Studio and load a coding model.');
        process.exit(2);
    }

    const projectRoot = process.env.WORKSPACE
        || fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-e2e-'));
    const maxTurns = parseInt(process.env.MAXTURNS || '40', 10);

    projectContext.setRoot(projectRoot);
    fs.mkdirSync(projectRoot, { recursive: true });

    console.log('\n=== Code Mode E2E: Personal Budget Tracker ===');
    console.log('  model:     ', model);
    console.log('  endpoint:  ', LMS);
    console.log('  workspace: ', projectRoot);
    console.log('  maxTurns:  ', maxTurns);
    console.log('');

    const events = [];
    const t0 = Date.now();
    let session;
    try {
        session = await runCodeTask({
            prompt: PROMPT,
            projectRoot,
            model,
            numCtx: Number(process.env.NUMCTX) || 8192,
            apiBaseUrl: LMS,
            userDataPath,
            projectContext,
            buildExecDeps,
            emit: (ev) => {
                events.push(ev);
                if (ev.type === 'tool_start') {
                    process.stdout.write(`  [turn ${ev.turn || '?'}] ${ev.name} ${ev.args?.path || ev.args?.command || ''}\n`);
                } else if (ev.type === 'verify_blocked') {
                    process.stdout.write(`  [gate blocked] ${(ev.messages || []).slice(0, 2).join(' | ')}\n`);
                } else if (ev.type === 'phase_change') {
                    process.stdout.write(`  [phase] ${ev.phase}\n`);
                }
            },
            maxTurns,
            codeTemperature: 0.2,
            grindMode: true
        });
    } catch (e) {
        console.error('\nRUN CRASH:', e.message);
        process.exit(2);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const post = await postVerify(projectRoot, session);

    const toolNames = events.filter(e => e.type === 'tool_start').map(e => e.name);
    const writes = events.filter(e => e.type === 'tool_result' && e.ok &&
        ['write_file', 'patch', 'append_file'].includes(e.name));

    console.log('\n── Run summary ──');
    console.log('  status:      ', session?.status);
    console.log('  turns:       ', session?.turn);
    console.log('  tools:       ', toolNames.length, '(' + [...new Set(toolNames)].join(', ') + ')');
    console.log('  filesTouched:', (session?.filesTouched || []).join(', ') || '(none)');
    console.log('  elapsed:     ', elapsed + 's');
    console.log('  gate.allow:  ', post.gate.allow, '→', post.gate.status);
    if (post.gate.messages?.length) {
        console.log('  gate msgs:   ', post.gate.messages.slice(0, 6).join(' | '));
    }
    if (post.acceptance.applicable) {
        console.log('  acceptance:  ', post.acceptance.failed.length ? 'FAIL' : 'PASS',
            post.acceptance.failed.map(f => f.label).join(', ') || '');
    }
    console.log('  smoke:       ', post.smoke.skipped ? 'skipped' : (post.smoke.ok ? 'PASS' : 'FAIL'));
    if (post.smoke.errors?.length) console.log('    ', post.smoke.errors.slice(0, 3).join(' | '));

    console.log('\n── Artifact checks ──');
    for (const c of post.artifacts) {
        console.log(`  ${c.ok ? '✓' : '✗'} ${c.id}${c.detail ? ' — ' + c.detail : ''}`);
    }

    const runOk = session?.status === 'done' && post.gate.allow && !post.artifactFails.length
        && (!post.acceptance.applicable || !post.acceptance.failed.length)
        && (post.smoke.skipped || post.smoke.ok);

    const report = {
        model,
        endpoint: LMS,
        projectRoot,
        elapsedSec: +elapsed,
        runOk,
        sessionStatus: session?.status,
        turns: session?.turn,
        filesTouched: session?.filesTouched,
        gate: { allow: post.gate.allow, status: post.gate.status, messages: post.gate.messages },
        acceptance: post.acceptance,
        smoke: post.smoke,
        artifacts: post.artifacts,
        finalSummary: session?.finalSummary,
        validation: session?.validation
    };

    if (process.env.OUT) {
        fs.writeFileSync(process.env.OUT, JSON.stringify(report, null, 2));
        console.log('\nWrote', process.env.OUT);
    }

    if (process.env.KEEP) {
        console.log('\nKEEP: workspace at', projectRoot);
    } else if (!process.env.WORKSPACE) {
        try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch { /* ignore */ }

    console.log('\n' + (runOk ? 'RESULT: PASS' : 'RESULT: FAIL'));
    process.exit(runOk ? 0 : 1);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
