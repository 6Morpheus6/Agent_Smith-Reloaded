#!/usr/bin/env node
/**
 * Headless Code Mode smoke — extractor + ledger revert (no LM Studio).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const projectContext = require('../src/main/services/projectContext.js');
const ChangeLedger = require('../src/main/services/changeLedger.js');
const EditEngine = require('../src/main/services/editEngine.js');
const { executeTool } = require('../src/code/tools/executor.js');

async function main() {
    const dir = path.join(os.tmpdir(), `code-smoke-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    projectContext.setRoot(dir);
    const ledger = new ChangeLedger(path.join(dir, '.xk'));
    const editEngine = new EditEngine(ledger, projectContext);
    const sessionId = 'smoke_session';
    const deps = {
        sessionId,
        projectContext,
        editEngine,
        changeLedger: ledger,
        grepProject: async () => ({ hits: [] }),
        globFiles: async () => ({ files: [] }),
        relPathFromRoot: (p) => path.relative(dir, p).replace(/\\/g, '/'),
        runForegroundCommand: async () => ({ stdout: 'ok' }),
        runBackgroundCommand: async () => ({ jobId: 1 })
    };
    await executeTool('write_file', { path: 'a.txt', content: 'v1\n' }, deps);
    await executeTool('patch', { path: 'a.txt', find: 'v1', replace: 'v2' }, deps);
    const rev = await ledger.revertAll(sessionId);
    if (!rev.success && rev.errors?.length) throw new Error(rev.errors.join('; '));
    console.log('code-smoke: OK');
}

main().catch(e => { console.error(e); process.exit(1); });
