const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const path = require('path');

const registerHistoryIpc = require('../src/main/ipc/history.js');
const {
    sanitizeCodeTimelineHtml,
    shouldCheckpointCodeEvent
} = require('../src/renderer/ui/historyPersistence.js');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-smith-history-'));
}

test('sanitizer removes orphaned Code Mode starting bubbles', () => {
    const html = [
        '<div class="message user-message">create pacman</div>',
        '<div class="message bot-message"><span class="loading-pulse">Code Mode — starting…</span></div>',
        '<div class="activity-turn">Turn 1 complete</div>'
    ].join('');

    const clean = sanitizeCodeTimelineHtml(html);
    assert.match(clean, /create pacman/);
    assert.match(clean, /Turn 1 complete/);
    assert.doesNotMatch(clean, /Code Mode — starting|loading-pulse/);
});

test('checkpoint filter saves durable Code Mode transitions but not token deltas', () => {
    assert.equal(shouldCheckpointCodeEvent({ type: 'tool_result' }), true);
    assert.equal(shouldCheckpointCodeEvent({ type: 'plan_awaiting_approval' }), true);
    assert.equal(shouldCheckpointCodeEvent({ type: 'done' }), true);
    assert.equal(shouldCheckpointCodeEvent({ type: 'delta' }), false);
    assert.equal(shouldCheckpointCodeEvent({ type: 'context_budget' }), false);
});

// Helper: wire the real history IPC handlers against a temp dir.
function mkHistoryHandlers(opts = {}) {
    const dir = tempDir();
    const historyFile = path.join(dir, 'history.json');
    const handlers = new Map();
    registerHistoryIpc({ handle(name, fn) { handlers.set(name, fn); } }, {
        dialog: {}, fs, fsPromises, path, historyFile,
        legacyFiles: opts.legacyFiles || [], userDataPath: dir
    });
    return { dir, historyFile, handlers };
}

test('INVARIANT: Chat/Agent/Code persist as three SEPARATE conversations and round-trip intact', async () => {
    const { handlers } = mkHistoryHandlers();
    const save = handlers.get('save-history');
    const load = handlers.get('load-history');

    // The exact keyed shape app.js persist() sends.
    const payload = {
        __modes: true,
        chat:  [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello chat' }],
        agent: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'run a shell cmd' }],
        code:  [{ role: 'system', content: 'sys' }, { role: 'user', content: 'build pacman' }],
        // Per-mode rendered snapshots (messages + tool cards) — what makes tools/output
        // survive a mode switch and an app relaunch.
        snapshots: {
            chat: '<div class="message">hi</div>',
            agent: '<div class="activity-turn">ran: ls</div>',
            code: '<div class="activity-turn">Turn 1</div>'
        },
        codeTimelineHtml: '<div class="activity-turn">Turn 1</div>'
    };
    await save(null, payload);
    const loaded = await load();

    assert.equal(loaded.__modes, true, 'keyed multi-mode shape survives the round-trip');
    // Each mode keeps its OWN messages — no cross-contamination.
    assert.equal(loaded.chat.at(-1).content, 'hello chat');
    assert.equal(loaded.agent.at(-1).content, 'run a shell cmd');
    assert.equal(loaded.code.at(-1).content, 'build pacman');
    assert.notDeepEqual(loaded.chat, loaded.agent, 'chat and agent are distinct conversations');
    assert.notDeepEqual(loaded.agent, loaded.code, 'agent and code are distinct conversations');
    // The per-mode rendered snapshots round-trip too (tools/output survive relaunch).
    assert.equal(loaded.snapshots.agent, '<div class="activity-turn">ran: ls</div>',
        'agent tool-activity snapshot persists');
    assert.equal(loaded.snapshots.code, '<div class="activity-turn">Turn 1</div>');
    assert.equal(loaded.snapshots.chat, '<div class="message">hi</div>');
});

test('INVARIANT: a legacy single-array history migrates into Chat only (Agent/Code stay empty)', async () => {
    // No history.json yet, but a >1KB legacy file exists → load-history migrates it.
    const legacyName = 'agent_smith_history.json';
    const { dir, handlers } = mkHistoryHandlers({ legacyFiles: [legacyName] });
    const legacyMessages = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `old message ${i}` }));
    fs.writeFileSync(path.join(dir, legacyName), JSON.stringify(legacyMessages), 'utf8');

    const loaded = await handlers.get('load-history')();
    // Legacy shape is a bare array (no __modes); app.js maps it into histories.chat,
    // leaving agent/code to seed fresh — so old chats are never lost on upgrade.
    assert.ok(Array.isArray(loaded), 'legacy history loads as a bare array');
    assert.equal(loaded.length, 40);
    assert.equal(loaded[0].content, 'old message 0');
});

test('history saves are serialized and atomically replace the destination', async () => {
    const dir = tempDir();
    const historyFile = path.join(dir, 'history.json');
    const handlers = new Map();
    const writes = [];
    const delayedFs = {
        ...fsPromises,
        async writeFile(file, data, encoding) {
            writes.push(path.basename(file));
            if (String(data).includes('"version":1')) {
                await new Promise(resolve => setTimeout(resolve, 30));
            }
            return fsPromises.writeFile(file, data, encoding);
        }
    };
    registerHistoryIpc({
        handle(name, fn) { handlers.set(name, fn); }
    }, {
        dialog: {},
        fs,
        fsPromises: delayedFs,
        path,
        historyFile,
        legacyFiles: [],
        userDataPath: dir
    });

    const save = handlers.get('save-history');
    await Promise.all([
        save(null, { version: 1 }),
        save(null, { version: 2 })
    ]);

    assert.deepEqual(JSON.parse(fs.readFileSync(historyFile, 'utf8')), { version: 2 });
    assert.ok(writes.every(name => name !== 'history.json'), 'writes go to temporary files before rename');
});
