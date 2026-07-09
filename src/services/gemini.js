'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

// Brand voice guide (voice.md at the repo root), loaded once at startup and
// injected into every draft prompt as the overall brand identity. HTML comments
// are stripped; if only headings/comments remain (the unfilled placeholder),
// it's treated as empty and nothing is injected.
function loadVoiceGuide() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'voice.md'), 'utf8');
    const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, '');
    const meaningful = withoutComments.replace(/^#.*$/gm, '').trim();
    return meaningful ? withoutComments.trim() : '';
  } catch {
    return '';
  }
}
const VOICE_GUIDE = loadVoiceGuide();

// Split the guide once into the universal parts (always injected) and the
// per-medium subsections of "## … Writing Across Mediums" (injected only for
// the relevant medium — see buildVoiceContext). This is the token optimization:
// instead of shipping the whole file on every asset call, we ship the universal
// craft + CTA library + banned words + just the one relevant medium section.
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

// The voice context to inject for a given asset: universal craft (incl. CTA
// library + banned words) plus only the relevant medium subsection. When a
// per-tenant `voiceGuide` (raw markdown) is supplied and non-empty, it is the
// source; otherwise we fall back to the repo voice.md loaded at startup.
function buildVoiceContext(assetType, voiceGuide) {
  // Pick the source + its parsed form. A non-empty tenant guide wins; otherwise
  // the module-level repo voice.md (parsed once at startup).
  let rawFull;
  let parsed;
  if (voiceGuide && String(voiceGuide).trim()) {
    rawFull = String(voiceGuide).trim();
    parsed = parseVoice(rawFull);
  } else {
    rawFull = VOICE_GUIDE;
    parsed = VOICE_PARSED;
  }

  if (!parsed) return '';
  if (!parsed.sliceable) return rawFull;

  const keywords = mediumKeywordsForAsset(assetType);
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

// Prompt lines for the brand-voice section, scoped to the asset's medium.
// Empty when no voice guide is set. Frames the layering: voice.md = how to
// write; Sheet Tone Notes = field-specific direction; character limits = hard
// constraints that always win.
function brandVoiceLines(assetType, voiceGuide) {
  const voice = buildVoiceContext(assetType, voiceGuide);
  if (!voice) return [];
  return [
    'BRAND VOICE & COPY PLAYBOOK — this is HOW to write: the overall brand voice',
    'and copywriting craft (tone, banned words, headline/body/CTA principles, the',
    'approved CTA library, and guidance for THIS asset\'s medium). Apply it to ALL copy.',
    '"""',
    voice,
    '"""',
    '',
    'PROMPT HIERARCHY — what governs what:',
    '1. The Brand Voice & Copy Playbook above = HOW to write (voice + craft).',
    "2. Each field's Tone Notes / guidance = field-specific tactical direction.",
    '3. Character limits = HARD constraints that ALWAYS win.',
    "When the playbook and a field's Tone Note conflict, the field's Tone Note",
    'wins for that field — but the overall voice (tone, banned words, CTA style)',
    'always applies, and a field\'s character limit is never exceeded.',
    'For CTA fields: prefer an option from the playbook\'s approved CTA library',
    "that matches the asset's destination / funnel stage, rather than inventing a",
    'new CTA phrasing.',
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

// Parse a free-form campaign brief into { summary, writerPrompt, assets }.
// Assets are constrained to the allowed list regardless of how they were
// written in the brief (bullets, numbers, or inline prose).
async function parseBrief(brief) {
  // Valid asset types (exact Sheet names) — single source of truth lives in
  // config.ALLOWED_ASSETS. Used both in the prompt and the defensive filter.
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
    `- assets: return ONLY asset types explicitly mentioned or clearly implied by the brief. You MUST use exact names from this list:\n\n${allowed.join(
      '\n'
    )}\n\nReturn only names from this list. Maximum 5 unless the brief explicitly requests more. If no specific assets are mentioned, return the 3 most relevant for the campaign goal described.`,
    '',
    'INTERPRET INTENT SEMANTICALLY, do not match exact strings. Briefs use',
    'informal, abbreviated, or platform-specific language. Map what the writer',
    'MEANS to the canonical asset name. The brief may list assets as bullets,',
    'numbers, or inline prose — extract them regardless of format. The lists below',
    'are illustrative, not exhaustive; treat obvious variants, plurals, and',
    'casing the same way:',
    '- "linkedin ad" or "linkedin" → LinkedIn Single Image Ad',
    '- "linkedin carousel" → LinkedIn Carousel Ad',
    '- "linkedin variants" or "ab test" or "variant" → LinkedIn Single Image Ad — Variant A, LinkedIn Single Image Ad — Variant B',
    '- "meta ad" or "facebook ad" → Meta Single Image Ad',
    '- "meta carousel" → Meta Carousel Ad',
    '- "twitter" or "x ad" → Twitter/X Ad',
    '- "display" or "banner" → Display Banner — Standard',
    '- "dv360" or "programmatic" → Google DV360 / Responsive Display',
    '- "email" or "nurture" → Demand Gen Nurture Email',
    '- "event email" or "invite" → Event Invitation Email',
    '- "reminder email" → Event Reminder Email',
    '- "follow up" or "recap email" → Event Follow-Up / Recap Email',
    '- "basho" or "sales email" → Sales Basho Email',
    '- "landing page" or "event page" → Event Landing Page',
    '- "signage" or "on-site" → On-Site Signage — General',
    '- "campaign page" → Campaign Landing Page',
    '- "confirm page" or "form confirm" → Form Confirm Page',
    '- "organic social" or "organic" → Organic Social — LinkedIn',
    '- "instagram" → Organic Social — Instagram',
    '- "direct mail" or "mailer" → Direct Mail — Box / Mailer',
    '- "rep letter" or "note card" → Direct Mail — Note Card / Rep Letter',
    '- "one pager" or "one-pager" → One-Pager',
    '- "battle card" → Battle Card',
    '',
    'Rules:',
    '- Only include an asset when the intent is reasonably clear; do not invent assets that are not implied. Never return all asset types for a vague brief.',
    '- If the brief requests an asset type that does NOT confidently map to the allowed list (e.g. TikTok, podcast ad, billboard, SMS), do NOT substitute a nearest guess. Put the original phrase in unmatchedAssets and leave it out of assets.',
    '',
    '- folderId: if the brief contains a Google Drive folder URL of the form',
    '  https://drive.google.com/drive/folders/FOLDER_ID , extract just the',
    '  FOLDER_ID string (the path segment after /folders/). Return null if none.',
    "- referenceLinks: extract every URL from the brief text that begins with http:// or https://. Include ALL URLs — Google Drive, Google Docs, Salesforce, external pages, AND Slack Canvas or Docs URLs (containing slack.com/canvas/ or slack.com/docs/). Return as a plain array of strings. If no URLs found, return [].",
    "  Example: ['https://docs.google.com/...', 'https://www.salesforce.com/...']",
    '- unmatchedAssets: asset types the brief asked for that do NOT map to the',
    '  allowed list. [] if none. Never force these into assets.',
    '',
    'Return an object of the shape: {"campaignTitle": string, "summary": string, "writerPrompt": string, "assets": string[], "unmatchedAssets": string[], "folderId": string|null, "referenceLinks": string[]}.',
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
  const normalize = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[—–\-]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  const canonicalByNorm = new Map(allowed.map((a) => [normalize(a), a]));

  const rawAssets = Array.isArray(parsed.assets) ? parsed.assets : [];
  const assets = [];
  const unmatchedFromAssets = [];
  for (const a of rawAssets) {
    const canonical = canonicalByNorm.get(normalize(a));
    if (canonical) {
      if (!assets.includes(canonical)) assets.push(canonical);
    } else {
      unmatchedFromAssets.push(a);
    }
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
// character limit and creative direction. Enforces the limit: if the draft is
// over, it gets one corrective rewrite, then a hard trim as a last resort.
async function generateFieldDraft({
  assetType,
  channel,
  fieldName,
  charMax,
  toneNotes,
  notes,
  funnelStage,
  assetDirection,
  summary,
  writerPrompt,
  direction,
  voiceGuide,
}) {
  const ceiling = Number(charMax) > 0 ? Number(charMax) : null;
  const limitLine = ceiling
    ? `Character limit: ${ceiling}. Stay within this limit — write a COMPLETE, self-contained thought and finish it, even a few characters short; never run up to the limit and get cut off mid-sentence.`
    : 'Keep it concise — a complete, self-contained thought appropriate for the field.';
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
      const ceiling = Number(f.charMax) > 0 ? Number(f.charMax) : null;
      const limit = ceiling
        ? `character limit ${ceiling} — stay within this limit`
        : 'concise';
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
    const ceiling = Number(f.charMax) > 0 ? Number(f.charMax) : null;
    // Missing from the batch, or over its limit → fall back to the robust
    // single-field generator (which rewrites and, if needed, hard-trims).
    // One field's fallback failing (a Gemini timeout / rate-limit / error) must
    // NOT abandon the whole asset — the many-field assets (carousels) fire the
    // most fallback calls and so are the most exposed. Isolate each: on failure
    // keep whatever the batch gave (or empty), and let the other fields proceed.
    if (!copy || (ceiling && copy.length > ceiling)) {
      try {
        copy = await generateFieldDraft({
          assetType,
          channel,
          fieldName: f.fieldName,
          charMax: f.charMax,
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
        console.warn(
          `[gemini] field fallback failed for ${assetType} / ${f.fieldName}: ${err.message}`
        );
        // Keep the batch value if we had one; otherwise leave it empty (dropped
        // downstream) rather than throwing away every field on this asset.
      }
    }
    out.push({ fieldName: f.fieldName, copy });
  }
  return out;
}

// Generate a brand voice guide (markdown) from the onboarding questionnaire
// answers. Optional `direction` (a revision instruction) and `previousGuide`
// (the current voice.md) drive regeneration. Returns the raw markdown string.
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
// feature). Judges each field's copy against (a) the brand reference (voice.md —
// voice, tone, rules, banned words, CTA conventions) and (b) universal writing
// craft, and returns a per-field comment ONLY where a material issue genuinely
// warrants it (silence is the good outcome). On re-review, prior copy/comment
// per field let it recognize the writer's improvements and not re-nag.
//   fields: [{ assetType, fieldName, charMax, copy, priorCopy, priorComment }]
// Returns [{ assetType, fieldName, comment }] (comment: string | null), one per
// input field, same order. Throws on a hard failure so the caller can show an
// error state (rather than silently posting nothing).
async function reviewCopyFields({ fields, voiceGuide } = {}) {
  const list = Array.isArray(fields) ? fields : [];
  if (list.length === 0) return [];

  const brand = String(voiceGuide || '').trim() || '(no brand guide provided — judge on universal writing craft only)';
  const prompt = [
    'You are a seasoned copy editor giving a thoughtful second pass on marketing copy — NOT a linter.',
    '',
    'BRAND REFERENCE — the single source of truth for this brand (voice, tone, rules, banned words, CTA conventions):',
    brand,
    '',
    'For EACH field, judge its copy against (a) the brand reference above and (b) universal writing craft:',
    'clarity, tightness, natural phrasing, grammar.',
    '',
    'MATERIALITY BAR: only flag an issue a skilled editor would genuinely raise because fixing it MATERIALLY improves',
    'the copy. Ignore minor preferences and marginal nitpicks. At most the 1–2 most important notes per field.',
    'SILENCE IS SUCCESS: if a field is strong and on-brand, return null for it. Do NOT manufacture feedback, and never',
    'write affirmations ("this works well") — comment only on what is worth CHANGING. A clean field gets null.',
    'Feedback must be specific, actionable, one or two sentences, and collegial.',
    '',
    'RE-REVIEW (when a field has priorCopy / priorComment from a previous pass), reason per field:',
    '• copy CHANGED and now works → the writer improved it: return null (do not re-flag, do not congratulate).',
    '• copy CHANGED but a genuine material issue remains → flag the CURRENT issue.',
    '• copy UNCHANGED and previously flagged → the writer saw the note and kept it: return null (do not nag).',
    'Only raise a NEW note on unchanged copy if it is genuinely material and was missed before — be conservative.',
    '',
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
      list.map((f) => ({
        assetType: f.assetType,
        fieldName: f.fieldName,
        charMax: f.charMax || 0,
        copy: f.copy || '',
        priorCopy: f.priorCopy || null,
        priorComment: f.priorComment || null,
      })),
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

  // Map results back to inputs by (assetType, fieldName); fall back to position.
  const byKey = new Map();
  parsed.forEach((r, i) => {
    if (!r) return;
    const key = `${String(r.assetType || '').trim().toLowerCase()}||${String(r.fieldName || '').trim().toLowerCase()}`;
    byKey.set(key, r);
    byKey.set(`__idx_${i}`, r);
  });
  return list.map((f, i) => {
    const key = `${String(f.assetType || '').trim().toLowerCase()}||${String(f.fieldName || '').trim().toLowerCase()}`;
    const r = byKey.get(key) || byKey.get(`__idx_${i}`) || {};
    const comment = typeof r.comment === 'string' && r.comment.trim() ? r.comment.trim() : null;
    return { assetType: f.assetType, fieldName: f.fieldName, comment };
  });
}

module.exports = {
  parseBrief,
  enrichWithReferences,
  generateFieldDraft,
  generateAssetDrafts,
  generateVoiceGuide,
  describeImage,
  extractHeaderSchema,
  reviewCopyFields,
  // Exposed for unit tests only.
  builtInFieldGuidance,
};
