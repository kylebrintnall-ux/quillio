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
// Authored compactly as [name, group, [[fieldName, charMin, charMax, groupLabel?], …]]
// and normalized below into the seed shape (adds sort_order, is_active, field_type,
// spec metadata, asset_direction and spec_note). field_type is 'text' for every
// current field. The optional 4th field element is a group_label: consecutive
// fields sharing one (e.g. 'Graphic Copy') render under a single indented
// sub-heading in the Doc — the on-graphic copy (Graphic Headline, Subhead, and
// CTA on paid/display) grouped so it reads as one unit and maps to Figma layers.

const SPEC_SOURCE = 'quillio_default';
const SPEC_VERSION = '1.0';

const RAW = [
  ['LinkedIn Single Image Ad', 'Paid Social', [
    ['Intro Text', 0, 600],
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
    ['Graphic Headline', 0, 40, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
  ]],
  ['Meta Carousel Ad', 'Paid Social', [
    ['Primary Text', 0, 125],
    ['Graphic Headline', 0, 40, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
    ['Card 1 Headline', 0, 45],
    ['Card 2 Headline', 0, 45],
    ['Card 3 Headline', 0, 45],
    ['Card 4 Headline', 0, 45],
    ['Card 5 Headline', 0, 45],
    ['Card Description', 0, 18],
  ]],
  ['Twitter/X Ad', 'Paid Social', [
    ['Ad Copy', 0, 280],
    ['Headline', 0, 70],
    ['Graphic Headline', 0, 40, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
  ]],
  ['Display Banner — Standard', 'Display', [
    ['Graphic Headline', 0, 30, 'Graphic Copy'],
    ['Subhead', 20, 40, 'Graphic Copy'],
    ['Body Copy', 0, 90, 'Graphic Copy'],
    ['CTA Button', 0, 20, 'Graphic Copy'],
  ]],
  ['Google DV360 / Responsive Display', 'Display', [
    ['Short Headline', 0, 30],
    ['Long Headline', 0, 90],
    ['Description', 0, 90],
    ['Business Name', 0, 25],
    ['Graphic Headline', 0, 30, 'Graphic Copy'],
    ['Subhead', 20, 40, 'Graphic Copy'],
    ['CTA Button', 0, 30, 'Graphic Copy'],
  ]],
  ['Demand Gen Nurture Email', 'Email', [
    ['Subject Line 1', 50, 75],
    ['Subject Line 2', 50, 75],
    ['Preheader', 85, 120],
    ['Headline (Offer 1)', 0, 60],
    ['Offer Body 1', 0, 500],
    ['CTA Text (Offer 1)', 0, 25],
    ['Headline (Offer 2)', 0, 60],
    ['Offer Body 2', 0, 165],
    ['CTA Text (Offer 2)', 0, 20],
  ]],
  ['Event Invitation Email', 'Email', [
    ['Subject Line 1', 50, 75],
    ['Subject Line 2', 50, 75],
    ['Preheader', 85, 120],
    ['Hero Headline', 0, 60],
    ['Event Description', 0, 300],
    ['Date / Location Line', 0, 80],
    ['CTA Text', 0, 25],
  ]],
  ['Event Reminder Email', 'Email', [
    ['Subject Line 1', 50, 75],
    ['Subject Line 2', 50, 75],
    ['Preheader', 85, 120],
    ['Headline', 0, 60],
    ['Body Copy', 0, 200],
    ['CTA Text', 0, 25],
  ]],
  ['Event Follow-Up / Recap Email', 'Email', [
    ['Subject Line 1', 50, 75],
    ['Subject Line 2', 50, 75],
    ['Preheader', 85, 120],
    ['Headline', 0, 60],
    ['Body Copy', 0, 350],
    ['CTA Text', 0, 25],
  ]],
  ['Sales Basho Email', 'Email', [
    ['Subject Line 1', 50, 75],
    ['Subject Line 2', 50, 75],
    ['Preheader', 85, 120],
    ['Opening Line', 0, 100],
    ['Body Copy', 0, 275],
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
    ['Post Copy', 0, 3000],
    ['Hook (first 150 chars, before See more)', 0, 150],
    ['Graphic Headline', 0, 40, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['Headline (if link)', 0, 70],
  ]],
  ['Organic Social — Instagram', 'Organic Social', [
    ['Caption', 0, 2200],
    ['Hook (first 125 chars, before More)', 0, 125],
    ['Graphic Headline', 0, 40, 'Graphic Copy'],
    ['Subhead', 40, 90, 'Graphic Copy'],
    ['Alt Text', 0, 100],
  ]],
  ['Organic Social — Twitter/X', 'Organic Social', [
    ['Post Copy', 0, 280],
    ['Graphic Headline', 0, 40, 'Graphic Copy'],
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
  'Google DV360 / Responsive Display':
    'System assembles combinations. Every element must work alone and together.',
  'Demand Gen Nurture Email': 'Curiosity or tension in the subject. No clickbait. Earn the click.',
  'Event Invitation Email': 'Make the value of attending undeniable. Date and CTA above the fold.',
  'Event Reminder Email': 'Urgency without panic. Reinforce the one reason to show up.',
  'Event Follow-Up / Recap Email': 'Gratitude first, value second, next step third.',
  'Sales Basho Email':
    'Write as a human, not a brand. Open with Dear [First Name]. Short sentences and short paragraphs. One clear ask. No marketing speak. Feels like it came from a real person, not a campaign.',
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
  'Google DV360 / Responsive Display':
    'Responsive — the platform assembles combinations across sizes from one copy set. Every element must read on its own and in combination.',
};

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
    field_type: 'text',
    sort_order: j + 1,
    group_label: group_label || null,
  })),
}));

module.exports = { DEFAULT_ASSETS };
