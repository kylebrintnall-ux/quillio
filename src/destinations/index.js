'use strict';

// Destination registry. Each destination is an adapter implementing:
//   name: string
//   createDocument({ brief, summary, writerPrompt, assetSpecs }) -> { id, url, title }
//   generateDraft(id) -> { title, fieldCount }
//
// Google Docs is the only destination today. To add Notion, OneDrive, etc.,
// write a new adapter file, register it here, and select it via the
// DESTINATION env var — no changes to the core workflow required.

const config = require('../config');
const googleDocs = require('./googleDocs');

const REGISTRY = {
  [googleDocs.name]: googleDocs,
};

function getDestination(name = config.DESTINATION) {
  const destination = REGISTRY[name];
  if (!destination) {
    throw new Error(
      `Unknown destination "${name}". Available: ${Object.keys(REGISTRY).join(', ')}`
    );
  }
  return destination;
}

module.exports = { getDestination };
