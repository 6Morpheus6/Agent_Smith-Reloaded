const GREENFIELD_NODE = {
    projectType: 'greenfield',
    steps: [
        'Initialize git repository and project scaffold',
        'Create core source files and entry point',
        'Add configuration and README',
        'Implement main feature logic',
        'Add tests and verify npm test passes',
        'Final review and documentation'
    ]
};

const GREENFIELD_PYTHON = {
    projectType: 'greenfield',
    steps: [
        'Initialize git and Python project structure',
        'Create main module and package layout',
        'Add requirements and README',
        'Implement core functionality',
        'Add pytest tests and verify',
        'Final review'
    ]
};

function stepsForType(projectType, language) {
    if (projectType === 'greenfield') {
        if (language === 'python') return [...GREENFIELD_PYTHON.steps];
        return [...GREENFIELD_NODE.steps];
    }
    return null;
}

module.exports = { GREENFIELD_NODE, GREENFIELD_PYTHON, stepsForType };
