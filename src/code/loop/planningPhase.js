/**
 * Code Mode planning phase — read-only exploration then submit_code_plan for user approval.
 */
'use strict';

const { streamCompletion } = require('./streamCompletion.js');
const { extractFromMessage } = require('../tools/extractor.js');
const { executeTool } = require('../tools/executor.js');
const { selectToolsForTurn } = require('../tools/router.js');
const { SUBMIT_CODE_PLAN } = require('../tools/planTools.js');
const { createPlan, defaultPlan } = require('../plan/codePlan.js');
const { adaptMessagesForModel } = require('../context/modelHarness.js');

const PLANNING_SYSTEM = `You are Agent Smith in PLANNING mode. Explore the project with read-only tools, then call submit_code_plan with 4–6 ordered steps (not 10+ micro-steps).
For a new web app use milestones like: index.html structure, style.css, script.js logic, README + verify.
Do NOT write or patch files. Do NOT declare the task done. Your only exit is submit_code_plan.`;

const MAX_PLAN_TURNS = 8;

async function runPlanningPhase(ctx) {
    const {
        session, apiBaseUrl, apiKey, emit, signal, execDeps, model, trace
    } = ctx;
    const stream = ctx.streamCompletion || streamCompletion;
    const executionMessageCount = session.messages.length;

    session.workflow = 'planning';
    emit({ type: 'planning_start', goal: session.goal });

    const readTools = selectToolsForTurn({
        userPrompt: session.goal,
        turnIndex: 0,
        phase: 'explore',
        pluginToolSchemas: []
    });
    const tools = readTools.concat([SUBMIT_CODE_PLAN]);

    let submitted = null;

    for (let t = 0; t < MAX_PLAN_TURNS && !submitted; t++) {
        if (signal?.aborted) throw new Error('Run aborted');

        const hint = t === 0
            ? 'Plan this task: explore briefly, then submit_code_plan with concrete steps.'
            : 'Continue exploring or call submit_code_plan now with your step list.';

        let bodyMessages = [
            { role: 'system', content: PLANNING_SYSTEM },
            ...session.messages.slice(-12),
            { role: 'user', content: hint }
        ];
        bodyMessages = adaptMessagesForModel(bodyMessages, model, {
            toolNames: tools.map(t => t.function.name),
            serializeToolHistory: true
        });

        emit({ type: 'planning_turn', turn: t + 1 });

        const result = await stream({
            apiBaseUrl,
            apiKey: apiKey || null,
            model,
            messages: bodyMessages,
            tools,
            signal
        });

        const msg = result.message;
        if (msg) session.messages.push(msg);

        extractFromMessage(msg, tools);
        const calls = (msg?.tool_calls || []).map(call => ({
            name: call?.function?.name,
            args: call?.function?.arguments || {}
        })).filter(call => call.name);
        if (!calls.length) {
            session.messages.push({
                role: 'user',
                content: 'You must call submit_code_plan with ordered steps, or use read tools first.'
            });
            continue;
        }

        for (const call of calls) {
            if (call.name === 'submit_code_plan') {
                const steps = call.args?.steps || call.args?.step_list || [];
                submitted = createPlan(call.args?.goal || session.goal, steps);
                emit({
                    type: 'plan_submitted',
                    codePlan: submitted,
                    stepCount: submitted.steps.length
                });
                break;
            }

            emit({ type: 'tool_start', turn: 0, name: call.name, args: call.args, phase: 'planning' });
            const toolResult = await executeTool(call.name, call.args, execDeps);
            emit({
                type: 'tool_result',
                turn: 0,
                name: call.name,
                result: toolResult,
                phase: 'planning'
            });
            session.messages.push({
                role: 'tool',
                name: call.name,
                content: JSON.stringify(toolResult).slice(0, 4000)
            });
        }
    }

    if (!submitted) {
        submitted = defaultPlan(session.goal);
        emit({ type: 'plan_submitted', codePlan: submitted, stepCount: submitted.steps.length, fallback: true });
    }

    session.codePlan = submitted;
    session.status = 'awaiting_approval';
    session.workflow = 'awaiting_approval';
    // Planning tool calls are internal. Persisting the terminal submit_code_plan
    // call leaves execution with an unanswered tool call after approval, which
    // OpenAI-compatible servers reject.
    session.messages.length = executionMessageCount;

    emit({
        type: 'plan_awaiting_approval',
        sessionId: session.id,
        goal: session.goal,
        codePlan: submitted
    });

    return submitted;
}

module.exports = { runPlanningPhase, MAX_PLAN_TURNS };
