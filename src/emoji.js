'use strict';

// Centralized emoji: custom Quillio emoji with standard fallbacks. Shared by
// every Slack-facing module (slackWorkflow, services/slack) so the
// custom-vs-fallback choice lives in exactly one place.
//
// USE_CUSTOM_EMOJI comes from config (SLACK_USE_CUSTOM_EMOJI) and defaults to
// FALSE, so a fresh workspace that hasn't uploaded the custom :quillio-*: emoji
// renders the standard Unicode fallbacks instead of literal ":quillio-scroll:"
// text. Workspaces that HAVE uploaded them set SLACK_USE_CUSTOM_EMOJI=true and
// emoji() returns the :name: shortcode. Wire this to the tenant custom_emoji
// column in a later step.

const config = require('./config');

const USE_CUSTOM_EMOJI = config.SLACK_USE_CUSTOM_EMOJI;

const EMOJI = {
  'quillio-scroll': '📜',
  'quillio-doc-done': '📄',
  'quillio-folder': '📁',
  'quillio-copy-done': '🪶',
  'quillio-review': '🔍',
  quillio: '🪶',
};

// Return the emoji string to use in a message: the custom :name: form when
// custom emoji are enabled, else the standard fallback.
function emoji(name) {
  return USE_CUSTOM_EMOJI ? `:${name}:` : EMOJI[name] || '';
}

module.exports = { emoji, EMOJI, USE_CUSTOM_EMOJI };
