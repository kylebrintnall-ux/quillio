'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { reviewUnitKey } = require('../utils/instanceKey');
const { normalize } = require('../utils/normalize');

// The two repo-root markdown guides, loaded once at startup:
//   craft.md — HOW GOOD COPY WORKS. Universal craft (headline/body/CTA
//     principles, the approved CTA library, character discipline, and the
//     per-medium sections). ALWAYS injected, for every tenant. Never replaced
//     by tenant content — a tenant's brand guide supplements it.
//   voice.md — HOW THIS COMPANY SOUNDS. Brand identity only. This is the
//     FALLBACK: a tenant's saved guide replaces it when one exists.
// HTML comments are stripped; if only headings/comments remain (the unfilled
// placeholder), the file is treated as empty and nothing is injected.
function loadGuide(fileName) {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', fileName), 'utf8');
    const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, '');
    const meaningful = withoutComments.replace(/^#.*$/gm, '').trim();
    return meaningful ? withoutComments.trim() : '';
  } catch {
    return '';
  }
}
const CRAFT_GUIDE = loadGuide('craft.md');
const VOICE_GUIDE = loadGuide('voice.md');

// Split a guide once into the universal parts (always injected) and the
// per-medium subsections of "## … Writing Across Mediums" (injected only for
// the relevant medium — see buildCraftContext). This is the token optimization:
// instead of shipping the whole file on every asset call, we ship the universal
// craft + CTA library + just the one relevant medium section. The mediums live
// in craft.md now, so that's the file this normally slices — but it is also
// applied to a tenant guide that happens to carry its own mediums section.
function parseVoice(guide) {
  if (!guide) return null;
  const lines = guide.split('\n');

  let mediumsStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) && /writing across mediums/i.test(lines[i])) {
      mediumsStart = i;
      break;
    }
  }
  // No recognizable mediums section → can't slice; fall back to the whole file.
  if (mediumsStart === -1) return { sliceable: false };

  let mediumsEnd = lines.length;
  for (let i = mediumsStart + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      mediumsEnd = i;
      break;
    }
  }

  const block = lines.slice(mediumsStart, mediumsEnd);
  let firstSub = block.length;
  for (let i = 0; i < block.length; i++) {
    if (/^###\s/.test(block[i])) {
      firstSub = i;
      break;
    }
  }

  const subs = [];
  let cur = null;
  for (let i = firstSub; i < block.length; i++) {
    if (/^###\s/.test(block[i])) {
      if (cur) subs.push(cur);
      cur = { title: block[i].replace(/^###\s*/, '').trim(), lines: [block[i]] };
    } else if (cur) {
      cur.lines.push(block[i]);
    }
  }
  if (cur) subs.push(cur);

  return {
    sliceable: true,
    preMedium: lines.slice(0, mediumsStart).join('\n').trim(),
    mediumsIntro: block.slice(0, firstSub).join('\n').trim(),
    subs: subs.map((s) => ({ title: s.title, text: s.lines.join('\n').trim() })),
    postMedium: lines.slice(mediumsEnd).join('\n').trim(),
  };
}
const CRAFT_PARSED = parseVoice(CRAFT_GUIDE);
const VOICE_PARSED = parseVoice(VOICE_GUIDE);

// Which "Writing Across Mediums" subsection(s) apply to an asset type. Matched
// as case-insensitive substrings of the ### headings. Null = unknown medium →
// include them all (safe fallback).
function mediumKeywordsForAsset(assetType) {
  const a = String(assetType).toLowerCase();
  if (a.includes('paid social') || /\b(linkedin|meta|facebook|instagram|twitter)\b/.test(a)) {
    return ['paid social'];
  }
  if (a.includes('organic')) return ['organic social'];
  if (a.includes('display') || a.includes('banner')) return ['google display'];
  if (a.includes('basho') || a.includes('sales') || a.includes('outbound')) return ['sales'];
  if (a.includes('email')) return ['email'];
  if (a.includes('form') || a.includes('confirm') || a.includes('thank')) return ['confirmation'];
  return null;
}

// Slice a parsed guide down to the universal part + only the medium subsections
// relevant to `assetType`. `assetType` may be a single type or an array of them
// (copy review spans several assets in one prompt) — the union of their mediums
// is kept, and an unrecognized type anywhere means "keep every medium".
function sliceGuide(parsed, rawFull, assetType) {
  if (!parsed) return '';
  if (!parsed.sliceable) return rawFull;

  const types = Array.isArray(assetType) ? assetType : [assetType];
  let keywords = [];
  for (const t of types) {
    const k = mediumKeywordsForAsset(t);
    if (!k) { keywords = null; break; } // unknown medium → include them all
    keywords.push(...k);
  }
  if (keywords && keywords.length === 0) keywords = null;

  let chosen = keywords
    ? parsed.subs.filter((s) => keywords.some((k) => s.title.toLowerCase().includes(k)))
    : parsed.subs;
  if (chosen.length === 0) chosen = parsed.subs; // no match → don't drop guidance

  return [
    parsed.preMedium,
    parsed.mediumsIntro,
    ...chosen.map((s) => s.text),
    parsed.postMedium,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// The CRAFT context for a given asset: universal craft (incl. the CTA library
// and character discipline) plus only the relevant medium subsection. Always
// sourced from the repo craft.md — a tenant NEVER replaces it.
function buildCraftContext(assetType) {
  return sliceGuide(CRAFT_PARSED, CRAFT_GUIDE, assetType);
}

// The BRAND context for a given asset: the tenant's saved guide when they have
// one, otherwise the repo voice.md placeholder. A tenant guide is normally a
// short brand document with no mediums section, so it passes through whole; if
// one does carry "Writing Across Mediums", it gets sliced like craft.md.
function buildBrandContext(assetType, voiceGuide) {
  if (voiceGuide && String(voiceGuide).trim()) {
    const raw = String(voiceGuide).trim();
    return sliceGuide(parseVoice(raw), raw, assetType);
  }
  return sliceGuide(VOICE_PARSED, VOICE_GUIDE, assetType);
}

// Prompt lines for the craft + brand sections, scoped to the asset's medium.
// Two clearly labeled blocks: craft.md = how good copy works (always present);
// brand = how this company sounds (tenant guide, else the repo voice.md).
// Frames the layering: craft + brand = how to write; field Tone Notes =
// field-specific direction; character limits = hard constraints that always win.
function brandVoiceLines(assetType, voiceGuide) {
  const craft = buildCraftContext(assetType);
  const brand = buildBrandContext(assetType, voiceGuide);
  if (!craft && !brand) return [];

  const craftBlock = craft
    ? [
        'COPY CRAFT PLAYBOOK — this is HOW GOOD COPY WORKS: universal copywriting craft',
        '(headline/body/CTA principles, the approved CTA library, character discipline,',
        'and guidance for THIS asset\'s medium). It applies to ALL copy, always.',
        '"""',
        craft,
        '"""',
        '',
      ]
    : [];
  const brandBlock = brand
    ? [
        'BRAND VOICE — this is HOW THIS COMPANY SOUNDS: voice attributes, tone, word',
        'choices, banned words, and mechanics. It does not replace the craft playbook —',
        'it tells you what the craft above should sound like in this brand\'s hands.',
        '"""',
        brand,
        '"""',
        '',
      ]
    : [];

  return [
    ...craftBlock,
    ...brandBlock,
    'PROMPT HIERARCHY — what governs what:',
    '1. The Copy Craft Playbook = HOW to write well (structure, format, craft).',
    '2. The Brand Voice = HOW this company sounds (voice, tone, word choice).',
    "3. Each field's Tone Notes / guidance = field-specific tactical direction.",
    '4. Character limits = HARD constraints that ALWAYS win.',
    'Craft governs STRUCTURE — length discipline, front-loading, one idea per line,',
    'CTA/destination match. Brand governs VOICE, and where the two conflict on how',
    'something SOUNDS (tone, word choice, phrasing), the BRAND VOICE wins.',
    "When the playbook and a field's Tone Note conflict, the field's Tone Note",
    'wins for that field — but the overall voice (tone, banned words, CTA style)',
    'always applies, and a field\'s character limit is never exceeded.',
    'For CTA fields: prefer an option from the craft playbook\'s approved CTA library',
    "that matches the asset's destination / funnel stage, rather than inventing a",
    'new CTA phrasing — then adjust its wording to the brand voice if needed.',
    '',
  ];
}

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

// Resilient JSON-array extractor for "thinking" models (e.g. gemini-3.5-flash)
// that can leak reasoning prose around — or fences around — the actual JSON.
// Tries, in order: (1) parse the fence-stripped text directly; (2) if that
// yields an object with an array-valued `results`/`items`/`fields` key, use it;
// (3) slice from the first `[` to the last `]` and parse that. Returns the array
// on success, or null if nothing parseable is found (so callers can retry).
function extractJsonArray(text) {
  const stripped = stripJsonFences(text);
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  // 1) Clean, direct parse.
  const direct = tryParse(stripped);
  if (Array.isArray(direct)) return direct;
  // 2) Object wrapper around the array.
  if (direct && typeof direct === 'object') {
    for (const k of ['results', 'items', 'fields', 'reviews', 'data']) {
      if (Array.isArray(direct[k])) return direct[k];
    }
  }
  // 3) Prose around the array — slice the outermost [ … ].
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const sliced = tryParse(stripped.slice(start, end + 1));
    if (Array.isArray(sliced)) return sliced;
  }
  return null;
}

// Coerce a Gemini field to a readable string. If the model returns a nested
// object (e.g. a structured writerPrompt), pretty-print it instead of letting
// String() turn it into "[object Object]".
function toReadableText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

// Parse-side sanity limits on the model's numbers. These are NOT the surface
// ceilings — core/pipeline re-clamps per surface (3 per asset / 6 total on Slack,
// 10 / 40 on the web) and is the authority. These only stop a hallucinated
// "count: 400" from travelling any further than the parse.
const PARSE_MAX_COUNT_PER_ASSET = 10;
const PARSE_MAX_TOTAL = 40;

// --- The parse prompt's phrase → asset mappings ------------------------------
//
// These teach the model what a writer MEANS ("basho" → Sales Basho Email). They
// are hand-written intent, so unlike the asset list itself they cannot be
// derived from a tenant's library — but they must still be FILTERED to it.
//
// A stale mapping line is worse than no mapping line. It instructs the model to
// emit a name the defensive filter below will then reject, which produces
// exactly the silent drop the partial-miss notice was added to make loud. So a
// line is emitted only when its target is actually in the tenant's list.
//
// `line` carries the fully rendered text rather than phrase parts, because the
// separators are not uniform ("a", "b" or "c" vs "a" or "b") and rebuilding them
// would have changed the prompt for no gain. Against the full bundled list the
// rendered block differs from the hand-written one it replaced by exactly one
// moved line: the "Testing language means MORE VERSIONS OF ONE ASSET" sentence
// now sits with the general A/B rule (which always ships) instead of with the
// LinkedIn example (which does not).
//
// `target` drives the filtering, so it must not drift from the text. A smoke
// test asserts every targeted line NAMES its own target — not that it ends with
// it, since the A/B entry is prose ("… one entry: X, count 3").
const ASSET_PHRASE_HINTS = [
  { target: 'LinkedIn Single Image Ad', line: '- "linkedin ad" or "linkedin" → LinkedIn Single Image Ad' },
  { target: 'LinkedIn Carousel Ad', line: '- "linkedin carousel" → LinkedIn Carousel Ad' },
  // A/B-test phrasing means MORE VERSIONS OF ONE ASSET, which is `count`. The
  // rule and its rationale are universal — they describe the `count` mechanism,
  // not any particular asset — so they are always emitted. Only the concrete
  // LinkedIn example and the Variant-type caveat below depend on the library.
  {
    always: true,
    line: [
      '- "ab test" or "a/b test" or "two versions" or "variants" → the BASE asset, count 2 (or the number given)',
      '  Testing language means MORE VERSIONS OF ONE ASSET — express it with count.',
    ].join('\n'),
  },
  {
    target: 'LinkedIn Single Image Ad',
    line: '- "3 linkedin ads to a/b test" → one entry: LinkedIn Single Image Ad, count 3',
  },
  // Only worth saying to a tenant who actually has "… — Variant A"-style types.
  {
    anyMatching: /—\s*variant\s/i,
    line: [
      '  Only return a "… — Variant A"/"Variant B" asset type when the brief names one',
      '  of those types outright; never as a way of expressing "two versions".',
    ].join('\n'),
  },
  { target: 'Meta Single Image Ad', line: '- "meta ad" or "facebook ad" → Meta Single Image Ad' },
  { target: 'Meta Carousel Ad', line: '- "meta carousel" → Meta Carousel Ad' },
  { target: 'Twitter/X Ad', line: '- "twitter" or "x ad" → Twitter/X Ad' },
  { target: 'Display Banner — Standard', line: '- "display" or "banner" → Display Banner — Standard' },
  {
    target: 'Google Responsive Display Ad',
    line: '- "responsive display", "dv360" or "programmatic" → Google Responsive Display Ad',
  },
  { target: 'Demand Gen Nurture Email', line: '- "email" or "nurture" → Demand Gen Nurture Email' },
  { target: 'Event Invitation Email', line: '- "event email" or "invite" → Event Invitation Email' },
  { target: 'Event Reminder Email', line: '- "reminder email" → Event Reminder Email' },
  { target: 'Event Follow-Up / Recap Email', line: '- "follow up" or "recap email" → Event Follow-Up / Recap Email' },
  { target: 'Sales Basho Email', line: '- "basho" or "sales email" → Sales Basho Email' },
  { target: 'Event Landing Page', line: '- "landing page" or "event page" → Event Landing Page' },
  { target: 'On-Site Signage — General', line: '- "signage" or "on-site" → On-Site Signage — General' },
  { target: 'Campaign Landing Page', line: '- "campaign page" → Campaign Landing Page' },
  { target: 'Form Confirm Page', line: '- "confirm page" or "form confirm" → Form Confirm Page' },
  { target: 'Organic Social — LinkedIn', line: '- "organic social" or "organic" → Organic Social — LinkedIn' },
  { target: 'Organic Social — Instagram', line: '- "instagram" → Organic Social — Instagram' },
  { target: 'Direct Mail — Box / Mailer', line: '- "direct mail" or "mailer" → Direct Mail — Box / Mailer' },
  {
    target: 'Direct Mail — Note Card / Rep Letter',
    line: '- "rep letter" or "note card" → Direct Mail — Note Card / Rep Letter',
  },
  { target: 'One-Pager', line: '- "one pager" or "one-pager" → One-Pager' },
  { target: 'Battle Card', line: '- "battle card" → Battle Card' },
];

// Things a brief might ask for that Quillio has no asset type for. Used only as
// EXAMPLES in the refusal rule — so any of them a tenant actually has must be
// dropped, or the prompt would be telling the model to refuse an asset that
// tenant owns.
const REFUSAL_EXAMPLES = ['TikTok', 'podcast ad', 'billboard', 'SMS'];

// The phrase-mapping lines that apply to THIS list of asset names.
function assetPhraseHintLines(allowed) {
  const have = new Set(allowed.map(normalize));
  return ASSET_PHRASE_HINTS.filter((h) => {
    if (h.always) return true;
    if (h.anyMatching) return allowed.some((n) => h.anyMatching.test(n));
    return have.has(normalize(h.target));
  }).map((h) => h.line);
}

// Word tokens of a name, normalized. Used to decide whether a refusal example
// describes something the tenant actually owns.
function nameTokens(s) {
  return normalize(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// The "don't guess" rule, with only the examples this tenant does NOT have.
// If a tenant somehow has all four, the rule still stands — it just stops
// offering examples rather than naming assets they own as things to refuse.
//
// Matching is TOKEN containment, not substring. A tenant asset called
// "Podcast Read Ad" does not contain the substring "podcast ad" — the word
// "Read" sits between them — so a substring test left the prompt telling the
// model to refuse podcast asks from a tenant whose library has a podcast asset.
// Every token of the example must appear as a token of the asset name.
function refusalRuleLine(allowed) {
  const have = allowed.map(nameTokens);
  const usable = REFUSAL_EXAMPLES.filter((ex) => {
    const want = nameTokens(ex);
    return !have.some((tokens) => want.every((w) => tokens.includes(w)));
  });
  const eg = usable.length > 0 ? ` (e.g. ${usable.join(', ')})` : '';
  return (
    `- If the brief requests an asset type that does NOT confidently map to the allowed list${eg}, ` +
    'do NOT substitute a nearest guess. Put the original phrase in unmatchedAssets and leave it out of assets.'
  );
}

// Parse a free-form campaign brief into { summary, writerPrompt, assets, … }.
// `assets` is an ordered PLAN — [{ asset, count, labels? }] — constrained to the
// allowed list regardless of how the brief was written (bullets, numbers, prose).
// Repeats are preserved: two entries naming one asset are two separate asks.
async function parseBrief(brief, allowedAssets) {
  // The asset VOCABULARY for this parse — used both as prompt data and as the
  // defensive filter below, which is why it has to be one value.
  //
  // It is now the TENANT'S OWN asset names, passed in by core/pipeline. It used
  // to be config.ALLOWED_ASSETS unconditionally, and that was the blocker: an
  // asset sitting in a tenant's asset_types but missing from the global 30 was
  // filtered straight out of the plan, so a brief could not ask for an asset the
  // tenant already owned. Three of the four gates downstream were already
  // per-tenant (tenantAssetsToSpecs throws on an unknown name; both plan
  // validators check getTenantAssets) — this was the one global one, sitting
  // upstream of all of them.
  //
  // config.ALLOWED_ASSETS remains the fallback for no-DB / demo / unseeded
  // tenants, where getTenantAssets returns null and there is no library to read.
  const allowed = Array.isArray(allowedAssets) && allowedAssets.length > 0
    ? allowedAssets
    : config.ALLOWED_ASSETS;

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
    `- assets: an ORDERED list of the asset types the brief asks for, in the order the brief mentions them. Each entry is an object {"asset": string, "count": number, "labels": string[]}. \`asset\` MUST be an exact name from this list:\n\n${allowed.join(
      '\n'
    )}\n\nReturn only names from this list. If no specific assets are mentioned, return the 3 most relevant for the campaign goal described, each with count 1.`,
    '',
    'HOW MANY OF EACH (the `count` field):',
    '- count is HOW MANY SEPARATE VERSIONS of that asset the brief wants — how many',
    '  distinct pieces of copy a writer has to produce. Default 1.',
    '- Only go above 1 when the brief actually asks for more than one: an explicit',
    '  number ("five nurture emails", "3 LinkedIn ads"), a per-group ask ("an email',
    '  for each audience" with the audiences named), or an A/B test ("two versions',
    '  to test").',
    '- A vague plural is NOT a number. "some LinkedIn ads", "a few emails", "ads" →',
    '  count 1. Do not guess a number the brief did not give.',
    '- Never split one asset type across several entries to express a count — use one',
    '  entry with the right count.',
    '',
    'A NUMBER CROSSED WITH GROUPS MULTIPLIES. This is the rule to get right:',
    '- "five nurture emails for two audiences" = 5 emails FOR EACH audience =',
    '  count 10. Each audience needs its own version of all five, so ten pieces of',
    '  copy get written. The default reading of "N <assets> for M <groups>" is',
    '  ALWAYS N x M, not N shared between the groups.',
    '- "an email for each of our three regions" = count 3.',
    '- "3 LinkedIn ads for enterprise and SMB" = 3 x 2 = count 6.',
    '- ONLY treat the number as a shared total when the brief says so outright —',
    '  "five emails TOTAL across two audiences", "five emails SPLIT between the two",',
    '  "five emails, some for each" → count 5, not 10.',
    '- A multiplied count is an explicit number, so it overrides the size guidance',
    '  below. Never shrink 10 back to 5 to look tidier.',
    '',
    'NAMING THE VERSIONS (the `labels` field):',
    '- labels names each version, in order, ONLY when the brief names the groups —',
    '  audiences, segments, regions, waves, offers. Otherwise return [].',
    '- labels must have EXACTLY `count` entries, GROUPED: all of one group first,',
    '  then all of the next.',
    '- "five nurture emails for two audiences: downtown and suburban" → count 10,',
    '  labels ["Downtown","Downtown","Downtown","Downtown","Downtown",',
    '  "Suburban","Suburban","Suburban","Suburban","Suburban"] — five Downtown',
    '  versions then five Suburban ones. NOT five labels for ten versions, and NOT',
    '  two labels.',
    '- "3 LinkedIn ads for enterprise and SMB" → count 6, labels',
    '  ["Enterprise","Enterprise","Enterprise","SMB","SMB","SMB"].',
    '- Keep each label to a few words. Never invent a group the brief did not name.',
    '',
    'SIZE: when the brief gives NO numbers, keep the total number of versions to 5 or',
    'fewer. Numbers the brief actually states always win — if the brief says ten, or',
    'implies ten by crossing five with two, return ten and let the system decide what',
    'it can build.',
    '',
    'INTERPRET INTENT SEMANTICALLY, do not match exact strings. Briefs use',
    'informal, abbreviated, or platform-specific language. Map what the writer',
    'MEANS to the canonical asset name. The brief may list assets as bullets,',
    'numbers, or inline prose — extract them regardless of format. The lists below',
    'are illustrative, not exhaustive; treat obvious variants, plurals, and',
    'casing the same way:',
    // Filtered to mappings whose TARGET is in `allowed` — see ASSET_PHRASE_HINTS.
    ...assetPhraseHintLines(allowed),
    '',
    'Rules:',
    '- Only include an asset when the intent is reasonably clear; do not invent assets that are not implied. Never return all asset types for a vague brief.',
    refusalRuleLine(allowed),
    '',
    '- folderId: if the brief contains a Google Drive folder URL of the form',
    '  https://drive.google.com/drive/folders/FOLDER_ID , extract just the',
    '  FOLDER_ID string (the path segment after /folders/). Return null if none.',
    "- referenceLinks: extract every URL from the brief text that begins with http:// or https://. Include ALL URLs — Google Drive, Google Docs, Salesforce, external pages, AND Slack Canvas or Docs URLs (containing slack.com/canvas/ or slack.com/docs/). Return as a plain array of strings. If no URLs found, return [].",
    "  Example: ['https://docs.google.com/...', 'https://www.salesforce.com/...']",
    '- unmatchedAssets: asset types the brief asked for that do NOT map to the',
    '  allowed list. [] if none. Never force these into assets.',
    '',
    'Return an object of the shape: {"campaignTitle": string, "summary": string, "writerPrompt": string, "assets": [{"asset": string, "count": number, "labels": string[]}], "unmatchedAssets": string[], "folderId": string|null, "referenceLinks": string[]}.',
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

  console.log('[gemini] raw referenceLinks from parse:', JSON.stringify(parsed.referenceLinks));

  // Defensively constrain assets to the allowed list. Match case- and
  // dash-insensitively (Gemini may emit a hyphen where the canonical name uses
  // an em dash), then map back to the canonical name. Anything that doesn't map
  // is treated as unmatched (surfaced to the user, not silently dropped).
  //
  // This used a LOCAL normalizer that folded case and the three dash characters
  // but did NOT drop the spaces around a hyphen, so it disagreed with
  // utils/normalize (the one core/pipeline, googleDocs and pendingBriefs all
  // use) on 14 of the 30 allowed names. Two functions deciding what "the same
  // asset name" means is one too many — especially now that a UNIQUE INDEX
  // enforces the same question in Postgres. Converged onto utils/normalize:
  // strictly more tolerant here (it additionally matches "Direct Mail—Box",
  // em dash with no spaces, which the local one rejected) and collision-free
  // across the allowed list, which a smoke test pins.
  const canonicalByNorm = new Map(allowed.map((a) => [normalize(a), a]));

  // `assets` is now an ordered PLAN: [{ asset, count, labels }]. Entries are NOT
  // deduped any more — a brief can ask for the same asset more than once, and two
  // entries naming it are two separate asks (the expansion counts ordinals across
  // the whole plan). A bare string is still accepted, both because an older cached
  // response could carry one and because the model occasionally emits the simpler
  // shape; it means count 1.
  //
  // Every number here comes from a language model, so none of it is trusted:
  // counts are floored at 1, capped at PARSE_MAX_COUNT_PER_ASSET, and the whole
  // plan is capped at PARSE_MAX_TOTAL. Those are parse-side sanity limits, NOT the
  // surface ceilings — core/pipeline clamps again per surface (3/6 on Slack,
  // 10/40 on the web) and is the authority.
  const rawAssets = Array.isArray(parsed.assets) ? parsed.assets : [];
  const assets = [];
  const unmatchedFromAssets = [];
  let planTotal = 0;
  for (const entry of rawAssets) {
    if (entry == null) continue;
    const isString = typeof entry === 'string';
    if (!isString && typeof entry !== 'object') continue;
    const rawName = isString ? entry : entry.asset || entry.assetType || entry.name;
    const name = String(rawName == null ? '' : rawName).trim();
    if (!name) continue;

    const canonical = canonicalByNorm.get(normalize(name));
    if (!canonical) {
      unmatchedFromAssets.push(name);
      continue;
    }

    const requested = isString ? 1 : parseInt(entry.count, 10);
    let count = Math.max(1, Math.min(PARSE_MAX_COUNT_PER_ASSET, requested || 1));
    if (Number.isFinite(requested) && requested > PARSE_MAX_COUNT_PER_ASSET) {
      console.warn(`[gemini] parse: "${canonical}" count ${requested} → clamped to ${PARSE_MAX_COUNT_PER_ASSET}`);
    }
    // Whole-plan cap: trim the entry that crosses it and stop, rather than
    // returning a plan the pipeline would only refuse later.
    if (planTotal + count > PARSE_MAX_TOTAL) {
      count = PARSE_MAX_TOTAL - planTotal;
      if (count <= 0) {
        console.warn(`[gemini] parse: plan hit the ${PARSE_MAX_TOTAL}-version cap — dropping "${canonical}"`);
        continue;
      }
      console.warn(`[gemini] parse: plan hit the ${PARSE_MAX_TOTAL}-version cap — "${canonical}" trimmed to ${count}`);
    }
    planTotal += count;

    // Labels are positional; blanks become null so a partly-labelled plan is fine.
    const labels = (Array.isArray(entry && entry.labels) ? entry.labels : [])
      .slice(0, count)
      .map((l) => (typeof l === 'string' && l.trim() ? l.trim().slice(0, 80) : null));

    assets.push(labels.some(Boolean) ? { asset: canonical, count, labels } : { asset: canonical, count });
  }

  const unmatchedAssets = [
    ...(Array.isArray(parsed.unmatchedAssets) ? parsed.unmatchedAssets : []),
    ...unmatchedFromAssets,
  ]
    .map((a) => String(a).trim())
    .filter(Boolean);

  const folderId = parsed.folderId ? String(parsed.folderId).trim() : null;
  const referenceLinks = Array.isArray(parsed.referenceLinks)
    ? parsed.referenceLinks.map((u) => String(u).trim()).filter(Boolean)
    : [];

  return {
    campaignTitle: String(parsed.campaignTitle || '').trim(),
    summary: toReadableText(parsed.summary).trim(),
    writerPrompt: toReadableText(parsed.writerPrompt).trim(),
    assets,
    unmatchedAssets,
    folderId,
    referenceLinks,
  };
}

// Phase 2 — second pass: enrich the Campaign Summary and Writer Direction using
// text pulled from the brief's linked reference docs. Additive and safe: if
// there's no context, or the call/parse fails, the original parsedBrief is
// returned unchanged (never breaks the pipeline). The assets list is never
// touched. Returns a (possibly) updated copy of parsedBrief.
async function enrichWithReferences(parsedBrief, referenceContext) {
  if (!referenceContext || !String(referenceContext).trim()) return parsedBrief;

  const prompt = `You are a senior B2B copywriter briefing a creative team. You have received a parsed creative brief and additional context from reference documents the requester linked. Your job is to rewrite the Campaign Summary and Writer Direction so they are as specific and actionable as possible for a copywriter who has not read the reference documents.

Use the reference content to pull the campaign theme/name, the most compelling exact statistics, the primary persona and their pain points, and any competitor-category framing.

Return ONLY valid JSON with exactly these three fields — no preamble, no markdown, no explanation:

summary: maximum 3 sentences. Campaign theme, target audience, and core message only. No backstory, no history, no context paragraphs.

writerPrompt: use this exact compact format, plain text, no markdown, no asterisks, each label on the same line as its content:

Audience: [one line — persona title, company size, industries]
Pain Points: [3 items, each 8 words or less, separated by the pipe character |]
Voice: [two sentences max — tone and angle]
Competitive Framing: [one sentence max]
Do Not Use: [comma-separated inline list]

referenceInsights: compress each source to this format:
{
  source: document title or hostname,
  type: 'drive', 'slides', 'external', 'pdf', or 'canvas',
  stats: array of max 3 items, each under 10 words, verbatim from source only — no inferred or generated stats, empty array if none,
  keyMessages: array of max 2 items, each under 12 words
}
Omit persona and bannedWords fields entirely — removed from spec.
Return as array — one object per source read. If no references were read, return [].

INPUTS:

Original Campaign Summary:
${parsedBrief.summary}

Original Writer Direction:
${parsedBrief.writerPrompt}

Reference Document Content:
${referenceContext}`;

  try {
    const text = await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3 },
    });
    const parsed = JSON.parse(stripJsonFences(text));
    return {
      ...parsedBrief,
      summary: toReadableText(parsed.summary).trim() || parsedBrief.summary,
      writerPrompt: toReadableText(parsed.writerPrompt).trim() || parsedBrief.writerPrompt,
      referenceInsights: Array.isArray(parsed.referenceInsights) ? parsed.referenceInsights : [],
    };
  } catch (err) {
    console.error('[Quillio] enrichWithReferences failed, using original brief:', err.message);
    return parsedBrief;
  }
}

// Wrapper delimiters we'll peel off model output: a straight quote pair, a
// markdown emphasis pair, or a matching curly pair. Opening char → closing char.
const WRAPPER_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ['*', '*'],
  ['_', '_'],
  ['“', '”'], // “ ”
  ['‘', '’'], // ‘ ’
];

// Peel ONE balanced wrapper enclosing the whole string; null if it isn't wrapped.
//
// Two conditions, and both matter:
//   1. the first and last characters are a matching pair, AND
//   2. the opening delimiter's match is the FINAL character — i.e. scanning the
//      text between them never closes the wrapper early.
//
// Condition 2 is the difference between a wrapper and two quoted phrases that
// merely happen to sit at each end:
//
//   "He said "hi" loudly"                  -> wrapped   (inner quotes nest)
//   "Make it pop" isn't a brief. "Stop."   -> NOT wrapped (closes at "pop")
//
// Curly pairs have distinct open/close characters, so depth counting is exact.
// Straight quotes and markdown emphasis reuse one character for both roles, so
// we infer the role from the preceding character: a delimiter that follows a
// non-space is closing something ("pop" ), one that follows a space or starts
// the text is opening ( "hi). Meeting a closer at depth 0 means the wrapper
// already ended, so the outer characters are not a wrapper at all.
function stripOneWrapper(s) {
  if (s.length < 2) return null;
  const pair = WRAPPER_PAIRS.find((p) => p[0] === s[0] && p[1] === s[s.length - 1]);
  if (!pair) return null;

  const [open, close] = pair;
  const symmetric = open === close;
  const inner = s.slice(1, -1);

  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== open && ch !== close) continue;

    const closing = symmetric ? i > 0 && !/\s/.test(inner[i - 1]) : ch === close;
    if (closing) {
      if (depth === 0) return null; // wrapper already closed — not a wrapper
      depth--;
    } else {
      depth++;
    }
  }
  if (depth !== 0) return null; // something opened and never closed

  return inner;
}

// Strip wrapping quotes / stray markdown from a single line of model output —
// but ONLY when the wrapper is balanced and encloses the ENTIRE string.
//
// Models sometimes hand back a whole answer wrapped ("Just do it." or
// **Bold headline**), and that junk has to come off. What must NOT come off is
// a quote that belongs to the copy: `"Make it pop" isn't a brief.` opens with a
// quoted phrase but is not wrapped, and the old blanket anchored-character-class
// strip ate its opening quote.
//
// Loops so `**bold**` peels both layers; each pass drops 2 chars, so it ends.
function cleanDraft(text) {
  let s = String(text).trim();
  for (;;) {
    const inner = stripOneWrapper(s);
    if (inner === null) return s;
    s = inner.trim();
  }
}

// The hard character ceiling implied by a charLimit cell. Handles "50",
// "50-75" (→75), and "150 recommended (600 max)" (→600). Null = no numeric cap.
function charCeiling(charLimit) {
  const nums = String(charLimit || '').match(/\d+/g);
  return nums ? Math.max(...nums.map(Number)) : null;
}

// Last-resort trim to a hard ceiling. Prefers ending on a COMPLETE sentence
// within the limit (so copy never dangles mid-thought); falls back to a word
// boundary only if no reasonable sentence break fits.
function trimToCeiling(s, max) {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);

  // Last sentence-ending punctuation (. ! ?) within the limit.
  const sentence = slice.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (sentence && sentence[0].trim().length >= max * 0.5) {
    return sentence[0].trim();
  }

  // Otherwise cut at the last word boundary and strip trailing punctuation.
  const lastSpace = slice.lastIndexOf(' ');
  const wordCut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return wordCut.replace(/[\s.,;:!\-–—]+$/, '').trim();
}

// Built-in per-field creative guidance, keyed by normalized field name. Fills the
// gap left by the retired Sheet "Notes" column for fields that need the same
// instruction regardless of tenant. Returns '' when there's nothing built in. A
// tenant's own field notes (if ever restored) take precedence over this.
function builtInFieldGuidance(fieldName) {
  const name = String(fieldName || '').trim().toLowerCase();
  if (name === 'subhead') {
    return 'Secondary supporting line beneath the headline. Add context, specificity, or urgency — do NOT restate or reword the headline. Read as the next beat, not an echo.';
  }
  if (name === 'graphic headline') {
    return 'Write in sentence case: capitalize only the first word and proper nouns (brand names, product names, acronyms like AI or SaaS) — NOT every word. e.g. "Resolve tickets faster with AI", not "Resolve Tickets Faster With AI".';
  }
  return '';
}

// Generate a single piece of draft copy for one asset field, honoring the
// Build the "sibling fields" context block for scoped single-field generation.
// `siblings` is [{ fieldName, copy }] — the current copy of the OTHER fields of
// the same asset. Returns a prompt block (or '' when there's nothing useful) that
// gives the field its surroundings so it stays cohesive without the whole-asset
// batch call. Siblings are context only — never rewritten or emitted. Pure.
function siblingContextBlock(siblings) {
  const list = Array.isArray(siblings)
    ? siblings.filter((s) => s && s.fieldName && s.copy && String(s.copy).trim())
    : [];
  if (list.length === 0) return '';
  return [
    'These are the OTHER fields of the same asset and their current copy (context only —',
    'do NOT rewrite or output them). Write THIS field to sit cohesively alongside them —',
    'same offer, angle, and voice:',
    ...list.map((s) => `- ${s.fieldName}: ${String(s.copy).trim()}`),
  ].join('\n');
}

// --- Length constraint, in the field's own UNIT ------------------------------
// Every prompt below used to hard-code "Character limit: N". Email body fields now
// carry a WORD range (copy_fields.field_type = 'words'), and telling a model to
// write 125 CHARACTERS when the spec says 125 WORDS is a 5x error in the direction
// that matters most — it produces a one-line email where a structured one was
// asked for.
//
// One helper, four callers, so the phrasing cannot drift between the drafter, the
// variations generator and the two reviewers.
//
// `charMin` only appears for word fields. On a character field a floor is close to
// meaningless (and the subject-line work just removed the last ones); on a word
// field the floor is half the point — 50–125 words says "this is a structured
// email", where "up to 125" would read as "shorter is safer".
function lengthClause(charMax, fieldType, charMin) {
  const max = Number(charMax) > 0 ? Number(charMax) : null;
  if (!max) return null;
  if (String(fieldType || '') === 'words') {
    const min = Number(charMin) > 0 ? Number(charMin) : null;
    const range = min ? `${min}-${max} words` : `up to ${max} words`;
    return (
      `Length: ${range}. This is a WORD count, not characters. Structure matters more than ` +
      'hitting a number: context in one or two sentences, the ask in one, the next step in one. ' +
      'A well-structured email at the top of the range beats a cramped one at the bottom.'
    );
  }
  return (
    `Character limit: ${max}. Stay within this limit — write a COMPLETE, self-contained thought ` +
    'and finish it, even a few characters short; never run up to the limit and get cut off mid-sentence.'
  );
}

function countWords(s) {
  const t = String(s || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

// Is this draft over its limit, measured in the field's OWN unit? The companion
// to lengthClause: that one states the limit in the right unit, this one CHECKS
// it in the right unit, and both have to agree or the check contradicts the
// instruction.
//
// A word field's charMax is a WORD count. Comparing copy.length (characters) to
// it reports "over" for every correctly-drafted body — a 120-word paragraph is
// ~850 characters — so the caller's rescue path fired on fields that had nothing
// wrong with them. That is how a latent ReferenceError inside that rescue path
// stayed invisible for every character field and fired on both word fields.
//
// char_max 0 is NO LIMIT, as everywhere else, so nothing is ever over it.
function overLimit(copy, charMax, fieldType) {
  const max = Number(charMax) > 0 ? Number(charMax) : null;
  if (!max || !copy) return false;
  return String(fieldType || '') === 'words' ? countWords(copy) > max : String(copy).length > max;
}

// How long this copy is against its limit, in that same unit, phrased for a human
// reading a log line. It lives next to overLimit so a warning can never report a
// length in one unit while the check that produced the warning used the other —
// which is the whole failure mode this pair exists to close.
function describeLength(copy, charMax, fieldType) {
  const max = Number(charMax) > 0 ? Number(charMax) : null;
  const unit = String(fieldType || '') === 'words' ? 'words' : 'chars';
  const size = unit === 'words' ? countWords(copy) : String(copy || '').length;
  return max ? `${size} ${unit}, limit ${max}` : `${size} ${unit}, no limit`;
}

// Draft ONE field. Builds a prompt from the brief, the field's own length
// constraint and the creative direction. Enforces the limit: if the draft is
// over, it gets one corrective rewrite, then a hard trim as a last resort.
async function generateFieldDraft({
  assetType,
  channel,
  fieldName,
  charMax,
  charMin,
  fieldType,
  toneNotes,
  notes,
  funnelStage,
  assetDirection,
  summary,
  writerPrompt,
  direction,
  voiceGuide,
  siblings,
}) {
  const limitLine =
    lengthClause(charMax, fieldType, charMin) ||
    'Keep it concise — a complete, self-contained thought appropriate for the field.';
  const fieldGuidance = notes || builtInFieldGuidance(fieldName);

  const prompt = [
    'Write marketing copy for a single field. Return ONLY the copy itself — no labels, quotes, options, or commentary. Exactly one version.',
    '',
    ...brandVoiceLines(assetType, voiceGuide),
    `Campaign summary: ${summary}`,
    `Creative direction: ${writerPrompt}`,
    `Asset: ${assetType}`,
    assetDirection ? `Asset creative direction (apply to ALL fields): ${assetDirection}` : '',
    channel ? `Channel: ${channel}` : '',
    `Field: ${fieldName}`,
    funnelStage ? `Funnel stage: ${funnelStage}` : '',
    toneNotes ? `Tone notes: ${toneNotes}` : '',
    fieldGuidance ? `Field guidance: ${fieldGuidance}` : '',
    direction
      ? `REVISION direction from the user — apply this, overriding earlier choices where they conflict: ${direction}`
      : '',
    // Cohesion recovery for scoped (single-field) generation: the current copy of
    // this field's sibling fields, so it hangs together with them even though it's
    // drafted alone rather than in the cohesive whole-asset batch.
    siblingContextBlock(siblings),
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

  // THE CEILING THIS FUNCTION ENFORCES, IN CHARACTERS.
  //
  // Restored. Commit 326c777 replaced the old pair
  //
  //   const ceiling = Number(charMax) > 0 ? Number(charMax) : null;
  //   const limitLine = ceiling ? `Character limit: ${ceiling}. …` : '…';
  //
  // with a single lengthClause() call, and the `ceiling` binding went with the
  // line that used it — while the enforcement block below kept referring to it.
  // This file is 'use strict', so that is a ReferenceError on EVERY call to this
  // function, for every field type. It survived because every caller reaches it
  // off the happy path and swallows what it throws: the batch drafter and the
  // variations generator only fall back here when a draft is missing or over,
  // and both catch; the scoped single-field regenerate (googleDocs.js, "Stay
  // close" with one option) calls it directly, inside a per-asset catch that
  // logs "asset N/M FAILED" and returns no fields for that asset.
  //
  // NULL FOR A WORD FIELD, deliberately. Everything below measures characters.
  // A word field's charMax is a WORD count, so enforcing it here would take a
  // correct 120-word body, "rewrite it to fit within 120 characters", and then
  // trimToCeiling it to 120 characters if that failed. That is the same unit
  // confusion 326c777 existed to remove — pointed the other way, and destructive
  // rather than merely wrong in the prompt. A word field's limit is carried into
  // the prompt by lengthClause above; there is no post-hoc word enforcement, and
  // inventing one is beyond this fix.
  const ceiling =
    String(fieldType || '') === 'words' ? null : (Number(charMax) > 0 ? Number(charMax) : null);

  // Enforce the hard ceiling: one corrective rewrite, then a hard trim.
  if (ceiling && copy.length > ceiling) {
    const retryPrompt = [
      prompt,
      '',
      `Your previous draft was ${copy.length} characters — too long. Rewrite it as a COMPLETE, self-contained thought that fits within ${ceiling} characters, preserving the meaning and tone. Do not end mid-sentence — finish the thought even if it comes in well under the limit. Return ONLY the copy.`,
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

// Draft ALL fields of a single asset in one call so the copy is cohesive — the
// headline, body, and CTA reinforce the same offer/voice, and multi-variant
// fields (e.g. several headlines) come out distinct rather than repetitive.
// `fields` is [{ fieldName, charMax, notes, funnelStage }]. Returns
// [{ fieldName, copy }] with each field's hard character limit enforced.
async function generateAssetDrafts({
  assetType,
  channel,
  toneNotes,
  assetDirection,
  summary,
  writerPrompt,
  fields,
  direction,
  voiceGuide,
}) {
  if (!fields || fields.length === 0) return [];

  // When the user asks to regenerate with feedback, inject their direction as a
  // high-priority revision instruction (otherwise these lines are absent).
  const revisionLines = direction
    ? [
        'IMPORTANT — this is a REVISION based on user feedback. Apply this direction,',
        'overriding earlier creative choices where they conflict:',
        direction,
        '',
      ]
    : [];

  const fieldLines = fields
    .map((f) => {
      // char_max 0 = NO limit. The character branch already guarded that; the
      // word branch did not, and rendered "up to 0 WORDS" — a real constraint
      // asserted on an unlimited field, in the batch prompt that drafts most copy.
      const wordCeiling = Number(f.charMax) > 0 ? Number(f.charMax) : null;
      const limit = f.fieldType === 'words'
        ? (wordCeiling
          ? `${Number(f.charMin) > 0 ? `${f.charMin}-` : 'up to '}${wordCeiling} WORDS (a word count, not characters)`
          : 'no word limit — length is yours to judge; measured in WORDS, not characters')
        : (Number(f.charMax) > 0 ? `character limit ${f.charMax} — stay within this limit` : 'concise');
      const guidance = f.notes || builtInFieldGuidance(f.fieldName);
      const extra = [
        f.funnelStage ? `funnel: ${f.funnelStage}` : '',
        guidance ? `guidance: ${guidance}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      return `- "${f.fieldName}" — ${limit}${extra ? `; ${extra}` : ''}`;
    })
    .join('\n');

  const prompt = [
    'Write the copy for ALL fields of one marketing asset as a COHESIVE SET: the',
    'fields must work together — headline, body, and CTA reinforce the same offer',
    'and voice. Where a field repeats (e.g. multiple headlines or variants), make',
    'them clearly DISTINCT, not reworded duplicates.',
    '',
    ...revisionLines,
    ...brandVoiceLines(assetType, voiceGuide),
    `Campaign summary: ${summary}`,
    `Creative direction: ${writerPrompt}`,
    `Asset: ${assetType}`,
    assetDirection ? `Asset creative direction (apply to ALL fields): ${assetDirection}` : '',
    channel ? `Channel: ${channel}` : '',
    toneNotes ? `Tone notes: ${toneNotes}` : '',
    '',
    'For each field, write a COMPLETE, self-contained thought that fits within its',
    'character limit. The limit is a hard MAXIMUM to compose within, not a target to',
    'fill — never run up to the limit and cut off mid-sentence; finish the thought,',
    'even a few characters short. Fields:',
    fieldLines,
    '',
    'Return a JSON object mapping each field name (exactly as written above, including any parentheses) to its copy string. Exactly one copy per field, no commentary.',
    'Respond with valid JSON only, no markdown, no backticks.',
  ].join('\n');

  let parsed = {};
  try {
    const text = await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // Headroom so a many-field asset (e.g. a carousel: 9–10 fields) can't
      // truncate mid-JSON and fail the parse, which would push every field onto
      // the slower single-field fallback path. gemini-3.5-flash is a thinking
      // model (reasoning tokens count against this budget), so 8192 keeps the
      // cohesive batch draft intact instead of collapsing to the fallback path —
      // which is what made regenerate crawl.
      generationConfig: { temperature: 0.8, maxOutputTokens: 8192 },
    });
    parsed = JSON.parse(stripJsonFences(text));
  } catch (err) {
    console.warn(`[gemini] asset batch draft parse failed for ${assetType}: ${err.message}`);
    parsed = {};
  }

  const byKey = new Map(
    Object.entries(parsed).map(([k, v]) => [
      k.trim().toLowerCase(),
      typeof v === 'string' ? v : (v && v.copy) || '',
    ])
  );

  const out = [];
  for (const f of fields) {
    let copy = cleanDraft(byKey.get(f.fieldName.trim().toLowerCase()) || '');
    let unenforced = false;
    // Missing from the batch, or over its limit → fall back to the robust
    // single-field generator (which rewrites and, if needed, hard-trims).
    // One field's fallback failing (a Gemini timeout / rate-limit / error) must
    // NOT abandon the whole asset — the many-field assets (carousels) fire the
    // most fallback calls and so are the most exposed. Isolate each: on failure
    // keep whatever the batch gave (or empty), and let the other fields proceed.
    //
    // The over-limit test is overLimit(), in the field's own unit. It used to be
    // `copy.length > f.charMax` — which, on a word field, called every correct
    // draft too long and sent it here for a rescue it did not need.
    if (!copy || overLimit(copy, f.charMax, f.fieldType)) {
      try {
        copy = await generateFieldDraft({
          assetType,
          channel,
          fieldName: f.fieldName,
          charMax: f.charMax,
          // charMin and fieldType were not passed, so the rescue drafted every
          // field in CHARACTERS — a 120-word field asked for 120 characters, the
          // 5x error in the direction that matters. The batch prompt above has
          // said WORDS since 326c777; this call now says the same thing.
          charMin: f.charMin,
          fieldType: f.fieldType,
          toneNotes,
          notes: f.notes,
          funnelStage: f.funnelStage,
          assetDirection,
          summary,
          writerPrompt,
          direction,
          voiceGuide,
        });
      } catch (err) {
        // Keep the batch value if we had one; otherwise leave it empty (dropped
        // downstream) rather than throwing away every field on this asset.
        //
        // But say which one happened. This rescue is the ONLY thing that enforces
        // the limit on this path, so a kept draft got NO enforcement — it is here
        // precisely because it was over. It still counts as drafted, because copy
        // exists, and it used to come back indistinguishable from a clean draft.
        // `unenforced` is what makes the difference visible to the caller.
        unenforced = Boolean(copy);
        console.warn(
          `[gemini] field fallback failed for ${assetType} / ${f.fieldName}: ${err.message} — ` +
            (unenforced
              ? `keeping the batch draft OVER ITS LIMIT and unenforced (${describeLength(copy, f.charMax, f.fieldType)})`
              : 'no copy for this field')
        );
      }
    }
    out.push(unenforced ? { fieldName: f.fieldName, copy, unenforced: true } : { fieldName: f.fieldName, copy });
  }
  return out;
}

// --- Conceptual variations (Phase 3): doorways ------------------------------
//
// A "doorway" is a distinct ANGLE into the SAME value prop — not a reworded
// version. Diversity is guaranteed structurally: assignDoorways() picks the N
// distinct doorways in JS, and buildVariationsPrompt() names the exact doorway
// for each numbered row, so the model is never asked to "be different" (which
// makes LLMs cluster). The doorway changes the angle only; the craft playbook
// (craft.md) and the brand voice still govern craft + tone for every variation.
const DOORWAYS = {
  Pain: 'lead with the ache / cost of the status quo the product removes.',
  Outcome: 'the after-state — who they become or what improves once they have it.',
  Contrast: 'old way vs. new way; before vs. after.',
  Question: 'open with a provocative question that frames the value prop.',
  Proof: 'lead with a specific, concrete fact, number, or verifiable claim.',
  Identity: 'speak to who the reader is or aspires to be.',
  Reframe: "challenge the category's assumption; recast what the thing even is.",
};

// Intensity (Variations Matrix, Step 3) — HOW HARD to push a row's angle. Like
// `distance`, it steers GENERATION only and never appears in the doc label. The
// matrix carries one intensity per row, so a single generation can mix them.
const INTENSITIES = {
  Safe: 'the proven, on-strategy execution of this angle — the version a seasoned copywriter ships without a second look. Play the hits; no surprises.',
  Bold: 'push past the obvious take — sharper language, a less expected way into the same angle, more voice. Still on-brief, but it takes a real position.',
  Wild: 'take a swing — break the expected pattern for this angle with surprising phrasing or structure, a line that makes someone stop. High-risk/high-reward; still sells the same value prop, from an unexpected height.',
};

// Per-field-type doorway ranking, most-obvious → least. Distance bands slice this:
// close = rank[0]; explore = rank[1..3]; wide = rank[4..6] (always ends Reframe).
const DOORWAY_RANKINGS = {
  headline: ['Outcome', 'Pain', 'Proof', 'Question', 'Contrast', 'Identity', 'Reframe'],
  body: ['Outcome', 'Proof', 'Pain', 'Contrast', 'Identity', 'Question', 'Reframe'],
  cta: ['Outcome', 'Identity', 'Question', 'Pain', 'Proof', 'Contrast', 'Reframe'],
  preheader: ['Question', 'Outcome', 'Pain', 'Proof', 'Contrast', 'Identity', 'Reframe'],
  default: ['Outcome', 'Pain', 'Proof', 'Question', 'Contrast', 'Identity', 'Reframe'],
};

// Classify a field into a doorway-ranking bucket by name keyword. Order matters:
// subhead/pre-header are checked before headline (so "subhead" isn't caught by a
// headline match), and CTA first (it's the most specific).
function doorwayRankingForField(fieldName) {
  const n = String(fieldName || '').toLowerCase();
  if (/\bcta\b|button|call to action/.test(n)) return DOORWAY_RANKINGS.cta;
  if (/pre-?header|preheader|subhead/.test(n)) return DOORWAY_RANKINGS.preheader;
  if (/headline|subject|hook|title/.test(n)) return DOORWAY_RANKINGS.headline;
  if (/body|description|caption|paragraph|message/.test(n)) return DOORWAY_RANKINGS.body;
  return DOORWAY_RANKINGS.default;
}

// Deterministically assign `count` doorways for a field at a given distance.
// Pure — no randomness — so diversity is guaranteed and the assignment is
// testable. Stay close → the one obvious doorway, repeated (N distinct
// EXECUTIONS of a single angle). Explore/Roam-wide → N DISTINCT doorways drawn
// from the band, spilling to the nearest neighbors outside it if count exceeds
// the band size (max count is 4).
function assignDoorways(fieldName, distance, count) {
  const rank = doorwayRankingForField(fieldName);
  const n = Math.max(1, Math.min(4, Number(count) || 1));
  const d = distance === 'explore' || distance === 'wide' ? distance : 'close';

  if (d === 'close') return Array(n).fill(rank[0]);

  const band = d === 'explore' ? rank.slice(1, 4) : rank.slice(4, 7);
  // Nearest doorways outside the band, to keep all N distinct when count > band.
  const spill = d === 'explore' ? [...rank.slice(4), rank[0]] : [...rank.slice(1, 4)].reverse();
  const pool = [...band, ...spill];
  const out = [];
  for (const dw of pool) {
    if (out.length >= n) break;
    if (!out.includes(dw)) out.push(dw);
  }
  return out;
}

// Build the variations prompt. `doorways` is the pre-assigned list (one per row);
// the prompt names each explicitly so the model can't collapse them. Pure.
function buildVariationsPrompt({
  assetType,
  fieldName,
  charMax,
  charMin,
  fieldType,
  summary,
  writerPrompt,
  assetDirection,
  voiceGuide,
  doorways,
  rows,
  distance,
  direction,
  currentCopy,
}) {
  // Normalize to one spec shape: [{ doorway, intensity|null }]. The matrix path
  // passes `rows` (per-angle intensity); the legacy path passes bare `doorways`
  // (intensity null → renders identically to before). Intensity, like distance,
  // is generation-only and never shown in the assignment label's door.
  const spec = Array.isArray(rows) && rows.length
    ? rows.map((r) => ({ doorway: r.doorway, intensity: INTENSITIES[r.intensity] ? r.intensity : null }))
    : (doorways || []).map((d) => ({ doorway: d, intensity: null }));
  const doorwayList = spec.map((s) => s.doorway);
  const n = spec.length;
  const ceiling = Number(charMax) > 0 ? Number(charMax) : null;
  const allSame = new Set(doorwayList).size === 1; // Stay close: one door, N executions
  const anyIntensity = spec.some((s) => s.intensity);
  // Same sentinel, worse symptom: lengthClause returns null for char_max 0, so a
  // word field with no ceiling interpolated the literal string "null" and the
  // prompt read "null EACH variation is held to this range."
  const wordClause = fieldType === 'words' ? lengthClause(charMax, fieldType, charMin) : null;
  const limitLine = fieldType === 'words'
    ? (wordClause
      ? `${wordClause} EACH variation is held to this range.`
      : 'Length is counted in WORDS, not characters, and this field has no word limit — judge length by what the thought needs.')
    : (ceiling
      ? `Character limit: ${ceiling} per variation. Each is a COMPLETE, self-contained thought within this hard maximum — finish the thought, even a few characters short.`
      : 'Keep each variation concise — a complete, self-contained thought appropriate for the field.');

  const doorwayDefs = Object.entries(DOORWAYS).map(([name, def]) => `- ${name}: ${def}`);
  const intensityDefs = anyIntensity ? Object.entries(INTENSITIES).map(([name, def]) => `- ${name}: ${def}`) : [];
  const assignmentRows = spec.map(
    (s, i) => `${i + 1}. (${s.doorway}${s.intensity ? ` · ${s.intensity}` : ''}) —`
  );

  const sameAngleLine = allSame
    ? [
        `All ${n} variations use the SAME doorway (${doorwayList[0]}) — write ${n} genuinely`,
        'DIFFERENT executions of that one angle (different hooks, specifics, structure),',
        'never reworded near-duplicates.',
        '',
      ]
    : [];

  // Intensity block + assignment framing. Matrix runs (per-row intensity) name
  // both the door and the push, and ALLOW a repeated door at different intensities
  // (Pain·Safe + Pain·Wild is intentional). Legacy runs keep the original framing.
  const intensityBlock = anyIntensity
    ? [
        'INTENSITY — how hard to push each row\'s angle. Changes the RISK and energy, not the door',
        'or the value prop; the brand voice above still governs tone and craft:',
        ...intensityDefs,
        '',
      ]
    : [];
  const assignmentInstruction = anyIntensity
    ? [
        'YOUR ASSIGNMENT — write exactly one variation per row, using the EXACT doorway AND intensity',
        'named for that row. A repeated doorway at a different intensity is INTENTIONAL — make those',
        'genuinely different in risk and execution, not reworded:',
      ]
    : [
        'YOUR ASSIGNMENT — write exactly one variation per row, using the EXACT doorway named for',
        'that row. Do NOT drift between doorways and do NOT repeat an angle:',
      ];

  return [
    `Write ONE marketing field as ${n} DISTINCT variation${n === 1 ? '' : 's'}. Each sells the`,
    'SAME value proposition but enters through a DIFFERENT DOORWAY — a different angle of',
    'attack — so the writer sees genuinely different strategic thinking, not reworded copy.',
    '',
    'THE VALUE PROP (from the campaign brief) — every variation sells THIS, its own way:',
    `Campaign summary: ${summary}`,
    `Creative direction: ${writerPrompt}`,
    assetDirection ? `Asset creative direction (apply to ALL): ${assetDirection}` : null,
    '',
    ...brandVoiceLines(assetType, voiceGuide),
    `Asset: ${assetType}`,
    `Field: ${fieldName}`,
    limitLine,
    '',
    'DOORWAYS — each is a different way IN to the value prop above. The doorway changes the',
    'ANGLE only; the brand voice above still governs tone and craft for every one:',
    ...doorwayDefs,
    '',
    ...intensityBlock,
    ...sameAngleLine,
    ...assignmentInstruction,
    ...assignmentRows,
    '',
    direction
      ? `REVISION direction from the user — apply to EVERY variation, overriding earlier choices where they conflict: ${direction}`
      : null,
    distance === 'wide' && currentCopy
      ? `This is a "roam wide" REGENERATION. The current copy took this angle: "${String(currentCopy).trim()}". Deliberately go somewhere it did NOT.`
      : null,
    '',
    `Return ONLY a JSON array of exactly ${n} object${n === 1 ? '' : 's'}, in the SAME order as the rows`,
    'above, each {"doorway": "<doorway name for that row>", "copy": "<copy>"}.',
    'Valid JSON only — no markdown, no backticks, no commentary.',
  ]
    // Drop only ABSENT conditional lines (null); keep the intentional '' blanks
    // that separate sections so the model reads a structured prompt, not a wall.
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
}

// Generate N conceptually-distinct variations of one field. Returns
// [{ doorway, copy }] (length ≤ count), each respecting the char limit. The
// doorway on each result is the ASSIGNED one (authoritative — it drives the doc
// label), not whatever the model echoes back. On a missing/oversized variation,
// falls back to the robust single-field generator with the doorway injected as
// direction, so one bad row never collapses the set.
async function generateFieldVariations({
  assetType,
  fieldName,
  charMax,
  charMin,
  fieldType,
  summary,
  writerPrompt,
  assetDirection,
  voiceGuide,
  direction,
  distance,
  count,
  rows,
  currentCopy,
  siblings,
}) {
  // Matrix path (Step 3): explicit per-angle rows [{ doorway, intensity }] drive
  // generation directly, bypassing assignDoorways (the writer chose the angles).
  // Legacy path: assignDoorways derives the doorways from distance + count, with
  // null intensity so the prompt reads exactly as before.
  const spec = Array.isArray(rows) && rows.length
    ? rows.map((r) => ({ doorway: r.doorway, intensity: r.intensity || null }))
    : assignDoorways(fieldName, distance, count).map((d) => ({ doorway: d, intensity: null }));
  const doorways = spec.map((s) => s.doorway);
  const n = spec.length;
  const ceiling = Number(charMax) > 0 ? Number(charMax) : null;
  const prompt = buildVariationsPrompt({
    assetType,
    fieldName,
    charMax,
    charMin,
    fieldType,
    summary,
    writerPrompt,
    assetDirection,
    voiceGuide,
    rows: spec,
    distance,
    direction,
    currentCopy,
  });

  let parsed = [];
  try {
    const text = await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // Higher temperature for angle spread; headroom for up to 4 long variations.
      generationConfig: { temperature: 0.9, maxOutputTokens: 4096 },
    });
    const arr = JSON.parse(stripJsonFences(text));
    if (Array.isArray(arr)) parsed = arr;
  } catch (err) {
    console.warn(`[gemini] variations parse failed for ${fieldName}: ${err.message}`);
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const doorway = doorways[i];
    const row = parsed[i];
    let copy = cleanDraft((row && (typeof row === 'string' ? row : row.copy)) || '');

    // Missing or over the ceiling → fall back to the single-field generator with
    // this doorway injected as revision direction (reuses its rewrite + trim).
    if (!copy || (ceiling && copy.length > ceiling)) {
      const doorwayDirection = [direction, `Use the "${doorway}" angle — ${DOORWAYS[doorway] || ''}`]
        .filter(Boolean)
        .join('. ');
      try {
        copy = await generateFieldDraft({
          assetType,
          fieldName,
          charMax,
          assetDirection,
          summary,
          writerPrompt,
          direction: doorwayDirection,
          voiceGuide,
          siblings,
        });
      } catch (err) {
        console.warn(`[gemini] variation fallback failed ${fieldName}/${doorway}: ${err.message}`);
      }
    }
    if (copy && ceiling && copy.length > ceiling) copy = trimToCeiling(copy, ceiling);
    if (copy) out.push({ doorway, copy });
  }
  return out;
}

// Generate a brand voice guide (markdown) from the onboarding questionnaire
// answers. Optional `direction` (a revision instruction) and `previousGuide`
// (the current guide) drive regeneration. Returns the raw markdown string. This
// is a BRAND guide only — universal copy craft comes from craft.md, which always
// loads alongside it, so the guide never needs to restate craft principles.
async function generateVoiceGuide(answers = {}) {
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v || ''));
  const revisionLines = [];
  if (answers.previousGuide) {
    revisionLines.push('', 'Here is the current voice guide to revise:', String(answers.previousGuide));
  }
  if (answers.direction) {
    revisionLines.push(
      '',
      'Apply this revision direction, overriding earlier choices where they conflict:',
      String(answers.direction)
    );
  }
  const prompt = [
    'You are a brand strategist. Generate a voice guide markdown file from these answers. Structure it with sections: Brand Personality, Tone, Words That Work, Do Not Use, Audience Language, Tone Reference. Be specific and actionable.',
    'Scope: BRAND VOICE ONLY — how this company sounds. Universal copywriting craft (headline/body/CTA principles, a CTA library, character limits, per-medium guidance) is supplied separately and always applies, so do NOT restate it here.',
    '',
    `Brand Personality: ${String(answers.brandPersonality || '')}`,
    `Tone Guidance: ${list(answers.toneGuidance)}`,
    `Words That Work: ${list(answers.wordsToUse)}`,
    `Do Not Use: ${list(answers.wordsToAvoid)}`,
    `Audience Language: ${String(answers.audienceLanguage || '')}`,
    `Tone Reference: ${String(answers.toneReference || '')}`,
    ...revisionLines,
    '',
    'Return ONLY the markdown, no preamble and no surrounding code fences.',
  ].join('\n');

  const text = await callGemini({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4 },
  });
  // Strip any stray markdown/code fences the model wraps around the output.
  return String(text)
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

// Describe an image used as a creative reference. Sends the image inline to
// Gemini vision (2.5 Flash accepts image inputs natively) and returns a text
// blob: any verbatim text in the image plus a description of its visual tone,
// palette, style, mood, and brand/product elements — feeds the writer direction
// as creative context. Best-effort: returns '' on any failure (no key, timeout,
// bad image) so a single bad attachment never blocks the brief.
async function describeImage(base64Data, mimetype) {
  if (!base64Data) return '';
  const prompt =
    'This image is being used as a creative reference for a marketing copywriting project. ' +
    'First, extract any text visible in the image verbatim. Then describe: the visual tone, ' +
    'color palette, design style, emotional mood, and any brand or product elements present. ' +
    'Be specific and concrete — this description will inform copy direction.';
  try {
    const text = await callGemini({
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimetype || 'image/png', data: base64Data } },
          ],
        },
      ],
    });
    return String(text || '').trim();
  } catch (err) {
    console.error(`[gemini] describeImage failed: ${err.message}`);
    return '';
  }
}

// Extract a doc-header STRUCTURE from a screenshot into the block schema
// (doc-header-template work, step 5). Vision pass: given an image of the top of
// a team's copy/brief doc, reproduce its header — labels, order, table structure
// — as { version, blocks } (see destinations/docHeaderSchema.js), classifying
// each field's fill (auto | static | blank). Honest scope: reproduce structure
// and labels exactly, fill only what Quillio legitimately owns, never invent
// values. Returns the RAW parsed object (caller normalizes) or null on any
// failure (no key, timeout, bad image, unparseable) — best-effort, never throws.
async function extractHeaderSchema(base64Data, mimetype) {
  if (!base64Data) return null;
  const prompt = [
    'You are extracting the STRUCTURE of a document header from a screenshot, to reproduce it as a reusable template.',
    'The image shows the TOP of a copy/brief document. Extract ONLY the header block(s) at the top (the title / metadata area).',
    'IGNORE body content below the header — e.g. "Campaign Summary", paragraphs, or asset sections.',
    '',
    'Return a JSON object of exactly this shape (no markdown, no backticks):',
    '{ "version": 1, "blocks": [ <block>, ... ] }',
    '',
    'Each block is one of:',
    '  { "type": "heading", "text": "<large title/brand text>" }',
    '  { "type": "text", "label": "<label>", "value": "<value>", "fill": "<auto|static|blank>" }   // a "Label: value" line',
    '  { "type": "text", "text": "<plain line, no label>" }',
    '  { "type": "field_row", "fields": [ { "label", "value", "fill" }, ... ] }                     // several label:value on one line',
    '  { "type": "divider" }                                                                        // a horizontal rule',
    '  { "type": "table", "table": { "columns": <n>, "rows": [ [ <cell>, ... ], ... ] } }           // a bordered/grid table',
    '        where each cell is either { "wordmark": "<brand text>", "fill": "static" }',
    '        or { "fields": [ { "label", "value", "fill" }, ... ] }   (an empty cell = { "fields": [] })',
    '',
    'Reproduce labels and text VERBATIM. Keep blocks, rows, and cells IN THE ORDER they appear.',
    'If the header is a bordered/grid table, use a table block. If it is headings and lines, use heading/text/field_row/divider. Do NOT force a table if there is none.',
    '',
    'Classify every field/cell with "fill":',
    '  "auto"   — a value Quillio can fill from its own data: project/campaign name, writer, date, version.',
    '  "static" — fixed branding that never changes (e.g. the team wordmark / logo text).',
    '  "blank"  — a field Quillio does NOT own (e.g. product, project owner, approver, reviewer, "last edit by"). Reproduce the LABEL but set "value" to "". Do NOT invent a value.',
    '',
    'Respond with valid JSON only.',
  ].join('\n');

  try {
    const text = await callGemini({
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimetype || 'image/png', data: base64Data } },
          ],
        },
      ],
      generationConfig: { temperature: 0.2 },
    });
    return JSON.parse(stripJsonFences(text));
  } catch (err) {
    console.error(`[gemini] extractHeaderSchema failed: ${err.message}`);
    return null;
  }
}

// Review drafted copy field-by-field like a thoughtful editor (copy-review
// feature). Judges each field's copy against (a) the craft playbook (craft.md —
// headline/body/CTA craft, the CTA library, character discipline, the relevant
// mediums) and (b) the brand reference (the tenant's guide, else voice.md —
// voice, tone, banned words), and returns a per-field comment ONLY where a
// material issue genuinely
// warrants it (silence is the good outcome). On re-review, prior copy/comment
// per field let it recognize the writer's improvements and not re-nag.
//   fields: [{ assetType, fieldName, charMax, copy, priorCopy, priorComment }]
//   briefContext: { summary, writerDirection } — THIS campaign's summary + writer
//     direction, which carry the brief's stated audience/goal. Optional.
// Returns [{ assetType, fieldName, comment }] (comment: string | null), one per
// input field, same order. Throws on a hard failure so the caller can show an
// error state (rather than silently posting nothing).
// The cross-field flag rule, shared by scoped field review and scoped variant
// review. Fires ONLY on a relational interaction between the selected field and a
// sibling — never on a sibling's standalone craft problem.
const CROSS_FIELD_FLAG_RULE = [
  'CROSS-FIELD FLAG — fire it TIGHT. Append " Also worth a look: <one short clause>." to the',
  'selected field\'s comment ONLY when a SIBLING directly INTERACTS with the selected field:',
  '  • contradiction (they disagree),',
  '  • duplication / redundancy (the sibling makes the SAME point),',
  '  • tonal clash (the sibling\'s register fights this field\'s).',
  'Do NOT flag a sibling\'s STANDALONE craft problem (a weak verb, a long sentence) that does',
  'not conflict with the selected field — that is not the writer\'s question; it waits for a',
  'full review. At most ONE flag per field; one clause; no separate comment on the sibling.',
  'Example: "…[note on the headline]. Also worth a look: the Subhead is making the same point',
  'as option 2."',
];

// LENGTH RULE — shared verbatim by both review prompts (single field + variation
// stack), because a writer must get the same answer whichever path reviewed them.
//
// A real run produced: "The current copy is 142 characters, falling short of the
// 150-character minimum. Expand slightly to meet the limit, perhaps by specifying
// the venue or adding a brief benefit." That is bad craft advice dressed as a
// spec. char_min exists so a field is not structurally EMPTY — a CTA with no
// verb, a one-word subject line. It is not a quota, and saying the same thing in
// fewer words is better writing, not a defect.
//
// The floor is ALSO no longer sent to the model at all — see the FIELDS payload
// in reviewCopyFields and limitLine in buildVariantReviewPrompt. Both halves
// matter: the rule tells the model what to do, and withholding the number means
// it has nothing to compute "142 against 150" from even if it ignores the rule.
// (The DRAFT prompt still receives the floor. That is generation, where a band is
// a legitimate target — this is review, where it becomes an instruction to pad.)
const LENGTH_RULE = [
  'LENGTH — READ CAREFULLY, THIS IS A COMMON ERROR:',
  '• A maximum is a HARD limit. Copy that exceeds it will be truncated in the wild — flag it,',
  '  say by roughly how much, and suggest what to cut.',
  '• A field with NO stated maximum — no "charMax" key, or a length line that states none — has',
  '  NO limit. It is unlimited by design (a legal line, a long-form body). Never invent a ceiling',
  '  for it, never say it is "over the limit", and never write "the 0-character limit" or suggest',
  '  that the limit "needs to be updated". Judge such a field on craft alone.',
  '• There is NO minimum. Shorter is not a defect. NEVER tell the writer to expand, lengthen,',
  '  pad, "add detail to meet the limit", or fill available space. Saying it in fewer words is',
  '  GOOD writing, and a note to the contrary destroys the writer\'s trust in this review.',
  '• Do NOT compute, quote, or reason about a character or word FLOOR. You have not been given',
  '  one. Never write a sentence of the form "X characters, short of the Y minimum".',
  '• Short copy is worth raising ONLY when it is genuinely INCOMPLETE — a CTA with no verb, a',
  '  subject line that is a single word, a body that names no benefit or offer. Then say what',
  '  is MISSING from the copy ("the CTA has no verb — the reader is not told what to do"),',
  '  never that it is under a count.',
];

// Comments are read by a writer inside a Google Doc. They never see craft.md, the
// brand/voice guide, or any other internal document, so a note like "align with
// the craft playbook's rule on adverbs" is an appeal to something that does not
// exist for them — it reads as an unfalsifiable authority claim and carries none
// of the guidance it is standing in for. State the point instead.
const NO_CITATION_RULE = [
  'NEVER CITE AN INTERNAL DOCUMENT. The writer cannot see the craft playbook, the brand',
  'reference, the voice guide or the brief — naming any of them is meaningless to them.',
  'Do not write "per the craft playbook", "the brand guide says", "the voice guide requires",',
  '"as the brief states", "the playbook\'s rule on…", or any equivalent. Make the point directly',
  'and let it stand on its own: not "cut \'actually\' — the craft playbook bans adverbs" but',
  '"cut \'actually\' — the line is punchier without it."',
];

// Belt and braces for NO_CITATION_RULE. The prompt is the fix; this is the
// guarantee, because a comment goes straight into a Google Doc where nobody
// reviews it first.
//
// It only ever performs removals that provably leave a grammatical sentence, and
// otherwise DROPS the comment. The first version of this tried to excise the
// citation from mid-sentence and produced "Strong specifics, but." and
// "Cut 'actually' — adverbs applies and the line is punchier without it" — worse
// than the thing it was fixing. You cannot cut a clause out of arbitrary prose
// and be sure of the result; you can only be sure about a clause that is the
// WHOLE of a delimited segment. Everything else is dropped, which is cheap here
// because silence is already this review's most common correct answer.
//
// Detection is deliberately wider than removal: anything that mentions an
// internal document at all is caught, and if the safe removals do not clear it,
// the note does not ship.
const CITATION_DOC = String.raw`(?:the\s+)?(?:copy\s+)?(?:craft|brand|voice|style)\s*(?:playbook|guide|guidelines|reference)|craft\.md|voice\.md`;
const HAS_CITATION_RE = new RegExp(`(?:${CITATION_DOC})|\\bthe brief\\s+(?:says|states|calls for|requires)`, 'i');

// A segment that is NOTHING BUT a citation — an optional connector, the document,
// and at most a short "…'s rule on adverbs" tail. If a delimited segment matches
// this end to end, deleting the segment cannot break the sentence around it.
const CITATION_ONLY = String.raw`(?:and\s+|also\s+)?(?:as\s+)?(?:per|per\s+the|according\s+to|in\s+line\s+with|consistent\s+with|following|aligned\s+with|to\s+align\s+with|in\s+keeping\s+with|see|cf\.?)?\s*(?:${CITATION_DOC})(?:'s|’s)?(?:\s+(?:rule|guidance|principle|convention|standard|note)s?(?:\s+(?:on|about|for|against)\s+[\w\s-]{1,32})?)?`;

// The three shapes that are safe to remove, in the order they are tried.
const SAFE_REMOVALS = [
  // 1. A parenthetical that contains only the citation: "front-load it (per the craft playbook)."
  [new RegExp(String.raw`\s*\(\s*${CITATION_ONLY}\s*\)`, 'gi'), ''],
  // 2. A leading clause: "Per the craft playbook, cut 'actually'." -> "Cut 'actually'."
  [new RegExp(String.raw`^\s*${CITATION_ONLY}\s*[,:]\s*`, 'i'), ''],
  // 3. A trailing clause running to the end: "Cut 'actually', per the craft playbook."
  [new RegExp(String.raw`\s*[,;—–-]\s*${CITATION_ONLY}\s*([.!?]?)\s*$`, 'i'), '$1'],
];

// Clean one comment for a human reader. Returns the input unchanged when it cites
// nothing, a safely-trimmed version when the citation was a whole delimited
// segment, and null when it was load-bearing mid-sentence.
function stripInternalCitations(text) {
  if (typeof text !== 'string') return null;
  const original = text.trim();
  if (!original) return null;
  if (!HAS_CITATION_RE.test(original)) return original === text ? text : original;

  let out = original;
  for (const [re, sub] of SAFE_REMOVALS) out = out.replace(re, sub);
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();

  // Still citing something, or reduced to a fragment → say nothing. A note that
  // points at a document the writer cannot open is worth less than silence, and
  // a mangled one costs more.
  if (HAS_CITATION_RE.test(out) || !/[a-z]{3}/i.test(out) || out.split(/\s+/).length < 3) {
    console.warn('[gemini] dropped a review comment that cited an internal document');
    return null;
  }
  if (out !== original) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

// Bind the model's review results back onto the inputs that produced them.
// Returns one entry per input, in input order: { assetType, instance, fieldName,
// comment } with comment null when there is no material note.
//
// Matching is by (assetType, fieldName) using the SHARED reviewUnitKey
// (utils/instanceKey) — previously a third inline copy of copyReview.fieldKey's
// template, free to drift from it. The instance ordinal is deliberately NOT in the
// key: the response schema has no `instance` field and the model is never told
// about instances, so a model-side key could never carry one.
//
// Duplicates are resolved BY OCCURRENCE on both sides instead. Two inputs share
// one (assetType, fieldName) when a doc carries the same asset twice, and the old
// `byKey.set(key, r)` made the LAST parsed entry win for that key — which, because
// the name lookup is consulted BEFORE the positional fallback, handed input #0 the
// wrong comment rather than falling through to position. Keeping a LIST per key and
// taking the nth match for the nth input with that key restores input↔result
// alignment. With unique keys this is exactly the previous behavior (one-element
// list, n = 0); the model is instructed to answer in input order, so occurrence
// order is the same order on both sides.
//
// Pure + exported so the duplicate-key path is testable without a Gemini call.
function matchReviewResults(list, parsed) {
  const results = Array.isArray(parsed) ? parsed : [];
  const byKey = new Map();
  for (const r of results) {
    if (!r) continue;
    const key = reviewUnitKey(r.assetType, r.fieldName);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const seen = new Map(); // key -> how many inputs with this key are already bound
  return (list || []).map((f, i) => {
    const key = reviewUnitKey(f.assetType, f.fieldName);
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    const matches = byKey.get(key);
    // nth same-key result, else this input's positional result, else no comment.
    const r = (matches && matches[n]) || results[i] || {};
    const raw = typeof r.comment === 'string' && r.comment.trim() ? r.comment.trim() : null;
    // The prompt forbids citing an internal document; this is what makes it true.
    const comment = raw ? stripInternalCitations(raw) : null;
    // `instance` is echoed from the INPUT (like assetType/fieldName) — the model
    // never sees it, so it can only come from here.
    return { assetType: f.assetType, instance: f.instance, fieldName: f.fieldName, comment };
  });
}

async function reviewCopyFields({ fields, voiceGuide, briefContext, scoped = false } = {}) {
  const list = Array.isArray(fields) ? fields : [];
  if (list.length === 0) return [];

  // Craft is scoped to the union of the mediums under review; brand is the
  // tenant guide (else the repo voice.md placeholder), never craft's substitute.
  const craft = buildCraftContext(list.map((f) => f.assetType));
  const brand = buildBrandContext(list.map((f) => f.assetType), voiceGuide)
    || '(no brand guide provided — judge on the craft playbook only)';
  // The brief governs WHO the copy targets (audience) for THIS campaign; the
  // brand guide governs HOW it should sound. A brand runs campaigns for varied
  // audiences, so the brief's audience overrides the brand guide's default.
  const bc = briefContext || {};
  const briefSummary = String(bc.summary || '').trim();
  const briefDirection = String(bc.writerDirection || '').trim();
  const hasBrief = !!(briefSummary || briefDirection);
  const briefBlock = hasBrief
    ? [
        'CAMPAIGN BRIEF — this specific campaign. AUTHORITATIVE for WHO the copy targets (audience) and the campaign goal:',
        briefSummary ? `Summary: ${briefSummary}` : '',
        briefDirection ? `Writer direction: ${briefDirection}` : '',
        '',
      ].filter(Boolean)
    : [];

  const prompt = [
    'You are a seasoned copy editor giving a thoughtful second pass on marketing copy — NOT a linter.',
    '',
    ...briefBlock,
    ...(craft
      ? [
          'COPY CRAFT PLAYBOOK — AUTHORITATIVE for HOW GOOD COPY WORKS: headline/body/CTA craft, the approved CTA',
          'library, character discipline, and how each medium under review behaves. It ALWAYS applies:',
          craft,
          '',
        ]
      : []),
    'BRAND REFERENCE — AUTHORITATIVE for HOW THIS COMPANY SOUNDS: voice, tone, rules, banned words,',
    'CTA conventions, the "Words That Work" list, sounding human. Its audience description is the brand DEFAULT.',
    'It SUPPLEMENTS the craft playbook above — it never replaces it:',
    brand,
    '',
    'AUDIENCE PRECEDENCE — read carefully:',
    '• The CAMPAIGN BRIEF decides the target audience. If the brief states an audience, treat it as CORRECT.',
    "• Do NOT flag copy for addressing the brief's audience, even when it differs from the brand reference's",
    "  default audience. Divergence from that default is NOT a defect — a brand runs campaigns for varied audiences.",
    '  (e.g. if the brief targets marketing operations leaders, do not tell the writer to re-aim it at the brand',
    '  reference\'s default IT/service audience.)',
    '• Only raise an audience note if the copy misaddresses the BRIEF\'s OWN audience (e.g. speaks to consumers when',
    '  the brief says enterprise) — never merely because it diverges from the brand default.',
    '• If the brief states no audience, the brand reference\'s default audience applies.',
    "• Regardless of audience, ALWAYS apply the brand reference's brand-universal guidance (voice, tone, avoid",
    '  buzzwords, Words That Work, sound human) AND the full craft playbook.',
    '',
    'For EACH field, judge its copy against (a) the craft playbook — structure, length discipline, front-loading,',
    'CTA/destination match, medium fit, (b) the brand reference\'s voice/tone rules, (c) fit to the BRIEF\'s audience &',
    'goal, and (d) universal writing craft: clarity, tightness, natural phrasing, grammar.',
    'Where craft and brand conflict on how something SOUNDS, the brand reference wins; craft still governs structure.',
    '',
    ...LENGTH_RULE,
    '',
    'MATERIALITY BAR: only flag an issue a skilled editor would genuinely raise because fixing it MATERIALLY improves',
    'the copy. Ignore minor preferences and marginal nitpicks. At most the 1–2 most important notes per field.',
    'SILENCE IS SUCCESS: if a field is strong and on-brand, return null for it. Do NOT manufacture feedback, and never',
    'write affirmations ("this works well") — comment only on what is worth CHANGING. A clean field gets null.',
    'Feedback must be specific, actionable, one or two sentences, and collegial.',
    ...NO_CITATION_RULE,
    '',
    'RE-REVIEW (when a field has priorCopy / priorComment from a previous pass), reason per field:',
    '• copy CHANGED and now works → the writer improved it: return null (do not re-flag, do not congratulate).',
    '• copy CHANGED but a genuine material issue remains → flag the CURRENT issue.',
    '• copy UNCHANGED and previously flagged → the writer saw the note and kept it: return null (do not nag).',
    'Only raise a NEW note on unchanged copy if it is genuinely material and was missed before — be conservative.',
    '',
    ...(scoped
      ? [
          'SCOPED REVIEW — the writer selected specific fields. Each field below is given WITH its',
          'ASSET CONTEXT (its sibling fields\' current copy, in "siblings"). For each field:',
          '• Judge it BOTH on its own AND against its siblings — does it fit the headline / subhead /',
          '  CTA / body it sits with?',
          '• COMMENT ONLY on the fields below. Do NOT write notes about sibling fields.',
          ...CROSS_FIELD_FLAG_RULE,
          '',
        ]
      : []),
    'OUTPUT FORMAT — CRITICAL. Return ONLY a raw JSON array and NOTHING else:',
    '• Do NOT include any reasoning, thinking, preamble, explanation, or trailing text.',
    '• Do NOT wrap the JSON in markdown code fences (no ``` and no ```json).',
    '• The response must START with "[" and END with "]" — the very first character is "[".',
    'One object per field, in the SAME ORDER given:',
    '[{"assetType": string, "fieldName": string, "comment": string|null}]',
    'comment = null means no material issue. Emit exactly one object per input field.',
    '',
    'FIELDS:',
    JSON.stringify(
      list.map((f) => {
        const entry = {
          assetType: f.assetType,
          fieldName: f.fieldName,
          lengthUnit: f.fieldType === 'words' ? 'words' : 'characters',
          copy: f.copy || '',
          priorCopy: f.priorCopy || null,
          priorComment: f.priorComment || null,
        };
        // char_max 0 is the NO-LIMIT sentinel, not a limit of zero — the same
        // rule fieldLabel applies when it renders "Legal Line" with no bracket
        // (googleDocs.js:408). Sent as `"charMax": 0` it produced "The copy is 40
        // characters over the 0-character limit… the character limit in the
        // system needs to be updated." So the key is OMITTED for an unlimited
        // field, exactly as the floor is: a number that is never sent cannot be
        // asserted as a constraint. LENGTH_RULE tells the model what an absent
        // key means.
        //
        // The floor is never sent at all — given a charMin the model reports
        // "142 characters, short of the 150 minimum — expand", a spec-shaped
        // instruction to pad. `lengthUnit` always travels, so a 300-word email is
        // judged in words rather than against a character count it was never
        // written to, whether or not it has a ceiling.
        const ceiling = Number(f.charMax) > 0 ? Number(f.charMax) : null;
        if (ceiling) entry.charMax = ceiling;
        // Sibling context (scoped review only) — read for fit + interaction, never commented.
        if (scoped && Array.isArray(f.siblings) && f.siblings.length) {
          entry.siblings = f.siblings.map((s) => ({ fieldName: s.fieldName, copy: s.copy }));
        }
        return entry;
      }),
      null,
      2
    ),
  ].join('\n');

  // Force structured output: JSON mode (responseMimeType) + a response schema so
  // the model returns a valid array and can't leak reasoning prose into the body.
  // maxOutputTokens is generous because gemini-3.5-flash is a thinking model —
  // internal reasoning eats the budget before the JSON is emitted otherwise.
  const REVIEW_SCHEMA = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        assetType: { type: 'STRING' },
        fieldName: { type: 'STRING' },
        comment: { type: 'STRING', nullable: true },
      },
      required: ['assetType', 'fieldName'],
    },
  };

  // Two attempts: JSON mode + the resilient extractor almost always succeed on
  // the first try, but a thinking model can still occasionally return unparseable
  // output — retry once before surfacing an error to the caller.
  let parsed = null;
  let lastText = '';
  for (let attempt = 0; attempt < 2 && parsed == null; attempt += 1) {
    lastText = await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        // gemini-3.5-flash is a thinking model: reasoning tokens count against
        // this budget too. 4096 fits the short all-clean case but a full review
        // WITH many comments (long JSON array) + reasoning can exceed it and
        // truncate mid-object, failing the parse. 8192 gives comfortable headroom
        // for a 20+ field review where most fields get a note.
        temperature: 0.3,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: REVIEW_SCHEMA,
      },
    });
    parsed = extractJsonArray(lastText);
    if (parsed == null && attempt === 0) {
      console.warn('[gemini] review JSON parse failed on attempt 1; retrying once');
    }
  }
  if (parsed == null) {
    throw new Error('Could not parse Gemini review JSON: ' + String(lastText).slice(0, 300));
  }

  return matchReviewResults(list, parsed);
}

// The doorway-fit guidance block (angle ↔ context) — shared by the prompt and
// exposed for tests. Tells the review WHEN each doorway is strategically strong
// vs. risky, so it can judge "is this the right angle" against funnel stage.
const DOORWAY_FIT_GUIDE = [
  '- Pain: strong when the audience actively feels the ache; risky in celebratory/',
  '  awareness contexts or if it tips into fear-mongering.',
  '- Outcome: broadly safe, benefit-led; rarely a strategic mismatch.',
  '- Contrast (old way vs new): strong when a shared "old way" exists; weak without one.',
  '- Question: strong TOP-of-funnel to stop the scroll; risky if gimmicky, or bottom-funnel',
  '  where the reader wants directness over a rhetorical question.',
  '- Proof (a number/claim): strong mid/bottom-funnel or where trust exists AND the claim is',
  '  specific and verifiable; RISKY top-of-funnel with a cold audience that does not trust you',
  '  yet, and risky whenever the number is vague or unsupported.',
  '- Identity (speaks to who they are): strong for community/aspirational placements; risky if',
  '  it presumes who the reader is, or on transactional copy.',
  '- Reframe (challenge the category): strong for thought-leadership / organic social /',
  '  differentiation; risky where clarity and directness matter most (CTAs, transactional).',
];

// Build the variant-review prompt for ONE stacked field. Pure — rendered from the
// field's options (each carrying its assigned doorway). `siblings` (scoped review)
// is the asset context — the stack's non-variation neighbors — read for fit +
// cross-field interaction, never commented. Exposed for tests.
// `charMin` is deliberately NOT a parameter — see LENGTH_RULE. The stack review
// is told the ceiling and the unit, never a floor.
function buildVariantReviewPrompt({ assetType, fieldName, charMax, fieldType, variations, voiceGuide, briefContext, siblings } = {}) {
  const opts = Array.isArray(variations) ? variations : [];
  const sibs = Array.isArray(siblings) ? siblings.filter((s) => s && s.fieldName && String(s.copy || '').trim()) : [];
  const craft = buildCraftContext(assetType);
  const brand = buildBrandContext(assetType, voiceGuide)
    || '(no brand guide provided — judge on the craft playbook only)';
  const bc = briefContext || {};
  const briefSummary = String(bc.summary || '').trim();
  const briefDirection = String(bc.writerDirection || '').trim();
  const briefBlock = briefSummary || briefDirection
    ? [
        'CAMPAIGN BRIEF — AUTHORITATIVE for audience + goal:',
        briefSummary ? `Summary: ${briefSummary}` : '',
        briefDirection ? `Writer direction: ${briefDirection}` : '',
        '',
      ].filter(Boolean)
    : [];
  // "50-140 words" read as a required band and drew the same padding note the
  // single-field path produced. A ceiling, or nothing.
  const limitLine = fieldType === 'words'
    ? (Number(charMax) > 0
      ? `Length: up to ${charMax} words per option — a WORD count, not characters. There is no floor.`
      : 'Length is counted in WORDS, not characters. Keep each option tight.')
    : (Number(charMax) > 0
      ? `Character limit: ${charMax} per option (a hard maximum). There is no minimum.`
      : 'Keep each option concise.');

  return [
    'You are a seasoned copy strategist AND editor giving a second pass on ONE marketing',
    'field that currently holds several VARIATION OPTIONS the writer is choosing between.',
    'Each option enters the SAME value prop through a different DOORWAY (angle), labeled in',
    'the doc. For EACH option, give the writer a sharper read. You do NOT pick a winner —',
    'the writer owns that decision.',
    '',
    ...briefBlock,
    ...(craft
      ? [
          'COPY CRAFT PLAYBOOK — AUTHORITATIVE for HOW GOOD COPY WORKS (headline/body/CTA craft,',
          'the approved CTA library, character discipline, this medium\'s behavior). ALWAYS applies:',
          '"""',
          craft,
          '"""',
          '',
        ]
      : []),
    'BRAND REFERENCE — AUTHORITATIVE for HOW THIS COMPANY SOUNDS (voice, tone, banned',
    'words, "Words That Work", sounding human). Supplements the craft playbook, never replaces it:',
    '"""',
    brand,
    '"""',
    '',
    'THIS FIELD:',
    `Asset: ${assetType}`,
    `Field: ${fieldName}`,
    limitLine,
    'Infer the FUNNEL STAGE from the asset type + brief: organic social / brand awareness is',
    'TOP-of-funnel (a cold, scrolling audience that does not trust you yet); a demo email or',
    'landing-page CTA is BOTTOM-of-funnel. Funnel stage shapes which doorway fits.',
    '',
    'ASSESS EACH OPTION ON TWO AXES — STRATEGY FIRST, THEN CRAFT:',
    '1. STRATEGY — is this DOORWAY the right ANGLE for this asset type, audience, and funnel',
    '   stage? Use the doorway-fit guidance below. If the angle is a genuine mismatch, say why',
    '   in one sentence. If the angle fits, strategy = null.',
    '2. CRAFT — is the execution strong under the craft playbook AND the brand reference',
    '   (tightness, front-loading, CTA/destination match, tone, banned words, sounds human,',
    '   within the limit)? Same bar as any review. If clean, craft = null.',
    '',
    'DOORWAY-FIT GUIDANCE (angle ↔ context):',
    ...DOORWAY_FIT_GUIDE,
    '',
    'MATERIALITY — READ CAREFULLY:',
    '- Comment on an option ONLY where a skilled editor would genuinely intervene. MOST options',
    '  come back clean (strategy null AND craft null). Returning null/null for EVERY option is a',
    '  valid, common outcome — do NOT manufacture a note to fill each row.',
    '- No affirmations, no "this is strong," no approving restatement of the angle. Only what is',
    '  worth CHANGING.',
    '- At most ONE strategy point and ONE craft point per option; each one sentence, collegial.',
    '- You MUST evaluate every option — evaluating is not the same as commenting.',
    '- An option with no doorway label (a "stay close" stack) → assess CRAFT only; leave strategy',
    '  null.',
    '',
    ...LENGTH_RULE,
    '',
    ...NO_CITATION_RULE,
    '',
    'RE-REVIEW: if an option is unchanged from a prior pass and was already noted (priorComment),',
    "return null (don't nag); if it changed and now works, null.",
    '',
    ...(sibs.length
      ? [
          'ASSET CONTEXT — this field\'s SIBLINGS in the same asset (their current copy). Read them',
          'for fit and for cross-field INTERACTION. COMMENT ONLY on the options below, never on a',
          'sibling. Siblings:',
          ...sibs.map((s) => `  - ${s.fieldName}: ${String(s.copy).trim()}`),
          '',
          ...CROSS_FIELD_FLAG_RULE,
          '(For a stack, put the flag in the "flag" field of the option it concerns — e.g. the',
          'option that duplicates a sibling.)',
          '',
          'OUTPUT — raw JSON array ONLY, one object per option IN ORDER, first char "[":',
          '[{"index": 1, "doorway": "Contrast", "strategy": string|null, "craft": string|null, "flag": string|null}]',
        ]
      : [
          'OUTPUT — raw JSON array ONLY, one object per option IN ORDER, first char "[":',
          '[{"index": 1, "doorway": "Contrast", "strategy": string|null, "craft": string|null}]',
        ]),
    '',
    'OPTIONS:',
    JSON.stringify(
      opts.map((o) => ({
        index: o.index,
        doorway: o.doorway || null,
        copy: o.copy || '',
        priorComment: o.priorComment || null,
      })),
      null,
      2
    ),
  ].join('\n');
}

// Review ONE unresolved numbered stack: assess each option on STRATEGY (is the
// doorway the right angle for this asset/audience/funnel?) then CRAFT (craft.md
// + the brand guide),
// per-variation, at the materiality bar. `siblings` (scoped review) adds asset
// context + enables a tight cross-field `flag`. Returns [{ index, doorway,
// strategy, craft, flag }], each axis null when clean. It does NOT pick a winner.
async function reviewVariationStack({ assetType, fieldName, charMax, fieldType, variations, voiceGuide, briefContext, siblings } = {}) {
  const opts = Array.isArray(variations) ? variations : [];
  if (opts.length === 0) return [];

  // fieldType was destructured here but never forwarded, so a WORD-count field's
  // stack was told "Character limit: 140 per option" — measuring words against a
  // character number, the same confusion the length rule exists to end.
  const prompt = buildVariantReviewPrompt({ assetType, fieldName, charMax, fieldType, variations: opts, voiceGuide, briefContext, siblings });

  const SCHEMA = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        index: { type: 'INTEGER' },
        doorway: { type: 'STRING', nullable: true },
        strategy: { type: 'STRING', nullable: true },
        craft: { type: 'STRING', nullable: true },
        flag: { type: 'STRING', nullable: true },
      },
      required: ['index'],
    },
  };

  let parsed = null;
  let lastText = '';
  for (let attempt = 0; attempt < 2 && parsed == null; attempt += 1) {
    lastText = await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
      },
    });
    parsed = extractJsonArray(lastText);
    if (parsed == null && attempt === 0) {
      console.warn(`[gemini] variant-review JSON parse failed for ${fieldName}; retrying once`);
    }
  }
  if (parsed == null) {
    throw new Error('Could not parse Gemini variant-review JSON: ' + String(lastText).slice(0, 300));
  }

  // Same citation strip as the single-field path — strategy, craft and flag all
  // reach the writer as doc comment text.
  const strOrNull = (v) => (typeof v === 'string' && v.trim() ? stripInternalCitations(v.trim()) : null);
  const byIndex = new Map();
  parsed.forEach((r, i) => {
    if (!r) return;
    if (r.index != null) byIndex.set(Number(r.index), r);
    byIndex.set(`__idx_${i}`, r);
  });
  return opts.map((o, i) => {
    const r = byIndex.get(o.index) || byIndex.get(`__idx_${i}`) || {};
    return { index: o.index, doorway: o.doorway || null, strategy: strOrNull(r.strategy), craft: strOrNull(r.craft), flag: strOrNull(r.flag) };
  });
}

// LiveSpecs (chunk 3b): read a platform spec page and suggest the character
// limit for each requested field. Best-effort — returns [] on ANY failure so the
// admin review falls back to manual entry; never throws fatally. Each requested
// field carries a numeric `ref` (its index) that the model echoes back, so the
// caller maps suggestions to the exact (asset,field) even when field names repeat.
const SPEC_EXTRACT_MAX = 12000; // page-text cap protecting the context window

async function extractSpecValues({ pageText, fields } = {}) {
  const text = String(pageText || '').slice(0, SPEC_EXTRACT_MAX);
  const list = Array.isArray(fields) ? fields : [];
  if (!text || list.length === 0) return [];

  const fieldLines = list
    .map(
      (f, i) =>
        `ref ${i}: asset="${f.asset}" field="${f.field}" current_char_max=${f.current_char_max != null && f.current_char_max !== '' ? f.current_char_max : '(unknown)'}`
    )
    .join('\n');

  const prompt = [
    'You are auditing an advertising/email platform spec page for CHARACTER LIMITS.',
    'Below is the visible text of the page, then a list of copy fields (each with a ref number).',
    'For EACH listed field, find the character limit the page states for it, if any.',
    'Return STRICT JSON — an array with one object per field:',
    '  { "ref": <the field\'s ref number>,',
    '    "suggested_char_max": <integer, or null if the page does not clearly state one>,',
    '    "snippet": <a short verbatim quote (<=160 chars) from the page supporting the number, else "">,',
    '    "confidence": "high" | "medium" | "low" }',
    'Rules: use ONLY numbers actually present in the page text. If a field is not clearly',
    'addressed, set suggested_char_max=null, snippet="", confidence="low". Do NOT guess or',
    'invent numbers. Match platform wording to the field by meaning (e.g. page "Headline"',
    'wording may map to field "Short Headline").',
    '',
    'FIELDS:',
    fieldLines,
    '',
    'PAGE TEXT:',
    text,
  ].join('\n');

  let parsed = null;
  try {
    const out = await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
      },
    });
    parsed = extractJsonArray(out);
  } catch (err) {
    console.error('[gemini] extractSpecValues failed:', err.message);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  // Sanitize each row to the expected shape; a positive integer within bounds or null.
  return parsed
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const ref = Number(r.ref);
      const n = Number(r.suggested_char_max);
      return {
        ref: Number.isInteger(ref) ? ref : null,
        suggested_char_max: Number.isInteger(n) && n > 0 && n <= 100000 ? n : null,
        snippet: r.snippet ? String(r.snippet).slice(0, 200) : '',
        confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low',
      };
    })
    .filter((r) => r && r.ref !== null);
}

module.exports = {
  extractSpecValues,
  parseBrief,
  enrichWithReferences,
  generateFieldDraft,
  generateAssetDrafts,
  generateFieldVariations,
  generateVoiceGuide,
  describeImage,
  extractHeaderSchema,
  reviewCopyFields,
  matchReviewResults, // pure result↔input binder; exported for unit tests
  reviewVariationStack,
  // Shared with destinations/googleDocs.js (cleanCampaignTitle) so the two
  // wrapper-stripping paths can't drift apart.
  cleanDraft,
  // Exposed for unit tests only.
  ASSET_PHRASE_HINTS,
  REFUSAL_EXAMPLES,
  assetPhraseHintLines,
  refusalRuleLine,
  brandVoiceLines,
  buildCraftContext,
  buildBrandContext,
  mediumKeywordsForAsset,
  builtInFieldGuidance,
  siblingContextBlock,
  overLimit,
  assignDoorways,
  buildVariationsPrompt,
  doorwayRankingForField,
  DOORWAYS,
  INTENSITIES,
  buildVariantReviewPrompt,
  DOORWAY_FIT_GUIDE,
  CROSS_FIELD_FLAG_RULE,
  // The two review-comment rules, shared verbatim by both review prompts, plus
  // the sanitizer that enforces the second one on the way out.
  LENGTH_RULE,
  NO_CITATION_RULE,
  stripInternalCitations,
};
