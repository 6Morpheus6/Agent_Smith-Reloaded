const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runPlanningPhase } = require('../src/code/loop/planningPhase.js');

test('planning phase accepts a native submit_code_plan tool call', async () => {
    const session = {
        id: 'plan-test',
        goal: 'Create a Pac-Man browser game',
        messages: [{ role: 'user', content: 'Create the game' }]
    };
    const events = [];
    const plan = await runPlanningPhase({
        session,
        apiBaseUrl: 'http://x',
        emit: event => events.push(event),
        execDeps: {},
        model: 'qwen/qwen3-14b',
        streamCompletion: async () => ({
            message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'plan-call',
                    type: 'function',
                    function: {
                        name: 'submit_code_plan',
                        arguments: {
                            goal: session.goal,
                            steps: ['Create game files', 'Implement gameplay', 'Verify in browser']
                        }
                    }
                }]
            },
            finishReason: 'tool_calls'
        })
    });

    assert.equal(plan.steps.length, 3);
    assert.equal(session.status, 'awaiting_approval');
    assert.deepEqual(session.messages, [{ role: 'user', content: 'Create the game' }]);
    assert.equal(events.filter(e => e.type === 'planning_turn').length, 1);
    assert.ok(events.some(e => e.type === 'plan_submitted' && !e.fallback));
});
