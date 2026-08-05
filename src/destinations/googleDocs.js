'use strict';

// Google Docs destination adapter.
//
// Implements the destination contract consumed by the core workflow:
//   createDocument({ brief, summary, writerPrompt, assetSpecs, folderId, referenceLinks }) -> { id, url, title }
//   generateDraft(id) -> { title, fieldCount, url }
//
// Everything Google-Docs-specific (the Drive/Docs API calls, the batchUpdate
// formatting, the stateless doc re-parsing) lives behind this boundary so a
// future Notion/OneDrive adapter can be added without touching the workflow.

const config = require('../config');
const { getClients } = require('../google');
const { DocBuilder } = require('./docBuilder');
const { findHeaderTable } = require('./docHeaderTable');
const { isValidHeaderSchema } = require('./docHeaderSchema');
const { isValidNamingPattern, applyNamingPattern } = require('./docNaming');
const { locateCells, readCells, buildCellWriteRequests } = require('./templateCells');
const { generateAssetDrafts, generateFieldDraft, generateFieldVariations, cleanDraft, DOORWAYS, INTENSITIES } = require('../services/gemini');
const { instanceTag, instanceCounter } = require('../utils/instanceKey');
// Same asset-name folding the pipeline uses to match a name to a library row, so
// instance-heading sibling detection groups names the same way.
const { normalize } = require('../utils/normalize');

// Allowed matrix names (Variations Matrix, Step 3), sourced from gemini so there's
// one taxonomy. Used to validate a scoped field's `variations` rows.
const ANGLE_NAMES = new Set(Object.keys(DOORWAYS));
const INTENSITY_NAMES = new Set(Object.keys(INTENSITIES));

// How many assets to draft concurrently (each asset is one batched Gemini call
// plus possible per-field fallbacks). Bounded to keep peak memory/CPU sane on an
// all-8-assets run while cutting wall-clock for typical 4-6 asset briefs.
// Tunable via DRAFT_CONCURRENCY.
const DRAFT_CONCURRENCY = Number(process.env.DRAFT_CONCURRENCY) || 5;

// Log a memory snapshot so we can see if a big run is approaching a ceiling.
function logMemory(label) {
  const m = process.memoryUsage();
  const mb = (b) => Math.round(b / 1024 / 1024);
  console.log(
    `[mem] ${label}: rss ${mb(m.rss)}MB, heapUsed ${mb(m.heapUsed)}MB, heapTotal ${mb(m.heapTotal)}MB`
  );
}

// Run `fn` over `items` with at most `limit` in flight; preserves input order.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function todayStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Articles / short prepositions that stay lowercase in Title Case unless they
// are the first word.
const SMALL_WORDS = new Set(['a', 'an', 'the', 'for', 'in', 'of', 'at', 'by']);

function toTitleCase(str) {
  return str
    .split(/\s+/)
    .map((word, i) => {
      if (!word) return word;
      if (i > 0 && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
      // Capitalize the first letter; leave the rest as-is to preserve acronyms.
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

// Cleanup pass for Gemini's campaign title: strip the junk models sometimes
// add (labels, surrounding quotes/markdown, an accidental leading date,
// trailing punctuation) and cap the length. Returns '' if nothing usable.
function cleanCampaignTitle(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.replace(/^(?:campaign\s*title|title|campaign|name)\s*[:\-–—]\s*/i, ''); // leading label
  t = t.replace(/^\d{4}-\d{2}-\d{2}\s*[-–—:]*\s*/, ''); // accidental leading date
  // Shares cleanDraft with the field-copy path so the two can't drift: peels a
  // wrapper only when it's balanced and encloses the whole title, leaving a
  // title that merely OPENS with a quoted phrase intact.
  t = cleanDraft(t); // surrounding quotes/markdown
  t = t.replace(/[.,;:!]+$/, '').trim(); // trailing punctuation
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 8) t = words.slice(0, 8).join(' '); // keep it concise
  return t;
}

// Today's exact default doc name: Title Case campaign with a YYYY-MM-DD prefix.
function defaultTitle(brief, campaignTitle) {
  const base =
    cleanCampaignTitle(campaignTitle) ||
    String(brief).trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ') ||
    'Campaign';
  return `${todayStamp()} — ${toTitleCase(base)}`;
}

// Build the doc filename. With a stored per-tenant naming pattern, fill its
// dynamic spans from real project data and keep the static text verbatim; with
// no/invalid pattern, produce today's EXACT default name unchanged. `namingCtx`
// supplies optional writer/version (campaign/date/year are derived here).
function makeTitle(brief, campaignTitle, namingPattern, namingCtx) {
  if (isValidNamingPattern(namingPattern)) {
    const stamp = todayStamp();
    const campaign =
      cleanCampaignTitle(campaignTitle) ||
      String(brief).trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ') ||
      'Campaign';
    const name = applyNamingPattern(namingPattern, {
      campaign: toTitleCase(campaign),
      date: stamp,
      year: stamp.slice(0, 4),
      version: (namingCtx && namingCtx.version) || 'v1',
      writer: (namingCtx && namingCtx.writer) || '',
    }).trim();
    if (name) return name.slice(0, 200); // usable pattern result
    // empty result (e.g. all-blank tokens) → fall through to the default
  }
  return defaultTitle(brief, campaignTitle);
}

// Left indent (points) applied to fields nested under a group sub-heading.
const GROUP_INDENT_PT = 18;

// === Instance headings: one format, written and read in one place ===
//
// A doc can carry the same asset more than once. A lone instance renders its bare
// library name (byte-identical to every doc written before instances existed); a
// repeated one gets a 1-BASED ordinal, and its instance label when it has one:
//
//   1 instance   → 'Demand Gen Nurture Email'
//   3 instances  → 'Demand Gen Nurture Email 1'
//                  'Demand Gen Nurture Email 2 — Downtown residents'
//
// Writers count from 1; the key ordinal stays 0-based (utils/instanceKey), so the
// heading shows `instance + 1`.
//
// PARSING THIS BACK IS THE DELICATE PART. The label separator ' — ' is NOT a safe
// anchor on its own: 10 of the 25 bundled asset names already contain it ('Direct
// Mail — Box / Mailer', 'Organic Social — LinkedIn', …), so splitting on it would
// shred real names. What makes the format parseable is that the ORDINAL sits
// between the name and the label, so the anchor is ' <digits>' followed by either
// end-of-string or ' — '. No bundled name ends in ' <digits>' or contains
// ' <digits> — '; since the Google asset was renamed off 'DV360', no bundled name
// contains a digit at all. A smoke test re-checks that against the live library
// rather than trusting this comment.
//
// On top of that, acceptance requires a SIBLING: a suffix is only ever written
// when an asset appears 2+ times, so a decomposition is trusted only when another
// heading in the same doc decomposes to the same library name. A tenant asset
// legitimately named 'Concept 2' therefore still reads back as itself.
const INSTANCE_HEADING_RE = /^(.+?) (\d+)(?: — (.+))?$/;

// Spec group → the heading text to render. `total` is how many groups in this doc
// share this asset name; 1 (or less) means no suffix at all.
function assetHeadingText(assetType, instance, instanceLabel, total) {
  const name = String(assetType == null ? '' : assetType);
  if (!(Number(total) > 1)) return name;
  const ordinal = (Number(instance) || 0) + 1;
  const label = String(instanceLabel == null ? '' : instanceLabel).trim();
  return label ? `${name} ${ordinal} — ${label}` : `${name} ${ordinal}`;
}

// Heading text → { assetType, instance, instanceLabel } candidate, or null when the
// text carries no instance suffix. `instance` is 0-based (the heading's ordinal
// minus 1). A 0 or negative ordinal is not a suffix this writer produces, so it is
// rejected rather than folded to instance 0.
function decomposeAssetHeading(text) {
  const m = INSTANCE_HEADING_RE.exec(String(text == null ? '' : text));
  if (!m) return null;
  const ordinal = parseInt(m[2], 10);
  if (!Number.isFinite(ordinal) || ordinal < 1) return null;
  const label = m[3] ? m[3].trim() : null;
  return { assetType: m[1], instance: ordinal - 1, instanceLabel: label || null };
}

// Decide, for a whole document, which HEADING_3 texts are instance-suffixed.
// Takes every heading in document order and returns Map<headingText, decomposition>
// containing only headings whose decomposed library name is shared by 2+ headings —
// the sibling rule above. Headings absent from the map are literal asset names.
function instanceHeadingMap(headingTexts) {
  const byName = new Map(); // decomposed library name -> [{ text, parts }]
  for (const text of headingTexts) {
    const parts = decomposeAssetHeading(text);
    if (!parts) continue;
    const key = normalize(parts.assetType);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ text, parts });
  }
  const accepted = new Map();
  for (const entries of byName.values()) {
    if (entries.length < 2) continue; // a lone suffix is never something we wrote
    for (const { text, parts } of entries) accepted.set(text, parts);
  }
  return accepted;
}

// Every HEADING_3 text in a doc, in document order. Shared by the two readers so
// they classify headings identically.
function assetHeadingTexts(doc) {
  const out = [];
  for (const item of (doc && doc.body && doc.body.content) || []) {
    if (!item.paragraph) continue;
    if (item.paragraph.paragraphStyle?.namedStyleType !== 'HEADING_3') continue;
    out.push(paragraphText(item.paragraph).trim());
  }
  return out;
}

// Map a field's spec_source to a human-readable platform name for the tier line,
// or null when there's no real source yet. Phase A: production spec_source is
// uniformly 'quillio_default' (real per-field values arrive in a later
// re-anchoring pass), so that value — and anything unrecognized — returns null.
// The raw spec_source string is NEVER surfaced (we must never print
// 'quillio_default' or a bogus source name).
function specSourceName(specSource) {
  const s = String(specSource || '').toLowerCase();
  if (!s || s === 'quillio_default') return null;
  if (s.includes('linkedin')) return 'LinkedIn';
  if (s.includes('meta') || s.includes('facebook') || s.includes('fb.com')) return 'Meta';
  if (s.includes('twitter') || s.includes('x.com')) return 'X';
  if (s.includes('google') || s.includes('dv360') || s.includes('doubleclick')) return 'Google';
  if (s.includes('instagram')) return 'Instagram';
  if (s.includes('constantcontact')) return 'Constant Contact';
  // 'gong.io', not 'gong' — a bare substring would match any URL that happens to
  // contain those three letters.
  if (s.includes('gong.io')) return 'Gong';
  return null; // unrecognized → no source name (never print the raw value)
}

// What a RESEARCH source actually measured, and what it found — for the sources
// that are studies rather than platform spec pages.
//
// A platform spec page needs no qualifier: "Recommended by Meta" is unambiguous
// because Meta is describing its own product. A research finding is not. Constant
// Contact's number comes from small-business campaigns, and a writer deciding
// whether to apply it to a B2B nurture email needs to know that before they trust
// it. Stating the population is the difference between a citation and an appeal to
// authority.
//
// `scope` goes in parentheses after the name; `finding` replaces the generic
// "Not a hard limit — adjust for your brand and goal." A source with no entry here
// renders exactly as it did before, so every platform line is unchanged.
const SPEC_SOURCE_DETAIL = {
  'https://www.constantcontact.com/blog/best-length-email-newsletter/': {
    // 2.1 million CUSTOMERS, not emails — the distinction matters, because a
    // per-customer figure says nothing about how many campaigns are behind it.
    scope: '2.1M customers, small-business campaigns',
    finding: 'Longer bodies click less.',
  },
  'https://www.gong.io/blog/do-execs-really-reply-to-cold-email-here-s-what-the-data-says': {
    // NO sample size, deliberately. The page states the finding without one, and
    // the figures in circulation (25M / 28M / 85M) attach to different Gong
    // studies — quoting any of them here would be citing a number this page does
    // not contain.
    //
    // The scope says REPLY rate and says it is not a click rate, because the other
    // research citation in this library IS a click rate. A writer who carries
    // Constant Contact's reasoning across to a cold email, or Gong's across to a
    // nurture email, has applied the right number to the wrong job — which is
    // exactly what naming the measured outcome prevents.
    scope: 'cold outreach reply rates, not marketing clicks',
    finding: 'Drops sharply past 100 words.',
  },
};

// Render-only citation links for hand-written spec_notes. Some notes end in a
// plain-text source credit like "(Litmus)"; this maps a note to the specific
// source page so fieldHint can hyperlink just the source WORD (same Phase-B
// range-link machinery as the tier-line platform name). This lives in the
// render layer only — it never touches spec_source, the seed, or the DB. Keyed
// on a DISTINCTIVE substring of the note (`match`) so the two Litmus notes each
// resolve to their own page; `name` is the exact word to hyperlink.
const NOTE_SOURCE_LINKS = [
  {
    match: 'Mobile inboxes cut around 40',
    name: 'Litmus',
    url: 'https://www.litmus.com/blog/how-to-write-the-perfect-subject-line-infographic',
  },
  {
    match: 'characters of preheader',
    name: 'Litmus',
    url: 'https://www.litmus.com/blog/the-ultimate-guide-to-preview-text-support',
  },
];

// THE HOUSE-DEFAULT SENTENCES. This is where a tenant finds out the number is
// theirs — deliberately here and not in an onboarding step. Onboarding is where
// people are lost, and a wall of spec fields in front of someone who has not yet
// seen the product work assumes they already have house numbers written down.
// They meet this at the moment they disagree with a number, which is when a
// setting actually gets adopted.
//
// Two forms, because the invitation is wrong once accepted: a tenant who has
// already set their own number does not need to be told to go and set it.
//
// EXPORTED, AND STRIPPED BACK OUT BEFORE DRAFTING (see parseDoc). Both sentences
// address the READER of the doc, not the writer of the copy — unlike the
// enforced/recommended lines, which are genuine constraints. Left in, they would
// reach Gemini as this field's `Field guidance:` on 144 seeded fields.
const HOUSE_DEFAULT_LINE = 'House default — set your own in Settings.';
const HOUSE_DEFAULT_LINE_SET = 'House default — yours, set in Settings.';
const HOUSE_DEFAULT_LINES = [HOUSE_DEFAULT_LINE, HOUSE_DEFAULT_LINE_SET];

// Remove the house-default sentence from a recovered italic line, leaving the
// tenant's own spec_note (which IS writing guidance and must survive).
//
// fieldHint space-joins note + tier, so the sentence is always a suffix — but
// this matches it anywhere and tidies the join, because a doc is a document:
// somebody will paste a note under it or reorder the line by hand, and a strip
// that only worked in one position would quietly start shipping the sentence to
// Gemini the first time that happened. Both wordings are matched, so a doc built
// before an override still strips after one.
function stripHouseDefaultLine(text) {
  let out = String(text == null ? '' : text);
  for (const line of HOUSE_DEFAULT_LINES) out = out.split(line).join(' ');
  return out.replace(/\s+/g, ' ').trim();
}

// Compose the spec_type tier sentence as { text, nameStart, nameLen } — or null
// when there is no tier line. nameStart/nameLen locate the platform-name sub-range
// WITHIN text (so Phase B can hyperlink just the name); nameStart is -1 when there
// is no recognized source (the no-source form names nothing). The "(name)" /
// "by name" clause only appears once a real spec_source resolves to a platform
// name (see specSourceName); until then enforced/recommended render without naming
// a source — so nothing bogus (e.g. 'quillio_default') is shown.
//
// house_default returns a line; NULL still returns none. That distinction is new
// and it is the point: NULL is what every TENANT-AUTHORED field carries
// (createAssetType never writes spec_type), and a custom field has no house
// default to go and set. scripts/migrateBackfillSeededSpecType.js exists to stop
// a long-lived tenant's bundled fields sitting on the wrong side of it.
function specTypeLine(specType, sourceName, detail, overridden) {
  if (specType === 'enforced') {
    if (sourceName) {
      const prefix = 'Platform limit (';
      return {
        text: `${prefix}${sourceName}). Stay within this count.`,
        nameStart: prefix.length,
        nameLen: sourceName.length,
      };
    }
    return { text: 'Platform limit. Stay within this count.', nameStart: -1, nameLen: 0 };
  }
  if (specType === 'recommended') {
    if (sourceName) {
      const prefix = 'Recommended by ';
      // A research source names its population and its finding; a platform source
      // has neither and falls through to the wording it has always produced.
      const scope = detail && detail.scope ? ` (${detail.scope})` : '';
      const tail = detail && detail.finding
        ? ` ${detail.finding}`
        : ' Not a hard limit — adjust for your brand and goal.';
      return {
        text: `${prefix}${sourceName}${scope}.${tail}`,
        nameStart: prefix.length,
        nameLen: sourceName.length,
      };
    }
    return {
      text: 'Recommended. Not a hard limit — adjust for your brand and goal.',
      nameStart: -1,
      nameLen: 0,
    };
  }
  if (specType === 'house_default') {
    // No source is named and nothing is hyperlinked — the authority is the
    // tenant, so nameStart stays -1 and fieldHint adds no link for this line.
    return {
      text: overridden ? HOUSE_DEFAULT_LINE_SET : HOUSE_DEFAULT_LINE,
      nameStart: -1,
      nameLen: 0,
    };
  }
  return null; // no tier (a tenant-authored field) → no tier line
}

// The italic grey guidance line under a field label, returned as { text, links }
// (or null when there's no line). `text` is the composed line — the hand-written
// spec_note (verbatim) then the spec_type tier sentence, space-joined. `links` is
// a list of { start, end, url } sub-ranges to hyperlink within `text` — currently
// just the platform name inside the tier line, pointing at the field's
// spec_source URL. `links` is empty when there's no recognized source (no-source
// form) or no tier line.
//
// The name offset is tracked structurally (specTypeLine reports nameStart, and we
// add the spec_note prefix + joining-space here) — never re-searched from the
// flat text. ONE paragraph, space-joined (not newline): b.fieldNote() emits a
// single paragraph and parseDoc treats any SECOND paragraph after a label as
// drafted copy (deleted on the first "Generate Draft"). The link is a sub-range
// within that one paragraph, so the notes-branch still consumes it whole.
function fieldHint(field) {
  const note = field && field.specNote != null ? String(field.specNote).trim() : '';
  const tier = field
    ? specTypeLine(
      field.specType,
      specSourceName(field.specSource),
      SPEC_SOURCE_DETAIL[field.specSource],
      field.specOverridden === true
    )
    : null;
  const parts = [note, tier && tier.text].filter(Boolean);
  if (!parts.length) return null;
  const text = parts.join(' ');
  const links = [];
  // Note-embedded citation (e.g. "(Litmus)"): the note is parts[0], so its
  // offsets map directly into `text` (base 0). Scan the NOTE ONLY, keyed on a
  // known match list — never the composed text or body copy, and never any
  // parenthesized word — then hyperlink just the source name. First match only.
  if (note) {
    for (const entry of NOTE_SOURCE_LINKS) {
      if (!note.includes(entry.match)) continue;
      const i = note.indexOf(entry.name);
      if (i < 0) continue;
      links.push({ start: i, end: i + entry.name.length, url: entry.url });
      break;
    }
  }
  if (tier && tier.nameStart >= 0) {
    const base = note ? note.length + 1 : 0; // spec_note prefix + the joining space
    const start = base + tier.nameStart;
    links.push({ start, end: start + tier.nameLen, url: String(field.specSource) });
  }
  return { text, links };
}

// Is this field's range counted in WORDS rather than characters? Accepts either the
// pipeline's `fieldType` or the raw `field_type` column, so a spec group and a
// database row both answer the same way.
function isWordField(field) {
  const t = field && (field.fieldType || field.field_type);
  return String(t || '') === 'words';
}
// The unit SUFFIX inside the bracket. This is not decoration — it is the only
// carrier of the unit through the document. There is no persisted doc state
// (CLAUDE.md): the draft, regenerate and review paths all reconstruct fields by
// re-parsing the Doc, so if the label did not say "words" the unit would be lost
// the moment the doc was written, and every downstream prompt would go back to
// telling the model to count characters.
const WORD_UNIT_SUFFIX = ' words';

function fieldLabel(field) {
  const min = Number(field.charMin) || 0;
  const max = Number(field.charMax) || 0;
  const unit = isWordField(field) ? WORD_UNIT_SUFFIX : '';
  if (min > 0 && max > 0) return `${field.fieldName} [${min}-${max}${unit}]`;
  if (max > 0) return `${field.fieldName} [${max}${unit}]`;
  return field.fieldName; // charMax === 0 → no bracket
}

// Strip the bits of markdown that render as literal characters in a Google Doc:
// **bold** / *italic* markers, leading # heading markers, and leading bullet
// symbols. Returns clean plain text. Applied at doc-write time only.
function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** -> bold
    .replace(/\*([^*]+)\*/g, '$1') // *italic* -> italic
    .replace(/^#{1,6}\s*/gm, '') // # heading markers
    .replace(/^\s*[-*•]\s+/gm, ' ') // leading bullet -> space
    .trim();
}

// Pull a Drive/Docs file or folder id out of a Google URL, or null.
function driveIdFromUrl(url) {
  if (!/(?:drive|docs)\.google\.com/.test(url)) return null;
  const m =
    url.match(/\/(?:d|folders)\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Resolve a reference URL to { url, label }. For Drive links, use the file's
// real name; otherwise (or on any failure) fall back to the raw URL.
async function resolveLinkLabel(drive, url) {
  const fileId = driveIdFromUrl(url);
  if (!fileId) return { url, label: url };
  try {
    const res = await drive.files.get({
      fileId,
      fields: 'name',
      supportsAllDrives: true,
    });
    return { url, label: res.data.name || url };
  } catch {
    return { url, label: url };
  }
}

// Appends the doc BODY (everything below the top header) onto `b`:
// Campaign Summary, Writer Direction, optional Reference Insights / Reference
// Materials, a horizontal rule, then one section per asset. Identical whether
// the header above it is today's default (title + HR) or a stored header schema,
// so the drafting pipeline still parses these sections the same way in both.
function appendBody(b, { summary, writerPrompt, resolvedLinks, referenceInsights, assetSpecs }) {
  b.heading('Campaign Summary');
  b.italic(stripMarkdown(summary) || '(no summary)');

  b.heading('Writer Direction');
  const wdLines = (stripMarkdown(writerPrompt) || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (wdLines.length === 0) {
    b.italic('(no direction)');
  } else {
    for (const line of wdLines) {
      // Pain Points renders as a label line + a disc bullet per pipe-separated
      // item. Every other field stays a plain prose line.
      const pp = line.match(/^pain points\s*:\s*(.*)$/i);
      if (pp) {
        b.italic('Pain Points:');
        const points = pp[1].split('|').map((p) => p.trim()).filter(Boolean);
        for (const p of points) b.bullet(p);
      } else {
        b.italic(line);
      }
    }
  }

  // Reference Insights — what was extracted per source. Omitted when empty.
  if (Array.isArray(referenceInsights) && referenceInsights.length > 0) {
    b.heading('Reference Insights');
    for (const ins of referenceInsights) {
      const source = String((ins && ins.source) || '').trim() || 'Unknown source';
      const type = String((ins && ins.type) || '').trim();
      b.italic(type ? `From: ${source} (${type})` : `From: ${source}`);

      const stats = Array.isArray(ins && ins.stats) ? ins.stats.filter(Boolean) : [];
      if (stats.length) {
        b.italic('Stats:');
        for (const s of stats) b.bullet(String(s).trim());
      }

      const keyMessages = Array.isArray(ins && ins.keyMessages) ? ins.keyMessages.filter(Boolean) : [];
      if (keyMessages.length) {
        b.italic('Key messages:');
        for (const m of keyMessages) b.bullet(String(m).trim());
      }

      b.blankLine();
    }
  }

  if (resolvedLinks.length > 0) {
    b.heading('Reference Materials');
    for (const { url, label } of resolvedLinks) {
      b.link(label, url);
    }
  }

  b.horizontalRule();

  // How many groups share each asset name — a name appearing once renders bare, so
  // every doc written before instances existed is byte-identical.
  const instanceTotals = new Map();
  for (const asset of assetSpecs) {
    const key = normalize(asset.assetType);
    instanceTotals.set(key, (instanceTotals.get(key) || 0) + 1);
  }

  for (const asset of assetSpecs) {
    b.assetHeading(
      assetHeadingText(
        asset.assetType,
        asset.instance,
        asset.instanceLabel,
        instanceTotals.get(normalize(asset.assetType))
      )
    );
    // Asset-level creative direction (from Postgres) — one italic line directly
    // under the heading. Falls back to the Sheet's channel · tone meta when no
    // direction is set; omitted entirely when both are empty.
    const direction = String(asset.asset_direction || '').trim();
    const meta = [asset.channel, asset.toneNotes].filter(Boolean).join(' · ');
    const headerLine = direction || meta;
    if (headerLine) b.italic(headerLine);
    // Fields render top-to-bottom. Consecutive fields sharing a group_label
    // (e.g. "Graphic Copy") emit that sub-heading once, then render indented so
    // the on-graphic copy reads as one nested unit.
    let openGroup = null;
    for (const field of asset.fields) {
      const group = field.groupLabel || null;
      if (group !== openGroup) {
        if (group) b.groupLabel(group);
        openGroup = group;
      }
      const indent = group ? GROUP_INDENT_PT : 0;
      b.boldLabel(fieldLabel(field), { indent });
      const hint = fieldHint(field);
      if (hint) b.fieldNote(hint.text, { indent, links: hint.links });
      b.blankLine({ indent });
    }
  }
}

// Creates the formatted Google Doc in the target Drive folder.
// `assetSpecs` is the grouped asset library from Postgres (pipeline's
// tenantAssetsToSpecs). `folderId` overrides the default folder when present;
// `referenceLinks` adds a Reference Materials section. `headerSchema` (optional,
// resolved per-tenant in the pipeline) renders a custom top-of-doc metadata
// header via DocBuilder.renderHeader(); when absent/invalid the doc uses today's
// exact default header (title + HR) unchanged. Returns { id, url, title }.
async function createDocument({
  brief,
  campaignTitle,
  summary,
  writerPrompt,
  assetSpecs,
  folderId,
  referenceLinks = [],
  referenceInsights = [],
  headerSchema = null,
  namingPattern = null,
  namingContext = null,
  clients,
}) {
  logMemory(`createDocument start — ${assetSpecs.length} asset(s), ${referenceLinks.length} link(s)`);
  // Diagnostic (counts only, never content): a missing Reference Materials /
  // Reference Insights section traces back to one of these being 0 here.
  console.log(
    `[googleDocs] createDocument references → links=${(referenceLinks || []).length} insights=${(referenceInsights || []).length}`
  );
  const activeClients = clients || (await getClients());
  const { drive, docs } = activeClients;
  const title = makeTitle(brief, campaignTitle, namingPattern, namingContext);
  console.log(`[googleDocs] doc name: ${isValidNamingPattern(namingPattern) ? 'tenant pattern' : 'default'}`);

  // Same placement rule as the project folder: explicit folder wins; otherwise an
  // OAuth user's doc lands in their My Drive root (parents omitted), and only the
  // quota-less service account falls back to config.DRIVE_FOLDER_ID.
  const parentFolder = folderId || (activeClients.usingOAuth ? null : config.DRIVE_FOLDER_ID);
  const created = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
      ...(parentFolder ? { parents: [parentFolder] } : {}),
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  const docId = created.data.id;

  // Resolve reference link labels (Drive file names where possible) up front.
  const resolvedLinks = [];
  for (const url of referenceLinks) {
    resolvedLinks.push(await resolveLinkLabel(drive, url));
  }

  const bodyFields = { summary, writerPrompt, resolvedLinks, referenceInsights, assetSpecs };
  const useSchema = isValidHeaderSchema(headerSchema);
  console.log(`[googleDocs] doc header: ${useSchema ? 'tenant schema' : 'default (title + HR)'}`);

  // Build the header. With a stored schema, DocBuilder.renderHeader() lays out its
  // blocks; otherwise the default is today's exact header (title + HR) — byte-for-
  // byte unchanged for existing tenants (the critical safety property).
  const b = new DocBuilder();
  if (useSchema) {
    b.renderHeader(headerSchema);
  } else {
    b.title(title);
    b.horizontalRule();
  }

  if (b.hasHeaderTable()) {
    // Two-phase table header (a Docs table can't be built in one batchUpdate —
    // see docHeaderTable.js). Insert the table, re-read to locate/fill it, then
    // render the body BELOW it starting at the table's post-fill end index.
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.headerTableInsertRequests() },
    });

    let reread = (await docs.documents.get({ documentId: docId })).data;
    let tableEl = findHeaderTable(reread);
    if (!tableEl) throw new Error('header table not found after insert');
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.headerTableFillRequests(tableEl) },
    });

    reread = (await docs.documents.get({ documentId: docId })).data;
    tableEl = findHeaderTable(reread);
    const body = new DocBuilder(tableEl.endIndex);
    appendBody(body, bodyFields);
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: body.buildRequests() },
    });
  } else {
    // No table anywhere — header + body fold into a single batchUpdate.
    appendBody(b, bodyFields);
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.buildRequests() },
    });
  }

  // webViewLink is REQUESTED, not guaranteed. A files.create response that omits
  // it used to end here as `url: undefined`, which generateDoc records as
  // projects.copy_doc_url = null — an id pointing at a real document in Drive
  // that the row cannot link to. createFromTemplate has always defended against
  // this on the same API call; the copy doc had no reason to be the exception.
  // The link is derivable from the id, so there is nothing to lose by deriving it.
  const url = created.data.webViewLink || `https://docs.google.com/document/d/${docId}/edit`;
  return { id: docId, url, title };
}

// --- Draft generation (stateless: re-parses the doc) ---

function runStyle(paragraph) {
  const el = (paragraph.elements || []).find(
    (e) => e.textRun && e.textRun.content && e.textRun.content.trim()
  );
  const ts = el?.textRun?.textStyle || {};
  return { bold: !!ts.bold, italic: !!ts.italic };
}

function paragraphText(paragraph) {
  return (paragraph.elements || [])
    .map((e) => (e.textRun ? e.textRun.content : ''))
    .join('')
    .replace(/\n+$/, '');
}

// Walks the document and reconstructs the campaign context needed to draft copy.
function parseDoc(doc) {
  const summary = { value: '' };
  const writer = { value: '' };
  const assets = [];
  let current = null;
  let currentField = null; // last field whose copy region we're scanning
  let notesSeen = false; // whether the current field's italic notes line was seen
  let expecting = null; // 'summary' | 'writerPrompt'
  const assetOrdinal = instanceCounter(); // per-heading-text instance ordinals
  // Which HEADING_3s are instance-suffixed (needs every heading, hence a pre-pass).
  const instanceHeadings = instanceHeadingMap(assetHeadingTexts(doc));

  for (const item of doc.body.content || []) {
    if (!item.paragraph) continue;
    const p = item.paragraph;
    const named = p.paragraphStyle?.namedStyleType;
    const text = paragraphText(p).trim();
    const { bold, italic } = runStyle(p);

    if (named === 'HEADING_2' && text === 'Campaign Summary') {
      expecting = 'summary';
      continue;
    }
    if (named === 'HEADING_2' && text === 'Writer Direction') {
      expecting = 'writerPrompt';
      continue;
    }
    if (expecting === 'summary') {
      if (text) {
        summary.value = text;
        expecting = null;
      }
      continue;
    }
    if (expecting === 'writerPrompt') {
      if (text) {
        writer.value = text;
        expecting = null;
      }
      continue;
    }

    if (named === 'HEADING_3') {
      // `assetType` is always the LIBRARY name, never the rendered heading: an
      // instance-suffixed heading is decomposed back so downstream lookups
      // (asset_direction, craft slicing, the tenant library) keep matching on the
      // real name. `instance` is 0-based — from the heading's own ordinal when it
      // carries one, else counted positionally over repeated heading text (a
      // hand-pasted duplicate section, which has no suffix to read).
      const parts = instanceHeadings.get(text);
      current = parts
        ? { assetType: parts.assetType, instance: parts.instance, instanceLabel: parts.instanceLabel,
            channel: '', toneNotes: '', fields: [], gotMeta: false }
        : { assetType: text, instance: assetOrdinal(text), instanceLabel: null,
            channel: '', toneNotes: '', fields: [], gotMeta: false };
      assets.push(current);
      currentField = null; // a new asset ends the previous field's copy region
      notesSeen = false;
      continue;
    }

    // A group sub-heading (e.g. "Graphic Copy", rendered HEADING_4) is a layout
    // label, not a field — skip it. It ends the previous field's copy region so
    // the heading is never mistaken for drafted copy.
    if (named === 'HEADING_4') {
      currentField = null;
      notesSeen = false;
      continue;
    }

    // Riff batch header (Variations Matrix, Step 3) — a faint HEADING_6 divider
    // above an appended variation batch ("Riff 1", "Riff 2", …). The named-style
    // check fires BEFORE the bold-label and copy branches below, so the header is
    // structurally NEVER read as a field label or a copy option (the guard is the
    // paragraph style, not its text). It deliberately does NOT reset currentField:
    // the field's copy region spans it, so a destructive Regenerate's single
    // [insertIndex, deleteEnd] range still covers the whole stack, headers
    // included. Record the batch number so a re-riff computes max+1 — gap-safe
    // (if a middle batch was deleted, max+1 still can't collide with a survivor,
    // where counting headers would).
    if (named === 'HEADING_6') {
      const rm = text.match(/^Riff\s+(\d+)/i);
      if (currentField && rm) {
        currentField.maxRiffN = Math.max(currentField.maxRiffN || 0, Number(rm[1]));
      }
      continue;
    }

    if (current && !current.gotMeta && current.fields.length === 0 && italic && text) {
      const parts = text.split('·').map((s) => s.trim());
      current.channel = parts[0] || '';
      current.toneNotes = parts.slice(1).join(' · ');
      current.gotMeta = true;
      continue;
    }

    // A field label is a bold paragraph, optionally ending in a [min-max] /
    // [max] bracket (no bracket when charMax was 0). Recover charMin/charMax.
    if (current && bold && text) {
      const m = text.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
      const fieldName = m ? m[1].trim() : text;
      const bracket = m ? m[2] : '';
      const nums = bracket.match(/\d+/g);
      // The unit rides in the bracket ("[50-125 words]") because nothing about a
      // field is persisted — see WORD_UNIT_SUFFIX. Reading it back here is what
      // keeps the drafter and the reviewer counting the same thing the writer sees.
      const fieldType = /\bwords?\b/i.test(bracket) ? 'words' : 'text';
      let charMin = 0;
      let charMax = 0;
      if (nums) {
        const vals = nums.map(Number);
        charMax = Math.max(...vals);
        if (vals.length >= 2) charMin = Math.min(...vals);
      }
      currentField = {
        fieldName,
        charMin,
        charMax,
        fieldType,
        // The blank paragraph immediately after the label starts where this
        // label paragraph ends; that's our draft insertion point (moved past the
        // notes line below when one is present).
        insertIndex: item.endIndex,
        // End of the last non-empty paragraph of already-drafted copy under this
        // label (null = nothing drafted yet). Drives delete-before-insert on
        // regeneration; stays null for a first draft so that path is untouched.
        deleteEnd: null,
        notes: '',
        // Highest "Riff N" batch number seen under this field (0 = none). Drives
        // the next append batch's number (max+1). Set by the HEADING_6 branch.
        maxRiffN: 0,
      };
      current.fields.push(currentField);
      notesSeen = false;
      continue;
    }

    // Per-field writing guidance: the italic paragraph right after a label,
    // before any drafted copy (which is always inserted non-italic). It's
    // permanent guidance — never copy, never deleted. Copy goes BELOW it, so
    // advance the insertion point past the notes line.
    if (current && currentField && currentField.deleteEnd == null && !notesSeen && italic && text) {
      notesSeen = true;
      // STRIPPED, not stored raw. `notes` is prompt input and nothing else — it
      // becomes this field's `Field guidance:` (services/gemini.js
      // fieldGuidanceFor). The house-default sentence is the one part of the
      // italic line addressed to the TENANT rather than to the writer: "set your
      // own in Settings" is not a fact about how to write the copy, and on 144
      // seeded fields it would be the only guidance most of them carry.
      //
      // Stripped HERE, in the same module that composes it, so there is no
      // string shared across a module boundary and no import for gemini.js to
      // grow (it is already required by this file — the other direction would be
      // a cycle). The doc still shows the line; the drafter never sees it.
      currentField.notes = stripHouseDefaultLine(text);
      currentField.insertIndex = item.endIndex;
      continue;
    }

    // Any other non-empty paragraph under an active field is previously drafted
    // copy. Advance deleteEnd to this paragraph's end; trailing blank lines have
    // empty text and never reach here, so the template blank is preserved.
    if (current && currentField && text) {
      currentField.deleteEnd = item.endIndex;
      continue;
    }
  }

  return { summary: summary.value, writerPrompt: writer.value, assets };
}

// Lookup key for matching a doc field back to its Sheet row.
//
// `instance` is the asset's 0-based instance ordinal, for a doc carrying the same
// asset more than once. It defaults to 0, which serializes to nothing at all —
// `ctxKey(a, f)` and `ctxKey(a, f, 0)` are byte-identical to each other and to
// the pre-instance key (see utils/instanceKey.js for why that matters).
function ctxKey(assetType, fieldName, instance) {
  return `${String(assetType).trim().toLowerCase()}${instanceTag(instance)}|${String(fieldName).trim().toLowerCase()}`;
}

// Normalize a scoped field's variation controls into one of two shapes:
//   { matrix: [{ doorway, intensity, count }] }  — Variations Matrix (Step 3):
//       explicit per-angle rows. Angle must be a known doorway; count capped 1–5;
//       intensity a known Safe/Bold/Wild (default Safe). Invalid rows are dropped.
//   { count, distance }                          — legacy Phase 2/3 controls.
// A valid matrix WINS (assignDoorways is bypassed downstream). This is the single
// place matrix input is validated, so the route can pass rows through loosely.
function normalizeVarControls(t) {
  const rows = Array.isArray(t.variations) ? t.variations : null;
  if (rows && rows.length) {
    const matrix = [];
    for (const r of rows) {
      const angle = r && ANGLE_NAMES.has(String(r.angle)) ? String(r.angle) : null;
      if (!angle) continue;
      const count = Math.max(1, Math.min(10, Number(r.count) || 1));
      const intensity = r && INTENSITY_NAMES.has(String(r.intensity)) ? String(r.intensity) : 'Safe';
      matrix.push({ doorway: angle, intensity, count });
    }
    if (matrix.length) return { matrix };
  }
  return {
    count: Math.max(1, Math.min(4, Number(t.count) || 1)),
    distance: t.distance === 'explore' || t.distance === 'wide' ? t.distance : 'close',
  };
}

// Assemble N variations into the single copy block inserted under a field label.
// Two independent markers: a NUMBER appears iff there's more than one option (a
// stack to resolve between); a (Doorway) LABEL appears iff a non-'close' distance
// was chosen (a meaningful door to name). So:
//   close  ×1  → `copy`                     (bare — identical to a Phase-1 draft)
//   wide   ×1  → `(Reframe) copy`           (labeled, no number — already resolved)
//   close  ×N  → `1. copy` / `2. copy`      (numbered, one obvious door, no labels)
//   wide   ×N  → `1. (Pain) copy` / `2. …`  (numbered + labeled stack)
// Inserted bold:false/italic:false by the caller, so markers parse as copy — not
// labels or notes. Long fields separate stacked options with a blank line.
//
// `startIndex` (append writes only): when given, the block is FORCE-numbered from
// that base — even a single option gets its number, so an appended batch always
// reads as a numbered group. Omitted → today's behavior exactly (numbered iff the
// batch has >1 option, base 1).
function buildVariantBlock(variations, { distance, charMax, fieldType, startIndex, labeled } = {}) {
  const list = (variations || []).filter((v) => v && String(v.copy || '').trim());
  if (list.length === 0) return '';
  const numbered = startIndex != null ? true : list.length > 1;
  const base = startIndex != null ? startIndex : 1;
  // `labeled` (Step 3) forces the (Doorway) tag on regardless of distance — the
  // append/matrix path always labels so every riffed option carries its angle.
  // When omitted, fall back to the legacy rule (label iff a non-'close' distance).
  const labelOn = labeled != null ? labeled : Boolean(distance && distance !== 'close');
  // Layout heuristic: short fields (headlines, CTAs) stack on one line each; long
  // ones get their own block. 120 is a CHARACTER threshold — a 125-WORD body field
  // would sail under it and be laid out as if it were a headline, so a word field is
  // always long. (No word field is short: the smallest band here is 25 words.)
  const longField = fieldType === 'words' || !(Number(charMax) > 0 && Number(charMax) <= 120);
  const lines = list.map((v, i) => {
    let prefix = '';
    if (numbered) prefix += `${base + i}. `;
    if (labelOn && v.doorway) prefix += `(${v.doorway}) `;
    return prefix + String(v.copy).trim();
  });
  return lines.join(numbered && longField ? '\n\n' : '\n');
}

// Reads the doc, drafts copy for every field via Gemini, and inserts it under
// each label. Returns { title, fieldCount }.
// `brief` is the client's own words off the project row (pipeline.generateDraft).
// Null for a pre-migration project, a doc with no project row, or no tenant — and
// null is the whole degradation: gemini's briefBlock emits nothing and the prompt
// is what it was before. The doc is still the source for summary and writerPrompt;
// this is the ONE value that could not live there (see
// scripts/migrateAddProjectBriefRaw.js for why not).
async function generateDraft(id, direction, clients, voiceGuide, lookupDirection, scopedFields, append, brief) {
  const { docs } = clients || (await getClients());

  const doc = (await docs.documents.get({ documentId: id })).data;
  const { summary, writerPrompt, assets } = parseDoc(doc);

  // SCOPED generation/regeneration: when `scopedFields` (a list of {assetType,
  // fieldName}) is present, draft ONLY those fields. Everything else — header,
  // other assets, and unselected fields — never enters the delete/insert lists,
  // so no deleteContentRange, insertText, or updateTextStyle touches them and
  // they stay BYTE-IDENTICAL. Absent/empty → whole-doc behavior, exactly as
  // before (backward-compatible). Matching is case-insensitive via ctxKey.
  // (Named scopedFields, not `targets`, to avoid colliding with `assetTargets`.)
  const scopeKeys =
    Array.isArray(scopedFields) && scopedFields.length > 0
      ? new Set(scopedFields.map((t) => ctxKey(t.assetType, t.fieldName, t.instance)))
      : null;

  // ADDITIVE (append) write — Variations Matrix Step 1. When `append` is set on a
  // SCOPED call, each selected field's new batch is inserted BELOW its current
  // copy (numbered from 1) and NOTHING is deleted. The no-delete guarantee is in
  // the data: append fields are pushed with deleteEnd:null, so they can't enter
  // the deletions filter below. Append is scoped-only (whole-doc append is not a
  // Step-1 concern); a stray append without scope degrades to normal behavior.
  const appendMode = !!(append && scopeKeys);
  if (append && !scopeKeys) {
    console.warn('[googleDocs] append requested without scopedFields — ignoring (whole-doc runs normally)');
  }

  // Per-field variation controls (Phase 2/3): count (how many options) and
  // distance (which doorways are eligible). Absent → count 1 / 'close', which
  // routes to the unchanged Phase-1 per-field path. Keyed by ctxKey.
  const scopeMeta = new Map();
  if (scopeKeys) {
    for (const t of scopedFields) {
      scopeMeta.set(ctxKey(t.assetType, t.fieldName, t.instance), normalizeVarControls(t));
    }
  }

  // Build per-asset draft targets straight from the doc. The Google Sheet has
  // been retired — per-field Notes / Funnel Stage / channel / tone no longer
  // feed the prompt; asset-level direction (from Postgres) carries the creative
  // guidance, and the doc carries field labels + char limits + positions.
  //
  // The instance ordinal is taken from parseDoc, which stamps it per HEADING_3 in
  // document order. Reading it (rather than re-counting here) is what makes it
  // agree with the post-delete re-parse below — no loop has to be careful to
  // count the same headings, because there is one ordinal per parsed entry.
  const assetTargets = assets
    .filter((asset) => asset.fields.length > 0)
    .map((asset) => ({
      assetType: asset.assetType,
      instance: asset.instance,
      assetDirection: lookupDirection ? lookupDirection(asset.assetType) : null,
      fields: asset.fields.map((field) => ({
        fieldName: field.fieldName,
        charMax: field.charMax || 0,
        charMin: field.charMin || 0,
        // Unit, recovered from the label bracket by parseDoc. Without it the draft
        // prompt tells the model "Character limit: 125" for a 125-WORD field.
        fieldType: field.fieldType === 'words' ? 'words' : 'text',
        insertIndex: field.insertIndex,
        deleteEnd: field.deleteEnd,
        // Highest existing "Riff N" batch number under this field (append uses +1).
        maxRiffN: field.maxRiffN || 0,
      })),
    }))
    // Scoped: drop assets with no selected field so we don't even iterate them.
    .filter((a) => !scopeKeys || a.fields.some((f) => scopeKeys.has(ctxKey(a.assetType, f.fieldName, a.instance))));

  // Scoped drafts per field (not the cohesive whole-asset batch), so read the
  // current copy of every field once to feed each field its siblings' copy as
  // context (cohesion recovery). Best-effort — a read failure just omits siblings.
  let copyByKey = null;
  if (scopeKeys) {
    try {
      const content = await getDocContent(id, clients);
      copyByKey = new Map();
      // getDocContent stamps the same per-HEADING_3 ordinal parseDoc does, so
      // these keys line up with assetTargets' without a second count.
      for (const a of content.assets || []) {
        for (const f of a.fields || []) copyByKey.set(ctxKey(a.name, f.fieldName, a.instance), String(f.copy || ''));
      }
    } catch (err) {
      console.warn('[googleDocs] scoped sibling-copy read failed (continuing without):', err.message);
      copyByKey = new Map();
    }
  }

  // Draft each asset's fields together (one batched call per asset) so the copy
  // is cohesive. Assets run with bounded concurrency; one asset failing is
  // logged and skipped rather than aborting the whole run.
  const total = assetTargets.length;
  logMemory(`generateDraft start — ${total} asset(s), concurrency ${DRAFT_CONCURRENCY}${scopeKeys ? ', scoped' : ''}`);

  const perAsset = await mapWithConcurrency(assetTargets, DRAFT_CONCURRENCY, async (a, idx) => {
    const fieldsToDraft = scopeKeys
      ? a.fields.filter((f) => scopeKeys.has(ctxKey(a.assetType, f.fieldName, a.instance)))
      : a.fields;
    if (fieldsToDraft.length === 0) return [];
    console.log(`[googleDocs] generating asset ${idx + 1}/${total}: ${a.assetType} (${fieldsToDraft.length} field(s))`);
    try {
      let drafts;
      if (scopeKeys) {
        // Per-field generation with sibling context — each selected field sees the
        // current copy of its siblings so scoped copy still hangs together.
        drafts = [];
        for (const f of fieldsToDraft) {
          const siblings = a.fields
            .filter((s) => s.fieldName !== f.fieldName)
            .map((s) => ({ fieldName: s.fieldName, copy: (copyByKey.get(ctxKey(a.assetType, s.fieldName, a.instance)) || '').trim() }))
            .filter((s) => s.copy);
          const meta = scopeMeta.get(ctxKey(a.assetType, f.fieldName, a.instance)) || { count: 1, distance: 'close' };
          const hasMatrix = Array.isArray(meta.matrix) && meta.matrix.length > 0;
          const wantsVariations = hasMatrix || meta.count > 1 || meta.distance !== 'close';
          try {
            // Produce the option list (reuse existing generators — no new prompt work).
            let variations;
            if (wantsVariations) {
              // Matrix path (Step 3): expand each row into `count` explicit
              // {doorway, intensity} entries and generate against them directly
              // (assignDoorways bypassed). Legacy path: distance + count.
              let genArgs;
              if (hasMatrix) {
                const rows = [];
                for (const m of meta.matrix) {
                  for (let k = 0; k < m.count; k++) rows.push({ doorway: m.doorway, intensity: m.intensity });
                }
                genArgs = { rows };
              } else {
                genArgs = { distance: meta.distance, count: meta.count };
              }
              variations = await generateFieldVariations({
                assetType: a.assetType,
                fieldName: f.fieldName,
                charMax: f.charMax,
                charMin: f.charMin,
                fieldType: f.fieldType,
                assetDirection: a.assetDirection,
                summary,
                writerPrompt,
                direction,
                voiceGuide,
                ...genArgs,
                currentCopy: copyByKey.get(ctxKey(a.assetType, f.fieldName, a.instance)) || '',
                siblings,
              });
            } else {
              // Phase-1 path: one bare draft, count 1 / Stay close.
              const c = await generateFieldDraft({
                assetType: a.assetType,
                brief,
                fieldName: f.fieldName,
                charMax: f.charMax,
                charMin: f.charMin,
                fieldType: f.fieldType,
                assetDirection: a.assetDirection,
                summary,
                writerPrompt,
                direction,
                voiceGuide,
                siblings,
              });
              variations = c ? [{ doorway: null, copy: c }] : [];
            }

            if (appendMode) {
              // ADDITIVE write: number the batch from 1, ALWAYS label each option
              // with its (Doorway), and insert it BELOW the field's current copy
              // (at deleteEnd — the end of the last existing copy paragraph, or
              // insertIndex when the field is empty). deleteEnd is set to null so
              // this field cannot enter the deletions list — existing copy is
              // never touched. The batch is prefaced by a faint "Riff N" header in
              // Phase 2; N = the field's highest existing Riff batch + 1 (max+1).
              const block = buildVariantBlock(variations, { charMax: f.charMax, fieldType: f.fieldType, startIndex: 1, labeled: true });
              const insertAt = f.deleteEnd != null ? f.deleteEnd : f.insertIndex;
              if (block && insertAt != null) {
                const riffN = (f.maxRiffN || 0) + 1;
                drafts.push({ fieldName: f.fieldName, copy: block, insertIndex: insertAt, deleteEnd: null, riffN });
              }
            } else {
              // Destructive-replace path (unchanged): buildVariantBlock with no
              // startIndex is byte-identical to before (bare for count-1/close).
              const copy = buildVariantBlock(variations, { distance: meta.distance, charMax: f.charMax, fieldType: f.fieldType });
              if (copy) drafts.push({ fieldName: f.fieldName, copy });
            }
          } catch (err) {
            console.warn(`[googleDocs] scoped field failed ${a.assetType}/${f.fieldName}: ${err.message}`);
          }
        }
      } else {
        drafts = await generateAssetDrafts({
          assetType: a.assetType,
          brief,
          assetDirection: a.assetDirection,
          summary,
          writerPrompt,
          fields: a.fields,
          direction,
          voiceGuide,
        });
      }
      const metaByName = new Map(
        a.fields.map((f) => [f.fieldName, { insertIndex: f.insertIndex, deleteEnd: f.deleteEnd }])
      );
      const mapped = drafts
        .map((d) => {
          const meta = metaByName.get(d.fieldName) || {};
          // Append items carry their own insertIndex (= deleteEnd position) and an
          // explicit deleteEnd:null; everything else uses the parsed field meta.
          return {
            assetType: a.assetType,
            instance: a.instance,
            fieldName: d.fieldName,
            insertIndex: d.insertIndex != null ? d.insertIndex : meta.insertIndex,
            deleteEnd: Object.prototype.hasOwnProperty.call(d, 'deleteEnd') ? d.deleteEnd : meta.deleteEnd,
            copy: d.copy,
            // Append batches carry their Riff header number (undefined otherwise).
            riffN: d.riffN,
          };
        })
        .filter((r) => r.insertIndex != null && r.copy);
      console.log(`[googleDocs] asset ${idx + 1}/${total} done: ${a.assetType} (${mapped.length} fields)`);
      return mapped;
    } catch (err) {
      console.error(
        `[googleDocs] asset ${idx + 1}/${total} FAILED: ${a.assetType}: ${err.message}`
      );
      return [];
    }
  });
  logMemory(`generateDraft end — ${total} asset(s)`);

  const drafted = perAsset.flat();

  const totalFields = assetTargets.reduce((n, a) => n + a.fields.length, 0);
  if (totalFields > 0 && drafted.length === 0) {
    throw new Error('All field drafts failed (Gemini timeout or error).');
  }

  // Regeneration is done in two phases so deletes and inserts never share a
  // batch (interleaving them makes indices very hard to reason about and is the
  // source of jumbled copy / cut labels). Phase 1 removes all previously drafted
  // copy; we then RE-PARSE the now-clean doc so the inserts use indices that
  // reflect its real current state, regardless of how long the old copy was.
  //
  // First drafts have no existing copy (deleteEnd == null everywhere), so Phase
  // 1 and the re-parse are skipped — inserts run against the original parse,
  // identical to the previous behavior.

  // Phase 1 — delete existing copy, bottom-to-top (reverse-order deletes are
  // index-safe: a deletion at a higher index never shifts lower indices).
  const deletions = drafted
    .filter((d) => d.deleteEnd != null && d.deleteEnd > d.insertIndex)
    .sort((a, b) => b.insertIndex - a.insertIndex);

  let insertIndexByField = null;
  if (deletions.length > 0) {
    await docs.documents.batchUpdate({
      documentId: id,
      requestBody: {
        requests: deletions.map((d) => ({
          deleteContentRange: { range: { startIndex: d.insertIndex, endIndex: d.deleteEnd } },
        })),
      },
    });

    // Re-parse the cleaned doc to recover fresh, correct insertion indices.
    //
    // Keyed WITH parseDoc's stamped instance ordinal. Entries have always been
    // pushed one per HEADING_3 with no dedupe, so a doc carrying the same asset
    // heading twice (today only reachable by hand-editing — pasting an asset
    // section) used to collapse here: the second occurrence's indices overwrote
    // the first's, and every drafted field for BOTH headings then resolved to the
    // second one's positions, so instance 1's copy landed inside instance 2.
    // The ordinals match the original parse's because the delete pass removed copy
    // paragraphs only — never a heading — so this re-parse sees the same headings
    // in the same order.
    const freshDoc = (await docs.documents.get({ documentId: id })).data;
    const fresh = parseDoc(freshDoc);
    insertIndexByField = new Map();
    for (const asset of fresh.assets) {
      for (const f of asset.fields) {
        // Two fields sharing a name WITHIN one instance still last-wins, matching
        // metaByName above; only the cross-instance collapse is fixed here.
        insertIndexByField.set(ctxKey(asset.assetType, f.fieldName, asset.instance), f.insertIndex);
      }
    }
  }

  // Resolve each drafted field's insertion index: the re-parsed value after a
  // delete pass, otherwise the original parse (first draft). Drop any field we
  // can't place (shouldn't happen, but never insert at a stale/unknown index).
  const inserts = drafted
    .map((d) => {
      const idx = insertIndexByField
        ? insertIndexByField.get(ctxKey(d.assetType, d.fieldName, d.instance))
        : d.insertIndex;
      return idx != null ? { insertIndex: idx, copy: d.copy, riffN: d.riffN } : null;
    })
    .filter(Boolean)
    // Bottom-to-top so each insert doesn't shift the indices of the ones above.
    .sort((a, b) => b.insertIndex - a.insertIndex);

  // Phase 2 — insert the new copy under each label (regular weight, not the
  // bold label style). Inserts run bottom-to-top (highest index first), so each
  // insert's absolute index stays valid until it's applied.
  //
  // Append batches (riffN set) are prefaced by a faint "Riff N" HEADING_6 header.
  // HEADING_6 is the structural marker parseDoc/getDocContent key off to exclude
  // the divider from copy — cosmetic faint styling is layered on top and does not
  // affect parsing. The header range stops BEFORE its newline so the paragraph
  // style lands only on the header; the block range is forced to NORMAL_TEXT so
  // it can't inherit the heading style.
  const requests = [];
  for (const { insertIndex, copy, riffN } of inserts) {
    if (riffN != null) {
      const header = `Riff ${riffN}`;
      requests.push({ insertText: { location: { index: insertIndex }, text: `${header}\n${copy}\n` } });
      const headerEnd = insertIndex + header.length;
      const blockStart = headerEnd + 1; // past the header's newline
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: insertIndex, endIndex: headerEnd },
          paragraphStyle: { namedStyleType: 'HEADING_6' },
          fields: 'namedStyleType',
        },
      });
      requests.push({
        updateTextStyle: {
          range: { startIndex: insertIndex, endIndex: headerEnd },
          textStyle: {
            bold: false,
            italic: true,
            fontSize: { magnitude: 8, unit: 'PT' },
            foregroundColor: { color: { rgbColor: { red: 0.6, green: 0.63, blue: 0.65 } } },
          },
          fields: 'bold,italic,fontSize,foregroundColor',
        },
      });
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: blockStart, endIndex: blockStart + copy.length },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      });
      requests.push({
        updateTextStyle: {
          range: { startIndex: blockStart, endIndex: blockStart + copy.length },
          textStyle: { bold: false, italic: false },
          fields: 'bold,italic',
        },
      });
      continue;
    }
    requests.push({ insertText: { location: { index: insertIndex }, text: copy + '\n' } });
    requests.push({
      updateTextStyle: {
        range: { startIndex: insertIndex, endIndex: insertIndex + copy.length },
        textStyle: { bold: false, italic: false },
        fields: 'bold,italic',
      },
    });
  }

  if (requests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: id,
      requestBody: { requests },
    });
  }

  return {
    title: doc.title,
    fieldCount: inserts.length,
    url: `https://docs.google.com/document/d/${id}/edit`,
  };
}

// Read a doc back into a structured, copy-bearing shape for the web project
// view. Unlike parseDoc (which recovers field *positions* for drafting), this
// also captures the per-field italic notes + drafted copy under each label: the
// plain paragraphs that follow a bold field label, up to the next label /
// heading. Returns
//   { summary, writerDirection, assets: [{ name, instance, instanceLabel,
//     fields: [{ fieldName, charMin, charMax, notes, copy }] }] }
// `name` is the LIBRARY asset name even when the heading carries an instance
// suffix ('Demand Gen Nurture Email 2 — Downtown residents' → name 'Demand Gen
// Nurture Email', instance 1, instanceLabel 'Downtown residents').
// Throws if the doc can't be read so the caller can surface the fallback.
async function getDocContent(id, clients) {
  const { docs } = clients || (await getClients());
  const doc = (await docs.documents.get({ documentId: id })).data;

  const result = { title: doc.title || '', summary: '', writerDirection: '', assets: [] };
  let current = null; // current asset block
  let field = null; // current field collecting copy
  let expecting = null; // 'summary' | 'writerDirection'
  const assetOrdinal = instanceCounter(); // per-heading-text instance ordinals
  const instanceHeadings = instanceHeadingMap(assetHeadingTexts(doc)); // same pre-pass as parseDoc

  for (const item of doc.body.content || []) {
    if (!item.paragraph) continue;
    const p = item.paragraph;
    const named = p.paragraphStyle?.namedStyleType;
    const text = paragraphText(p).trim();
    const { bold, italic } = runStyle(p);

    if (named === 'HEADING_2' && text === 'Campaign Summary') {
      expecting = 'summary';
      field = null;
      continue;
    }
    if (named === 'HEADING_2' && text === 'Writer Direction') {
      expecting = 'writerDirection';
      field = null;
      continue;
    }
    if (expecting === 'summary') {
      if (text) {
        result.summary = text;
        expecting = null;
      }
      continue;
    }
    if (expecting === 'writerDirection') {
      if (text) {
        result.writerDirection = text;
        expecting = null;
      }
      continue;
    }

    if (named === 'HEADING_3') {
      // Same decomposition + 0-based ordinal parseDoc does (see there): `name` is
      // the LIBRARY name even when the heading carries an instance suffix.
      const parts = instanceHeadings.get(text);
      current = parts
        ? { name: parts.assetType, instance: parts.instance, instanceLabel: parts.instanceLabel,
            asset_direction: '', fields: [] }
        : { name: text, instance: assetOrdinal(text), instanceLabel: null, asset_direction: '', fields: [] };
      result.assets.push(current);
      field = null;
      continue;
    }

    // A group sub-heading (e.g. "Graphic Copy", HEADING_4) is a layout label, not
    // a field — skip it and end the previous field's copy region.
    if (named === 'HEADING_4') {
      field = null;
      continue;
    }

    // Riff batch header (Step 3) — structural divider, never copy. Skip it WITHOUT
    // ending the field, so the batch options below it still accumulate into this
    // field's copy. The header is EXCLUDED from copy (the named-style check fires
    // before the bold-label and copy branches, so it can never be read as an
    // option), but its position + number are recorded on field.riffMarks so the
    // app can render a faint "Riff N" divider before that batch's first option —
    // with the doc-accurate number (gap-safe: a surviving Riff 3 renders as 3).
    // beforeLine is the index (in the \n-split of field.copy) of the first option
    // that follows this header.
    if (named === 'HEADING_6') {
      if (field) {
        const rm = text.match(/^Riff\s+(\d+)/i);
        const beforeLine = field.copy ? field.copy.split('\n').length : 0;
        field.riffMarks.push({ beforeLine, riffN: rm ? Number(rm[1]) : field.riffMarks.length + 1 });
      }
      continue;
    }

    if (!current) continue;

    // The italic line between the asset heading and its first field is the
    // asset-level creative direction (or legacy channel · tone) — capture it for
    // display; it isn't field copy.
    if (italic && text && current.fields.length === 0 && !field) {
      if (!current.asset_direction) current.asset_direction = text;
      continue;
    }

    // A bold paragraph (optionally ending in a [min-max] / [max] bracket) starts
    // a new field. Recover charMin/charMax exactly as parseDoc does.
    if (bold && text) {
      const m = text.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
      const fieldName = m ? m[1].trim() : text;
      const bracket = m ? m[2] : '';
      const nums = bracket.match(/\d+/g);
      // The unit rides in the bracket ("[50-125 words]") because nothing about a
      // field is persisted — see WORD_UNIT_SUFFIX. Reading it back here is what
      // keeps the drafter and the reviewer counting the same thing the writer sees.
      const fieldType = /\bwords?\b/i.test(bracket) ? 'words' : 'text';
      let charMin = 0;
      let charMax = 0;
      if (nums) {
        const vals = nums.map(Number);
        charMax = Math.max(...vals);
        if (vals.length >= 2) charMin = Math.min(...vals);
      }
      field = { fieldName, charMin, charMax, fieldType, notes: '', copy: '', riffMarks: [] };
      current.fields.push(field);
      continue;
    }

    // Per-field guidance: the italic line right after a label, before any copy.
    // Capture it for display, but never count it as drafted copy.
    if (field && italic && text && !field.copy && !field.notes) {
      field.notes = text;
      continue;
    }

    // Any other non-empty paragraph is drafted copy for the current field.
    if (field && text) {
      field.copy = field.copy ? `${field.copy}\n${text}` : text;
    }
  }

  return result;
}

// --- Copy-review comments (Drive API v3) ---
// Comments are anchored to exact copy via quotedFileContent (verified). Quillio's
// review comments are branded + identified by this prefix so re-review can clear
// the previous ones before posting the currently-warranted set.
const REVIEW_PREFIX = '🪶 Quillio Review — ';

// List the live Quillio review comments on the doc (prefix-identified). Returns
// [{ id, content, resolved, quote }] where `quote` is the copy the comment was
// anchored to (quotedFileContent snapshot at post time) and `resolved` is true
// when the user manually resolved it in Google Docs. RESOLVED COMMENTS ARE
// INCLUDED — reconcile needs them to respect manual dismissals. `content` has the
// REVIEW_PREFIX stripped. Non-Quillio comments are excluded by the prefix.
async function listReviewComments(docId, clients) {
  const { drive } = clients || (await getClients());
  const out = [];
  let pageToken = null;
  do {
    const res = await drive.comments.list({
      fileId: docId,
      fields: 'nextPageToken, comments(id, content, deleted, resolved, quotedFileContent/value)',
      pageSize: 100,
      includeDeleted: false,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
    });
    for (const c of res.data.comments || []) {
      if (c.deleted || typeof c.content !== 'string' || !c.content.startsWith(REVIEW_PREFIX)) continue;
      out.push({
        id: c.id,
        content: c.content.slice(REVIEW_PREFIX.length),
        resolved: !!c.resolved,
        quote: (c.quotedFileContent && c.quotedFileContent.value) || '',
      });
    }
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return out;
}

// Post ONE branded review comment anchored to `quote` via quotedFileContent.
// Returns the new comment id, or null on failure (logged). Empty quote/content
// is a no-op (returns null).
async function addReviewComment(docId, { quote, content } = {}, clients) {
  const q = String(quote || '');
  if (!q.trim() || !content) return null;
  const { drive } = clients || (await getClients());
  try {
    const res = await drive.comments.create({
      fileId: docId,
      fields: 'id',
      supportsAllDrives: true,
      requestBody: {
        content: REVIEW_PREFIX + content,
        quotedFileContent: { mimeType: 'text/plain', value: q },
      },
    });
    return (res.data && res.data.id) || null;
  } catch (err) {
    console.error(`[review] failed to add comment: ${err.message}`);
    return null;
  }
}

// Delete ONE comment by id. Best-effort; returns true if it was deleted.
async function deleteReviewComment(docId, commentId, clients) {
  if (!commentId) return false;
  const { drive } = clients || (await getClients());
  try {
    await drive.comments.delete({ fileId: docId, commentId, supportsAllDrives: true });
    return true;
  } catch (err) {
    console.error(`[review] failed to delete comment ${commentId}: ${err.message}`);
    return false;
  }
}

// The destination adapter contract.
// BUILD ONE TEMPLATE DOCUMENT for a project (custom document types, STEP THREE).
//
// A tenant's own document — a landscape multi-table copy matrix, typically —
// copied into the campaign folder and filled with this project's copy.
//
// COPY, DON'T REBUILD. drive.files.copy duplicates the imported Google Doc
// wholesale: landscape, tables, merged cells, column widths, shading and fonts
// all come along because they are never re-derived. The fidelity probe
// (scripts/probeDocxImport.js) confirmed those survive the .docx import in the
// first place; copy preserves whatever survived. Rebuilding the matrix from a
// schema — the docBuilder route the copy doc takes — would mean re-implementing
// every one of those, and getting column widths wrong on someone's client
// deliverable is not a recoverable kind of wrong.
//
// FILL WITH replaceAllText. One batchUpdate carrying one request per marker. No
// index arithmetic (the two-phase problem docHeaderTable.js exists to solve is
// avoided entirely), and the replacement INHERITS the formatting of the run it
// replaces — so copy dropped into a bold header cell comes out bold, which is
// what the tenant designed and what any insert-at-index approach would lose.
//
// AN UNMAPPED MARKER IS LEFT ALONE, on purpose. It stays in the output as a
// literal {{Marker}}, visible to whoever opens the document. Blanking it would
// be worse in the exact way that matters: an empty cell in a matrix reads as
// "nobody wrote this yet" and a visible {{Form ID}} reads as "this one is not
// mine to write", and only the second is true. Nothing here ever writes an
// empty string over a marker.
//
//   values: Map|Object of markerKey -> copy. A key with no value is skipped.
//   markers: [{ name, key }] — every marker in the template, so the result can
//            report what was left unfilled without a second read.
//
// Returns { id, url, title, filled: [...], unfilled: [...] }.
async function createFromTemplate({ sourceDocId, name, folderId, values, markers = [], clients }) {
  const { drive, docs } = clients || (await getClients());
  if (!sourceDocId) throw new Error('createFromTemplate: no source document.');

  const copied = await drive.files.copy({
    fileId: sourceDocId,
    requestBody: { name: name || 'Template document', ...(folderId ? { parents: [folderId] } : {}) },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  const id = copied.data.id;
  const url = copied.data.webViewLink || `https://docs.google.com/document/d/${id}/edit`;

  const get = (k) => (values instanceof Map ? values.get(k) : values ? values[k] : undefined);

  const requests = [];
  const filled = [];
  const unfilled = [];
  for (const m of markers) {
    const copy = get(m.key);
    // Only a non-empty string fills. undefined (unmapped) and '' (mapped to a
    // field that has no copy yet) both leave the marker standing.
    if (typeof copy === 'string' && copy.trim()) {
      requests.push({
        replaceAllText: {
          containsText: { text: `{{${m.name}}}`, matchCase: false },
          replaceText: copy,
        },
      });
      filled.push(m.name);
    } else {
      unfilled.push(m.name);
    }
  }

  if (requests.length) {
    await docs.documents.batchUpdate({ documentId: id, requestBody: { requests } });
  }

  console.log(
    `[googleDocs] template document "${copied.data.name}" -> ${id} — ` +
      `${filled.length} marker(s) filled, ${unfilled.length} left visible`
  );

  return { id, url, title: copied.data.name, filled, unfilled };
}

async function writeTemplateCells(documentId, { markers, values }, clients) {
  const { docs } = clients || (await getClients());
  if (!documentId) throw new Error('writeTemplateCells: no document.');

  const doc = (await docs.documents.get({ documentId })).data;
  const { found, missing } = locateCells(doc, markers || []);
  const { requests, written, skipped } = buildCellWriteRequests(found, values);

  if (requests.length) {
    await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
  }

  const healed = found.filter((c) => c.healed).map((c) => ({ name: c.marker.marker_name, reason: c.reason }));
  console.log(
    `[googleDocs] template cells ${documentId} — ${written.length} written, ${skipped.length} left as-is` +
      (healed.length ? `, ${healed.length} found by label after an edit` : '') +
      (missing.length ? `, ${missing.length} NOT LOCATED` : '')
  );
  for (const m of missing) {
    console.warn(`[googleDocs]   could not place {{${m.marker && m.marker.marker_name}}}: ${m.reason}`);
  }

  return {
    written,
    skipped,
    healed,
    missing: missing.map((m) => ({ name: m.marker && m.marker.marker_name, reason: m.reason })),
    requests: requests.length,
  };
}

// READ BACK a built template document by stored coordinate (step three).
//
// One documents.get, no write. The coordinate is structural, so it still finds
// the cell after the marker has been replaced by copy — reading it back is how
// that stops being an assertion and starts being an observation.
//
// Returns { rows, missing } from templateCells.readCells. A row carries the
// cell's CURRENT text and whether it still shows its {{marker}}.
async function readTemplateCells(documentId, { markers } = {}, clients) {
  const { docs } = clients || (await getClients());
  if (!documentId) throw new Error('readTemplateCells: no document.');

  const doc = (await docs.documents.get({ documentId })).data;
  const { rows, missing } = readCells(doc, markers || []);

  const drafted = rows.filter((r) => r.is_copy && !r.showingMarker && !r.empty).length;
  const standing = rows.filter((r) => r.showingMarker).length;
  console.log(
    `[googleDocs] read ${documentId} — ${rows.length} located, ${drafted} holding copy, ` +
      `${standing} still showing a marker` + (missing.length ? `, ${missing.length} NOT LOCATED` : '')
  );
  return { rows, missing, title: (doc && doc.title) || '' };
}

// Post ONE branded review comment with NO ANCHOR.
//
// WHY UNANCHORED, AND WHY THIS IS NOT A DEGRADED addReviewComment. The anchoring
// probe settled it: a Drive comment whose quotedFileContent is text inside a
// TABLE CELL does not resolve. All six probe cases came back with Google
// rendering "Original content deleted" — the comment exists, carries its text,
// and points nowhere. Every cell of a template document is a table cell, so
// there is no anchored path here to fall back FROM.
//
// Which makes the field name load-bearing: it is the only thing tying the
// comment to a cell. A matrix is already a lookup table with a Field column, so
// naming the field in the body text is not a workaround — it is the same way a
// human would refer to a row.
async function addUnanchoredComment(docId, content, clients) {
  if (!content || !String(content).trim()) return null;
  const { drive } = clients || (await getClients());
  try {
    const res = await drive.comments.create({
      fileId: docId,
      fields: 'id',
      supportsAllDrives: true,
      // No quotedFileContent. Sending one that cannot resolve is what produces
      // the "Original content deleted" banner, so the absence is deliberate.
      requestBody: { content: REVIEW_PREFIX + content },
    });
    return (res.data && res.data.id) || null;
  } catch (err) {
    console.error(`[review] failed to add unanchored comment: ${err.message}`);
    return null;
  }
}

module.exports = {
  name: 'google-docs',
  createDocument,
  createFromTemplate,
  writeTemplateCells,
  readTemplateCells,
  addUnanchoredComment,
  generateDraft,
  getDocContent,
  listReviewComments,
  addReviewComment,
  deleteReviewComment,
  REVIEW_PREFIX,
  // Exposed for unit tests only (not part of the destination interface used by
  // the registry): char-limit bracket rendering, the field explainer, doc
  // re-parsing including the regeneration delete-range detection, and the body
  // builder (to lock the default-header fallback ordering).
  fieldLabel,
  fieldHint,
  parseDoc,
  // The house-default sentences and the strip that keeps them out of a prompt.
  // Unit tests only, like the four around them — not part of the destination
  // interface (see the table in CLAUDE.md).
  HOUSE_DEFAULT_LINE,
  HOUSE_DEFAULT_LINE_SET,
  stripHouseDefaultLine,
  appendBody,
  buildVariantBlock,
  // The composite (asset, field, instance) lookup key — exposed so its DEFAULT
  // serialization can be pinned byte-for-byte (it is not persisted like
  // copyReview's fieldKey, but a drift would silently mis-place drafted copy).
  ctxKey,
  // The instance-heading format, both directions. Exposed so the round trip
  // (render → read → key) is assertable without a Google client.
  assetHeadingText,
  decomposeAssetHeading,
  instanceHeadingMap,
};
