// Capture the EXACT body Code Mode sends through streamCompletion, using the real
// tool-selection path and a realistic post-compaction history. Prints the JSON body
// so we can audit it against Moonshot's strict validation.
const http = require('http');
const { streamCompletion } = require('../src/code/loop/streamCompletion.js');
const { selectToolsForTurn } = require('../src/code/tools/router.js');

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const parsed = JSON.parse(body);
        require('fs').writeFileSync('/tmp/code-mode-body.json', JSON.stringify(parsed, null, 2));
        console.log('CAPTURED. keys:', Object.keys(parsed).join(','));
        console.log('max_tokens:', parsed.max_tokens, 'temperature:', parsed.temperature);
        console.log('tools count:', (parsed.tools || []).length);
        for (const m of parsed.messages) {
            console.log(`- role=${m.role}` +
                (m.tool_calls ? ` tool_calls=${m.tool_calls.length}` : '') +
                (m.tool_call_id ? ` tool_call_id=${m.tool_call_id}` : '') +
                (m.name ? ` name=${m.name}` : '') +
                ` content=${JSON.stringify(String(m.content).slice(0, 40))}`);
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        server.close();
    });
});

server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const tools = selectToolsForTurn({
        userPrompt: 'build a todo web app',
        turnIndex: 2,
        phase: 'implement',
        pluginToolNames: [],
        pluginToolSchemas: []
    });
    const messages = [
        { role: 'system', content: 'You are Agent Smith Code Mode.' },
        { role: 'user', content: '[PHASE EXPLORE → IMPLEMENT]\n\nContext compacted...' },
        { role: 'user', content: 'build a todo web app' },
        {
            role: 'assistant', content: '',
            tool_calls: [
                { id: 'call_0', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html","content":"..."}' } },
                { id: 'call_1', type: 'function', function: { name: 'run_command', arguments: '{"command":"ls"}' } }
            ]
        },
        { role: 'tool', tool_call_id: 'call_0', name: 'write_file', content: '{"ok":true}' },
        { role: 'tool', tool_call_id: 'call_1', name: 'run_command', content: '{"exit":0}' },
        { role: 'system', content: '[NUDGE] keep going' },
        { role: 'assistant', content: 'Continuing.' }
    ];
    await streamCompletion({
        apiBaseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'test-key',
        model: 'kimi-k3',
        messages,
        tools,
        maxTokens: 8192,
        temperature: 0.2
    });
});
