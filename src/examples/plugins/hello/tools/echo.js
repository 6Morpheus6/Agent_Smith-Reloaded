/**
 * Example tool. Declares no special capability — `host.log` is always available.
 * The model calls this as `hello_echo`.
 */
module.exports = {
    schema: {
        name: 'hello_echo',
        description: 'Echo back the provided text (example plugin tool).',
        parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Text to echo' } },
            required: ['text'],
        },
    },
    async run(args, host) {
        host.log(`echo called with: ${args.text}`);
        return `hello: ${args.text}`;
    },
};
