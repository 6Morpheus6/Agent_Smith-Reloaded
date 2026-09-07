'use strict';

const SUBMIT_CODE_PLAN = {
    type: 'function',
    function: {
        name: 'submit_code_plan',
        description: 'Submit the final ordered plan for user approval. Call once you have explored enough. Provide 3–12 concrete steps.',
        parameters: {
            type: 'object',
            properties: {
                goal: { type: 'string', description: 'Restated task goal' },
                steps: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Ordered step titles'
                }
            },
            required: ['steps']
        }
    }
};

const MARK_CODE_STEP_DONE = {
    type: 'function',
    function: {
        name: 'mark_code_step_done',
        description: 'Mark the current approved plan step complete and advance to the next step.',
        parameters: {
            type: 'object',
            properties: {
                note: { type: 'string', description: 'Brief note on what was accomplished' }
            }
        }
    }
};

module.exports = { SUBMIT_CODE_PLAN, MARK_CODE_STEP_DONE };
