const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    isLoopbackApiBase,
    buildContextCandidates,
    createLmStudioManager
} = require('../src/main/services/lmStudioManager.js');

function modelPayload(contextLength = 4096, parallel = 4) {
    return {
        models: [{
            key: 'google/gemma-4-e4b',
            max_context_length: 131072,
            loaded_instances: [{
                id: 'google/gemma-4-e4b',
                config: { context_length: contextLength, parallel }
            }]
        }]
    };
}

test('isLoopbackApiBase permits local LM Studio only', () => {
    assert.equal(isLoopbackApiBase('http://127.0.0.1:1234'), true);
    assert.equal(isLoopbackApiBase('http://localhost:1234/v1'), true);
    assert.equal(isLoopbackApiBase('http://[::1]:1234'), true);
    assert.equal(isLoopbackApiBase('https://example.com/v1'), false);
    assert.equal(isLoopbackApiBase('not a url'), false);
});

test('buildContextCandidates clamps to model max and descends through standard sizes', () => {
    assert.deepEqual(
        buildContextCandidates(70000, 65536).slice(0, 3),
        [65536, 49152, 32768]
    );
    assert.deepEqual(buildContextCandidates(8192, 131072), [8192, 4096]);
});

test('getStatus reports the loaded LM Studio instance', async () => {
    const manager = createLmStudioManager({
        requestJson: async () => modelPayload()
    });
    const status = await manager.getStatus({
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'google/gemma-4-e4b'
    });
    assert.deepEqual(status, {
        managed: true,
        model: 'google/gemma-4-e4b',
        loadedContext: 4096,
        maxContext: 131072,
        parallel: 4
    });
});

test('getStatus leaves remote OpenAI-compatible endpoints unmanaged', async () => {
    let requested = false;
    const manager = createLmStudioManager({
        requestJson: async () => { requested = true; return modelPayload(); }
    });
    const status = await manager.getStatus({
        apiBaseUrl: 'https://example.com',
        model: 'google/gemma-4-e4b'
    });
    assert.equal(status.managed, false);
    assert.equal(status.reason, 'remote_endpoint');
    assert.equal(requested, false);
});

test('ensureModel is a no-op when context and parallel already match', async () => {
    const calls = [];
    const manager = createLmStudioManager({
        requestJson: async () => modelPayload(65536, 1),
        execFile: async (...args) => calls.push(args)
    });
    const result = await manager.ensureModel({
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'google/gemma-4-e4b',
        contextLength: 65536
    });
    assert.equal(result.reloaded, false);
    assert.equal(result.loadedContext, 65536);
    assert.equal(calls.length, 0);
});

test('ensureModel reloads with safe fixed CLI arguments', async () => {
    const calls = [];
    let statusReads = 0;
    const manager = createLmStudioManager({
        requestJson: async () => {
            statusReads++;
            return modelPayload(statusReads === 1 ? 4096 : 65536, statusReads === 1 ? 4 : 1);
        },
        execFile: async (file, args) => {
            calls.push({ file, args });
            return { stdout: '', stderr: '' };
        },
        lmsPath: 'lms'
    });
    const result = await manager.ensureModel({
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'google/gemma-4-e4b',
        contextLength: 65536
    });
    assert.equal(result.reloaded, true);
    assert.equal(result.loadedContext, 65536);
    assert.deepEqual(calls.map(c => c.args), [
        ['load', 'google/gemma-4-e4b', '--context-length', '65536', '--parallel', '1', '--gpu', 'max', '--estimate-only', '-y'],
        ['unload', 'google/gemma-4-e4b'],
        ['load', 'google/gemma-4-e4b', '--context-length', '65536', '--parallel', '1', '--gpu', 'max', '--identifier', 'google/gemma-4-e4b', '-y']
    ]);
});

test('ensureModel falls back to the highest context whose estimate succeeds', async () => {
    const attempted = [];
    let loadedContext = 4096;
    const manager = createLmStudioManager({
        requestJson: async () => modelPayload(loadedContext, loadedContext === 4096 ? 4 : 1),
        execFile: async (_file, args) => {
            if (args.includes('--estimate-only')) {
                const context = Number(args[args.indexOf('--context-length') + 1]);
                attempted.push(context);
                if (context > 49152) throw new Error('insufficient memory');
            } else if (args[0] === 'load') {
                loadedContext = Number(args[args.indexOf('--context-length') + 1]);
            }
            return { stdout: '', stderr: '' };
        }
    });
    const result = await manager.ensureModel({
        apiBaseUrl: 'http://localhost:1234',
        model: 'google/gemma-4-e4b',
        contextLength: 65536
    });
    assert.deepEqual(attempted.slice(0, 2), [65536, 49152]);
    assert.equal(result.loadedContext, 49152);
    assert.equal(result.fallbackUsed, true);
    assert.match(result.warning, /49152/);
});

// --- v52.3: UNLOAD ALL -------------------------------------------------------

function multiModelPayload() {
    return {
        models: [
            {
                key: 'unsloth/qwen3-8b',
                loaded_instances: [{ id: 'unsloth/qwen3-8b', config: { context_length: 4096, parallel: 1 } }]
            },
            {
                key: 'OBLITERATUS/gemma-4-12b',
                loaded_instances: [
                    { id: 'OBLITERATUS/gemma-4-12b', config: { context_length: 8192, parallel: 1 } },
                    { id: 'OBLITERATUS/gemma-4-12b#2', config: { context_length: 4096, parallel: 1 } }
                ]
            },
            { key: 'not-loaded/model', loaded_instances: [] }
        ]
    };
}

test('unloadAll unloads every loaded instance across all models (v52.3)', async () => {
    const posts = [];
    let listReads = 0;
    const manager = createLmStudioManager({
        requestJson: async () => { listReads++; return multiModelPayload(); },
        postJson: async (url, body) => { posts.push({ url, body }); return {}; }
    });
    const result = await manager.unloadAll({ apiBaseUrl: 'http://127.0.0.1:1234' });
    assert.equal(result.ok, true);
    // Two models loaded, one of them with TWO instances → 3 unloads total.
    assert.deepEqual(posts.map(p => p.body), [
        { instance_id: 'unsloth/qwen3-8b' },
        { instance_id: 'OBLITERATUS/gemma-4-12b' },
        { instance_id: 'OBLITERATUS/gemma-4-12b#2' }
    ]);
    // Every POST hits the management unload endpoint on the same host.
    assert.ok(posts.every(p => p.url === 'http://127.0.0.1:1234/api/v1/models/unload'));
    assert.deepEqual(result.unloaded.map(u => u.instanceId), [
        'unsloth/qwen3-8b',
        'OBLITERATUS/gemma-4-12b',
        'OBLITERATUS/gemma-4-12b#2'
    ]);
    // Model names are reported from the list (the UI shows them in the receipt).
    assert.deepEqual(result.unloaded.map(u => u.model), [
        'unsloth/qwen3-8b',
        'OBLITERATUS/gemma-4-12b',
        'OBLITERATUS/gemma-4-12b'
    ]);
    assert.equal(listReads, 1); // one list read, then unloads — no polling loop
});

test('unloadAll with nothing loaded is a success that unloads nothing (v52.3)', async () => {
    let posts = 0;
    const manager = createLmStudioManager({
        requestJson: async () => ({ models: [{ key: 'a/b', loaded_instances: [] }] }),
        postJson: async () => { posts++; return {}; }
    });
    const result = await manager.unloadAll({ apiBaseUrl: 'http://localhost:1234' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.unloaded, []);
    assert.deepEqual(result.errors, []);
    assert.equal(posts, 0);
});

test('unloadAll refuses remote endpoints without any network call (v52.3)', async () => {
    let touched = false;
    const manager = createLmStudioManager({
        requestJson: async () => { touched = true; return multiModelPayload(); },
        postJson: async () => { touched = true; return {}; }
    });
    const result = await manager.unloadAll({ apiBaseUrl: 'https://api.example.com/v1' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'remote_endpoint');
    assert.deepEqual(result.unloaded, []);
    assert.equal(touched, false);
});

test('unloadAll degrades to a warning when the management API is unreachable (v52.3)', async () => {
    const manager = createLmStudioManager({
        requestJson: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1234'); },
        postJson: async () => ({})
    });
    const result = await manager.unloadAll({ apiBaseUrl: 'http://127.0.0.1:1234' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'lmstudio_unavailable');
    assert.match(result.warning, /ECONNREFUSED/);
});

test('unloadAll keeps going when one unload fails and reports it (v52.3)', async () => {
    const posts = [];
    const manager = createLmStudioManager({
        requestJson: async () => multiModelPayload(),
        postJson: async (_url, body) => {
            posts.push(body.instance_id);
            if (body.instance_id === 'OBLITERATUS/gemma-4-12b') {
                const e = new Error('LM Studio API returned 500');
                e.body = '{"error":{"message":"internal error"}}';
                throw e;
            }
            return {};
        }
    });
    const result = await manager.unloadAll({ apiBaseUrl: 'http://127.0.0.1:1234' });
    // All three were attempted — the failure did not abort the rest.
    assert.deepEqual(posts, ['unsloth/qwen3-8b', 'OBLITERATUS/gemma-4-12b', 'OBLITERATUS/gemma-4-12b#2']);
    assert.equal(result.ok, false);
    assert.equal(result.unloaded.length, 2);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].model, 'OBLITERATUS/gemma-4-12b');
});

test('unloadAll treats a "not loaded" race as success (v52.3)', async () => {
    const manager = createLmStudioManager({
        requestJson: async () => multiModelPayload(),
        postJson: async (_url, body) => {
            if (body.instance_id === 'unsloth/qwen3-8b') {
                const e = new Error('LM Studio API returned 404');
                e.body = '{"error":{"type":"model_not_found","message":"Model with instance identifier \'unsloth/qwen3-8b\' is not loaded."}}';
                throw e;
            }
            return {};
        }
    });
    const result = await manager.unloadAll({ apiBaseUrl: 'http://127.0.0.1:1234' });
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
    // The raced instance still counts as unloaded — it is gone from VRAM either way.
    assert.deepEqual(result.unloaded.map(u => u.instanceId), [
        'unsloth/qwen3-8b',
        'OBLITERATUS/gemma-4-12b',
        'OBLITERATUS/gemma-4-12b#2'
    ]);
});

// --- v52.5: MODEL SWAP + EMBED ON STARTUP ------------------------------------

function swapPayload() {
    return {
        models: [
            {
                key: 'unsloth/qwen3-8b',
                type: 'llm',
                loaded_instances: [{ id: 'unsloth/qwen3-8b', config: { context_length: 4096, parallel: 1 } }]
            },
            {
                key: 'OBLITERATUS/gemma-4-12b',
                type: 'llm',
                loaded_instances: [{ id: 'OBLITERATUS/gemma-4-12b', config: { context_length: 8192, parallel: 1 } }]
            },
            {
                key: 'second-state/all-MiniLM-L6-v2',
                type: 'embedding',
                loaded_instances: [{ id: 'second-state/all-MiniLM-L6-v2', config: {} }]
            },
            { key: 'target/new-model-70b', type: 'llm', loaded_instances: [] }
        ]
    };
}

test('swapModel unloads every other LLM but protects the embedding model (v52.5)', async () => {
    const posts = [];
    const execCalls = [];
    // Stateful fake: mirrors what LM Studio would report as unloads/loads happen, so
    // ensureNow's post-load confirmation sees the target actually resident.
    const state = new Map([
        ['unsloth/qwen3-8b', { context_length: 4096, parallel: 1 }],
        ['OBLITERATUS/gemma-4-12b', { context_length: 8192, parallel: 1 }],
        ['second-state/all-MiniLM-L6-v2', {}] // embedding — must survive the swap
    ]);
    const payload = () => ({ models: [
        { key: 'unsloth/qwen3-8b', type: 'llm', loaded_instances: state.has('unsloth/qwen3-8b') ? [{ id: 'unsloth/qwen3-8b', config: state.get('unsloth/qwen3-8b') }] : [] },
        { key: 'OBLITERATUS/gemma-4-12b', type: 'llm', loaded_instances: state.has('OBLITERATUS/gemma-4-12b') ? [{ id: 'OBLITERATUS/gemma-4-12b', config: state.get('OBLITERATUS/gemma-4-12b') }] : [] },
        { key: 'second-state/all-MiniLM-L6-v2', type: 'embedding', loaded_instances: state.has('second-state/all-MiniLM-L6-v2') ? [{ id: 'second-state/all-MiniLM-L6-v2', config: {} }] : [] },
        { key: 'target/new-model-70b', type: 'llm', max_context_length: 262144, loaded_instances: state.has('target/new-model-70b') ? [{ id: 'target/new-model-70b', config: state.get('target/new-model-70b') }] : [] }
    ] });
    const manager = createLmStudioManager({
        requestJson: async () => payload(),
        postJson: async (_url, body) => { posts.push(body.instance_id); state.delete(body.instance_id); return {}; },
        execFile: async (file, args) => {
            execCalls.push(args);
            if (args[0] === 'load' && !args.includes('--estimate-only')) {
                const ctx = Number(args[args.indexOf('--context-length') + 1]);
                state.set(args[1], { context_length: ctx, parallel: 1 });
            } else if (args[0] === 'unload') {
                state.delete(args[1]);
            }
            return { stdout: '', stderr: '' };
        },
        lmsPath: 'lms'
    });
    const result = await manager.swapModel({
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'target/new-model-70b',
        contextLength: 16384
    });
    assert.equal(result.ok, true);
    // Both old LLMs unloaded — the embedding instance was NOT touched.
    assert.deepEqual(posts, ['unsloth/qwen3-8b', 'OBLITERATUS/gemma-4-12b']);
    assert.deepEqual(result.unloaded.map(u => u.model), ['unsloth/qwen3-8b', 'OBLITERATUS/gemma-4-12b']);
    // The selection was loaded with the requested context (estimate + real load).
    const loads = execCalls.filter(a => a[0] === 'load' && !a.includes('--estimate-only'));
    assert.equal(loads.length, 1);
    assert.deepEqual(loads[0], [
        'load', 'target/new-model-70b', '--context-length', '16384',
        '--parallel', '1', '--gpu', 'max', '--identifier', 'target/new-model-70b', '-y'
    ]);
});

test('swapModel is a no-op load when the selection is already resident (v52.5)', async () => {
    const posts = [];
    const execCalls = [];
    const manager = createLmStudioManager({
        requestJson: async () => ({
            models: [
                { key: 'a/old-model', type: 'llm', loaded_instances: [{ id: 'a/old-model', config: { context_length: 4096, parallel: 1 } }] },
                { key: 'b/current-model', type: 'llm', loaded_instances: [{ id: 'b/current-model', config: { context_length: 32768, parallel: 1 } }] }
            ]
        }),
        postJson: async (_url, body) => { posts.push(body.instance_id); return {}; },
        execFile: async (file, args) => { execCalls.push(args); return { stdout: '', stderr: '' }; }
    });
    const result = await manager.swapModel({
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'b/current-model',
        contextLength: 32768
    });
    assert.equal(result.ok, true);
    // The other LLM was freed…
    assert.deepEqual(posts, ['a/old-model']);
    // …but the already-loaded selection was NOT reloaded (no estimate, no load).
    assert.equal(execCalls.length, 0);
});

test('swapModel restores freed models when the new model fails to load (v52.5)', async () => {
    const posts = [];
    const execCalls = [];
    const manager = createLmStudioManager({
        requestJson: async () => swapPayload(),
        postJson: async (_url, body) => { posts.push(body.instance_id); return {}; },
        execFile: async (file, args) => {
            execCalls.push(args);
            if (args[0] === 'load' && !args.includes('--estimate-only') && args[1] === 'target/new-model-70b') {
                const e = new Error('insufficient VRAM');
                e.stderr = 'out of memory';
                throw e;
            }
            return { stdout: '', stderr: '' };
        },
        lmsPath: 'lms'
    });
    const result = await manager.swapModel({
        apiBaseUrl: 'http://127.0.0.1:1234',
        model: 'target/new-model-70b',
        contextLength: 16384
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /insufficient VRAM|out of memory/);
    // The two freed LLMs were restored best-effort so the user is not left with nothing.
    const restores = execCalls.filter(a => a[0] === 'load' && !a.includes('--estimate-only') && a[1] !== 'target/new-model-70b');
    assert.deepEqual(restores.map(a => a[1]), ['OBLITERATUS/gemma-4-12b', 'unsloth/qwen3-8b']); // reverse order
});

test('swapModel refuses remote endpoints without any network call (v52.5)', async () => {
    let touched = false;
    const manager = createLmStudioManager({
        requestJson: async () => { touched = true; return swapPayload(); },
        postJson: async () => { touched = true; return {}; }
    });
    const result = await manager.swapModel({ apiBaseUrl: 'https://api.example.com/v1', model: 'x/y' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'remote_endpoint');
    assert.equal(touched, false);
});

test('swapModel degrades to a warning when the management API is unreachable (v52.5)', async () => {
    const manager = createLmStudioManager({ requestJson: async () => { throw new Error('connect ECONNREFUSED'); } });
    const result = await manager.swapModel({ apiBaseUrl: 'http://127.0.0.1:1234', model: 'x/y' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'lmstudio_unavailable');
});

test('ensureEmbeddingModel is a no-op when an embedding instance is already loaded (v52.5)', async () => {
    const execCalls = [];
    let listReads = 0;
    const manager = createLmStudioManager({
        requestJson: async () => {
            listReads++;
            return swapPayload(); // has a loaded embedding instance
        },
        execFile: async (file, args) => { execCalls.push(args); return { stdout: '', stderr: '' }; }
    });
    const result = await manager.ensureEmbeddingModel({ apiBaseUrl: 'http://127.0.0.1:1234' });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyLoaded, true);
    assert.equal(result.model, 'second-state/all-MiniLM-L6-v2');
    assert.equal(execCalls.length, 0); // no lms load issued
    assert.equal(listReads, 1);
});

test('ensureEmbeddingModel loads the smallest embedding model with --gpu off (v52.5)', async () => {
    const execCalls = [];
    let listReads = 0;
    const manager = createLmStudioManager({
        requestJson: async () => {
            listReads++;
            if (listReads === 1) return { models: [
                { key: 'big/nomic-embed-text-v1.5', type: 'embedding', size_bytes: 274877906944, loaded_instances: [] },
                { key: 'small/all-MiniLM-L6-v2', type: 'embedding', size_bytes: 900000000, loaded_instances: [] },
                { key: 'chat/qwen3-8b', type: 'llm', size_bytes: 4975, loaded_instances: [{ id: 'chat/qwen3-8b', config: {} }] }
            ] };
            return { models: [
                { key: 'big/nomic-embed-text-v1.5', type: 'embedding', size_bytes: 274877906944, loaded_instances: [] },
                { key: 'small/all-MiniLM-L6-v2', type: 'embedding', size_bytes: 900000000, loaded_instances: [{ id: 'small/all-MiniLM-L6-v2', config: {} }] },
                { key: 'chat/qwen3-8b', type: 'llm', size_bytes: 4975, loaded_instances: [{ id: 'chat/qwen3-8b', config: {} }] }
            ] };
        },
        execFile: async (file, args) => { execCalls.push(args); return { stdout: '', stderr: '' }; },
        lmsPath: 'lms'
    });
    const result = await manager.ensureEmbeddingModel({ apiBaseUrl: 'http://127.0.0.1:1234' });
    assert.equal(result.ok, true);
    assert.equal(result.model, 'small/all-MiniLM-L6-v2'); // smallest wins — fastest to start
    assert.deepEqual(execCalls[0], ['load', 'small/all-MiniLM-L6-v2', '--gpu', 'off', '-y']);
});

test('ensureEmbeddingModel honors the XK_EMBED_MODEL override (v52.5)', async () => {
    const execCalls = [];
    process.env.XK_EMBED_MODEL = 'big/nomic-embed-text-v1.5';
    try {
        const manager = createLmStudioManager({
            requestJson: async () => ({ models: [
                { key: 'big/nomic-embed-text-v1.5', type: 'embedding', size_bytes: 274877906944, loaded_instances: [] },
                { key: 'small/all-MiniLM-L6-v2', type: 'embedding', size_bytes: 900000000, loaded_instances: [] }
            ] }),
            execFile: async (file, args) => { execCalls.push(args); return { stdout: '', stderr: '' }; },
            lmsPath: 'lms'
        });
        const result = await manager.ensureEmbeddingModel({ apiBaseUrl: 'http://127.0.0.1:1234' });
        assert.equal(result.ok, true);
        assert.equal(result.model, 'big/nomic-embed-text-v1.5'); // override beats size order
    } finally {
        delete process.env.XK_EMBED_MODEL;
    }
});

test('ensureEmbeddingModel reports no_embedding_model when LM Studio has none (v52.5)', async () => {
    const manager = createLmStudioManager({
        requestJson: async () => ({ models: [{ key: 'chat/qwen3-8b', type: 'llm', loaded_instances: [] }] })
    });
    const result = await manager.ensureEmbeddingModel({ apiBaseUrl: 'http://127.0.0.1:1234' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_embedding_model');
    assert.match(result.warning, /embedding model/i);
});

test('ensureEmbeddingModel surfaces lms load failures (v52.5)', async () => {
    const manager = createLmStudioManager({
        requestJson: async () => ({ models: [
            { key: 'small/all-MiniLM-L6-v2', type: 'embedding', size_bytes: 900000000, loaded_instances: [] }
        ] }),
        execFile: async (file, args) => {
            const e = new Error('lms failed');
            e.stderr = 'model file missing';
            throw e;
        },
        lmsPath: 'lms'
    });
    const result = await manager.ensureEmbeddingModel({ apiBaseUrl: 'http://127.0.0.1:1234' });
    assert.equal(result.ok, false);
    assert.match(result.error, /model file missing/);
});

test('swapModel and ensureEmbeddingModel serialize on the same operation queue (v52.5)', async () => {
    // Nothing loaded: BOTH operations must run lms commands, so interleaving them would
    // produce concurrent execFile calls if they didn't share the serialized queue.
    const order = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const emptyPayload = () => ({ models: [
        { key: 'target/new-model-70b', type: 'llm', size_bytes: 4194304, loaded_instances: [] },
        { key: 'small/all-MiniLM-L6-v2', type: 'embedding', size_bytes: 900000000, loaded_instances: [] }
    ] });
    const manager = createLmStudioManager({
        requestJson: async () => emptyPayload(),
        postJson: async () => { await new Promise(r => setTimeout(r, 5)); return {}; },
        execFile: async (file, args) => {
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
            order.push(`enter:${args[0]}:${args[1]}`);
            await new Promise(r => setTimeout(r, 10));
            order.push(`exit:${args[0]}:${args[1]}`);
            inFlight--;
            return { stdout: '', stderr: '' };
        },
        lmsPath: 'lms'
    });
    const [a, b] = await Promise.all([
        manager.swapModel({ apiBaseUrl: 'http://127.0.0.1:1234', model: 'target/new-model-70b', contextLength: 8192 }),
        manager.ensureEmbeddingModel({ apiBaseUrl: 'http://127.0.0.1:1234' })
    ]);
    assert.equal(maxInFlight, 1); // never two lms operations at once
    assert.ok(a && b);
    // Every enter is matched by its exit before the next enter (strict serialization).
    const stack = [];
    for (const step of order) {
        if (step.startsWith('enter:')) stack.push(step.slice(6));
        else {
            const name = step.slice(5);
            assert.equal(stack.pop(), name, `operations overlapped at ${name}`);
        }
    }
});
