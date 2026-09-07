/**
 * Example slash command: /greet <name> injects a prompt template.
 */
module.exports = {
    name: 'greet',
    description: 'Insert a friendly greeting prompt.',
    prompt: 'Please write a short, friendly greeting for {{args}}.',
};
