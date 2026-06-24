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
// library + banned words) plus only the relevant medium subsection.
function buildVoiceContext(assetType) {
  if (!VOICE_PARSED) return '';
  if (!VOICE_PARSED.sliceable) return VOICE_GUIDE;

  const keywords = mediumKeywordsForAsset(assetType);
  let chosen = keywords
    ? VOICE_PARSED.subs.filter((s) => keywords.some((k) => s.title.toLowerCase().includes(k)))
    : VOICE_PARSED.subs;
  if (chosen.length === 0) chosen = VOICE_PARSED.subs; // no match → don't drop guidance

  return [
    VOICE_PARSED.preMedium,
    VOICE_PARSED.mediumsIntro,
    ...chosen.map((s) => s.text),
    VOICE_PARSED.postMedium,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Prompt lines for the brand-voice section, scoped to the asset's medium.
// Empty when no voice guide is set. Frames the layering: voice.md = how to
// write; Sheet Tone Notes = field-specific direction; character limits = hard
// constraints that always win.
function brandVoiceLines(assetType) {
  const voice = buildVoiceContext(assetType);
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
  summary,
  writerPrompt,
  direction,
}) {
  const ceiling = Number(charMax) > 0 ? Number(charMax) : null;
  const limitLine = ceiling
    ? `Character limit: ${ceiling}. Stay within this limit — write a COMPLETE, self-contained thought and finish it, even a few characters short; never run up to the limit and get cut off mid-sentence.`
    : 'Keep it concise — a complete, self-contained thought appropriate for the field.';

  const prompt = [
    'Write marketing copy for a single field. Return ONLY the copy itself — no labels, quotes, options, or commentary. Exactly one version.',
    '',
    ...brandVoiceLines(assetType),
    `Campaign summary: ${summary}`,
    `Creative direction: ${writerPrompt}`,
    `Asset: ${assetType}`,
    channel ? `Channel: ${channel}` : '',
    `Field: ${fieldName}`,
    funnelStage ? `Funnel stage: ${funnelStage}` : '',
    toneNotes ? `Tone notes: ${toneNotes}` : '',
    notes ? `Field guidance: ${notes}` : '',
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
  summary,
  writerPrompt,
  fields,
  direction,
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
      const extra = [
        f.funnelStage ? `funnel: ${f.funnelStage}` : '',
        f.notes ? `guidance: ${f.notes}` : '',
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
    ...brandVoiceLines(assetType),
    `Campaign summary: ${summary}`,
    `Creative direction: ${writerPrompt}`,
    `Asset: ${assetType}`,
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
      generationConfig: { temperature: 0.8 },
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
    if (!copy || (ceiling && copy.length > ceiling)) {
      copy = await generateFieldDraft({
        assetType,
        channel,
        fieldName: f.fieldName,
        charMax: f.charMax,
        toneNotes,
        notes: f.notes,
        funnelStage: f.funnelStage,
        summary,
        writerPrompt,
        direction,
      });
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

module.exports = { parseBrief, enrichWithReferences, generateFieldDraft, generateAssetDrafts, generateVoiceGuide };
