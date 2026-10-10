/**
 * Renderer bundle entry — Code Mode IPC bridge + shared persona (no agent loop).
 */
require('../shared/renderThrottle.js');
require('../shared/contextPrune.js');
require('../shared/smithPersona.js');
require('../shared/modelClassifier.js');
require('../shared/taskClassifier.js');
require('../shared/toolPairing.js');
require('../shared/runtimeProfile.js');
require('../shared/streamSignals.js'); // v52.7: model-agnostic stream/busy/cut-off signals (window.XKStreamSignals)
require('../shared/sendSlot.js');      // v53.1: single in-flight send slot — double-send guard (window.XKSendSlot)
require('../shared/ctxGate.js');
require('../shared/retryPolicy.js');  // v53.6: hermes-grade transient-failure retry (window.XKRetryPolicy)
require('../shared/toolResults.js');  // v53.6: honest tool-result classification + timeouts (window.XKToolResults)
require('../shared/thinkingToggle.js'); // v54.4: 🧠 THINK toggle → request-level thinking overrides (window.XKThinkingToggle)
require('../code/context/gemmaHarness.js');
require('../code/context/modelHarness.js');
require('./timeline/eventAdapter.js');
require('./timeline/diffView.js');
require('./timeline/activityTimeline.js');
require('./ui/scrollFollow.js');
require('./ui/historyPersistence.js');
require('./modes/agentTools.js');
require('./modes/chatLoop.js');
require('./modes/webSearchFallback.js'); // v53.5: post-search silence → answer from actual results (window.XKWebSearchFallback)
require('./modes/runState.js');
require('./modes/modeHistory.js');
require('./modes/code.js');
require('./ui/codeRunUI.js');
require('./ui/runtimeProfileUI.js');
require('./ui/codePlanPanel.js');
require('./ui/previewPanel.js');
require('./ui/sidebarLayout.js');
require('./ui/modeBar.js');
require('./ui/modelPicker.js');
require('./ui/imageGenPanel.js');
require('./ui/electronAssetsPanel.js'); // v55.3: BUILD ASSETS — depot auto-provisioning progress (window.XKElectronAssetsPanel)
