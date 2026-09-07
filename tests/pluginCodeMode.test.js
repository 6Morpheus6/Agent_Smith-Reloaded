/**
 * Plugin tools end-to-end in Code Mode. Previously plugin tools were never offered to
 * the model (router dropped names at schema lookup) and the executor had no invoke path.
 * Now: schemas are offered in implement/verify (not explore), the phase gate allows them
 * outside explore, and the executor delegates unknown tools to the plugin manager.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { selectToolsForTurn } = require('../src/code/tools/router.js');
const { executeTool } = require('../src/code/tools/executor.js');
const { createDefaultMiddleware, runMiddlewareChain } = require('../src/code/loop/middleware.js');

const PLUGIN_SCHEMA = {
    type: 'function',
    function: { name: 'weather_lookup', description: 'Look up weather', parameters: { type: 'object', properties: {} } }
};

test('router offers plugin tool schemas in implement phase', () => {
    const tools = selectToolsForTurn({ phase: 'implement', pluginToolSchemas: [PLUGIN_SCHEMA] });
    const names = tools.map(t => t.function.name);
    assert.ok(names.includes('weather_lookup'), 'plugin tool offered in implement');
    assert.ok(names.includes('write_file'), 'core tools still present');
});

test('router withholds plugin tools during read-only explore phase', () => {
    const tools = selectToolsForTurn({ phase: 'explore', pluginToolSchemas: [PLUGIN_SCHEMA] });
    const names = tools.map(t => t.function.name);
    assert.ok(!names.includes('weather_lookup'), 'no plugin tools in explore');
});

test('phase gate allows a plugin tool outside explore, blocks it inside explore', async () => {
    const mw = createDefaultMiddleware({});
    const session = { phase: 'implement', pluginToolNames: ['weather_lookup'] };
    const allow = await runMiddlewareChain(mw, 'beforeTool', { ctx: {}, session, payload: { name: 'weather_lookup', args: {}, dup: false } });
    assert.equal(allow, null, 'allowed in implement');

    const session2 = { phase: 'explore', pluginToolNames: ['weather_lookup'] };
    const block = await runMiddlewareChain(mw, 'beforeTool', { ctx: {}, session: session2, payload: { name: 'weather_lookup', args: {}, dup: false } });
    assert.equal(block.veto, true, 'blocked in explore');
});

test('executor delegates an unknown tool to invokePluginTool', async () => {
    let called = null;
    const deps = {
        projectContext: { getRoot: () => '.', resolvePath: () => ({ path: '.' }) },
        invokePluginTool: async (name, args) => {
            if (name !== 'weather_lookup') return { __notFound: true };
            called = { name, args };
            return 'Sunny, 22C';
        }
    };
    const r = await executeTool('weather_lookup', { city: 'Paris' }, deps);
    assert.deepEqual(called, { name: 'weather_lookup', args: { city: 'Paris' } });
    assert.equal(r.result, 'Sunny, 22C');
    assert.ok(r.pluginTool);
});

test('executor still reports a truly unknown tool', async () => {
    const r = await executeTool('does_not_exist', {}, { invokePluginTool: async () => ({ __notFound: true }) });
    assert.match(r.error, /Unknown tool/);
});

test('executor surfaces a plugin tool error as an error result', async () => {
    const deps = { invokePluginTool: async () => 'Error in plugin "x" tool "y": boom' };
    const r = await executeTool('y', {}, deps);
    assert.ok(r.error && /boom/.test(r.error));
});
