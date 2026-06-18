'use strict';

// Centralized emoji: custom Quillio emoji with standard fallbacks. Shared by
// every Slack-facing module (slackWorkflow, services/slack, handlers/approval)
// so the custom-vs-fallback choice lives in exactly one place.
//
// USE_CUSTOM_EMOJI is hardcoded true for now (existing behavior — emoji()
// returns the :name: shortcode). When false, emoji() returns the standard
// Unicode fallback, so a workspace that hasn't uploaded the custom :quillio-*:
// emoji still renders correctly. Wire this to the tenant custom_emoji column
// in a later step.

const USE_CUSTOM_EMOJI = true;

const EMOJI = {
  'quillio-scroll': '📜',
  'quillio-doc-done': '📄',
  'quillio-folder': '📁',
  'quillio-copy-done': '🪶',
  quillio: '🪶',
};

// Return the emoji string to use in a message: the custom :name: form when
// custom emoji are enabled, else the standard fallback.
function emoji(name) {
  return USE_CUSTOM_EMOJI ? `:${name}:` : EMOJI[name] || '';
}

module.exports = { emoji, EMOJI, USE_CUSTOM_EMOJI };
