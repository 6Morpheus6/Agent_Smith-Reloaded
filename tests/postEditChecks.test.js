const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { runPostEditChecks, buildScopedLintCommand } = require('../src/code/governor/postEditChecks.js');
const { runMiddlewareChain, createDefaultMiddleware, mergeSensorWarnings } = require('../src/code/loop/middleware.js');
const { detectProjectCommands, runLint, runTest } = require('../src/shared/verificationHarness.js');

test('detectProjectCommands finds npm lint and test', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcmd-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: 't',
        scripts: { lint: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' }
    }));
    const meta = detectProjectCommands(root);
    assert.equal(meta.lintCmd, 'npm run lint');
    assert.equal(meta.testCmd, 'npm test');
});

test('runLint reports failure with prefix', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-fail-'));
    const r = await runLint(root, 'node -e "process.exit(1)"');
    assert.equal(r.ok, false);
    assert.match(r.messages[0], /\[LINT FAILED\]/);
});

test('postEditChecks surfaces project rule violation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pec-rule-'));
    const rulesDir = path.join(root, '.agentsmith', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'no-foo.js'), `
module.exports = {
    id: 'no-foo',
    match: (p) => p.endsWith('.js'),
    check: async (ctx) => ctx.content.includes('FORBIDDEN')
        ? { ok: false, message: 'contains FORBIDDEN', fix: 'remove FORBIDDEN' }
        : { ok: true }
};
`);
    const rel = 'src/app.js';
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'const x = "FORBIDDEN";\n');

    const sensor = await runPostEditChecks(root, rel, {}, {});
    assert.ok(sensor.warnings.some(w => /\[RULE:no-foo\]/.test(w)));
    assert.ok(sensor.remediation.some(r => /remove FORBIDDEN/.test(r)));
});

test('postEditSensors middleware merges warnings into tool result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-sensor-'));
    const rel = 'index.js';
    fs.writeFileSync(path.join(root, rel), 'console.log(1);\n');

    const rulesDir = path.join(root, '.agentsmith', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.copyFileSync(
        path.join(__dirname, '..', 'examples', 'agentsmith-rules', 'no-console-in-src.js'),
        path.join(rulesDir, 'no-console-in-src.js')
    );
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const srcRel = 'src/index.js';
    fs.writeFileSync(path.join(root, srcRel), 'console.log("hi");\n');

    const toolResult = { success: true, relPath: srcRel };
    const mw = createDefaultMiddleware({});
    const post = mw.find(m => m.name === 'postEditSensors');
    assert.ok(post);

    const emitted = [];
    await post.afterTool({
        ctx: { emit: (ev) => emitted.push(ev) },
        session: { projectRoot: root, projectMeta: {} },
        payload: { name: 'write_file', args: { path: srcRel }, toolResult, ok: true }
    });

    assert.ok(Array.isArray(toolResult.warnings));
    assert.ok(toolResult.warnings.length > 0);
    assert.equal(emitted[0]?.type, 'sensor_result');
});

test('mergeSensorWarnings deduplicates', () => {
    const tr = { warnings: ['a'] };
    mergeSensorWarnings(tr, { warnings: ['a', 'b'], remediation: ['fix b'] });
    assert.deepEqual(tr.warnings, ['a', 'b']);
    assert.deepEqual(tr.sensorRemediation, ['fix b']);
});

test('buildScopedLintCommand returns null without eslint config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-eslint-'));
    assert.equal(buildScopedLintCommand(root, 'foo.js'), null);
});
