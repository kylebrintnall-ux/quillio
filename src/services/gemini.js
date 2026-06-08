'use strict';

const config = require('../config');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini(body) {
  if (!config.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const url = `${API_BASE}/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini returned no text. Raw: ' + JSON.stringify(data));
  }
  return text;
}

// Parse a free-form campaign brief into { summary, writerPrompt, assets }.
// Assets are constrained to the allowed list regardless of how they were
// written in the brief (bullets, numbers, or inline prose).
async function parseBrief(brief) {
  const allowed = config.ALLOWED_ASSETS;

  const prompt = [
    'You are a marketing operations assistant. Read the campaign brief below and extract structured data.',
    '',
    'Return:',
    '- summary: 2-3 sentences summarizing the campaign.',
    '- writerPrompt: ONE sentence of creative direction for a copywriter.',
    `- assets: an array of asset types requested in the brief. Choose ONLY from this exact list: ${allowed.join(
      ', '
    )}. The brief may list assets as bullets, numbers, or inline prose — extract them regardless of format. Match loosely (e.g. "LinkedIn ads" -> "Paid Social - LinkedIn", "email" -> "Dynamic Email"). Only include assets that clearly map to the list. Use the exact strings from the list.`,
    '',
    'CAMPAIGN BRIEF:',
    brief,
  ].join('\n');

  const text = await callGemini({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          writerPrompt: { type: 'string' },
          assets: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'writerPrompt', 'assets'],
      },
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error('Could not parse Gemini brief JSON: ' + text);
  }

  // Defensively constrain assets to the allowed list.
  const allowedSet = new Set(allowed);
  const assets = Array.isArray(parsed.assets)
    ? parsed.assets.filter((a) => allowedSet.has(a))
    : [];

  return {
    summary: String(parsed.summary || '').trim(),
    writerPrompt: String(parsed.writerPrompt || '').trim(),
    assets,
  };
}

// Generate a single piece of draft copy for one asset field, honoring the
// character limit and creative direction.
async function generateFieldDraft({
  assetType,
  channel,
  fieldName,
  charLimit,
  toneNotes,
  notes,
  summary,
  writerPrompt,
}) {
  const limitLine =
    charLimit && /\d/.test(String(charLimit))
      ? `Keep it within ${charLimit} characters.`
      : 'Keep it concise and appropriate for the field.';

  const prompt = [
    'Write marketing copy for a single field. Return ONLY the copy itself — no labels, quotes, or commentary.',
    '',
    `Campaign summary: ${summary}`,
    `Creative direction: ${writerPrompt}`,
    `Asset: ${assetType}`,
    channel ? `Channel: ${channel}` : '',
    `Field: ${fieldName}`,
    toneNotes ? `Tone notes: ${toneNotes}` : '',
    notes ? `Field notes: ${notes}` : '',
    limitLine,
  ]
    .filter(Boolean)
    .join('\n');

  const text = await callGemini({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.8 },
  });

  return text.trim().replace(/^["']|["']$/g, '');
}

module.exports = { parseBrief, generateFieldDraft };
