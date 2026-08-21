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
// August 2026 (scripts/migrateAddGoogleSearchAsset.js adds the same asset to
// already-seeded tenants):
//   • 'Google Responsive Search Ad' added — the twenty-sixth asset, and the first
//     new one since the prune. Every number read off
//     support.google.com/google-ads/answer/7684791, quoted in that migration.
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

// Marker in RAW for a field whose band comes from EMAIL_CLASSES below, not from a
// literal here. Resolved by classBand() when the seed is built.
const FROM_CLASS = null;

// Both classes share this. A preheader is cut at the same point regardless of how
// the reader came to be receiving the email — Litmus: mobile shows ~35–40
// characters, published sweet spot 85–100. Named once rather than written twice,
// for the same reason the classes exist at all. It stays a per-class KEY so a
// future class can differ without restructuring anything.
const PREHEADER_BAND = [85, 100];

// --- EMAIL CLASSES -----------------------------------------------------------
// The two kinds of email Quillio writes, and the ONE place their inbox-facing
// numbers live. Every email asset derives its subject and preheader bands from its
// class; the RAW rows above carry FROM_CLASS instead of literals, so there is
// nothing to keep in sync and nothing to fix in five places.
//
// That five-places problem is not hypothetical. Subject lines were 50–75 on all
// five assets, and correcting them meant five identical edits in the seed plus five
// rows in a migration; the preheader ceiling was wrong on all five for the same
// reason. One value, one edit, five assets.
//
// WHAT A CLASS GOVERNS — inbox-facing fields ONLY: subject line, preheader, and how
// many CTAs the email carries. These are properties of the CHANNEL. A subject line
// is cut at the same pixel whoever sent it, and an unsolicited email gets a
// different amount of patience than one the reader asked for.
//
// WHAT A CLASS DOES NOT GOVERN — BODY LENGTH. Deliberately, and this is the part a
// future session is most likely to "tidy up": the five assets have different body
// bands and that inconsistency is CORRECT. A reminder to someone who already
// registered has a different job than a nurture email trying to earn a click, and a
// recap has a different job again. Body length is a property of the MESSAGE, not
// the channel, so it stays per-asset. Unifying it would make four of the five
// assets wrong in order to make a table look neat.
//
// NOT A COLUMN ON asset_types, deliberately. Custom assets do not exist yet, so a
// class column would be written at seed time and read by nothing — the same dead
// column field_type was until the word-count work wired it end to end. A constant
// buys the single-source-of-truth benefit today, and converting it to a column when
// tenants can define their own assets is a small, mechanical change.
const EMAIL_CLASSES = {
  // Opted-in. HTML, branded. The reader asked for this. Goal: a CLICK.
  marketing: {
    label: 'marketing',
    subject: [0, 130],
    preheader: PREHEADER_BAND,
    ctas: 'one primary CTA',
    assets: [
      'Demand Gen Nurture Email',
      'Event Invitation Email',
      'Event Reminder Email',
      'Event Follow-Up / Recap Email',
    ],
  },
  // Unsolicited. Plain text, 1:1 feel. The reader did not ask for this. Goal: a
  // REPLY. The shorter subject is the whole difference at the inbox: cold B2B
  // performs best at roughly 2–4 words, where an opt-in subject keeps earning
  // clicks well past 130 characters.
  cold: {
    label: 'cold outreach',
    subject: [0, 40],
    preheader: PREHEADER_BAND,
    ctas: 'one ask',
    assets: ['Sales Basho Email'],
  },
};

// Which fields a class governs, and which key on the class supplies each one.
const CLASS_GOVERNED_FIELDS = {
  'Subject Line 1': 'subject',
  'Subject Line 2': 'subject',
  Preheader: 'preheader',
};

// assetName → its class entry. Every email asset must belong to exactly one class;
// classBand throws otherwise rather than silently seeding a null band.
const EMAIL_CLASS_BY_ASSET = new Map();
for (const cls of Object.values(EMAIL_CLASSES)) {
  for (const name of cls.assets) {
    if (EMAIL_CLASS_BY_ASSET.has(name)) {
      throw new Error(`defaultAssets: "${name}" is in two email classes`);
    }
    EMAIL_CLASS_BY_ASSET.set(name, cls);
  }
}

// Resolve a FROM_CLASS field's [min, max]. Throws rather than returning nulls: a
// class-governed field on an asset with no class would otherwise seed [0, 0], which
// renders as a field with NO bracket at all — a silently unlimited subject line.
function classBand(assetName, fieldName) {
  const cls = EMAIL_CLASS_BY_ASSET.get(assetName);
  if (!cls) {
    throw new Error(
      `defaultAssets: "${assetName}/${fieldName}" is class-governed but "${assetName}" ` +
        'is in no EMAIL_CLASSES member list'
    );
  }
  const key = CLASS_GOVERNED_FIELDS[fieldName];
  if (!key) throw new Error(`defaultAssets: no class key for field "${fieldName}"`);
  return cls[key];
}

// WHICH FIELDS CARRY A SUPPLIED FACT rather than generating one. Keyed by field
// NAME here because the seed is the only place a name is authoritative; the
// column exists precisely so nothing downstream has to match on names — a tenant
// who renames a field, or adds their own, keeps the flag on the row.
//
// One kind today, deliberately. `datetime` covers a date, a clock time and a
// venue, because "Date / Location Line" is one field carrying all three and a
// brief supplying only the venue still has something for it. The other candidate
// classes (prices, named customers, deliverables, statistics) are enumerated in
// ROADMAP.md and NOT started — this column takes one value and commits to
// nothing else.
// TWO KINDS, because one was wrong. All four fields transcribe a supplied fact
// rather than generating one — that part was right — but a track label carries a
// ROOM and a directional label carries a PLACE, and the note `datetime` gates
// says "The brief does not state a date or time", which on those two is a
// sentence about the wrong fact. scripts/migrateFixLocationFactKind.js moves the
// rows the first migration already wrote.
//
// NOTHING FIRES ON 'location' YET. It is out of scope until the detector is
// strong enough — briefFacts LOCATION misses "at Moscone West" and "at the
// Hilton" — and until a location invention has actually been measured. Every
// consumer gates on 'datetime' explicitly rather than on truthiness, so adding
// the value here switches nothing on.
const FACT_KIND_FIELDS = new Map([
  ['Date / Location Line', 'datetime'],
  ['Location Label', 'location'],
  ['Track / Room Label', 'location'],
]);

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
    // 255, not 600. LinkedIn's carousel specs page publishes "Introductory text:
    // 255 characters"; 600 appears nowhere on it. See
    // scripts/migrateFixLinkedInCarouselIntro.js for the fetched text and the
    // provenance of the 600.
    ['Intro Text', 0, 255],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
    ['Card 1 Headline', 0, 45],
    ['Card 2 Headline', 0, 45],
    ['Card 3 Headline', 0, 45],
    ['Card 4 Headline', 0, 45],
    ['Card 5 Headline', 0, 45],
  ]],
  // RETIRED — the four "— Variant A/B/C/D" copies of LinkedIn Single Image Ad.
  // Four identical asset types existed so a brief could ask for four versions of
  // one ad. Multi-instance made that a count: "4 LinkedIn ads" is one entry with
  // count 4, and the doc numbers the instances itself. Keeping them cost more
  // than the feature they stood in for — they were four of the thirty names the
  // parse had to choose between, and near-duplicates are what a name match gets
  // wrong. scripts/migrateRetireDeadAssets.js switches them off for tenants that
  // already have them.
  // META'S NUMBERS ARE READ OFF META'S OWN PER-FORMAT PAGES (August 2026). They
  // previously came from a general Facebook recommendation applied to two formats
  // it does not describe — see scripts/migrateFixMetaSpecs.js, which carries the
  // fetched page text.
  ['Meta Single Image Ad', 'Paid Social', [
    ['Primary Text', 50, 150],
    ['Headline', 0, 27],
    // 30 is QUILLIO'S number, not Meta's — /image's Text Recommendations lists
    // Primary Text and Headline only. The field stays (Description renders in
    // several placements and writers fill it); the CITATION goes, so it is tiered
    // house_default and cites quillio_default like any other house number.
    ['Description', 0, 30],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
  ]],
  ['Meta Carousel Ad', 'Paid Social', [
    ['Primary Text', 0, 80],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
    ['Card 1 Headline', 0, 20],
    ['Card 2 Headline', 0, 20],
    ['Card 3 Headline', 0, 20],
    ['Card 4 Headline', 0, 20],
    ['Card 5 Headline', 0, 20],
    ['Card Description', 0, 18],
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
  // THREE HEADLINES AND TWO DESCRIPTIONS ARE GOOGLE'S OWN MINIMUMS, not a
  // sample of the fifteen it accepts: "You’ll need to enter a minimum of 3
  // headlines, but you can enter up to 15" and "a minimum of 2 descriptions".
  // (The apostrophe is the page's U+2019. A straight one here would not match
  // the fetched text, which is how two quotes first read ABSENT.)
  // Seeding fifteen headline fields would put a writer in front of a wall of
  // empty slots before they have seen the product write anything, and Riffs is
  // the feature that covers the gap — one field per SHAPE, more by riffing,
  // which is what the Display asset above already does with its one Short
  // Headline. The seed is the minimum viable ad; the ceiling is the writer's.
  //
  // THE PATH COUNT IS THE ONE NUMBER HERE WITH NO PAGE BEHIND IT. The page
  // publishes the limit — "the path fields support up to 15 each" — and states
  // no count. Two is the interface's shape, not a cited figure. Recorded in
  // scripts/migrateAddGoogleSearchAsset.js rather than quietly shipped, because
  // the alternative is a number in a sourced library that nobody can trace.
  ['Google Responsive Search Ad', 'Paid Search', [
    ['Headline 1', 0, 30],
    ['Headline 2', 0, 30],
    ['Headline 3', 0, 30],
    ['Description 1', 0, 90],
    ['Description 2', 0, 90],
    ['Display Path 1', 0, 15],
    ['Display Path 2', 0, 15],
    ['Graphic Headline', 0, 70, 'Graphic Copy'],
    ['Subhead', 20, 40, 'Graphic Copy'],
    ['CTA Button', 0, 30, 'Graphic Copy'],
  ]],
  ['Demand Gen Nurture Email', 'Email', [
    ['Subject Line 1', FROM_CLASS, FROM_CLASS],
    ['Subject Line 2', FROM_CLASS, FROM_CLASS],
    ['Preheader', FROM_CLASS, FROM_CLASS],
    ['Headline (Offer 1)', 0, 60],
    ['Offer Body 1', 50, 140],
    ['CTA Text (Offer 1)', 0, 25],
    ['Headline (Offer 2)', 0, 60],
    ['Offer Body 2', 25, 60],
    ['CTA Text (Offer 2)', 0, 20],
  ]],
  ['Event Invitation Email', 'Email', [
    ['Subject Line 1', FROM_CLASS, FROM_CLASS],
    ['Subject Line 2', FROM_CLASS, FROM_CLASS],
    ['Preheader', FROM_CLASS, FROM_CLASS],
    ['Hero Headline', 0, 60],
    ['Event Description', 50, 125],
    ['Date / Location Line', 0, 80],
    ['CTA Text', 0, 25],
  ]],
  // A REMINDER NEEDS A PLACE TO PUT THE TIME. This asset shipped with a field
  // list byte-identical to Event Follow-Up / Recap Email — which genuinely needs
  // no date, because the event is over — and that shared shape is the follow-up's.
  // The consequence was measured: with nowhere to say when the event is, and an
  // asset_direction demanding urgency, drafts invented arrival times ("Starting
  // in 10 minutes", "We start in 24 hours") that disagreed with each other by a
  // full day. A reminder email with a wrong time makes the reader miss the event
  // — the only failure in this system that harms the READER rather than the
  // client. Named exactly as Event Invitation Email names it: a reminder and an
  // invitation must not disagree about what the field is called.
  ['Event Reminder Email', 'Email', [
    ['Subject Line 1', FROM_CLASS, FROM_CLASS],
    ['Subject Line 2', FROM_CLASS, FROM_CLASS],
    ['Preheader', FROM_CLASS, FROM_CLASS],
    ['Headline', 0, 60],
    ['Body Copy', 25, 75],
    ['Date / Location Line', 0, 80],
    ['CTA Text', 0, 25],
  ]],
  ['Event Follow-Up / Recap Email', 'Email', [
    ['Subject Line 1', FROM_CLASS, FROM_CLASS],
    ['Subject Line 2', FROM_CLASS, FROM_CLASS],
    ['Preheader', FROM_CLASS, FROM_CLASS],
    ['Headline', 0, 60],
    ['Body Copy', 25, 75],
    ['CTA Text', 0, 25],
  ]],
  ['Sales Basho Email', 'Email', [
    ['Subject Line 1', FROM_CLASS, FROM_CLASS],
    ['Subject Line 2', FROM_CLASS, FROM_CLASS],
    ['Preheader', FROM_CLASS, FROM_CLASS],
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
  // RETIRED — 'Form Confirm Page'. A form-and-confirmation page is a document a
  // tenant NAMES: they upload their own, confirm its fields, and a brief asks for
  // it by name. A three-field house approximation of the same artifact competed
  // with that name at parse time and won, which is how a brief asking for a
  // template came back with a copy-doc section instead.
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
  'Meta Single Image Ad': 'Lead with the insight or tension. Stop the scroll in the first line.',
  'Meta Carousel Ad': 'Each card standalone. Swipe tells a story. Last card closes.',
  'Twitter/X Ad': 'Punchy. Opinionated. One idea, no hedging.',
  'Display Banner — Standard': 'Fewest possible words. Headline does all the work. CTA is a verb.',
  'Google Responsive Display Ad':
    'System assembles combinations. Every element must work alone and together.',
  // PULL, not push — the reader typed the query. The one direction that
  // separates this asset from every other paid one in the library.
  'Google Responsive Search Ad':
    'They are already looking. Match the intent, name the thing, skip the setup.',
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
  // ASSET-LEVEL NOTES RENDER IN SETTINGS, NOT IN THE DOC — rowToSpecGroup carries
  // asset_direction and not this. That is the right surface for it: "why only
  // three headlines?" is a question a tenant asks of the LIBRARY, and the answer
  // is the page's own minimum. Both numbers below are quoted in
  // scripts/migrateAddGoogleSearchAsset.js.
  'Google Responsive Search Ad':
    'Google assembles each ad from the headlines and descriptions supplied, so every headline must read on its own and beside any other. Three headlines and two descriptions are Google’s stated minimum; it accepts up to 15 headlines — riff for more rather than seeding empty slots.',
};

// Field-level spec notes — per-field guidance rendered as an italic line under
// the field label (see fieldHint in destinations/googleDocs.js). Only "Hook"
// fields carry one today: the visible-then-"…more" explainer. The text is kept
// BYTE-IDENTICAL to the backfill in scripts/migrateAddCopyFieldSpecNote.js, so
// existing (migrated) and newly-seeded tenants render the exact same note.
const HOOK_SPEC_NOTE =
  'Only this opening runs before the app collapses the rest behind “…more.” ' +
  'Land the hook within the character limit; the full caption/post can keep going — it just shows after the fold.';

// LinkedIn Single Image Ad → Intro Text note. char_max is the page's own
// "Introductory text: 150 characters"; this note says WHY that number rather than
// restating it, which is what a note is for.
//
// THE "600 IS THE TECHNICAL MAX" CLAUSE WAS REMOVED 2026-08-18, and it is worth
// knowing why rather than assuming it was trimmed for length. 600 has no source:
// it entered at scripts/migrateFixLinkedInIntroText.js:3-4 as a bare assertion,
// and it appears NOWHERE on either LinkedIn specs page. The single-image page's
// only other large number is "URL characters: 2000 characters for destination
// field URL" — a limit on a different field entirely — so the claim was not even
// a misreading of something on the page. It corresponded to nothing.
//
// This string is customer-visible twice over: it renders as the italic line under
// the field label AND reaches the drafter as that field's `Field guidance:`.
// BYTE-IDENTICAL to NOTE in scripts/migrateFixLinkedInIntroText.js.
const LINKEDIN_SIA_INTRO_NOTE = 'In-feed preview truncates near 150.';

// Twitter/X → the post-copy fields. Real writing guidance the 280 cannot carry:
// LinkedIn-style truncation is not the issue here, link cost is.
//
// The page states: "post copy: 280 characters. (Note: each link used reduces
// character count by 23 characters, electing 257 characters for X copy.)"
//
// Worded for a writer rather than as provenance. The mechanism goes first because
// it is the part a writer gets wrong — the cost is FIXED regardless of URL length,
// which is not what anyone assumes — and the workable number goes second.
//
// NOT applied to Twitter/X Ad → Headline. The 23-character cost is on links in
// the post body; a headline is a separate field that does not carry them, and the
// page attaches the note to "post copy". Putting it there would have a writer
// budgeting for something that never happens.
const X_LINK_COST_NOTE =
  'Every link costs 23 characters regardless of its length, so a post with one link has 257 characters of copy.';

// Demand Gen Nurture Email → Offer Body 1 note. The cited figure and this field's
// number are DIFFERENT NUMBERS, and without this note a writer reads "Recommended
// by Constant Contact" beside [50-140 words] and has no way to reconcile them.
//
// Constant Contact measured whole EMAILS — ~20 lines, about 200 words, as the
// highest-click-through length for a newsletter. This asset has TWO body blocks
// that stack (craft.md § Email: "Secondary offers come after"), so the cited 200 is
// the budget for the pair, not for either one. 140 + Offer Body 2's 60 = 200.
//
// This is the same shape as the LinkedIn carousel note below: a real published
// number whose UNIT is not the unit the label can express, so the label carries
// what this field may use and the note carries what was actually measured.
// BYTE-IDENTICAL to OFFER_BODY_1_NOTE in
// scripts/migrateEmailClassesAndCitedBands.js.
const OFFER_BODY_1_NOTE =
  'The cited ~200 words is a WHOLE-EMAIL figure; this is one of two body blocks, so 140 here leaves 60 for Offer Body 2.';

// Sales Basho Email → Body Copy note. Gong's number is about the FIRST touch. A
// cold opener is earning the right to a reply from someone who did not ask to hear
// from you, and 50–100 words is what that costs; a follow-up in the same sequence
// is talking to someone who has already seen you once, and Gong's guidance for
// those runs longer. Without this note the band reads as a rule for every email in
// the sequence, which is not what was measured.
// BYTE-IDENTICAL to BASHO_BODY_NOTE in scripts/migrateCiteColdEmailBand.js.
const BASHO_BODY_NOTE =
  'Applies to the FIRST touch; Gong\'s guidance for follow-ups in the same sequence runs longer.';

// LinkedIn Carousel Ad → Card N Headline note. The 45 in the label is CONDITIONAL:
// it holds for a carousel driving to a destination URL, but a carousel whose CTA
// opens a Lead Gen Form caps its cards at 30. One field, two limits, and the label
// can only carry one number — so the note carries the other. Applied to all five
// card headlines. BYTE-IDENTICAL to CARD_HEADLINE_NOTE in
// scripts/migrateSpecIntegrityFixes.js.
const LINKEDIN_CAROUSEL_CARD_NOTE =
  'Applies to carousels driving to a destination URL; with a Lead Gen Form CTA the cap is 30.';

// Meta Carousel → card headline note. Meta's carousel page states ONE entry,
// "Headline: 20 characters", with no cardinality. The note tells a writer what
// they need to know: the 20 is per card, not a budget to divide across five.
//
// WHERE THE INFERENCE IS, for whoever maintains this. The page names a field and
// gives it a number; it does not say "per card". A Meta carousel has no
// format-level headline — the headline exists once per card by construction — so
// the field the page is naming can only be the per-card one. That is a claim
// about Meta's ad structure, not a quote from the page. The alternative reading,
// a single global headline at 20, describes a field this asset does not have and
// would leave all five card headlines sitting on the old wrong 40.
//
// The note deliberately does NOT say "we inferred this". A writer needs the fact,
// not our confidence in it. BYTE-IDENTICAL to CARD_HEADLINE_NOTE in
// scripts/migrateFixMetaSpecs.js.
const META_CAROUSEL_CARD_NOTE =
  'Meta publishes one Headline recommendation for carousel; it applies to each card.';

// NOTES THAT MAY BE SHOWN ONCE PER RUN OF ADJACENT FIELDS THAT SHARE THEM.
//
// ─── THE TEST, so you can classify your own sentence ────────────────────────
// Ask: IF A WRITER NEVER READS THIS NOTE, CAN THEY STILL FILL THE FIELD
// CORRECTLY?
//
//   YES  -> it restates something already in front of them, usually the bracket.
//           Add it here.
//   NO   -> it carries a fact the field does not, and they need it AT the field.
//           Leave it out.
//
// The two carousel notes are the worked example, and they look alike until you
// apply the test:
//
//   META_CAROUSEL_CARD_NOTE — "it applies to each card". The writer is looking at
//     "Card 3 Headline [20]". The note tells them the 20 is theirs alone rather
//     than a fifth of a budget — true of the bracket they can already see, and
//     equally true whether or not they read it. SHOW ONCE.
//
//   LINKEDIN_CAROUSEL_CARD_NOTE — "with a Lead Gen Form CTA the cap is 30". This
//     is a SECOND LIMIT, conditional on something the document cannot know. The
//     bracket says 45 and for some campaigns it is wrong. A writer on Card 4 who
//     did not read it writes 45 into a field that caps at 30 and ships a broken
//     deliverable. SHOW EVERY TIME.
//
// The difference is not length, tone, or how repetitive it feels on the page. It
// is whether the sentence is REDUNDANT with the field or ADDITIONAL to it.
//
// ─── WHY OPT-IN, AND WHY THAT DEFAULT IS NOT NEGOTIABLE ─────────────────────
// Absence means show on every field. A note nobody has classified stays visible,
// so the cost of forgetting is a wall of text; the cost of the opposite default
// would be silently hiding a conditional limit from the writer it protects. The
// two failures are not comparable and the default is set against the worse one.
//
// Three things inherit that safe default for free: a note edited here stops
// matching and reverts to showing; a tenant's overridden note is a different
// string and is never a member; and a NEW note is absent until someone decides.
//
// ─── SCOPE ──────────────────────────────────────────────────────────────────
// Keyed by the note CONSTANT, not by (asset, field): five card headlines share
// one sentence, so five keys would be five chances to disagree. One entry, one
// decision. Suppression applies only to a run of ADJACENT fields sharing the
// note — a gap resets it, because the same sentence reappearing seven fields
// later is not repetition, it is a different reader.
//
// EMAIL_SUBJECT_NOTE IS DELIBERATELY ABSENT. "Front-load the first 40" is an
// instruction about how to build a line, and Subject Line 2 is a different line
// being built — it fails the test above. scripts/notesAB.js measured it moving
// Subject Line 1's median length 55 -> 44 and its in-band rate 1/5 -> 4/5, so it
// demonstrably acts on the copy at the field rather than sitting as background. A
// sentence that changes what gets written is not one to hide.
const SHOW_ONCE_NOTES = new Set([META_CAROUSEL_CARD_NOTE]);

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
  // X's link cost, on the two POST COPY fields and deliberately not on the
  // headline — see X_LINK_COST_NOTE. Matched per (asset, field) rather than by
  // field name, because "Headline" exists on the same asset.
  if (assetName === 'Twitter/X Ad' && fieldName === 'Ad Copy') return X_LINK_COST_NOTE;
  if (assetName === 'Organic Social — Twitter/X' && fieldName === 'Post Copy') return X_LINK_COST_NOTE;
  if (assetName === 'Demand Gen Nurture Email' && fieldName === 'Offer Body 1') return OFFER_BODY_1_NOTE;
  if (assetName === 'Sales Basho Email' && fieldName === 'Body Copy') return BASHO_BODY_NOTE;
  if (assetName === 'LinkedIn Carousel Ad' && LINKEDIN_CAROUSEL_CARD_FIELDS.has(fieldName)) {
    return LINKEDIN_CAROUSEL_CARD_NOTE;
  }
  // Same field names on a different platform — matched on the asset too, so a
  // LinkedIn card never picks up Meta's note or the reverse.
  if (assetName === 'Meta Carousel Ad' && LINKEDIN_CAROUSEL_CARD_FIELDS.has(fieldName)) {
    return META_CAROUSEL_CARD_NOTE;
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
  // The two NON-platform recommendations in the library: research findings rather
  // than spec pages. Each cites the one field it measured, and each tier line names
  // what was measured — a click rate on opt-in marketing is not a reply rate on
  // cold outreach, and applying one where the other belongs is the mistake the
  // scope clause exists to prevent.
  'Sales Basho Email||Body Copy',
  // The other NON-platform recommendation: a research finding rather
  // than a spec page. Constant Contact reports ~20 lines / ~200 words as the
  // highest click-through length. It is tiered 'recommended' because that is what
  // it is — an advisory number from a real source — and the tier line says exactly
  // what was measured, because small-business campaign data is not B2B nurture data
  // and a writer deciding whether to trust the number needs to know that.
  'Demand Gen Nurture Email||Offer Body 1',
  'Meta Single Image Ad||Primary Text',
  'Meta Single Image Ad||Headline',
  // 'Meta Single Image Ad||Description' IS DELIBERATELY ABSENT. Meta's /image page
  // publishes no Description recommendation, so there is nothing to cite and the
  // field falls through to house_default — which is the honest tier for a number
  // only Quillio holds. See scripts/migrateFixMetaSpecs.js.
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
  // ENFORCED ON THE PAGE'S OWN WORDS, and this is NOT the LinkedIn case.
  //
  // CLAUDE.md carries an open question about LinkedIn's nine enforced fields,
  // and the evidence that opened it was a HEADING: both LinkedIn spec pages put
  // their numbers under "Text Recommendations", which is recommendation language
  // sitting over a tier that claims a cap. Nothing on this page does that.
  // Google states them as limits in prose — "responsive search ads have
  // character limits", "The headline fields ... support up to 30 characters" —
  // and "support up to" is a ceiling, not advice.
  //
  // So the LinkedIn caution does not transfer here, and nobody should read it as
  // though it does. Different evidence, different tier. What WOULD reopen this is
  // the same thing that would settle LinkedIn: pasting 200 characters into a
  // 30-character headline in the ads interface and watching what happens.
  'Google Responsive Search Ad||Headline 1',
  'Google Responsive Search Ad||Headline 2',
  'Google Responsive Search Ad||Headline 3',
  'Google Responsive Search Ad||Description 1',
  'Google Responsive Search Ad||Description 2',
  'Google Responsive Search Ad||Display Path 1',
  'Google Responsive Search Ad||Display Path 2',
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
// URLs are kept BYTE-IDENTICAL to the SOURCE_URLS map of whichever migration is
// the CURRENT authority for that asset (asserted by a smoke test, which spreads
// them in order): scripts/migrateMetaPlacementCitations.js for the two Meta
// assets, scripts/migrateSpecIntegrityFixes.js for the rest. Meta has moved twice
// and each earlier map is LEFT AS IT WAS — they are WRITES, and editing one into
// agreement with a later step would both re-point Meta on a re-run and turn the
// replay chain into a false account of what each step did.
const SPEC_SOURCE_URLS = {
  // PER PLACEMENT, and it took two corrections to get here — the same defect
  // twice, one level apart each time.
  //
  //   .../ads-guide/update              the INDEX. 2,208 chars of nav, marketing
  //                                     copy and a signup form, no character
  //                                     limit anywhere, stating outright that the
  //                                     specs are elsewhere.
  //   .../ads-guide/update/image        the FORMAT page. Carries limits, and
  //                                     serves Facebook Feed's by default while
  //                                     naming no placement — so a reader could
  //                                     find A number but not learn which of the
  //                                     five it was.
  //   .../update/image/facebook-feed    the PLACEMENT page. Primary Text is 150
  //                                     here and 44 on instagram-reels, from the
  //                                     same guide.
  //
  // Both times the test was the same: can a reader who doubts this number follow
  // the link and settle it? The bare format URL passes that test by accident, on
  // one placement, and says nothing about the accident.
  'Meta Single Image Ad': 'https://www.facebook.com/business/ads-guide/update/image/facebook-feed',
  'Meta Carousel Ad': 'https://www.facebook.com/business/ads-guide/update/carousel/facebook-feed',
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
  // answer/7684791 — "About responsive search ads". THE SAME URL THAT WAS ONCE
  // WRONG ON THE DISPLAY ASSET, now on the asset it actually describes.
  //
  // That is worth stating rather than leaving as a coincidence for somebody to
  // trip over: scripts/migrateFixGoogleSpecSource.js moved the four Display
  // fields OFF this page in July because it is the search article, and
  // checkSpecHealth still reports "URL CHANGED since a flag (was answer/7684791)"
  // on the Display watch row from the flags that repoint dismissed. Anyone who
  // meets that line and then finds this URL back in the file needs to know the
  // two facts are the same fact seen twice.
  //
  // The Display numbers were confirmed against their own page in the 2026-08-20
  // audit (scripts/migrateBackfillSpecVerifiedAt.js), so nothing is outstanding
  // there.
  'Google Responsive Search Ad': 'https://support.google.com/google-ads/answer/7684791',
};

// Per-FIELD spec source, for the handful of fields whose citation is not their
// asset's platform page. Checked before SPEC_SOURCE_URLS. Email has no platform
// spec page — nobody publishes a "limit" for a nurture body — so a research finding
// is cited directly on the one field it measured.
const FIELD_SPEC_SOURCE_URLS = {
  'Demand Gen Nurture Email||Offer Body 1':
    'https://www.constantcontact.com/blog/best-length-email-newsletter/',
  'Sales Basho Email||Body Copy':
    'https://www.gong.io/blog/do-execs-really-reply-to-cold-email-here-s-what-the-data-says',
};

function fieldSpecSource(assetName, fieldName) {
  if (fieldSpecType(assetName, fieldName) === 'house_default') return SPEC_SOURCE;
  return (
    FIELD_SPEC_SOURCE_URLS[`${assetName}||${fieldName}`] || SPEC_SOURCE_URLS[assetName] || SPEC_SOURCE
  );
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
  fields: fields.map(([field_name, rawMin, rawMax, group_label], j) => ({
    field_name,
    // FROM_CLASS (null) means the band is the CLASS's, not this row's — resolved
    // here so EMAIL_CLASSES is the only place those numbers appear.
    char_min: rawMin === FROM_CLASS ? classBand(name, field_name)[0] : rawMin,
    char_max: rawMax === FROM_CLASS ? classBand(name, field_name)[1] : rawMax,
    field_type: fieldUnit(name, field_name),
    sort_order: j + 1,
    group_label: group_label || null,
    spec_note: fieldSpecNote(name, field_name),
    spec_type: fieldSpecType(name, field_name),
    spec_source: fieldSpecSource(name, field_name),
    fact_kind: FACT_KIND_FIELDS.get(field_name) || null,
  })),
}));

module.exports = {
  DEFAULT_ASSETS,
  // Read by destinations/googleDocs.js, which decides per document whether a
  // repeated note is emitted again. Exported rather than duplicated there: a
  // second copy of these strings would drift the first time one was edited, and
  // drifting silently back to "show every time" is the harmless direction only
  // by luck.
  SHOW_ONCE_NOTES,
};
