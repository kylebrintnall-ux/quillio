'use strict';

// Compatibility shim. workflow.js was split into:
//   - core/pipeline.js          platform-agnostic logic (no Slack)
//   - adapters/slackWorkflow.js Slack orchestration (runBriefWorkflow, runGenerateDraft)
// This re-export keeps existing imports (e.g. server.js requires './workflow')
// working unchanged.
module.exports = require('./adapters/slackWorkflow');
