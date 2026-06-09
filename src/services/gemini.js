'use strict';

const config = require('../config');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Hard per-request timeout. Without this a stalled Gemini call hangs forever,
// which (in the fire-and-forget draft flow) leaves Slack stuck on "Generating…"
// with no error ever surfacing. Overridable via GEMINI_TIMEOUT_MS.
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 45000;

async function callGemini(body) {
  if (!config.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const url = `${API_BASE}/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Gemini request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

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

// Defensive backstop: if the model wraps its JSON in a ```json ... ``` fence
// despite being told not to, strip the fence so JSON.parse still succeeds.
function stripJsonFences(text) {
  return String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
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
    '- campaignTitle: a concise, descriptive campaign title of 3-7 words based on',
    '  what the campaign ACTUALLY is — the event name, product, or theme — read',
    '  from the whole brief, NOT just the opening words. E.g. a brief about promos',
    '  for a speed dating event called Holy Flirtation -> "Holy Flirtation Speed',
    '  Dating Event", not "Promos For A". No date, no quotes, no trailing punctuation.',
    '- summary: 2-3 sentences summarizing the campaign.',
    '- writerPrompt: ONE sentence of creative direction for a copywriter.',
    `- assets: an array of asset types requested in the brief. Each value MUST be one of these exact strings: ${allowed.join(
      ', '
    )}.`,
    '',
    'INTERPRET INTENT SEMANTICALLY, do not match exact strings. Briefs use',
    'informal, abbreviated, or platform-specific language. Map what the writer',
    'MEANS to the canonical asset name. The brief may list assets as bullets,',
    'numbers, or inline prose — extract them regardless of format. The lists below',
    'are illustrative, not exhaustive; treat obvious variants, plurals, and',
    'casing the same way:',
    '- "Paid Social - LinkedIn": LinkedIn, LI, li, linked in, LinkedIn ad, LinkedIn paid, paid LinkedIn, LinkedIn sponsored, sponsored content, LinkedIn social, social LinkedIn, B2B social, LI ad, LinkedIn campaign, LinkedIn post',
    '- "Paid Social - Meta": Meta, Facebook, FB, Instagram, IG, Meta ad, Facebook ad, FB ad, IG ad, Instagram ad, paid Meta, paid Facebook, paid Instagram, Meta social, Facebook social, Instagram social, social Meta, paid social Meta',
    '- "Paid Social - Twitter/X": Twitter, X, tweet, X ad, Twitter ad, paid Twitter, paid X, Twitter social, X social, Twitter campaign, X campaign',
    '- "Display Banner": display, banner, GDN, Google Display, display ad, banner ad, display banner, Google banner, programmatic, digital display, web banner, HTML banner, rich media',
    '- "Dynamic Email": email, DEM, dynamic email, nurture email, nurture, email campaign, marketing email, bulk email, batch email, demand email, email blast, EDM, triggered email, automated email',
    '- "Sales Basho": Basho, basho, sales email, outbound email, outbound, 1:1 email, one to one email, SDR email, BDR email, prospecting email, cold email, sales outreach, rep email, AE email, direct email, personalized email',
    '- "Organic Social": organic, organic social, social post, organic post, social media, social media post, earned social, unpaid social, owned social, social content',
    '- "Form Confirm Page": form confirm, confirmation page, thank you page, form confirmation, TY page, post-form, form landing page, confirmation, form page, submission confirmation, form complete',
    '',
    'Category / fallback rules:',
    '- "all assets", "full campaign", "everything", or "all channels" -> return ALL 8 asset types.',
    '- "paid social" without a named platform -> all three Paid Social variants (LinkedIn, Meta, Twitter/X).',
    '- "social" used generally -> both Paid Social... and Organic Social, i.e. Paid Social - LinkedIn, Paid Social - Meta, Paid Social - Twitter/X, and Organic Social.',
    '- "email" used generally -> both Dynamic Email and Sales Basho.',
    '- Only include an asset when the intent is reasonably clear; do not invent assets that are not implied.',
    '',
    '- folderId: if the brief contains a Google Drive folder URL of the form',
    '  https://drive.google.com/drive/folders/FOLDER_ID , extract just the',
    '  FOLDER_ID string (the path segment after /folders/). Return null if none.',
    '- referenceLinks: an array of every URL found anywhere in the brief (Drive',
    '  links, external links, anything starting with http or https). Return [] if none.',
    '',
    'Return an object of the shape: {"campaignTitle": string, "summary": string, "writerPrompt": string, "assets": string[], "folderId": string|null, "referenceLinks": string[]}.',
    'Respond with valid JSON only, no markdown, no backticks.',
    '',
    'CAMPAIGN BRIEF:',
    brief,
  ].join('\n');

  const text = await callGemini({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch (err) {
    throw new Error('Could not parse Gemini brief JSON: ' + text);
  }

  // Defensively constrain assets to the allowed list.
  const allowedSet = new Set(allowed);
  const assets = Array.isArray(parsed.assets)
    ? parsed.assets.filter((a) => allowedSet.has(a))
    : [];

  const folderId = parsed.folderId ? String(parsed.folderId).trim() : null;
  const referenceLinks = Array.isArray(parsed.referenceLinks)
    ? parsed.referenceLinks.map((u) => String(u).trim()).filter(Boolean)
    : [];

  return {
    campaignTitle: String(parsed.campaignTitle || '').trim(),
    summary: String(parsed.summary || '').trim(),
    writerPrompt: String(parsed.writerPrompt || '').trim(),
    assets,
    folderId,
    referenceLinks,
  };
}

// Strip wrapping quotes / stray markdown from a single line of model output.
function cleanDraft(text) {
  return String(text).trim().replace(/^[*_"'“”‘’\s]+|[*_"'“”‘’\s]+$/g, '').trim();
}

// The hard character ceiling implied by a charLimit cell. Handles "50",
// "50-75" (→75), and "150 recommended (600 max)" (→600). Null = no numeric cap.
function charCeiling(charLimit) {
  const nums = String(charLimit || '').match(/\d+/g);
  return nums ? Math.max(...nums.map(Number)) : null;
}

// Last-resort trim to a hard ceiling, cutting on a word boundary where possible.
function trimToCeiling(s, max) {
  if (s.length <= max) return s;
  let t = s.slice(0, max);
  const lastSpace = t.lastIndexOf(' ');
  if (lastSpace > max * 0.6) t = t.slice(0, lastSpace);
  return t.replace(/[\s.,;:!\-–—]+$/, '').trim();
}

// Generate a single piece of draft copy for one asset field, honoring the
// character limit and creative direction. Enforces the limit: if the draft is
// over, it gets one corrective rewrite, then a hard trim as a last resort.
async function generateFieldDraft({
  assetType,
  channel,
  fieldName,
  charLimit,
  toneNotes,
  notes,
  funnelStage,
  summary,
  writerPrompt,
}) {
  const ceiling = charCeiling(charLimit);
  const limitLine = ceiling
    ? `Hard limit: the copy MUST be ${ceiling} characters or fewer${
        /[-–—]/.test(String(charLimit)) ? ` (target range ${charLimit})` : ''
      }.`
    : 'Keep it concise and appropriate for the field.';

  const prompt = [
    'Write marketing copy for a single field. Return ONLY the copy itself — no labels, quotes, options, or commentary. Exactly one version.',
    '',
    `Campaign summary: ${summary}`,
    `Creative direction: ${writerPrompt}`,
    `Asset: ${assetType}`,
    channel ? `Channel: ${channel}` : '',
    `Field: ${fieldName}`,
    funnelStage ? `Funnel stage: ${funnelStage}` : '',
    toneNotes ? `Tone notes: ${toneNotes}` : '',
    notes ? `Field guidance: ${notes}` : '',
    limitLine,
  ]
    .filter(Boolean)
    .join('\n');

  let copy = cleanDraft(
    await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8 },
    })
  );

  // Enforce the hard ceiling: one corrective rewrite, then a hard trim.
  if (ceiling && copy.length > ceiling) {
    const retryPrompt = [
      prompt,
      '',
      `Your previous draft was ${copy.length} characters — too long. Rewrite it to be ${ceiling} characters or fewer while preserving the meaning and tone. Return ONLY the copy.`,
      `Previous draft: ${copy}`,
    ].join('\n');

    copy = cleanDraft(
      await callGemini({
        contents: [{ role: 'user', parts: [{ text: retryPrompt }] }],
        generationConfig: { temperature: 0.5 },
      })
    );

    if (copy.length > ceiling) copy = trimToCeiling(copy, ceiling);
  }

  return copy;
}

module.exports = { parseBrief, generateFieldDraft };
