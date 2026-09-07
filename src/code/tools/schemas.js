/**
 * v50 unified tool surface — Code Mode project tools + Agent host-control tools,
 * all routed through the single main-process engine. The former Chat mode is gone;
 * every run is a harness run with this one tool set (phases still gate which subset
 * the model sees per stage).
 */
const CODE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file from the project (optionally a line range).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path from project root' },
                    offset: { type: 'number', description: '1-based start line (optional)' },
                    limit: { type: 'number', description: 'Max lines to read (optional)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'patch',
            description: 'Search/replace edit in a file — the right tool for CHANGING existing code. Provide exact find text and its replacement. Set replace_all when the find text occurs more than once and you want every occurrence replaced.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    find: { type: 'string' },
                    replace: { type: 'string' },
                    replace_all: { type: 'boolean', description: 'Replace every occurrence of find (default false). Use this to fix "Multiple exact matches".' }
                },
                required: ['path', 'find', 'replace']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Create or overwrite a file with its COMPLETE content (up to ~1000 lines / 64KB). Prefer this for new files and for rewriting a file you need to restructure — a full overwrite always leaves balanced braces and valid structure. To change a few lines of an existing file, use patch instead.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string', description: 'The full file content' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'append_file',
            description: 'Add NEW content to the END of an existing file. Use it ONLY to extend a file (e.g. continue a write that was cut off). Never use it to change code already in the file — that duplicates definitions. To modify existing code use patch; to rewrite use write_file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string', description: 'New content to add at end of file (not already present)' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'grep',
            description: 'Search file contents in the project.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string' },
                    glob: { type: 'string', description: 'Optional glob filter' }
                },
                required: ['pattern']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'glob',
            description: 'Find files matching a glob pattern.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string' }
                },
                required: ['pattern']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Run a shell command in the project root.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string' },
                    is_background: { type: 'boolean', description: 'Run in background' }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_project',
            description: 'List project tree (skips node_modules, .git, dist).',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'show_preview',
            description: 'Open the Preview panel for the user. kind=project_file (live iframe of workspace HTML), web_url (snapshot of a URL), screenshot (desktop/window capture; scope app|window|screen).',
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['project_file', 'web_url', 'screenshot'] },
                    target: { type: 'string', description: 'Relative project path or URL' },
                    caption: { type: 'string' },
                    viewport: {
                        type: 'object',
                        properties: {
                            width: { type: 'number' },
                            height: { type: 'number' }
                        }
                    },
                    scope: { type: 'string', enum: ['screen', 'window', 'app'], description: 'For screenshot kind only' }
                },
                required: ['kind']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'browser_verify',
            description: 'Load a project HTML file in a headless browser and verify it loads without console errors. Optional JS checks array.',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'string', description: 'Relative path to HTML file (default index.html)' },
                    checks: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional JS expressions that must evaluate truthy (e.g. document.querySelector("#app"))'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'query_run_trace',
            description: 'Query the current Code run trace for failures, tool errors, and verify blocks. Use during verify phase to diagnose issues.',
            parameters: {
                type: 'object',
                properties: {
                    failuresOnly: { type: 'boolean', description: 'Return only error/failure steps (default true)' },
                    tool: { type: 'string', description: 'Filter by tool name' },
                    lastN: { type: 'number', description: 'Max steps to return (default 20, max 50)' }
                }
            }
        }
    },
    // ── v52.6 dsh Code Mode transport — programs that loop over tools in ONE call ──
    {
        type: 'function',
        function: {
            name: 'run_code',
            description:
                'Execute a program against the available tools (dsh Code Mode). `code` is the BODY of an async JavaScript function; call any offered tool as `await tools.name(args)` — e.g. `const r = await tools.read_file({ path: "src/app.js" })`. Use it for work that LOOPS OVER TOOLS: read many files, grep-then-filter, run a check per file, aggregate results — one call instead of dozens of turns. `print(...)` and/or `return <value>` produce the output; ONLY what you print or return reaches the model (curate it — summarize, don\'t dump). A tool denial THROWS: wrap in try/catch to handle it. For writing a single file, prefer write_file directly.',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: 'The program: the body of an async JavaScript function (top-level await and return work).' },
                    description: { type: 'string', description: 'Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: "Syntax-check every changed JS file"; "Collect test output per module".' }
                },
                required: ['code', 'description']
            }
        }
    },
    // ── v50 host-control tools (merged from Agent Mode) ─────────────────────────
    // These reach OUTSIDE the project root — that is the point: one harness for both
    // building a project and operating the machine. Guardrails are pathPolicy
    // (catastrophic targets refused), commandPolicy (shell screen) and the actionLog
    // audit + undo layer, not containment.
    {
        type: 'function',
        function: {
            name: 'read_host_file',
            description: 'Read a file anywhere on the host system by absolute path (tilde ~ ok). Use for config files, logs, and anything outside the project root — e.g. /etc/hosts, ~/.config/foo/bar.json.',
            parameters: {
                type: 'object',
                properties: {
                    filepath: { type: 'string' },
                    offset: { type: 'number', description: '1-based start line (optional)' },
                    limit: { type: 'number', description: 'Max lines to read (optional, default 400)' }
                },
                required: ['filepath']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_host_file',
            description: 'Create or overwrite a file anywhere on the host system by absolute path (tilde ~ ok). Guarded against catastrophic targets (system roots, home root itself). Prefer patch/write_file INSIDE the project.',
            parameters: {
                type: 'object',
                properties: {
                    filepath: { type: 'string' },
                    content: { type: 'string', description: 'The full file content' }
                },
                required: ['filepath', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_host_file',
            description: 'Delete a file or directory anywhere on the host system by absolute path (tilde ~ ok). Guarded against catastrophic targets.',
            parameters: {
                type: 'object',
                properties: { filepath: { type: 'string' } },
                required: ['filepath']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_host_directory',
            description: 'List contents of a directory anywhere on the host (absolute or ~ path; default "." = project root).',
            parameters: {
                type: 'object',
                properties: { dirpath: { type: 'string' } }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_processes',
            description: 'List all background jobs started this run, with their running state and last output line.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_process_log',
            description: 'Read the recent output log of a background job started via run_command is_background:true.',
            parameters: {
                type: 'object',
                properties: {
                    job_id: { type: 'string' },
                    lines: { type: 'number', description: 'Max tail lines (default 50)' }
                },
                required: ['job_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'send_input',
            description: 'Send a line of stdin to an active background job.',
            parameters: {
                type: 'object',
                properties: { job_id: { type: 'string' }, input: { type: 'string' } },
                required: ['job_id', 'input']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'stop_process',
            description: 'Kill a background job by its id.',
            parameters: {
                type: 'object',
                properties: { job_id: { type: 'string' } },
                required: ['job_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the web (DuckDuckGo) AND read the top result pages in full — returns a DEEP RESEARCH REPORT: what was actually learned from each source page (natural-language findings + key facts), not just snippets. Your next response must be a detailed natural-language report of everything it contains, written for the user. Set quick:true to skip reading pages and get fast snippet-only results.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    quick: { type: 'boolean', description: 'Optional. true = snippet-only search (fast, no page reads). Default false = deep research report.' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fetch_url',
            description: 'Fetch a public http(s) URL and return its text (HTML stripped to readable text, 8KB cap). Internal hosts are rejected.',
            parameters: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'review_actions',
            description: 'Review recent consequential actions taken this session (audit log, newest first). Each entry has an id usable with undo_action.',
            parameters: {
                type: 'object',
                properties: { limit: { type: 'number' } }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'undo_action',
            description: 'Undo a reversible action (file write/create/delete) by its id from review_actions.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'save_user_fact',
            description: 'Save a NEW persistent fact about the user or their environment to cross-session memory. Save only facts genuinely new and durable — not restatements of retrieved memories.',
            parameters: {
                type: 'object',
                properties: { exact_new_fact: { type: 'string' } },
                required: ['exact_new_fact']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'memory_search',
            description: 'Search cross-session persistent memory for relevant facts.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query']
            }
        }
    }
];

const TOOL_CATEGORIES = {
    read: ['read_file', 'grep', 'glob', 'list_project', 'show_preview'],
    write: ['patch', 'write_file', 'append_file'],
    shell: ['run_command']
};

// Host-control tools (merged from Agent Mode). Always offered by the router in every
// phase — they are small, and an all-purpose harness must be able to look outside the
// project root on turn one. Phase gating still applies to the project build tools.
const HOST_TOOLS = [
    'read_host_file', 'write_host_file', 'delete_host_file', 'list_host_directory',
    'list_processes', 'read_process_log', 'send_input', 'stop_process',
    'web_search', 'fetch_url', 'review_actions', 'undo_action',
    'save_user_fact', 'memory_search'
];

function toolNames() {
    return CODE_TOOLS.map(t => t.function.name);
}

function schemasForNames(names) {
    const set = new Set(names);
    return CODE_TOOLS.filter(t => set.has(t.function.name));
}

module.exports = { CODE_TOOLS, TOOL_CATEGORIES, HOST_TOOLS, toolNames, schemasForNames };
