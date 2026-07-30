'use strict';

// Default asset library — Quillio Asset & Field Library v3. Seeded into a new
// tenant's asset_types / copy_fields on install. Source of truth: the v3 Sheet
// (1NVDCcjPO2ZG1Vmt40WTwTYmXTl27dBiwrinHHKK9tCU), transcribed June 2026.
//
// June 2026 spec audit (scripts/migrateAssetSpecFixes.js applies the same
// changes to already-seeded tenants):
//   • Email subject lines standardized to 50–75; preheaders to 85–120; every
//     email has Subject Line 1, Subject Line 2 and a Preheader.
//   • Paid social / display: char maxes aligned to current platform limits and
//     a "Graphic Headline" field added (the on-image line → [Headline] in Figma).
//   • Organic social: full max + visible-hook (before "See more"/"More") fields.
//   • Landing pages: SEO fields (Meta Title / Meta Description / OG Title).
//   • spec_note added to the multi-size display assets.
//
// July 2026 spec-integrity audit (scripts/migrateSpecIntegrityFixes.js applies the
// same changes to already-seeded tenants):
//   • Meta's numbers retiered enforced → recommended (they are Meta's published
//     advice, not caps), which is what first put a row in the 'recommended' tier.
//   • Meta Carousel card headline 45 → 40 (45 was LinkedIn's number) and card
//     description 18 → 20.
//   • LinkedIn Carousel now cites the carousel spec page, not the single-image one.
//   • 'Google DV360 / Responsive Display' renamed to 'Google Responsive Display Ad'
//     to match its source and its numbers.
//   • Organic Social — Twitter/X Post Copy promoted to enforced with X's spec page.
//   • Preheaders 85–120 → 85–100; subject lines split by email type (cold 40,
//     opt-in 130) and their char_min floor dropped.
//
// Authored compactly as [name, group, [[fieldName, charMin, charMax, groupLabel?], …]]
// and normalized below into the seed shape (adds sort_order, is_active, field_type,
// spec metadata, asset_direction and spec_note). field_type is 'text' (characters)
// for every field EXCEPT the six email body fields, which are 'words' — see
// fieldUnit below; on those, char_min/char_max are a WORD range. The optional 4th
// field element is a group_label: consecutive
// fields sharing one (e.g. 'Graphic Copy') render under a single indented
// sub-heading in the Doc — the on-graphic copy (Graphic Headline, Subhead, and
// CTA on paid/display) grouped so it reads as one unit and maps to Figma layers.

const SPEC_SOURCE = 'quillio_default';
const SPEC_VERSION = '1.0';

const RAW = [
  ['LinkedIn Single Image Ad', 'Paid Social', [
    ['Intro Text', 0, 150],
    ['Headline', 0, 70],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
    ['LAN Description', 0, 70],
  ]],
  ['LinkedIn Carousel Ad', 'Paid Social', [
    ['Intro Text', 0, 600],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
    ['Card 1 Headline', 0, 45],
    ['Card 2 Headline', 0, 45],
    ['Card 3 Headline', 0, 45],
    ['Card 4 Headline', 0, 45],
    ['Card 5 Headline', 0, 45],
  ]],
  ['LinkedIn Single Image Ad — Variant A', 'Paid Social', [
    ['Intro Text', 0, 600],
    ['Headline', 0, 70],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
  ]],
  ['LinkedIn Single Image Ad — Variant B', 'Paid Social', [
    ['Intro Text', 0, 600],
    ['Headline', 0, 70],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
  ]],
  ['LinkedIn Single Image Ad — Variant C', 'Paid Social', [
    ['Intro Text', 0, 600],
    ['Headline', 0, 70],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
  ]],
  ['LinkedIn Single Image Ad — Variant D', 'Paid Social', [
    ['Intro Text', 0, 600],
    ['Headline', 0, 70],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
  ]],
  ['Meta Single Image Ad', 'Paid Social', [
    ['Primary Text', 0, 125],
    ['Headline', 0, 40],
    ['Description', 0, 30],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
  ]],
  ['Meta Carousel Ad', 'Paid Social', [
    ['Primary Text', 0, 125],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
    ['Card 1 Headline', 0, 40],
    ['Card 2 Headline', 0, 40],
    ['Card 3 Headline', 0, 40],
    ['Card 4 Headline', 0, 40],
    ['Card 5 Headline', 0, 40],
    ['Card Description', 0, 20],
  ]],
  ['Twitter/X Ad', 'Paid Social', [
    ['Ad Copy', 0, 280],
    ['Headline', 0, 70],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
  ]],
  ['Display Banner — Standard', 'Display', [
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 20, 40, 'Graphic Copy'],
    ['Body Copy', 0, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
  ]],
  ['Google Responsive Display Ad', 'Display', [
    ['Short Headline', 0, 30],
    ['Long Headline', 0, 90],
    ['Description', 0, 90],
    ['Business Name', 0, 25],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 20, 40, 'Graphic Copy'],
    ['CTA Button', 0, 30, 'Graphic Copy'],
  ]],
  ['Demand Gen Nurture Email', 'Email', [
    ['Subject Line 1', 0, 130],
    ['Subject Line 2', 0, 130],
    ['Preheader', 85, 100],
    ['Headline (Offer 1)', 0, 60],
    ['Offer Body 1', 50, 125],
    ['CTA Text (Offer 1)', 0, 25],
    ['Headline (Offer 2)', 0, 60],
    ['Offer Body 2', 25, 60],
    ['CTA Text (Offer 2)', 0, 20],
  ]],
  ['Event Invitation Email', 'Email', [
    ['Subject Line 1', 0, 130],
    ['Subject Line 2', 0, 130],
    ['Preheader', 85, 100],
    ['Hero Headline', 0, 60],
    ['Event Description', 50, 125],
    ['Date / Location Line', 0, 80],
    ['CTA Text', 0, 25],
  ]],
  ['Event Reminder Email', 'Email', [
    ['Subject Line 1', 0, 130],
    ['Subject Line 2', 0, 130],
    ['Preheader', 85, 100],
    ['Headline', 0, 60],
    ['Body Copy', 25, 75],
    ['CTA Text', 0, 25],
  ]],
  ['Event Follow-Up / Recap Email', 'Email', [
    ['Subject Line 1', 0, 130],
    ['Subject Line 2', 0, 130],
    ['Preheader', 85, 100],
    ['Headline', 0, 60],
    ['Body Copy', 25, 75],
    ['CTA Text', 0, 25],
  ]],
  ['Sales Basho Email', 'Email', [
    ['Subject Line 1', 0, 40],
    ['Subject Line 2', 0, 40],
    ['Preheader', 85, 100],
    ['Opening Line', 0, 100],
    ['Body Copy', 50, 100],
    ['CTA / Ask', 0, 100],
  ]],
  ['Event Landing Page', 'Events', [
    ['Hero Headline', 0, 70],
    ['Hero Subheadline', 0, 120],
    ['Hero CTA', 0, 25],
    ['About Section Headline', 0, 60],
    ['About Section Body', 0, 400],
    ['Benefit 1 Headline', 0, 40],
    ['Benefit 1 Body', 0, 100],
    ['Benefit 2 Headline', 0, 40],
    ['Benefit 2 Body', 0, 100],
    ['Benefit 3 Headline', 0, 40],
    ['Benefit 3 Body', 0, 100],
    ['Benefit 4 Headline', 0, 40],
    ['Benefit 4 Body', 0, 100],
    ['Stat 1', 0, 60],
    ['Stat 1 Label', 0, 40],
    ['Stat 2', 0, 60],
    ['Stat 2 Label', 0, 40],
    ['Stat 3', 0, 60],
    ['Stat 3 Label', 0, 40],
    ['Bottom CTA Headline', 0, 70],
    ['Bottom CTA Button', 0, 25],
    ['Meta Title', 50, 60],
    ['Meta Description', 150, 160],
    ['OG Title', 0, 60],
  ]],
  ['On-Site Signage — General', 'Events', [
    ['Headline', 0, 40],
    ['Subheadline', 0, 80],
    ['Body / Context', 0, 150],
    ['CTA or URL', 0, 40],
  ]],
  ['On-Site Signage — Session Title Card', 'Events', [
    ['Session Title', 0, 80],
    ['Speaker Name(s)', 0, 60],
    ['Speaker Title / Company', 0, 80],
    ['Track / Room Label', 0, 40],
  ]],
  ['On-Site Signage — Directional', 'Events', [
    ['Location Label', 0, 30],
    ['Supporting Line', 0, 50],
  ]],
  ['Campaign Landing Page', 'Web', [
    ['Hero Headline', 0, 70],
    ['Hero Subheadline', 0, 130],
    ['Hero CTA', 0, 25],
    ['Section 1 Headline', 0, 60],
    ['Section 1 Body', 0, 350],
    ['Benefit 1 Headline', 0, 40],
    ['Benefit 1 Body', 0, 100],
    ['Benefit 2 Headline', 0, 40],
    ['Benefit 2 Body', 0, 100],
    ['Benefit 3 Headline', 0, 40],
    ['Benefit 3 Body', 0, 100],
    ['Bottom CTA Headline', 0, 70],
    ['Bottom CTA Button', 0, 25],
    ['Meta Title', 50, 60],
    ['Meta Description', 150, 160],
    ['OG Title', 0, 60],
  ]],
  ['Form Confirm Page', 'Web', [
    ['Headline', 0, 60],
    ['Subheadline / Body', 0, 200],
    ['CTA', 0, 40],
  ]],
  ['Organic Social — LinkedIn', 'Organic Social', [
    ['Post Copy', 0, 500],
    ['Hook (first 150 chars, before See more)', 0, 150],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['Headline (if link)', 0, 70],
  ]],
  ['Organic Social — Instagram', 'Organic Social', [
    ['Caption', 0, 165],
    ['Hook (first 125 chars, before More)', 0, 125],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['Alt Text', 0, 100],
  ]],
  ['Organic Social — Twitter/X', 'Organic Social', [
    ['Post Copy', 0, 280],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
  ]],
  ['Direct Mail — Box / Mailer', 'Direct Mail', [
    ['Exterior Front Headline', 0, 60],
    ['Exterior Front Subheadline', 0, 100],
    ['Exterior Back Headline', 0, 60],
    ['Exterior Back Body', 0, 200],
    ['Flap Copy', 0, 150],
  ]],
  ['Direct Mail — Note Card / Rep Letter', 'Direct Mail', [
    ['Salutation', 0, 40],
    ['Opening Line', 0, 150],
    ['Body Paragraph 1', 0, 300],
    ['Body Paragraph 2', 0, 300],
    ['Closing / Ask', 0, 150],
    ['Signature Line', 0, 60],
  ]],
  ['Direct Mail — Insert', 'Direct Mail', [
    ['Headline', 0, 60],
    ['Body Copy', 0, 300],
    ['CTA', 0, 40],
  ]],
  ['One-Pager', 'Sales Enablement', [
    ['Headline', 0, 70],
    ['Subheadline', 0, 120],
    ['Problem Statement', 0, 200],
    ['Solution Description', 0, 300],
    ['Benefit 1', 0, 100],
    ['Benefit 2', 0, 100],
    ['Benefit 3', 0, 100],
    ['Proof Point / Stat', 0, 80],
    ['CTA', 0, 60],
  ]],
  ['Battle Card', 'Sales Enablement', [
    ['Product Positioning', 0, 200],
    ['Key Differentiators', 0, 300],
    ['Common Objections', 0, 400],
    ['Competitive Landmines', 0, 300],
    ['Proof Points', 0, 200],
  ]],
];

// Asset-level creative direction — one line of "how to write this asset",
// rendered as an italic line under the asset heading and fed to the drafter.
// Keyed by exact asset name.
const DIRECTIONS = {
  'LinkedIn Single Image Ad': 'Direct. Benefit-led. Lead with the outcome, not the feature.',
  'LinkedIn Carousel Ad': 'Each card earns the next. One idea per card, strong close.',
  'LinkedIn Single Image Ad — Variant A':
    'One variable per variant. Change one element — headline, angle, or offer — not everything at once.',
  'LinkedIn Single Image Ad — Variant B':
    'One variable per variant. Change one element — headline, angle, or offer — not everything at once.',
  'LinkedIn Single Image Ad — Variant C':
    'One variable per variant. Change one element — headline, angle, or offer — not everything at once.',
  'LinkedIn Single Image Ad — Variant D':
    'One variable per variant. Change one element — headline, angle, or offer — not everything at once.',
  'Meta Single Image Ad': 'Lead with the insight or tension. Stop the scroll in the first line.',
  'Meta Carousel Ad': 'Each card standalone. Swipe tells a story. Last card closes.',
  'Twitter/X Ad': 'Punchy. Opinionated. One idea, no hedging.',
  'Display Banner — Standard': 'Fewest possible words. Headline does all the work. CTA is a verb.',
  'Google Responsive Display Ad':
    'System assembles combinations. Every element must work alone and together.',
  'Demand Gen Nurture Email': 'Curiosity or tension in the subject — they are mid-sequence, not meeting you.',
  'Event Invitation Email': 'Make the value of attending undeniable. Date and CTA above the fold.',
  'Event Reminder Email': 'Urgency without panic. They already said yes — reinforce, do not re-sell.',
  'Event Follow-Up / Recap Email': 'Gratitude first, value second, next step third.',
  'Sales Basho Email': 'Open with Dear [First Name].',
  'Event Landing Page': 'The page answers one question: why should I be there? Answer it fast.',
  'On-Site Signage — General': 'Read in motion. Three seconds max. Verb first.',
  'On-Site Signage — Session Title Card': 'Clear over clever. Speaker name prominent. No jargon in the title.',
  'On-Site Signage — Directional': 'Action word + destination. Nothing else.',
  'Campaign Landing Page': 'One message, one CTA. Everything else supports or gets cut.',
  'Form Confirm Page': 'Confirm the action, set the expectation, suggest the next step.',
  'Organic Social — LinkedIn': 'Insight or opinion first. Professional but human. No corporate speak.',
  'Organic Social — Instagram': 'Visual does the work. Copy adds context or personality, not explanation.',
  'Organic Social — Twitter/X': 'One idea. Confident take. Under 240 and it still lands.',
  'Direct Mail — Box / Mailer': 'Outer copy earns the open. Inside copy earns the action.',
  'Direct Mail — Note Card / Rep Letter': 'First person, human tone. Sounds like the rep, not marketing.',
  'Direct Mail — Insert': 'Standalone piece — assume no context. Lead with the offer, close with urgency.',
  'One-Pager': 'Scannable in 30 seconds. Problem, solution, proof, CTA. Nothing extra.',
  'Battle Card': 'Arm the rep, not the reader. Crisp, confident, scannable under pressure.',
};

// Asset-level spec notes — clarifying constraints surfaced on the asset (e.g.
// one copy set spanning multiple sizes). Keyed by exact asset name; absent → null.
const SPEC_NOTES = {
  'Display Banner — Standard':
    'One copy set serves all standard banner sizes (300×250, 728×90, 160×600, 320×50, 300×600). Keep the headline short enough to read in the smallest format.',
  'Google Responsive Display Ad':
    'Responsive — the platform assembles combinations across sizes from one copy set. Every element must read on its own and in combination.',
};

// Field-level spec notes — per-field guidance rendered as an italic line under
// the field label (see fieldHint in destinations/googleDocs.js). Only "Hook"
// fields carry one today: the visible-then-"…more" explainer. The text is kept
// BYTE-IDENTICAL to the backfill in scripts/migrateAddCopyFieldSpecNote.js, so
// existing (migrated) and newly-seeded tenants render the exact same note.
const HOOK_SPEC_NOTE =
  'Only this opening runs before the app collapses the rest behind “…more.” ' +
  'Land the hook within the character limit; the full caption/post can keep going — it just shows after the fold.';

// LinkedIn Single Image Ad → Intro Text note. char_max is the recommended 150
// (in-feed truncation), not LinkedIn's technical 600; this note explains the gap.
// BYTE-IDENTICAL to NOTE in scripts/migrateFixLinkedInIntroText.js.
const LINKEDIN_SIA_INTRO_NOTE = 'In-feed preview truncates near 150; 600 is the technical max.';

// LinkedIn Carousel Ad → Card N Headline note. The 45 in the label is CONDITIONAL:
// it holds for a carousel driving to a destination URL, but a carousel whose CTA
// opens a Lead Gen Form caps its cards at 30. One field, two limits, and the label
// can only carry one number — so the note carries the other. Applied to all five
// card headlines. BYTE-IDENTICAL to CARD_HEADLINE_NOTE in
// scripts/migrateSpecIntegrityFixes.js.
const LINKEDIN_CAROUSEL_CARD_NOTE =
  'Applies to carousels driving to a destination URL; with a Lead Gen Form CTA the cap is 30.';

// The five LinkedIn Carousel card-headline fields that carry the note above.
const LINKEDIN_CAROUSEL_CARD_FIELDS = new Set([
  'Card 1 Headline',
  'Card 2 Headline',
  'Card 3 Headline',
  'Card 4 Headline',
  'Card 5 Headline',
]);

// Email mobile-truncation notes. Subject Lines cap at 40 (cold outreach) or 130
// (opt-in) with NO minimum, and Preheaders run 85–100, but mobile inboxes clip far
// earlier (Litmus) — these tell the writer to front-load. Applied to Subject Line
// 1, Subject Line 2 and Preheader on every email asset. BYTE-IDENTICAL to
// SUBJECT_NOTE / PREHEADER_NOTE in scripts/migrateAddEmailSubjectPreheaderNotes.js.
//
// The note text is deliberately UNCHANGED by the July 2026 band rework: ~40
// characters of subject and ~35–40 of preheader is what the inbox shows, whatever
// the band allows.
const EMAIL_SUBJECT_NOTE = 'Mobile inboxes cut around 40 characters — front-load the first 40. (Litmus)';
const EMAIL_PREHEADER_NOTE = 'Mobile shows ~35–40 characters of preheader — keep the key part first. (Litmus)';

// The 5 email assets that carry the subject/preheader notes above.
const EMAIL_NOTE_ASSETS = new Set([
  'Demand Gen Nurture Email',
  'Event Invitation Email',
  'Event Reminder Email',
  'Event Follow-Up / Recap Email',
  'Sales Basho Email',
]);

// Resolve a field's spec_note, keyed on (assetName, fieldName): the LinkedIn SIA
// Intro Text explainer for that exact pair; the Lead-Gen-Form caveat for the
// LinkedIn Carousel card headlines; the mobile-truncation note for email
// Subject Line 1/2 and Preheader; else the visible-then-"…more" Hook explainer
// for any Hook field (mirrors the migration's `field_name ~* '^Hook\y'` match).
// Byte-identical to the corresponding migrations so seed and backfill agree.
function fieldSpecNote(assetName, fieldName) {
  if (assetName === 'LinkedIn Single Image Ad' && fieldName === 'Intro Text') return LINKEDIN_SIA_INTRO_NOTE;
  if (assetName === 'LinkedIn Carousel Ad' && LINKEDIN_CAROUSEL_CARD_FIELDS.has(fieldName)) {
    return LINKEDIN_CAROUSEL_CARD_NOTE;
  }
  if (EMAIL_NOTE_ASSETS.has(assetName)) {
    if (fieldName === 'Subject Line 1' || fieldName === 'Subject Line 2') return EMAIL_SUBJECT_NOTE;
    if (fieldName === 'Preheader') return EMAIL_PREHEADER_NOTE;
  }
  return /^Hook\b/i.test(String(fieldName || '')) ? HOOK_SPEC_NOTE : null;
}

// Per-field spec tier: 'enforced' (the platform's own published hard cap),
// 'recommended' (the platform's own published ADVICE — a real number from a real
// source, but not a cap), or 'house_default' (a Quillio convention with no
// external source). Enforcement is PER ASSET — the same field name can be a hard
// cap in one asset and a house default in another — so both sets are keyed on
// (assetName, fieldName). Anything in neither set is 'house_default'.
//
// The tier is USER-VISIBLE: it becomes the italic sentence under the field label
// (specTypeLine in destinations/googleDocs.js). Calling a recommendation a
// "Platform limit … stay within this count" tells a writer they must not exceed a
// number the platform will happily accept, so the distinction is the point.
//
// Kept BYTE-IDENTICAL to scripts/migrateSpecIntegrityFixes.js, which applies the
// same tiering to already-seeded tenants; a smoke test asserts the two agree in
// both directions.
//
// Meta's numbers are RECOMMENDATIONS, not caps. Meta publishes 125 / 40 / 30 as
// what renders without truncation across placements; the technical ceilings are
// 255 for headlines and far larger for primary text. Every Meta field here is
// therefore 'recommended' — including the carousel's card fields, which are the
// carousel's equivalents of the same three numbers.
const RECOMMENDED_SPEC_FIELDS = new Set([
  'Meta Single Image Ad||Primary Text',
  'Meta Single Image Ad||Headline',
  'Meta Single Image Ad||Description',
  'Meta Carousel Ad||Primary Text',
  'Meta Carousel Ad||Card 1 Headline',
  'Meta Carousel Ad||Card 2 Headline',
  'Meta Carousel Ad||Card 3 Headline',
  'Meta Carousel Ad||Card 4 Headline',
  'Meta Carousel Ad||Card 5 Headline',
  'Meta Carousel Ad||Card Description',
]);

// Genuine hard caps, each stated as a limit on the platform's own spec page.
const ENFORCED_SPEC_FIELDS = new Set([
  'LinkedIn Single Image Ad||Intro Text',
  'LinkedIn Single Image Ad||Headline',
  'LinkedIn Single Image Ad||LAN Description',
  'LinkedIn Carousel Ad||Intro Text',
  'LinkedIn Carousel Ad||Card 1 Headline',
  'LinkedIn Carousel Ad||Card 2 Headline',
  'LinkedIn Carousel Ad||Card 3 Headline',
  'LinkedIn Carousel Ad||Card 4 Headline',
  'LinkedIn Carousel Ad||Card 5 Headline',
  'Twitter/X Ad||Ad Copy',
  'Twitter/X Ad||Headline',
  'Google Responsive Display Ad||Short Headline',
  'Google Responsive Display Ad||Long Headline',
  'Google Responsive Display Ad||Description',
  'Google Responsive Display Ad||Business Name',
  // X's 280 is a hard cap on an organic post exactly as it is on a paid one — the
  // same platform limit, and it was previously an uncited house default here.
  'Organic Social — Twitter/X||Post Copy',
]);

// --- Field UNIT -------------------------------------------------------------
// copy_fields.field_type carries the UNIT a field's char_min/char_max are counted
// in. 'text' (the default, and every field before this) means characters. 'words'
// means the numbers are a WORD range.
//
// Characters are the right unit where truncation is literal — a subject line, an ad
// headline, a preheader all get cut at a real character position, so a character
// count is the actual constraint. Email BODY copy has no truncation point. What it
// has is an attention budget, and every study of that budget measures it in words
// (Boomerang's 40M-email analysis: 50–125 words highest response, 75–100 the sweet
// spot, past 200 words response drops below 40%). Rendering "[500]" on a body field
// asked the writer to count the wrong thing.
//
// ONLY email body fields convert. Ad copy, headlines, CTAs, subject lines and
// preheaders stay in characters because their limits are literal truncation points.
// Non-email long-form (landing page body, one-pager, direct mail) stays in
// characters for now — see the note in the migration.
//
// Kept BYTE-IDENTICAL to WORD_FIELDS in scripts/migrateEmailBodyWordCounts.js.
const WORD_FIELDS = new Set([
  // Marketing / nurture band, 50–125 words. Opt-in, branded, aiming for a click.
  'Demand Gen Nurture Email||Offer Body 1',
  // Offer Body 2 is the deliberately LIGHTER second offer, so it gets its own
  // smaller band (25–60) rather than the nurture one. Two fields at 125 would
  // permit a 250-word nurture email, and the research behind these numbers puts
  // response below 40% past 200 words — a per-field band that is individually
  // defensible can still be wrong for the email the two of them add up to.
  'Demand Gen Nurture Email||Offer Body 2',
  // An invitation is making a case to attend — marketing, not a reminder.
  'Event Invitation Email||Event Description',
  // Cold outreach band, 50–100 words. Plain text, 1:1 feel, aiming for a reply.
  'Sales Basho Email||Body Copy',
  // Follow-up band, 25–75 words. The reader already decided; these reinforce or
  // recap rather than persuade.
  'Event Reminder Email||Body Copy',
  'Event Follow-Up / Recap Email||Body Copy',
]);

// 'words' | 'text'. The value stored in copy_fields.field_type and threaded through
// the pipeline to the label, the prompt and the review.
function fieldUnit(assetName, fieldName) {
  return WORD_FIELDS.has(`${assetName}||${fieldName}`) ? 'words' : 'text';
}

function fieldSpecType(assetName, fieldName) {
  const key = `${assetName}||${fieldName}`;
  if (ENFORCED_SPEC_FIELDS.has(key)) return 'enforced';
  if (RECOMMENDED_SPEC_FIELDS.has(key)) return 'recommended';
  return 'house_default';
}

// Per-ASSET spec-source URL. Every tiered field on an asset cites that asset's own
// spec page; untiered fields keep the 'quillio_default' sentinel. The renderer
// substring-matches the URL to a display name (specSourceName) and hyperlinks that
// name in the tier line, so the URL is what the reader actually lands on.
//
// Keyed per ASSET rather than per PLATFORM, which is what the previous shape got
// wrong: one URL per platform meant LinkedIn Carousel cited the SINGLE IMAGE ad
// specs page, which does not contain the carousel's numbers. A reader who followed
// the citation to check the 45-character card headline would not have found it.
//
// URLs are kept BYTE-IDENTICAL to SOURCE_URLS in
// scripts/migrateSpecIntegrityFixes.js (asserted by a smoke test).
const SPEC_SOURCE_URLS = {
  'Meta Single Image Ad': 'https://www.facebook.com/business/ads-guide/update',
  'Meta Carousel Ad': 'https://www.facebook.com/business/ads-guide/update',
  'LinkedIn Single Image Ad':
    'https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs',
  'LinkedIn Carousel Ad':
    'https://business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs',
  'Twitter/X Ad': 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications',
  // The organic X post cites the same X page as the paid asset — one platform, one
  // 280-character cap.
  'Organic Social — Twitter/X': 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications',
  // Google Ads, not Display & Video 360. The asset was named for DV360 while citing
  // (and carrying the numbers of) a Google Ads Responsive Display Ad — 30 / 90 / 90
  // / 25. The NAME was corrected to match the source and the numbers, rather than
  // the numbers changed to match the name.
  'Google Responsive Display Ad': 'https://support.google.com/google-ads/answer/17090561',
};

function fieldSpecSource(assetName, fieldName) {
  if (fieldSpecType(assetName, fieldName) === 'house_default') return SPEC_SOURCE;
  return SPEC_SOURCE_URLS[assetName] || SPEC_SOURCE;
}

const DEFAULT_ASSETS = RAW.map(([name, group, fields], i) => ({
  name,
  group,
  sort_order: i + 1,
  is_active: true,
  spec_source: SPEC_SOURCE,
  spec_version: SPEC_VERSION,
  asset_direction: DIRECTIONS[name] || '',
  spec_note: SPEC_NOTES[name] || null,
  fields: fields.map(([field_name, char_min, char_max, group_label], j) => ({
    field_name,
    char_min,
    char_max,
    field_type: fieldUnit(name, field_name),
    sort_order: j + 1,
    group_label: group_label || null,
    spec_note: fieldSpecNote(name, field_name),
    spec_type: fieldSpecType(name, field_name),
    spec_source: fieldSpecSource(name, field_name),
  })),
}));

module.exports = { DEFAULT_ASSETS };
