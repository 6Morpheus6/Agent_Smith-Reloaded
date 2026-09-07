const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const projectContext = require('../src/main/services/projectContext.js');
const ChangeLedger = require('../src/main/services/changeLedger.js');
const EditEngine = require('../src/main/services/editEngine.js');
const verificationHarness = require('../src/shared/verificationHarness.js');
const { applyPatchToFile, applySearchReplace } = require('../src/shared/editFormats.js');
const { extractToolCallsFromText } = require('../src/code/tools/extractor.js');
const { grepProject } = require('../src/shared/grepTool.js');
const { globFiles } = require('../src/shared/globTool.js');
const { buildRepoMap } = require('../src/shared/repoMap.js');

test('ledger snapshot and revert', async () => {
    const testDir = path.join(os.tmpdir(), `xk-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    const ledger = new ChangeLedger(testDir);
    const planId = 'test_plan';
    const filePath = path.join(testDir, 'sample.txt');
    fs.writeFileSync(filePath, 'hello world\n');
    await ledger.snapshotBefore(planId, filePath, 'write');
    fs.writeFileSync(filePath, 'changed\n');
    const revert = await ledger.revertAll(planId);
    assert.ok(revert.reverted.length >= 1);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'hello world\n');
});

test('edit engine apply', async () => {
    const testDir = path.join(os.tmpdir(), `xk-edit-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    projectContext.setRoot(testDir);
    const ledger = new ChangeLedger(testDir);
    const editEngine = new EditEngine(ledger, projectContext);
    const filePath = path.join(testDir, 'a.txt');
    fs.writeFileSync(filePath, 'foo bar\n');
    const res = await editEngine.apply('p1', 'a.txt', 'bar', 'baz');
    assert.equal(res.success, true);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'foo baz\n');
});

test('code extractor recovers calls from content', () => {
    const tag = extractToolCallsFromText('<tool_call>{"name":"read_file","arguments":{"path":"a.js"}}</tool_call>', new Set(['read_file']));
    assert.equal(tag[0].function.name, 'read_file');
    assert.equal(tag[0].function.arguments.path, 'a.js');

    const fenced = extractToolCallsFromText('ok\n```json\n{"function":{"name":"patch","arguments":{"path":"x","find":"a","replace":"b"}}}\n```', new Set(['patch']));
    assert.equal(fenced[0].function.name, 'patch');

    const params = extractToolCallsFromText('{"name":"write_file","parameters":{"path":"f","content":"hi"}}', new Set(['write_file']));
    assert.equal(params[0].function.arguments.content, 'hi');
});

test('code extractor ignores prose and unknown tools', () => {
    assert.equal(extractToolCallsFromText('Let me think about the approach first.', new Set(['read_file'])), null);
    assert.equal(extractToolCallsFromText('Example: {"name":"foobar","arguments":{}}', new Set(['read_file'])), null);
});

test('grep and glob', async () => {
    const testDir = path.join(os.tmpdir(), `xk-grep-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'findme.js'), 'const TOKEN = 1;\n');
    projectContext.setRoot(testDir);
    const g = await grepProject(testDir, 'TOKEN');
    assert.ok(g.hits.length >= 1);
    const gl = await globFiles(testDir, '**/*.js');
    assert.ok(gl.files.some(f => f.endsWith('findme.js')));
});

test('repo map builds', () => {
    const testDir = path.join(os.tmpdir(), `xk-map-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'package.json'), '{"name":"t","scripts":{"test":"node -e 0"}}');
    const map = buildRepoMap(testDir, { maxTokens: 500 });
    assert.ok(map.includes('package.json'));
});

test('apply_patch preserves lines outside the hunk', () => {
    const original = ['line1', 'line2', 'target_old', 'line4', 'line5'].join('\n');
    const patch = ['--- a/f.js', '+++ b/f.js', '@@ -3,1 +3,1 @@', '-target_old', '+target_new'].join('\n');
    const r = applyPatchToFile(original, patch);
    assert.equal(r.content, ['line1', 'line2', 'target_new', 'line4', 'line5'].join('\n'));
});

test('apply_patch leading insertion lands at anchor, not file top', () => {
    const original = ['a', 'b', 'c'].join('\n');
    const patch = ['--- a/f', '+++ b/f', '@@ -2,1 +2,2 @@', '+b0', ' b'].join('\n');
    const r = applyPatchToFile(original, patch);
    assert.equal(r.content, ['a', 'b0', 'b', 'c'].join('\n'));
});

test('search/replace whitespace-tolerant match', () => {
    // find uses different indentation than the file; matcher should still locate it
    const content = 'function foo() {\n    return 1;\n}\n';
    const r = applySearchReplace(content, 'function foo() {\nreturn 1;\n}', 'function foo() {\n    return 2;\n}');
    assert.ok(!r.error, r.error);
    assert.equal(r.note, 'whitespace-tolerant');
    assert.ok(r.content.includes('return 2;'));
});
const netGuard = require('../src/shared/netGuard.js');

test('netGuard proxy allowlist blocks SSRF, allows local LLM', () => {
    const llm = 'http://127.0.0.1:1234';
    assert.ok(netGuard.validateProxyTarget('http://127.0.0.1:1234/v1/models', llm));
    assert.ok(netGuard.validateProxyTarget('http://localhost:1234/v1/chat/completions', llm));
    assert.ok(netGuard.validateProxyTarget('http://192.168.1.50:1234/v1/models', 'http://192.168.1.50:1234'));
    // SSRF targets rejected
    assert.equal(netGuard.validateProxyTarget('http://169.254.169.254/latest/meta-data/', llm), null);
    assert.equal(netGuard.validateProxyTarget('http://metadata.google.internal/x', llm), null);
    assert.equal(netGuard.validateProxyTarget('http://evil.example.com/x', llm), null);
    assert.equal(netGuard.validateProxyTarget('http://10.0.0.5:8080/admin', llm), null);
    assert.equal(netGuard.validateProxyTarget('file:///etc/passwd', llm), null);
    assert.equal(netGuard.validateProxyTarget('not a url', llm), null);
});

test('netGuard download path stays inside allowed roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-dl-'));
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    const good = path.join(sub, 'report.txt');
    fs.writeFileSync(good, 'hi');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-out-'));
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'top');

    assert.ok(netGuard.validateDownloadPath(good, [root]));
    assert.equal(netGuard.validateDownloadPath(secret, [root]), null);
    assert.equal(netGuard.validateDownloadPath(root, [root]), null); // directory, not a file
    assert.equal(netGuard.validateDownloadPath(path.join(root, 'missing.txt'), [root]), null);
    // symlink escape (needs privilege on Windows; skip if unavailable)
    try {
        const link = path.join(root, 'escape.txt');
        fs.symlinkSync(secret, link);
        assert.equal(netGuard.validateDownloadPath(link, [root]), null);
    } catch (e) { /* EPERM on Windows without admin — realpath containment still covered above */ }
});

test('A3: search/replace refuses an ambiguous whitespace-tolerant match', () => {
    // Two indentation-only-different blocks both normalize to the same find; editing
    // the first silently would corrupt the wrong site. Expect a multiple-match error.
    const content = 'if (a) {\n  do();\n}\nif (a) {\n  do();\n}\n';
    const r = applySearchReplace(content, 'if (a) {\ndo();\n}', 'if (a) { done(); }');
    assert.ok(r.error && /multiple/i.test(r.error), `expected multiple-match error, got ${JSON.stringify(r)}`);
});

test('A3: apply_patch uses the hunk line number to disambiguate a repeated target line', () => {
    const original = ['a', 'dup', 'b', 'dup', 'c'].join('\n');
    // target the SECOND "dup" (line 4) — without line-number anchoring the matcher hits the first
    const patch = ['--- a/f', '+++ b/f', '@@ -4,1 +4,1 @@', '-dup', '+DUP2'].join('\n');
    const r = applyPatchToFile(original, patch);
    assert.equal(r.content, ['a', 'dup', 'b', 'DUP2', 'c'].join('\n'));
});

test('A5: verification syntax-checks touched files when no test/lint command is set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-a5bad-'));
    fs.writeFileSync(path.join(dir, 'bad.js'), 'function broken( {\n');
    const plan = { verifyPolicy: 'block', lintCmd: null, testCmd: null, filesLedger: { 'bad.js': { lastAction: 'write' } } };
    const r = await verificationHarness.runVerification(dir, plan);
    assert.equal(r.ok, false);
    assert.ok(r.messages.join('\n').includes('bad.js'), `expected bad.js in messages, got ${JSON.stringify(r.messages)}`);
});

test('A5: a syntactically valid touched file passes the fallback check', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-a5ok-'));
    fs.writeFileSync(path.join(dir, 'good.js'), 'const x = 1;\nmodule.exports = x;\n');
    const plan = { verifyPolicy: 'block', lintCmd: null, testCmd: null, filesLedger: { 'good.js': { lastAction: 'write' } } };
    const r = await verificationHarness.runVerification(dir, plan);
    assert.equal(r.ok, true);
});

test('verification harness canMarkStepDone', () => {
    const plan = {
        verifyPolicy: 'block',
        steps: [{ id: 1, status: 'active', verifiedAt: null }]
    };
    assert.equal(verificationHarness.canMarkStepDone(plan, 1), false);
    verificationHarness.markStepVerified(plan, 1);
    assert.equal(verificationHarness.canMarkStepDone(plan, 1), true);
});
