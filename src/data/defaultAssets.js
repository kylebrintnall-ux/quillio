'use strict';

// Default asset library — Quillio Asset & Field Library v3. Seeded into a new
// tenant's asset_types / copy_fields on install. Source of truth: the v3 Sheet
// (1NVDCcjPO2ZG1Vmt40WTwTYmXTl27dBiwrinHHKK9tCU), transcribed June 2026.
//
// Authored compactly as [name, group, [[fieldName, charMin, charMax], …]] and
// normalized below into the seed shape (adds sort_order, is_active, field_type,
// and the spec metadata). field_type is 'text' for every current field.

const SPEC_SOURCE = 'quillio_default';
const SPEC_VERSION = '1.0';

const RAW = [
  ['LinkedIn Single Image Ad', 'Paid Social', [
    ['Intro Text', 0, 150],
    ['Headline', 0, 70],
    ['CTA Button', 0, 20],
    ['LAN Description', 0, 70],
  ]],
  ['LinkedIn Carousel Ad', 'Paid Social', [
    ['Intro Text', 0, 150],
    ['Card 1 Headline', 0, 45],
    ['Card 2 Headline', 0, 45],
    ['Card 3 Headline', 0, 45],
    ['Card 4 Headline', 0, 45],
    ['Card 5 Headline', 0, 45],
    ['CTA Button', 0, 20],
  ]],
  ['LinkedIn Single Image Ad — Variant A', 'Paid Social', [
    ['Intro Text', 0, 150],
    ['Headline', 0, 70],
    ['CTA Button', 0, 20],
  ]],
  ['LinkedIn Single Image Ad — Variant B', 'Paid Social', [
    ['Intro Text', 0, 150],
    ['Headline', 0, 70],
    ['CTA Button', 0, 20],
  ]],
  ['LinkedIn Single Image Ad — Variant C', 'Paid Social', [
    ['Intro Text', 0, 150],
    ['Headline', 0, 70],
    ['CTA Button', 0, 20],
  ]],
  ['LinkedIn Single Image Ad — Variant D', 'Paid Social', [
    ['Intro Text', 0, 150],
    ['Headline', 0, 70],
    ['CTA Button', 0, 20],
  ]],
  ['Meta Single Image Ad', 'Paid Social', [
    ['Primary Text', 0, 125],
    ['Headline', 0, 27],
    ['Description', 0, 30],
    ['CTA Button', 0, 20],
  ]],
  ['Meta Carousel Ad', 'Paid Social', [
    ['Primary Text', 0, 125],
    ['Card 1 Headline', 0, 45],
    ['Card 2 Headline', 0, 45],
    ['Card 3 Headline', 0, 45],
    ['Card 4 Headline', 0, 45],
    ['Card 5 Headline', 0, 45],
    ['Card Description', 0, 18],
    ['CTA Button', 0, 20],
  ]],
  ['Twitter/X Ad', 'Paid Social', [
    ['Ad Copy', 0, 280],
    ['Headline', 0, 70],
    ['CTA Button', 0, 20],
  ]],
  ['Display Banner — Standard', 'Display', [
    ['Headline', 0, 30],
    ['Body Copy', 0, 90],
    ['CTA Button', 0, 20],
  ]],
  ['Google DV360 / Responsive Display', 'Display', [
    ['Short Headline', 0, 30],
    ['Long Headline', 0, 90],
    ['Description', 0, 90],
    ['Business Name', 0, 25],
    ['CTA Button', 0, 30],
  ]],
  ['Demand Gen Nurture Email', 'Email', [
    ['Subject Line 1', 40, 60],
    ['Subject Line 2', 40, 60],
    ['Preheader', 85, 100],
    ['Headline (Offer 1)', 0, 60],
    ['Offer Body 1', 0, 500],
    ['CTA Text (Offer 1)', 0, 25],
    ['Headline (Offer 2)', 0, 60],
    ['Offer Body 2', 0, 165],
    ['CTA Text (Offer 2)', 0, 20],
  ]],
  ['Event Invitation Email', 'Email', [
    ['Subject Line 1', 40, 60],
    ['Subject Line 2', 40, 60],
    ['Preheader', 85, 100],
    ['Hero Headline', 0, 60],
    ['Event Description', 0, 300],
    ['Date / Location Line', 0, 80],
    ['CTA Text', 0, 25],
  ]],
  ['Event Reminder Email', 'Email', [
    ['Subject Line', 40, 60],
    ['Preheader', 85, 100],
    ['Headline', 0, 60],
    ['Body Copy', 0, 200],
    ['CTA Text', 0, 25],
  ]],
  ['Event Follow-Up / Recap Email', 'Email', [
    ['Subject Line', 40, 60],
    ['Preheader', 85, 100],
    ['Headline', 0, 60],
    ['Body Copy', 0, 350],
    ['CTA Text', 0, 25],
  ]],
  ['Sales Basho Email', 'Email', [
    ['Subject Line', 0, 60],
    ['Opening Line', 0, 100],
    ['Body Copy', 0, 300],
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
  ]],
  ['On-Site Signage — General', 'Events', [
    ['Headline', 0, 50],
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
  ]],
  ['Form Confirm Page', 'Web', [
    ['Headline', 0, 60],
    ['Subheadline / Body', 0, 200],
    ['CTA', 0, 40],
  ]],
  ['Organic Social — LinkedIn', 'Organic Social', [
    ['Post Copy', 0, 700],
    ['Headline (if link)', 0, 70],
  ]],
  ['Organic Social — Instagram', 'Organic Social', [
    ['Caption', 0, 300],
    ['Alt Text', 0, 100],
  ]],
  ['Organic Social — Twitter/X', 'Organic Social', [
    ['Post Copy', 0, 280],
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

const DEFAULT_ASSETS = RAW.map(([name, group, fields], i) => ({
  name,
  group,
  sort_order: i + 1,
  is_active: true,
  spec_source: SPEC_SOURCE,
  spec_version: SPEC_VERSION,
  fields: fields.map(([field_name, char_min, char_max], j) => ({
    field_name,
    char_min,
    char_max,
    field_type: 'text',
    sort_order: j + 1,
  })),
}));

module.exports = { DEFAULT_ASSETS };
