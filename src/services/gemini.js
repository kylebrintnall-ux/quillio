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

  // PERFORMANCE MAX GOES FIRST, AND THAT POSITION IS THE FIX RATHER THAN A
  // PREFERENCE. It did not fall through to the null fallback — it MATCHED, on
  // the last branch, because `a.includes('form')` is true of "perFORMance". So
  // the one Google asset that assembles its own ad was receiving the
  // Confirmation / Post-Conversion section and nothing else: not Display, not
  // Search, not the fallback's eight. A substring collision reads as a working
  // route from every direction — the function returns a non-null array, no test
  // asked which one, and CLAUDE.md's own note about this file listed the asset
  // as unmatched. Anchoring the branch above the loose keywords is what stops a
  // future asset name being decided by a syllable.
  //
  // ONE SECTION, NOT TWO, and the argument is against the obvious reading.
  // Performance Max serves Search, Display, YouTube, Gmail, Discover and Maps
  // inventory, so "it spans both, give it both" is the natural call. Rejected on
  // three counts, each checkable:
  //
  //   1. THE DISPLAY SECTION DESCRIBES THIS ASSET'S FIELD SHAPE and the Search
  //      section does not. Display: "Short headline (30) carries the message
  //      universally; long headline (90) should stand alone since description
  //      sometimes doesn't render." PMax is Headline 1-3 [30], Long Headline
  //      [90], Description 1-2 [90] — the responsive-assembly shape it shares
  //      with Google Responsive Display Ad, whose asset_direction ("System
  //      assembles combinations. Every element must work alone and together.")
  //      is near word-for-word PMax's own. Search has no long-headline concept.
  //
  //   2. THE SEARCH SECTION'S CENTRAL INSTRUCTION IS FALSE HERE. "Match the
  //      search intent. Include the keyword." Performance Max has no keywords —
  //      that is the defining property of the campaign type. An instruction to
  //      include a thing that does not exist is not neutral filler.
  //
  //   3. THE TWO SECTIONS CONTRADICT EACH OTHER IN THEIR OPENING CLAUSE.
  //      Display: "Push advertising — interrupts browsing." Search: "Pull
  //      advertising — the reader is actively looking." Injecting both puts two
  //      mutually exclusive reader models in one prompt, which is the shape
  //      CLAUDE.md records for craft.md §1.4 against the §2 punctuation
  //      permission — where the measured adoption of the losing rule was 0/12.
  //      The likely outcome is not a blend; it is one silently winning.
  //
  // Search USED TO carry "write all 15 headlines to give the algorithm room",
  // which was a fourth reason not to route here: it contradicted Responsive
  // Search Ad's three headline fields, and PMax also has three. That clause is
  // gone from craft.md now, so this particular hazard is spent — the three
  // reasons above are what hold the branch, and they are enough on their own.
  //
  // The counter-argument — PMax genuinely runs on Search inventory — is a fact
  // about where the ad APPEARS, not about how the copy is WRITTEN. The writing
  // problem is "every asset has to stand alone and beside any other", which is
  // the Display section's subject and the whole of PMax's asset_direction.
  if (a.includes('performance max') || a.includes('pmax')) return ['google display'];

  // PINTEREST AND DEMAND GEN, both seeded August 2026, both previously null →
  // all eight sections. Each is grouped 'Paid Social' in the seed and each is
  // interruptive feed copy the reader did not ask for, which is exactly what
  // that section opens by saying. Neither has a section of its own in craft.md
  // and neither is close enough to Display or Email to borrow one, so this is
  // the section that applies rather than the nearest available.
  //
  // What they LOSE by being routed is the point of routing them: Print /
  // Out-of-Home, Sales / 1:1 Outreach, Email and Confirmation were all reaching
  // a Pinterest title.
  //
  // 'demand gen VIDEO' AND NOT 'demand gen', AND THIS ONE ALREADY BIT. The first
  // version of this branch tested `a.includes('demand gen')`, which is also true
  // of "Demand Gen Nurture Email" — so the library's most-used email asset was
  // silently rerouted from ['email'] to ['paid social'], losing the subject-line
  // and pre-header guidance that is the whole reason that section exists.
  //
  // It survived a green suite, including the every-asset-matches-a-branch test
  // added in this same commit: the email still MATCHED, just not correctly. It
  // was caught the moment the full routing table below was written out by value,
  // which is the argument for that test in one line — a coverage check cannot
  // see a mis-route, because a mis-route is coverage.
  //
  // Second instance of `form`/"perFORMance" in one function, introduced by the
  // person writing the comment warning about it.
  if (a.includes('pinterest')) return ['paid social'];
  if (a.includes('demand gen video')) return ['paid social'];

  // DIRECT MAIL AND ON-SITE SIGNAGE → "### Print / Out-of-Home", six assets.
  //
  // The section is four sentences and every one of them is about these six:
  // "No click, no link — the copy has to do everything. Fewer words, bigger
  // idea. Memorable over detailed. The reader sees it for seconds — one message,
  // cleanly delivered. Include a clear, simple way to act (URL, QR, search
  // term)." The "no click, no link" premise is FALSE of all eight of the other
  // sections and true of all six of these, which is as clean as a routing
  // decision gets in this file.
  //
  // WHY THIS IS THE SAME CHANGE AS PINTEREST AND NOT A RISKIER ONE. Both narrow
  // an asset from all eight sections to the single one that describes it — the
  // direction is identical and so is the mechanism. What these six were getting
  // instead included Google Search's "include the keyword" and Email's
  // "~50 chars to avoid inbox truncation", advice about mediums a printed insert
  // does not have. Deferring them while shipping Pinterest would have been an
  // inconsistency in the commit, not caution.
  //
  // 'direct mail' AND NOT 'direct', deliberately: "On-Site Signage —
  // Directional" contains "direct", and a shorter keyword here would route it
  // through the mail branch instead of the signage one. Same answer either way
  // today, which is exactly what makes it the kind of collision that survives —
  // see the `form` note at the bottom of this function.
  if (a.includes('direct mail') || a.includes('signage')) return ['print'];

  // ORGANIC BEFORE PAID, AND THE ORDER IS THE WHOLE FIX.
  //
  // All three seeded organic assets are named "Organic Social — LinkedIn",
  // "— Instagram" and "— Twitter/X". The platform regex below matches
  // "linkedin", "instagram" and "twitter", so with paid tested first every one
  // of them received the PAID section and craft.md's "### Organic Social" was
  // unreachable for the entire seeded library — dead the same way "### Google
  // Search" was before a search asset existed.
  //
  // The sentence they never saw is the one that matters, and it is aimed
  // precisely at the mistake the mis-route was making: "Don't run paid copy as
  // organic or it reads like an ad in the feed."
  //
  // REORDERED RATHER THAN NARROWING THE PLATFORM REGEX. Both would work.
  // Reordering is the smaller change and 'organic' is unambiguous — no asset
  // that is not organic contains it — where a narrowed regex would need a
  // negative lookahead per platform and would have to be kept in step with the
  // seed. This ordering also states the precedence outright: an asset naming
  // both a platform and organic is organic, which is the correct reading of
  // every name in the library today.
  if (a.includes('organic')) return ['organic social'];
  if (a.includes('paid social') || /\b(linkedin|meta|facebook|instagram|twitter)\b/.test(a)) {
    return ['paid social'];
  }
  if (a.includes('display') || a.includes('banner')) return ['google display'];
  // craft.md's "### Google Search" section has existed since the file's first
  // commit and NOTHING HAS EVER SELECTED IT — there was no search asset, so no
  // asset name reached this branch and the section only ever arrived through the
  // fallback below, bundled with all seven others. 'Google Responsive Search Ad'
  // is what makes it reachable.
  //
  // It goes AFTER the display branch on purpose: 'display' and 'search' are
  // disjoint on every name in the library today, but the ordering states which
  // wins if a tenant ever authors "Search Display Banner", and the display
  // section is the one that describes a banner.
  //
  // THE CONFLICT THIS BRANCH ONCE CARRIED IS RESOLVED, and how it was resolved
  // is the part worth keeping. The section ended "write all 15 headlines to give
  // the algorithm room" while this asset has THREE headline fields. Before this
  // branch existed the sentence was one of eight mediums in a fallback; adding
  // the branch made it the ONLY medium section a search-ad prompt carries, which
  // is what turned a dormant line into a live contradiction against the asset
  // direction in the same prompt.
  //
  // It was fixed in craft.md rather than here, on a boundary that generalises:
  // craft.md states CRAFT, and how many fields an asset has is not a craft fact
  // — it is an asset fact, and it already arrives per asset from asset_direction
  // and the field list. The per-field ceiling arrives too, in limitLine, which is
  // the LAST line of the prompt; the section's "Headlines 30 chars, descriptions
  // 90 chars" was upstream duplication of it and went at the same time.
  if (a.includes('search')) return ['google search'];
  if (a.includes('basho') || a.includes('sales') || a.includes('outbound')) return ['sales'];
  if (a.includes('email')) return ['email'];
  // `form` IS A SUBSTRING TRAP. It matches "perFORMance", which is how Google
  // Performance Max spent its whole life on this branch — see the top of this
  // function. It also matches "transFORM", "inFORMation" and "plaTFORM". The
  // Performance Max branch above is anchored ahead of it rather than this test
  // being narrowed, because narrowing it to \bform\b would still match "Form
  // Confirmation" and miss nothing today, but a word-boundary regex here is a
  // second thing to keep in step with the seed; the test below is what actually
  // catches the next collision, by asserting every seeded name reaches a branch.
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

// HOW TO READ THE EVIDENCE FOR FUNNEL STAGE — ONE DEFINITION, SHARED VERBATIM.
//
// The variant-review prompt has told the model to infer the funnel stage since
// it was written; the DRAFT prompts never did, and `funnelStage` reaches them as
// the empty string (core/pipeline.js sets it, with a comment saying the Sheet
// column that fed it is gone). So two prompts in one system disagreed about
// whether funnel stage is knowable — and since the raw brief arrived, the one
// that says no holds exactly the evidence the one that says yes is told to read.
//
// This is the shared DEFINITION, and it lives here rather than in craft.md for
// three reasons:
//
//   • craft.md answers "how does good copy work". This answers "what is this
//     campaign", which is a different question and a different authority.
//   • craft.md is SLICED PER ASSET and injected by brandVoiceLines BEFORE any
//     campaign context enters the prompt. An instruction to infer from "the
//     asset type + brief" would sit above the brief it refers to.
//   • craft.md is a tenant-facing document about writing. A rule about how to
//     read the inputs is the system's, not the house style's.
//
// The two consequence clauses below are per-prompt on purpose. "Which doorway
// fits" is meaningful only where doorways exist (the review path); the draft
// prompts have no such concept and a dangling term is worse than none. What must
// never drift — the definition of top- and bottom-of-funnel — is the part that
// is shared, and a source test asserts both prompts reach for it.
const FUNNEL_STAGE_INFERENCE = [
  'Infer the FUNNEL STAGE from the asset type + brief: organic social / brand awareness is',
  'TOP-of-funnel (a cold, scrolling audience that does not trust you yet); a demo email or',
  'landing-page CTA is BOTTOM-of-funnel.',
];
const FUNNEL_STAGE_FOR_REVIEW = 'Funnel stage shapes which doorway fits.';
const FUNNEL_STAGE_FOR_DRAFT = 'Funnel stage shapes what this copy has to do.';

// THE JSON ENVELOPE RULE — one wording, two prompts, and the SCOPE is the point.
//
// This was two sentences that had drifted apart already:
//   generateAssetDrafts    'Respond with valid JSON only, no markdown, no backticks.'
//   buildVariationsPrompt  'Valid JSON only — no markdown, no backticks, no commentary.'
//
// Both mean the RESPONSE ENVELOPE — do not wrap the JSON in a fenced code block
// — and neither said so. Read literally, "no markdown" forbids markdown
// ANYWHERE, and the JSON's string values are the copy. A bulleted body is
// markdown, so the sentence forbade the thing the copy might need.
//
// IT WAS WRONG ON ITS OWN TERMS BEFORE ANY BULLETS RULE EXISTED. The constraint
// is about the wrapper; the copy is inside it; one sentence covered both without
// distinguishing them. craft.md §3 only made the cost visible: measured on the
// real batch prompt for Demand Gen Nurture Email, the old line sat 650 chars
// after the field it governs and 56 from the end of a 20,189-char prompt — the
// most recent instruction the model reads, contradicting a rule 13,643 chars
// back.
//
// ONE CONSTANT, because two prompts each carrying their own wording is exactly
// the review-overlay duplication CLAUDE.md names as the lesson not to repeat.
//
// MODELLED ON reviewCopyFields, which already gets the envelope half right
// ("Do NOT wrap the JSON in markdown code fences (no ``` and no ```json)"). It
// is not folded in here: its output is an ARRAY with a first-character rule and
// no copy strings, so it needs neither the scope clause nor this shape.
//
// generateFieldDraft composes NO envelope line at all — it returns bare text —
// so it never carried the ambiguity and needs nothing. That asymmetry is worth
// knowing: batch and rescue drafted the same field under different formatting
// instructions, and only the batch one said "no markdown".
const JSON_ENVELOPE_RULE = [
  'Raw JSON only — no code fences, no backticks, nothing before or after it.',
  'That governs the response, not the copy: a copy string may carry any formatting the copy needs.',
];

// THE BRIEF, AND WHICH OF THE THREE CAMPAIGN SOURCES OUTRANKS WHICH.
//
// A draft prompt can carry three descriptions of the same campaign, and until the
// brief arrived it carried two paraphrases and not the original:
//
//   brief        the client's own words, verbatim — AUTHORITATIVE
//   writerPrompt ONE sentence of creative direction, EXTRACTED from the brief
//                (gemini.js parseBrief) — a directive, not a description
//   summary      a read of what the ask is, useful when a brief buries it
//
// Presented with equal billing, three sources invite the model to reconcile them
// and to prefer the shortest. Saying which is authoritative is the whole job of
// this block: `summary` and `writerPrompt` stay because they do work the brief
// does not — one states the ask when the brief scatters it, the other converts it
// into an instruction — but they stop being the primary source.
//
// This is not hypothetical tidiness. With no brief in the prompt, the campaign
// was 2% of 15,405 characters, the brief said "in about a minute", and ten of
// twelve headlines said "in 60 seconds" — a phrase present in no input.
const MAX_BRIEF_CHARS = 6000;

// TAIL-TRUNCATED, AND SAID OUT LOUD. Three decisions:
//
//   • THE HEAD IS KEPT. A brief front-loads: what the campaign is, who it is for,
//     what the offer is. Cutting the middle would splice two halves into a
//     sentence nobody wrote, which is worse than a clean stop.
//   • THE MODEL IS TOLD. A severed brief that ends mid-sentence reads as the end
//     of the ask, and the model would treat a truncated thought as the complete
//     one. The notice costs a line and removes that reading.
//   • THE ORIGINAL IS NOT TOUCHED. The cap is applied HERE, at prompt-build time,
//     never on write — `projects.brief_raw` keeps whatever was sent, so raising
//     the cap later is a code change and not a data loss that already happened.
//
// 6000 characters puts a long brief at roughly a third of the prompt, which is a
// lot and is the point: it is the only part that is about THIS campaign.
//
// `enriched` SAYS WHICH OF TWO DIFFERENT SITUATIONS THIS IS, AND IT IS NOT A
// REFINEMENT — the unconditional sentence is FALSE on the reference path.
//
// When a brief carries references, `enrichWithReferences` does not merely
// annotate: it REWRITES summary and writerPrompt from the reference content, and
// both adapters overwrite the originals with them. So on that path the summary
// is a read of the brief AND of the linked material, and can legitimately hold a
// statistic, a persona or a competitive frame that appears nowhere in the brief.
// "Where it and the summary below differ, follow the brief" then instructs the
// model to discard exactly the material that was fetched at real cost to produce.
//
// The model is TOLD which case it is in rather than left to infer it. Inferring
// would mean guessing whether an unfamiliar specific came from a source it
// cannot see or from nowhere — and "came from nowhere" is the failure this whole
// block exists to prevent.
//
// The unenriched branch is BYTE-IDENTICAL to what shipped, which is why the
// sentence is swapped by rewriting the group rather than by appending to it: the
// common path must not move at all.
function briefBlock(brief, enriched) {
  const raw = String(brief == null ? '' : brief).trim();
  if (!raw) return [];
  const truncated = raw.length > MAX_BRIEF_CHARS;
  const text = truncated ? raw.slice(0, MAX_BRIEF_CHARS).trimEnd() : raw;
  const head = enriched
    ? [
        'THE BRIEF — the client\'s own words, verbatim. This is the AUTHORITATIVE source for',
        'what this campaign is, what it offers, and the vocabulary it uses. Prefer ITS phrasing',
        'and ITS words over any paraphrase — if it says "about a minute", do not write',
        '"60 seconds".',
        'The direction and summary below were written from this brief AND from reference material',
        'the client linked and which you cannot see. They may therefore carry specifics — a',
        'statistic, a persona, a competitor frame — that the brief itself does not contain. Those',
        'came from the linked sources, not from nowhere: keep them. Where the two genuinely',
        'conflict about what the campaign IS or how it is worded, follow the brief.',
      ]
    : [
        'THE BRIEF — the client\'s own words, verbatim. This is the AUTHORITATIVE source for',
        'what this campaign is, what it offers, and the vocabulary it uses. Where it and the',
        'summary below differ, follow the brief. Prefer ITS phrasing and ITS words over any',
        'paraphrase — if it says "about a minute", do not write "60 seconds".',
      ];
  return [
    ...head,
    '"""',
    text,
    truncated
      ? `[…the brief continues beyond this point and was cut for length — ${raw.length - text.length} characters not shown. Do NOT treat the last line above as the end of the ask.]`
      : '',
    '"""',
    '',
  ].filter((l) => l !== '');
}

// The two DERIVED campaign lines, labelled by what they ACTUALLY are on this
// path. Same reason as briefBlock's conditional head, and they have to move
// together with it: telling the model the summary was written from the linked
// material and then labelling it "a read of the ask — the brief above is the
// source" two lines later re-opens the contradiction the head just closed.
//
// Both draft builders call this, so a field rescued out of a failed batch is not
// told a different story about where the direction came from.
function derivedCampaignLines(summary, writerPrompt, enriched) {
  return enriched
    ? [
        `Creative direction (a directive extracted from the brief and the linked reference material): ${writerPrompt}`,
        `Campaign summary (a read of the brief and the linked reference material): ${summary}`,
      ]
    : [
        `Creative direction (a directive extracted from the brief): ${writerPrompt}`,
        `Campaign summary (a read of the ask — the brief above is the source): ${summary}`,
      ];
}

// How many extracted figures reach one prompt. Three stats per source is the
// enrich pass's own ceiling, so 12 is four sources' worth — past the 1-3 links a
// real brief carries, and short of a link dump crowding out the brief. Anything
// dropped is LOGGED rather than announced in the prompt: briefBlock announces its
// cut because a severed sentence reads as the end of the ask, and a bullet list
// has no such misreading available to it.
const MAX_REFERENCE_STATS = 12;

// FIGURES REPORTED IN THE LINKED MATERIAL.
//
// `stats` is [{ text, source }] recovered from the doc's Reference Insights
// section — the enrich pass's per-source extraction, which its own prompt
// constrains to "verbatim from source only — no inferred or generated stats".
//
// THE SOURCE NAME IS DELIBERATELY WITHHELD. `source` arrives on every row and is
// never rendered. The first version sent `- <figure> — <source>` and it produced
// a failure worse than the invention it was written to prevent.
//
// WHAT HAPPENED, measured by scripts/statsAB.js against Demand Gen Nurture
// Email: the model turned the source NAME into a lead magnet the client was
// offering. Five of five Offer 2 bodies pitched "B2B Content Ops Benchmark
// 2026"; four of five Offer 2 headlines were "Get the 2026 Content Ops
// Benchmark"; the CTA moved to "Get the Report" four times in five. Quillio does
// not have that report — it is somebody else's citation — so the copy offered a
// prospect a document that does not exist. Separately, a source hostname
// appeared by name in three drafts of customer-facing copy.
//
// WHY THE MODEL WAS RIGHT TO DO IT, which is the part that decides the fix.
// craft.md is ALWAYS injected. Its CTA section states "The CTA must match the
// destination", and its approved library contains a destination category named
// "Gated content (whitepaper, report, guide)" whose entries include the literal
// string "Get the Report". craft.md also says a secondary offer should "read as
// lighter". Demand Gen Nurture Email has fields NAMED "Headline (Offer 2)" /
// "Offer Body 2" / "CTA Text (Offer 2)", so the prompt asks outright what the
// second, lighter offer is — and a named report was the only object in the
// prompt that could be one. Every rule involved was correct on its own terms.
//
// SO WORDING CANNOT CARRY THIS, and three things say so rather than one:
//   • A prohibition has to name what it prohibits, and this file's own measured
//     history is that a named shape gets reproduced (craft.md demonstrates a
//     number-led opening twice; the model invented "in 60 seconds" to fill it).
//   • The careful clause ALREADY LOST once. "…and only as that source's claim"
//     was written to constrain how a figure was asserted; read as copy direction
//     it says attribute this in the copy, and that is the hostname leak.
//   • A new prohibition would have to beat an always-injected rule that is right
//     on its own terms. Plenty of campaigns really do offer a report, so the
//     gated-content category cannot be deleted. CLAUDE.md already records one
//     late clause arguing with an always-present rule (§1.4 vs the §2
//     punctuation permission) and its measured adoption was 0/12.
// Withholding differs in KIND, not degree: there is no object in the prompt, so
// there is nothing to reason about and no compliance rate to fall below 1.0.
//
// PER-FIELD GATING WAS CONSIDERED AND REFUSED. It keeps the object and aims it:
// the failure appeared in a TWENTY-CHARACTER field (CTA Text (Offer 2)), so it
// is not about length or room. Offer-shaped fields are common across the library
// and nothing records which they are — and Event Landing Page has literal
// "Stat 1 / Stat 2 / Stat 3" fields, which want a figure more than any field in
// the product and would be the last ones anybody would gate. Removing the fuel
// is cheaper and more complete than aiming it.
//
// WHAT IS LOST: nothing the drafter needs. The figure is what fills craft.md's
// specificity slot, and the LinkedIn Single Image Ad arm — zero invention, zero
// fabricated offers — is the evidence that the numbers alone are the gain. The
// human's attribution is untouched: it lives in the doc's Reference Insights
// section as "From: <source> (<type>)", which is where it is read and where a
// wrong figure can be deleted before Generate First Draft.
//
// THE FRAMING IS STILL ATTRIBUTION, NOT TRUTH. There is no validator possible
// and there never will be: the raw reference content is capped at 6000 chars per
// source, used once for the enrich call, and never persisted, so by draft time
// there is nothing left to check a figure against. "Verbatim" is an instruction
// to a model, and no instruction here has ever had a compliance rate of 1.0.
// Calling these REPORTED says exactly as much as is actually known — and it
// needs no name to say it.
//
// The three prohibitions earn their lines from the measured failure this block
// exists to correct: with no figures available the drafter invented one. The
// risk of handing it real ones is not that it ignores them but that it rounds or
// sharpens them, or welds two into one.
function referenceStatsBlock(stats) {
  const rows = (Array.isArray(stats) ? stats : [])
    .map((s) => ({
      text: String((s && s.text) || '').trim(),
      source: String((s && s.source) || '').trim(),
    }))
    .filter((s) => s.text);
  if (rows.length === 0) return [];
  const shown = rows.slice(0, MAX_REFERENCE_STATS);
  if (rows.length > shown.length) {
    console.warn(
      `[gemini] reference stats capped: ${shown.length} of ${rows.length} sent (MAX_REFERENCE_STATS=${MAX_REFERENCE_STATS})`
    );
  }
  return [
    'FIGURES REPORTED IN THE LINKED MATERIAL — taken from the reference documents the client',
    'linked. They are REPORTED, not verified: nothing in this system has checked them against',
    'their source. Use one only where it earns its place. Do NOT invent a figure, do NOT round',
    'or sharpen one of these into a number no source stated, and do NOT combine two of them',
    'into a single figure.',
    // THE FIGURE ONLY. `source` is deliberately not rendered — see above.
    ...shown.map((s) => `- ${s.text}`),
    '',
  ];
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

// WHY A FAILURE CARRIES ITS CLASS OUT OF HERE RATHER THAN BEING RE-DERIVED LATER.
//
// August 2026: a prepaid balance ran out mid-run. Every call returned 429, every
// field came back blank, and the only thing any surface said was "All field
// drafts failed (Gemini timeout or error)" — a sentence that names the two causes
// it was NOT and offers "try again", which was guaranteed to fail identically.
//
// The class is attached at the throw because this is the only place that still
// holds the HTTP status and the structured body. Everything downstream has a
// string, and a string is the wrong thing to ask this question of: the callers
// that would have to parse it are a per-field rescue, a per-asset catch and two
// adapters, which is four places to keep a regex in step with Google's wording.
//
// THE ONE HARD CASE IS 429, and it is the case that happened. Google returns it
// for BOTH a per-minute rate limit (wait) and a spent quota (pay), and the enum
// in `error.status` is RESOURCE_EXHAUSTED for both. What separates them is the
// QuotaFailure violation's id: a PerMinute/PerSecond quota refills on its own, a
// PerDay/free-tier/billing one does not. An unrecognised or absent violation is
// read as `quota`, deliberately — the costs are asymmetric. Telling someone to
// check billing when it was a transient blip costs them one look at a dashboard;
// telling them to wait when the balance is gone costs them every retry after
// this one, which is exactly what happened.
const GEMINI_FAILURE_SENTENCES = {
  quota: "The Gemini API quota is used up. Retrying will fail the same way until the key's billing is topped up.",
  rate_limit: 'Gemini is rate-limiting this key. Wait a few minutes and try again.',
  auth: 'Gemini rejected the API key.',
  server: 'Gemini is returning errors. Wait a few minutes and try again.',
  timeout: 'Every Gemini request timed out. Wait a few minutes and try again.',
  network: 'Gemini could not be reached. Wait a few minutes and try again.',
  unconfigured: 'No Gemini API key is configured.',
  empty: 'Gemini returned nothing usable.',
  unknown:
    'Every Gemini request failed. Wait a few minutes and try again — if it keeps failing, check the API key and its billing.',
};

// Most-actionable-first. A run that saw several classes is reported by the
// earliest one present, not the commonest: a spent balance shows up as timeouts
// and 5xx on the way down, so counting would let the symptom outvote the cause.
const GEMINI_KIND_PRIORITY = [
  'unconfigured',
  'quota',
  'auth',
  'rate_limit',
  'server',
  'timeout',
  'network',
  'empty',
  'unknown',
];

function geminiFailureSentence(kind) {
  return GEMINI_FAILURE_SENTENCES[kind] || GEMINI_FAILURE_SENTENCES.unknown;
}

function geminiErrorKind(err) {
  return (err && err.geminiKind) || 'unknown';
}

function worstGeminiKind(kinds) {
  const seen = new Set((kinds || []).filter(Boolean));
  if (seen.size === 0) return null;
  for (const k of GEMINI_KIND_PRIORITY) if (seen.has(k)) return k;
  return 'unknown';
}

function geminiError(message, kind, httpStatus) {
  const err = new Error(message);
  err.geminiKind = kind;
  if (httpStatus != null) err.geminiStatus = httpStatus;
  return err;
}

// 429 only. Reads the structured QuotaFailure detail rather than the prose.
function exhaustedKind(bodyText) {
  let json = null;
  try {
    json = JSON.parse(bodyText);
  } catch (err) {
    return 'quota';
  }
  const details = (json && json.error && json.error.details) || [];
  const ids = [];
  for (const d of details) {
    if (!d || !Array.isArray(d.violations)) continue;
    for (const v of d.violations) {
      const id = (v && (v.quotaId || v.quotaMetric)) || '';
      if (id) ids.push(String(id));
    }
  }
  if (ids.length === 0) return 'quota';
  // Every violated quota refills on a clock → a wait. One that does not → a spend.
  return ids.every((id) => /per[_-]?(?:minute|second)/i.test(id)) ? 'rate_limit' : 'quota';
}

function classifyGeminiStatus(httpStatus, bodyText) {
  if (httpStatus === 429) return exhaustedKind(String(bodyText || ''));
  if (httpStatus === 401 || httpStatus === 403) return 'auth';
  if (httpStatus >= 500) return 'server';
  return 'unknown';
}

async function callGemini(body) {
  if (!config.GEMINI_API_KEY) {
    throw geminiError('GEMINI_API_KEY is not set.', 'unconfigured');
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
      throw geminiError(`Gemini request timed out after ${REQUEST_TIMEOUT_MS}ms`, 'timeout');
    }
    // A fetch that rejects for any other reason never reached Gemini — DNS, TLS,
    // a dropped socket. Classed as network so the sentence says "could not be
    // reached" rather than blaming a key that was never presented.
    throw geminiError(err.message || String(err), 'network');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The body stays on the MESSAGE (which is logged) and never reaches a
    // surface — the surfaces render the sentence keyed off geminiKind instead.
    const text = await res.text();
    throw geminiError(
      `Gemini API error ${res.status}: ${text}`,
      classifyGeminiStatus(res.status, text),
      res.status
    );
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw geminiError('Gemini returned no text. Raw: ' + JSON.stringify(data), 'empty', 200);
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

// A BOUNDED, ONE-LINE SAMPLE of a model response, for a failure log.
//
// Head AND tail, because the two failure shapes live at opposite ends: a
// "position N" error is decided in the first characters (an empty {} followed by
// content fails at position 2), while "Unexpected end of JSON input" means the
// response was truncated and only the tail shows where. Reporting one end would
// diagnose half the cases.
//
// JSON.stringify, not the raw string: newlines become \n so the whole sample
// stays on ONE line. A multi-line dump is unusable in Railway's log view, where
// concurrent requests interleave, and it would break the grep this exists for.
//
// Bounded because a batch response can run to thousands of characters and this
// is a log, not a store. The TRUE length is reported separately, so a truncated
// sample never reads as a short response.
//
// It is tenant copy, so it is logged ONLY on the failure path and never on a
// successful draft. Nothing here touches credentials or the voice guide.
function sampleForLog(text, head = 1000, tail = 400) {
  const s = String(text == null ? '' : text);
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}…[${s.length - head - tail} more]…${s.slice(-tail)}`;
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
  //
  // KEPT, THOUGH THE SEED NO LONGER SHIPS ANY. The four bundled Variant assets
  // are retired, so for a stock tenant this rule now emits nothing — `anyMatching`
  // tests the tenant's own vocabulary, not the bundled one. A tenant who built
  // their own "— Variant" types still needs the rule, and they are exactly the
  // tenant this was written for.
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
  // EVERY PHRASE HERE NAMES SEARCH, and none of them is "google ads".
  //
  // That omission is the whole point. A bare "google ad" now has two plausible
  // answers where it had one, and wiring the generic phrase to either sibling is
  // exactly the edit that sent every "a landing page" brief to the EVENT asset —
  // a generic phrase pointing at one specialisation, with nothing downstream able
  // to notice, because a WRONG match is not an UNMATCHED one and unmatchedAssets
  // only ever holds the latter.
  //
  // So the bare phrase stays unrouted and the model picks, which is the state
  // "a couple of paid posts" is in (CLAUDE.md's open question on generic phrases
  // over siblings). This asset makes that population two rather than one. It is
  // not made worse by being left alone, and it would be made worse by a guess.
  {
    target: 'Google Responsive Search Ad',
    line: '- "search ad", "responsive search", "rsa" or "paid search" → Google Responsive Search Ad',
  },
  { target: 'Demand Gen Nurture Email', line: '- "email" or "nurture" → Demand Gen Nurture Email' },
  { target: 'Event Invitation Email', line: '- "event email" or "invite" → Event Invitation Email' },
  { target: 'Event Reminder Email', line: '- "reminder email" → Event Reminder Email' },
  { target: 'Event Follow-Up / Recap Email', line: '- "follow up" or "recap email" → Event Follow-Up / Recap Email' },
  { target: 'Sales Basho Email', line: '- "basho" or "sales email" → Sales Basho Email' },
  // THE DEFAULT FIRST, THE SPECIALISATION SECOND — and the order is deliberate.
  //
  // This pair used to be the wrong way round in a way that decided every brief:
  // a bare "landing page" routed to Event Landing Page, and Campaign Landing Page
  // was reachable only by the literal phrase "campaign page". So a product launch
  // asking for "a landing page" came back with the EVENT asset — 24 fields
  // including Stat 1-3 and four benefit blocks — and nothing anywhere flagged it,
  // because a mapped asset is not an unmatched one. The generic phrase pointed at
  // the specialised asset and the general asset needed a password.
  //
  // Inverted here: the bare phrase takes the campaign asset, and the event asset
  // requires an EVENT SIGNAL. That costs nothing on an event brief, which always
  // carries one — a date, a venue, a registration ask — and it is the difference
  // between the two documents.
  //
  // EACH LINE NAMES ONLY ITS OWN TARGET. assetPhraseHintLines filters by `target`,
  // so a line that mentioned the other asset would survive into the prompt of a
  // tenant who does not have it — the stale-mapping failure this table's header
  // warns about. That is why the default is not described as "not the event one":
  // the two lines have to stand alone, and the ordering is what relates them.
  //
  // Campaign is listed FIRST because the one measurement this project has on
  // competing prompt rules (craft.md §1.4 against the §2 punctuation permission,
  // 0/12) is that the earlier, more general rule wins. UNMEASURED HERE: no parse
  // A/B has been run on either ordering. scripts/checkParsePlans.js carries the
  // cases that would settle it.
  {
    target: 'Campaign Landing Page',
    line: '- "landing page", "campaign page", "launch page" or "product page" → Campaign Landing Page',
  },
  {
    target: 'Event Landing Page',
    line: [
      '- a landing page for an event the brief NAMES — it gives a date, a venue, a',
      '  registration ask, or calls it an "event page" → Event Landing Page',
    ].join('\n'),
  },
  { target: 'On-Site Signage — General', line: '- "signage" or "on-site" → On-Site Signage — General' },
  // NO 'Form Confirm Page' HINT. The asset is retired (see defaultAssets.js), and
  // this line is the reason it is worth saying so here: it taught the model to
  // read "confirm page" as an ASSET at a time when the same words are how a
  // tenant names their form-and-confirmation TEMPLATE. The hint table is filtered
  // against the tenant's vocabulary, so a leftover entry would have gone quiet on
  // its own — but a hint pointing at a name nothing can return is a trap for the
  // next person reading this list.
  // A FALLBACK, SAID AS ONE. Three organic assets exist and this line named one
  // of them as the answer to a phrase that names no platform — so a brief asking
  // for "organic social across Instagram and X" was told, in the prompt, that
  // organic means LinkedIn. Adding "with no platform named" makes the line do
  // what it is for (answer the platformless ask) and stop overriding the ask that
  // does name one, which "INTERPRET INTENT SEMANTICALLY" above already handles.
  //
  // NOT an inversion like the landing pages, and the wording reflects that: the
  // three organic assets are siblings, none is the general case, and LinkedIn is
  // a defensible B2B default. Behaviour on a platformless brief is UNCHANGED, so
  // this cannot drop an ask that used to land.
  {
    target: 'Organic Social — LinkedIn',
    line: '- "organic social" or "organic" with NO platform named → Organic Social — LinkedIn',
  },
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
// Words that carry no identity in an asset or template name. Dropped before
// comparison so "Form and Confirmation Page" and "Form Confirm Page" are
// compared on the words that mean something.
const NAME_STOPWORDS = new Set(['and', 'the', 'a', 'an', 'of', 'for', 'to', 'or', 'with']);

// A name reduced to the tokens that identify it, each cut to five characters.
//
// FIVE IS THE WHOLE TRICK, and it is a blunt stemmer on purpose: "confirm" and
// "confirmation" both become "confi", which is the pair that had to match. A
// real stemmer would be more precise and would be one more thing that has to
// agree with normalize() forever; a prefix cut is inspectable by reading it.
function nameSignature(s) {
  return new Set(
    nameTokens(s)
      .filter((t) => !NAME_STOPWORDS.has(t))
      .map((t) => t.slice(0, 5))
  );
}

// Does this hint's TARGET describe the same artifact as one of the tenant's
// document templates?
//
// WHY NOT normalize() EQUALITY. That is what the collision check uses, and it
// is right there — it decides whether two names are THE SAME NAME. This is a
// different question: whether two DIFFERENT names describe the same thing.
// "form confirm page" and "form and confirmation page" are not the same name,
// and the tenant means the same document by both.
//
// THE RULE: one signature is a subset of the other, and the smaller has at
// least two tokens. Subset rather than a similarity score because a threshold
// is a number nobody can predict the behaviour of; two tokens because a
// one-token template ("Page", "Matrix") would otherwise silence every hint that
// happens to share that word.
//
// WHICH WAY IT FAILS. Strictly, and deliberately: a hint that stays is the
// behaviour that shipped, a hint wrongly removed silently stops an asset
// matching for every brief. So a template named "Form and Confirmation Matrix"
// does NOT suppress the "Form Confirm Page" hint — {form,confi,matri} and
// {form,confi,page} are neither a subset of the other. A template named
// something genuinely unrelated — "Rate Card", "Media Plan" — suppresses
// nothing at all, which is the case for every tenant who has not named a
// template after an asset type.
function hintOverlapsTemplate(target, templateSignatures) {
  const t = nameSignature(target);
  if (t.size < 2) return false;
  for (const sig of templateSignatures) {
    if (sig.size < 2) continue;
    const [small, large] = t.size <= sig.size ? [t, sig] : [sig, t];
    let subset = true;
    for (const tok of small) {
      if (!large.has(tok)) { subset = false; break; }
    }
    if (subset) return true;
  }
  return false;
}

// `allowed` filters by TARGET — a hint can only ever name an asset this tenant
// actually has, which has been true since these were made per-tenant.
//
// `templateNames` is the new one. A hint pointing at "Form Confirm Page" while
// the tenant owns a "Form and Confirmation Page" TEMPLATE is the prompt arguing
// against itself: it instructs the model to route the ask to an asset, a
// hundred lines before it is told templates exist. The asset side wins on
// position and on having a worked example, and the template is never returned.
function assetPhraseHintLines(allowed, templateNames = []) {
  const have = new Set(allowed.map(normalize));
  const templateSignatures = (templateNames || []).filter(Boolean).map(nameSignature);
  return ASSET_PHRASE_HINTS.filter((h) => {
    if (h.always) return true;
    if (h.anyMatching) return allowed.some((n) => h.anyMatching.test(n));
    if (!have.has(normalize(h.target))) return false;
    if (templateSignatures.length && hintOverlapsTemplate(h.target, templateSignatures)) {
      console.log(`[gemini] phrase hint suppressed — "${h.target}" describes the same thing as a document template`);
      return false;
    }
    return true;
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
async function parseBrief(brief, allowedAssets, allowedTemplates) {
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

  // THE SECOND VOCABULARY: this tenant's DOCUMENT TEMPLATES (rework step four).
  //
  // A template is a first-class thing a brief names, not an asset with a
  // document attached. The old shape put an asset in the middle — attach an
  // asset type to a template, map its fields to markers — and that was wrong in
  // a way worth stating: form and confirmation copy ended up in BOTH the copy
  // doc and the matrix. They are different deliverables from one brief. The copy
  // doc holds copy assets; the matrix holds form and confirmation copy; naming
  // the template asks for the matrix, and nothing else.
  //
  // Empty for a tenant with no templates, which is every tenant today and stays
  // the default — the prompt below then says nothing about templates at all, so
  // an ordinary brief's prompt is byte-identical to before.
  const templates = Array.isArray(allowedTemplates) ? allowedTemplates.filter(Boolean) : [];
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
    // THE TOP-LEVEL MENTION. Everything below this point teaches the model how to
    // MATCH; the Return: list is where it learns what containers exist at all.
    // Without this clause the list named ONE home for "things the brief asks
    // for" — assets — and the model had committed to that reading 124 lines
    // before the DOCUMENT TEMPLATES block appeared. An explicit
    // "Build the <template name>" line came back absorbed into the nearest
    // asset, or dropped, with nothing in `templates` and nothing in
    // `unmatchedTemplates` to say so.
    //
    // The clause is absent when the tenant has no templates, so their prompt
    // stays byte-identical.
    `- assets: an ORDERED list of the asset types the brief asks for, in the order the brief mentions them. Each entry is an object {"asset": string, "count": number, "labels": string[]}.${
      templates.length
        ? ' NOT everything a brief names is an asset type — this workspace also owns whole DOCUMENTS a brief can name, listed under DOCUMENT TEMPLATES below, and those go in `templates` instead of here.'
        : ''
    } \`asset\` MUST be an exact name from this list:\n\n${allowed.join(
      '\n'
    )}\n\nReturn only names from this list. If the brief names no assets at all, return an empty list — do NOT choose assets for the writer. A brief that describes a campaign without naming what to build has not asked for anything yet, and the system will ask them. Inferring here produces three plausible assets that look like an answer rather than a guess.`,
    // The second container, named in the Return: list BESIDE assets rather than
    // only at the bottom. The DETAIL stays where it was — what was missing is
    // the mention, not the explanation.
    ...(templates.length
      ? [
        '- templates: the DOCUMENT TEMPLATES this brief names, chosen from the list further down.',
        '  A template is a whole document this workspace owns. It is NOT an asset type and it is',
        '  a SEPARATE deliverable — a brief naming a template AND some assets gets both.',
        '  If the brief names one, it MUST appear here. Never leave it out because an asset type',
        '  sounds similar: that similarity is the mistake this field exists to prevent.',
      ]
      : []),
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
    ...assetPhraseHintLines(allowed, templates),
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
    // DOCUMENT TEMPLATES — omitted entirely for a tenant with none, so an
    // ordinary brief's prompt is exactly what it was.
    ...(templates.length
      ? [
        '',
        'DOCUMENT TEMPLATES. This tenant has their own documents that a brief can',
        'ask for BY NAME. They are NOT asset types and do not go in `assets`:',
        ...templates.map((t) => `  - ${t}`),
        'If the brief names one of these, put it in `templates`. Match the same way',
        'you match an asset — semantically, tolerating plurals, casing and obvious',
        'shorthand — but NEVER map an asset request onto a template or the reverse.',
        'A template is a whole document, so `count` is always 1. If the brief asks',
        'for two of one, still return 1 and let the system say why.',
        'A brief can ask for assets AND a template; they are separate deliverables',
        'and both get built. A brief that names only a template returns assets: [].',
        '- unmatchedTemplates: template names the brief asked for that are NOT in',
        '  the list above. [] if none. Never force these into templates.',
      ]
      : []),
    '',
    templates.length
      ? 'Return an object of the shape: {"campaignTitle": string, "summary": string, "writerPrompt": string, "assets": [{"asset": string, "count": number, "labels": string[]}], "templates": [{"template": string, "count": number}], "unmatchedAssets": string[], "unmatchedTemplates": string[], "folderId": string|null, "referenceLinks": string[]}.'
      : 'Return an object of the shape: {"campaignTitle": string, "summary": string, "writerPrompt": string, "assets": [{"asset": string, "count": number, "labels": string[]}], "unmatchedAssets": string[], "folderId": string|null, "referenceLinks": string[]}.',
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
  // THE RAW TEMPLATE FIELDS, logged for the same reason referenceLinks are: an
  // absent line is not evidence of an empty list. A template that did not match
  // produces no warning anywhere downstream — resolveTemplatePlan is never
  // reached with an empty plan — so without this the only signal is a silence
  // that looks identical to "this brief named no template".
  //
  // Logged BEFORE the filters below, so it says what the MODEL returned rather
  // than what survived: a name in `templates` that no vocabulary matched, and a
  // name the model put in `assets` that is really a template, are different
  // failures and the raw shape is the only place they are still distinguishable.
  if (templates.length) {
    console.log(
      `[gemini] template vocabulary: ${templates.length} — ${JSON.stringify(templates)}; ` +
        `model returned templates=${JSON.stringify(parsed.templates || [])} ` +
        `unmatchedTemplates=${JSON.stringify(parsed.unmatchedTemplates || [])} ` +
        `assets=${JSON.stringify((Array.isArray(parsed.assets) ? parsed.assets : []).map((a) => (a && (a.asset || a.assetType || a)) || a))}`
    );
  }

  // Defensively constrain assets to the allowed list. Match case- and
  // dash-insensitively (Gemini may emit a hyphen where the canonical name uses
  // an em dash), then map back to the canonical name. Anything that doesn't map
  // is treated as unmatched (surfaced to the user, not silently dropped).
  //
  // This used a LOCAL normalizer that folded case and the three dash characters
  // but did NOT drop the spaces around a hyphen, so it disagreed with
  // utils/normalize (the one core/pipeline, googleDocs and pendingBriefs all
  // use) on most of the allowed names. Two functions deciding what "the same
  // asset name" means is one too many — especially now that a UNIQUE INDEX
  // enforces the same question in Postgres. Converged onto utils/normalize:
  // strictly more tolerant here (it additionally matches "Direct Mail—Box",
  // em dash with no spaces, which the local one rejected) and collision-free
  // across the allowed list, which a smoke test pins.
  const canonicalByNorm = new Map(allowed.map((a) => [normalize(a), a]));
  // The template vocabulary, folded the same way, and built BEFORE the asset
  // loop on purpose — see the misroute check inside it.
  const templateByNorm = new Map(templates.map((t) => [normalize(t), t]));

  // THE REVERSE MISROUTE CHECK, run BEFORE the asset loop so what it recovers
  // goes through the same clamping every other asset entry does.
  //
  // The forward check (below, inside the asset loop) was built first because it
  // is the direction the reported failure came from: a template in `assets` was
  // refused as an unknown asset. This direction is the more dangerous one, and
  // it is the reason it needed finding rather than guessing at: an ASSET name in
  // `templates` failed the template lookup, landed in unmatchedTemplates — which
  // nothing read — and vanished. The brief then had no assets at all, and an
  // empty asset plan used to mean "build the whole library".
  //
  // So: one loud wrong refusal in one direction, one silent wrong document in
  // the other. Both are misroutes by a model that was told not to, and both are
  // recovered here rather than reported.
  const rawTemplateEntries = Array.isArray(parsed.templates) ? parsed.templates : [];
  const templateEntries = [];
  const assetsFromTemplates = [];
  for (const entry of rawTemplateEntries) {
    if (entry == null) continue;
    const isString = typeof entry === 'string';
    if (!isString && typeof entry !== 'object') continue;
    const name = String((isString ? entry : entry.template || entry.name || entry.asset) || '').trim();
    if (!name) continue;
    if (!templateByNorm.has(normalize(name)) && canonicalByNorm.has(normalize(name))) {
      // Carry the count across: "three nurture emails" misfiled as a template is
      // still an ask for three, and the asset loop clamps it like any other.
      assetsFromTemplates.push({ asset: canonicalByNorm.get(normalize(name)), count: isString ? 1 : entry.count });
      continue;
    }
    templateEntries.push(entry);
  }

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
  const rawAssets = [
    ...(Array.isArray(parsed.assets) ? parsed.assets : []),
    ...assetsFromTemplates,
  ];
  const assets = [];
  const unmatchedFromAssets = [];
  // Templates the model put in `assets` by mistake. Merged into the template
  // plan below rather than dropped or refused.
  const misroutedTemplates = [];
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
      // A TEMPLATE NAME IS NOT AN UNKNOWN ASSET. Before this, every gate treated
      // it as one: it failed this lookup, landed in unmatchedAssets, and the
      // adapters refused the brief with "not in your asset library" naming a
      // document the tenant definitely had. The model is told to put templates
      // in `templates`, but it is a model, so the miss list is checked against
      // the other vocabulary before anything is called unknown.
      const asTemplate = templateByNorm.get(normalize(name));
      if (asTemplate) {
        misroutedTemplates.push(asTemplate);
        continue;
      }
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

  // THE TEMPLATE PLAN, filtered exactly as defensively as the asset plan and
  // against its OWN vocabulary. Same normalize(), so a brief writing
  // "form & confirmation page" reaches the template the tenant called
  // "Form and Confirmation Page".
  //
  // count is pinned to 1 rather than clamped. A template is a whole document and
  // projects carries ONE template_doc_id/url pair, so two of one template is a
  // thing the data model cannot record. The pipeline refuses an explicit ask for
  // more than one by name; this only stops a model-invented 3 from arriving as a
  // number nobody asked for.
  const rawTemplates = [...templateEntries, ...misroutedTemplates];
  const templatePlan = [];
  const unmatchedFromTemplates = [];
  const seenTemplates = new Set();
  for (const entry of rawTemplates) {
    if (entry == null) continue;
    const isString = typeof entry === 'string';
    if (!isString && typeof entry !== 'object') continue;
    const rawName = isString ? entry : entry.template || entry.name || entry.asset;
    const name = String(rawName == null ? '' : rawName).trim();
    if (!name) continue;
    const canonical = templateByNorm.get(normalize(name));
    if (!canonical) {
      unmatchedFromTemplates.push(name);
      continue;
    }
    // The model naming one template twice is one ask, not two.
    const key = normalize(canonical);
    if (seenTemplates.has(key)) continue;
    seenTemplates.add(key);
    const requested = isString ? 1 : parseInt(entry.count, 10);
    templatePlan.push({
      template: canonical,
      count: 1,
      // What the brief actually asked for, kept so the pipeline can refuse an
      // explicit "two of these" by name instead of silently building one.
      requestedCount: Number.isFinite(requested) && requested > 0 ? requested : 1,
    });
  }

  const unmatchedAssets = [
    ...(Array.isArray(parsed.unmatchedAssets) ? parsed.unmatchedAssets : []),
    ...unmatchedFromAssets,
  ]
    .map((a) => String(a).trim())
    .filter(Boolean);

  // NON-EMPTY IS REACHABLE, so this cannot stay a list nothing reads. After the
  // reverse misroute check above, a name lands here only when it matches NEITHER
  // vocabulary — "build the rate card" against a workspace with no such template
  // and no such asset. That is a genuine miss and the same kind of thing
  // unmatchedAssets is: something the brief asked for that was not built. Both
  // adapters merge the two lists into one refusal/notice, so a writer is told
  // once, in one sentence, whichever namespace the miss came from.
  const unmatchedTemplates = [
    ...(Array.isArray(parsed.unmatchedTemplates) ? parsed.unmatchedTemplates : []),
    ...unmatchedFromTemplates,
  ]
    .map((a) => String(a).trim())
    .filter(Boolean);

  if (templates.length) {
    console.log(
      `[gemini] template plan after filtering: ${JSON.stringify(templatePlan.map((t) => t.template))}` +
        (misroutedTemplates.length ? `, recovered from assets: ${JSON.stringify(misroutedTemplates)}` : '') +
        (assetsFromTemplates.length ? `, assets recovered from templates: ${JSON.stringify(assetsFromTemplates.map((a) => a.asset))}` : '') +
        (unmatchedFromTemplates.length ? `, matched NEITHER vocabulary: ${JSON.stringify(unmatchedFromTemplates)}` : '')
    );
  }

  const folderId = parsed.folderId ? String(parsed.folderId).trim() : null;
  const referenceLinks = Array.isArray(parsed.referenceLinks)
    ? parsed.referenceLinks.map((u) => String(u).trim()).filter(Boolean)
    : [];

  return {
    campaignTitle: String(parsed.campaignTitle || '').trim(),
    summary: toReadableText(parsed.summary).trim(),
    writerPrompt: toReadableText(parsed.writerPrompt).trim(),
    assets,
    templates: templatePlan,
    unmatchedAssets,
    unmatchedTemplates,
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
// instruction regardless of tenant. Returns '' when there's nothing built in.
//
// A FIELD'S OWN NOTE DOES NOT REPLACE THIS — IT LEADS IT. fieldGuidanceFor sends
// both, note first, mechanic second. This comment used to say a tenant's note
// "takes precedence over this", which described a `||` that suppressed the
// built-in entirely; if you are reading that sentence somewhere, it is stale and
// the code below is the truth. The reason is what these two entries ARE: sentence
// case, and not echoing the headline. They are MECHANICS a model gets wrong by
// default, not voice claims a brand could reasonably overrule — so a tenant note
// about what to say has no conflict with them, and one that does conflict wins by
// being read first. Do not restore the short-circuit to match a stale sentence.
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

// THE FIELD'S GUIDANCE LINE — composed from both sources, never chosen between.
//
// This was `notes || builtInFieldGuidance(fieldName)` at both call sites, and
// that `||` is a latent bug, not a preference. `notes` is whatever guidance the
// field carries: for a TEMPLATE marker it is the raw spec_note
// (core/pipeline.js:1515, :1733), but for the copy doc it is the italic line
// parseDoc recovers (destinations/googleDocs.js:830) — which fieldHint composes
// as spec_note PLUS the spec_type tier sentence. So any of three unrelated
// events made the built-in rule vanish from every prompt for that field:
// a tenant writing a spec_note, a migration adding one, or the field being
// tiered enforced/recommended so the tier line renders.
//
// It has never fired: all 20 seeded 'Subhead' / 'Graphic Headline' fields are
// house_default with a NULL spec_note, so fieldHint returns null, `notes` is ''
// and the built-in has always won. That is the whole safety margin — one
// spec_note away, on the two fields whose rules are about mechanics a model gets
// wrong by default (sentence case; not echoing the headline). Nothing would
// error and nothing in the doc would show it.
//
// THE FIELD'S OWN NOTE COMES FIRST. Where the two touch, the note still reads as
// the governing instruction — CLAUDE.md's prompt hierarchy ("field Tone Notes
// win for their field") is kept in ORDER rather than by discarding the craft
// rule that the hierarchy never said to discard.
//
// Space-joined into ONE line because that is what both call sites emit: a single
// `Field guidance: …` in the per-field prompt, and one `guidance: …` clause
// inside the batch prompt's per-field line, which is `;`-separated and cannot
// carry a newline.
function fieldGuidanceFor(fieldName, notes) {
  return [String(notes == null ? '' : notes).trim(), builtInFieldGuidance(fieldName)]
    .filter(Boolean)
    .join(' ');
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

// The field's CURRENT copy, for a redraft that is a revision rather than a fresh
// start. Distinct from siblingContextBlock, which is the OTHER fields: those are
// context to sit alongside and must never be rewritten; this one IS the thing
// being rewritten, and saying so is what stops the model quietly re-deciding the
// offer when it was asked to shorten a headline. Returns '' when there is no
// current copy — a first draft has none and must not be told there is.
function currentCopyBlock(currentCopy) {
  const s = String(currentCopy || '').trim();
  if (!s) return '';
  return [
    'This field ALREADY has copy. Revise it — keep what works, change what the',
    'direction asks for, and stay on the same offer and angle unless told otherwise.',
    'Do not start over. Return only the new version.',
    `Current copy: ${s}`,
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
// THE FLOOR IS STATED FOR BOTH UNITS. It used to be word-only, and the comment
// here read: "on a character field a floor is close to meaningless (and the
// subject-line work just removed the last ones)".
//
// THAT WAS CORRECT WHEN IT WAS WRITTEN, and it stopped being correct without
// anyone editing it. Two things moved underneath it. The seed in fact kept 19
// character fields with a floor — every Subhead, every Preheader, the Meta
// Title/Description pairs — so "the last ones" was true of the fields that work
// had just touched and not of the library. And the house-default work made a
// character floor something a TENANT can type, which is the case that has no
// defensible reading at all: they set 40-60, the field renders [40-60], and the
// model is told only "limit 60". A number a tenant can see and the drafter
// cannot is not a subtle failure.
//
// Worse than silent: the no-floor sentence ends "even a few characters short",
// which pushes DOWN. Sitting beside a floor it would argue against it, so the
// floor branch does not inherit it.
//
// The general lesson, since this is the second time today: a decision can be
// undermined by a FEATURE rather than by having been wrong. When you add a
// capability, the comments worth re-reading are the ones that justify an
// omission by saying the case never arises.
//
// A FLOOR IN THE PROMPT IS NOT ENFORCEMENT, and the difference is the whole
// reason this is safe to state here and nowhere else. It tells the model where
// the useful range is, so it does not default short because the prompt said
// short was safe. Nothing checks the result against it: no trim, no rescue, no
// retry, and — decided 2026-08-05 — no review note either (see
// copyReview.collectCopyFields, where the no-floor rule was re-examined and
// held). ONLY THE CEILING IS ENFORCED. Over is a defect, under is a choice: copy
// that says the thing in 32 characters beats copy padded to 40 to reach a
// number. If you ever find yourself adding a check that fires on being under
// this range, you are undoing that decision rather than completing this one.
function lengthClause(charMax, fieldType, charMin) {
  const max = Number(charMax) > 0 ? Number(charMax) : null;
  if (!max) return null;
  const min = Number(charMin) > 0 && Number(charMin) < max ? Number(charMin) : null;
  // THE FRAME IS PRESCRIBED; THE MIDDLE IS NOT. This clause used to end
  // "…the ask in one, the next step in one." — which reads as a sentence for
  // EVERY part of the email, the middle included. craft.md §3 now says the
  // material between the frame becomes bullets when the brief supplies three or
  // more parallel points, so the old wording had this clause quietly arguing
  // against the playbook in the same prompt. That is the §1.4-versus-§2 shape
  // CLAUDE.md records, where measured adoption of the losing rule was 0/12.
  //
  // The fix is subtractive: the frame still names a sentence each for context,
  // ask and next step, and the middle is left to whatever form carries it. NO
  // BULLETS INSTRUCTION BELONGS HERE — the rule lives in craft.md, reaches every
  // asset through the universal block, and a second copy here would be two
  // wordings for one rule. This clause only has to stop contradicting it.
  if (String(fieldType || '') === 'words') {
    const range = min ? `${min}-${max} words` : `up to ${max} words`;
    return (
      `Length: ${range}. This is a WORD count, not characters. Structure matters more than ` +
      'hitting a number: context in one or two sentences, the ask in one, the next step in one, ' +
      'and the material between them in whatever form carries it. ' +
      'A well-structured email at the top of the range beats a cramped one at the bottom.'
    );
  }
  if (min) {
    return (
      `Length: ${min}-${max} characters. BOTH ends are real: at least ${min}, never more than ${max}. ` +
      'Write a COMPLETE, self-contained thought and land it inside that range — do not stop short of ' +
      `${min} to be safe, and never run up to ${max} and get cut off mid-sentence.`
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

// The ceiling that may be enforced by CHARACTER COUNT — the corrective rewrite
// and, at the end of the ladder, trimToCeiling. Null for a word field, because a
// word field's charMax is a WORD count and every enforcement step below measures
// characters: handing 120 to trimToCeiling on a 120-word body does not shorten it
// to 120 words, it cuts it to 120 CHARACTERS and throws the rest away.
//
// That is why this is a named helper rather than the expression written twice.
// Both places that trim have to make the same decision, and the one that got it
// wrong was silent about it — the copy simply came back short.
function trimCeiling(charMax, fieldType) {
  if (String(fieldType || '') === 'words') return null;
  return Number(charMax) > 0 ? Number(charMax) : null;
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
  // The client's own words. Absent on a pre-migration project row and on any
  // caller that has none — briefBlock emits nothing, and the prompt is then
  // byte-identical to before except for the two relabelled lines.
  brief,
  // Whether summary/writerPrompt were written from linked reference material as
  // well as from the brief. Recovered from the doc (the Reference Insights
  // section's presence), so it is false on every brief that linked nothing —
  // which is nearly all of them, and their prompt does not move.
  enrichedFromReferences,
  // [{ text, source }] — figures the enrich pass pulled out of those references.
  referenceStats,
  // THE A/B CONTROL, AND IT EXISTS FOR THAT ALONE — see scripts/funnelAB.js.
  // Default on; `false` omits the inference block and reproduces the prompt as
  // it was before the block existed, byte for byte, through this same call.
  //
  // floorAB.js needed no such flag only because `char_min: 0` happened to be a
  // real production value that reproduced the old prompt. There is no lucky
  // equivalent here: nothing a caller can legitimately pass makes the block
  // vanish, so re-measuring this change later would otherwise mean editing the
  // builder or checking out old code — and the repo's own standing rule is that
  // finding out whether a prompt rule paid for itself outranks the rule.
  // No production caller passes it.
  funnelInference,
  summary,
  writerPrompt,
  direction,
  voiceGuide,
  siblings,
  currentCopy,
}) {
  const limitLine =
    lengthClause(charMax, fieldType, charMin) ||
    'Keep it concise — a complete, self-contained thought appropriate for the field.';
  const fieldGuidance = fieldGuidanceFor(fieldName, notes);

  const prompt = [
    'Write marketing copy for a single field. Return ONLY the copy itself — no labels, quotes, options, or commentary. Exactly one version.',
    '',
    ...brandVoiceLines(assetType, voiceGuide),
    // The brief FIRST, then the two things DERIVED from it, each labelled by what
    // it is rather than presented as a third equal description of the campaign.
    // Both draft builders use the identical block and ordering: a field rescued
    // out of a failed batch must not be told a different story about which source
    // outranks which. See briefBlock.
    ...briefBlock(brief, enrichedFromReferences),
    ...derivedCampaignLines(summary, writerPrompt, enrichedFromReferences),
    // AFTER the campaign block, because these are figures FROM it and read as
    // house boilerplate anywhere above it.
    ...referenceStatsBlock(referenceStats),
    `Asset: ${assetType}`,
    assetDirection ? `Asset creative direction (apply to ALL fields): ${assetDirection}` : '',
    channel ? `Channel: ${channel}` : '',
    `Field: ${fieldName}`,
    // A STORED stage still wins — nothing populates it today (pipeline.js sets
    // '') but a column or a per-brief value would, and an inference instruction
    // must not talk over a value somebody set. Inference is the fallback, placed
    // here so the evidence it names (the brief, the asset) is already above it.
    funnelStage ? `Funnel stage: ${funnelStage}` : '',
    ...(funnelStage || funnelInference === false ? [] : [...FUNNEL_STAGE_INFERENCE, FUNNEL_STAGE_FOR_DRAFT]),
    toneNotes ? `Tone notes: ${toneNotes}` : '',
    fieldGuidance ? `Field guidance: ${fieldGuidance}` : '',
    direction
      ? `REVISION direction from the user — apply this, overriding earlier choices where they conflict: ${direction}`
      : '',
    // Cohesion recovery for scoped (single-field) generation: the current copy of
    // this field's sibling fields, so it hangs together with them even though it's
    // drafted alone rather than in the cohesive whole-asset batch.
    siblingContextBlock(siblings),
    // THIS field's current copy, when there is any. Absent on a first draft, so
    // every existing caller's prompt is byte-identical to before.
    currentCopyBlock(currentCopy),
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
  // NULL FOR A WORD FIELD — see trimCeiling. Everything below measures
  // characters, so enforcing a word count here would take a correct 120-word
  // body, "rewrite it to fit within 120 characters", and then trim it to 120
  // characters if that failed. A word field's limit is carried into the prompt by
  // lengthClause above; there is no post-hoc word enforcement, and inventing one
  // is beyond this fix.
  const ceiling = trimCeiling(charMax, fieldType);

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
  // The client's own words. Absent on a pre-migration project row and on any
  // caller that has none — briefBlock emits nothing, and the prompt is then
  // byte-identical to before except for the two relabelled lines.
  brief,
  // See generateFieldDraft — both builders take the identical pair, and the
  // rescue below passes them on, so a field that falls out of a failed batch is
  // told the same story about its sources as the batch was.
  enrichedFromReferences,
  referenceStats,
  // The A/B control — see generateFieldDraft. No production caller passes it.
  funnelInference,
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
      const ceiling = Number(f.charMax) > 0 ? Number(f.charMax) : null;
      // THE FLOOR, ON BOTH UNITS — see lengthClause for why this was word-only and
      // why that stopped being right. This line does not call lengthClause (it is
      // a terse clause inside a per-field bullet, not a paragraph) so the same
      // omission had to be fixed twice; a floor stated in one draft path and not
      // the other is a field that obeys its range only when it is redrafted alone.
      // Guarded against min >= max, which would state an impossible range.
      const floor = Number(f.charMin) > 0 && ceiling && Number(f.charMin) < ceiling ? Number(f.charMin) : null;
      const limit = f.fieldType === 'words'
        ? (ceiling
          ? `${floor ? `${floor}-` : 'up to '}${ceiling} WORDS (a word count, not characters)`
          : 'no word limit — length is yours to judge; measured in WORDS, not characters')
        : (ceiling
          ? (floor
            ? `${floor}-${ceiling} characters — at least ${floor}, never more than ${ceiling}`
            : `character limit ${ceiling} — stay within this limit`)
          : 'concise');
      const guidance = fieldGuidanceFor(f.fieldName, f.notes);
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
    // The brief FIRST, then the two things DERIVED from it, each labelled by what
    // it is rather than presented as a third equal description of the campaign.
    // Both draft builders use the identical block and ordering: a field rescued
    // out of a failed batch must not be told a different story about which source
    // outranks which. See briefBlock.
    ...briefBlock(brief, enrichedFromReferences),
    ...derivedCampaignLines(summary, writerPrompt, enrichedFromReferences),
    ...referenceStatsBlock(referenceStats),
    `Asset: ${assetType}`,
    assetDirection ? `Asset creative direction (apply to ALL fields): ${assetDirection}` : '',
    channel ? `Channel: ${channel}` : '',
    toneNotes ? `Tone notes: ${toneNotes}` : '',
    // ASSET-LEVEL, NOT PER-FIELD. The batch drafts every field of one asset in
    // one call, and funnel stage is a property of the campaign and the asset —
    // the per-field `funnel:` slot in the field list below stays exactly as it
    // was, for a stored value that still nothing writes.
    ...(funnelInference === false ? [] : [...FUNNEL_STAGE_INFERENCE, FUNNEL_STAGE_FOR_DRAFT]),
    '',
    'For each field, write a COMPLETE, self-contained thought that fits within its',
    'character limit. The limit is a hard MAXIMUM to compose within, not a target to',
    'fill — never run up to the limit and cut off mid-sentence; finish the thought,',
    'even a few characters short. Fields:',
    fieldLines,
    '',
    'Return a JSON object mapping each field name (exactly as written above, including any parentheses) to its copy string. Exactly one copy per field, no commentary.',
    ...JSON_ENVELOPE_RULE,
  ].join('\n');

  let parsed = {};
  // HOISTED SO THE CATCH CAN SEE IT. `text` used to be declared inside the try,
  // which meant the raw response was not merely unlogged — it was out of scope,
  // and no line added to the catch could have printed it. A parse failure with no
  // sample is a bug you can only ever see the shadow of: the error message gives
  // the SHAPE of the failure ("position 2" means a complete two-character value
  // with something immediately after it) and nothing at all about the content.
  //
  // A second thing the hoist buys, free: this catch covers BOTH a callGemini
  // failure (network, rate limit, timeout) and a JSON.parse failure, and the old
  // message called them all "parse failed". `len=0` now tells them apart.
  let text = '';
  // THE CLASS OF THE BATCH FAILURE, KEPT. Nothing in this function throws on a
  // model failure — both the batch and the per-field rescue are caught, so an
  // outage returns an array of empty drafts and the caller sees a clean run with
  // nothing in it. Carrying the class out on the entries is what lets
  // googleDocs.generateDraft say WHY the doc is blank.
  let batchFailureKind = null;
  try {
    text = await callGemini({
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
    // ONE LINE, STABLE PREFIX, key=value. `BATCH_PARSE_FAIL` is a token that
    // appears nowhere else in the source, so `grep BATCH_PARSE_FAIL` over a log
    // window counts occurrences exactly — which is the whole point, since nothing
    // in this system persists or counts this event (no metrics, no events table,
    // and the project row records the document, not how it was drafted).
    //
    // asset and fields are here because the cost is per FIELD: every field of
    // this asset now falls through to a sequential single-field rescue, so
    // fields=9 is nine extra model calls, and the pair is what makes a log line
    // tell you what the failure cost.
    console.warn(
      `[gemini] BATCH_PARSE_FAIL asset=${JSON.stringify(assetType)} fields=${fields.length} ` +
        `err=${JSON.stringify(err && err.message ? err.message : String(err))} ` +
        `len=${String(text || '').length} raw=${JSON.stringify(sampleForLog(text))}`
    );
    // A JSON.parse failure carries no geminiKind, and must not be reported as
    // one: the call SUCCEEDED and the response was unusable. It leaves this null
    // so a per-field rescue failure — which is a real transport class — wins.
    batchFailureKind = err && err.geminiKind ? err.geminiKind : null;
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
    let rescueFailureKind = null;
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
      // SIBLING CONTEXT, WHICH THIS CALL NEVER HAD. The batch writes every field
      // of an asset in ONE call so they can reference each other; a rescue
      // without siblings is a field written in ignorance of the set it belongs
      // to. When the whole batch fails to parse, EVERY field takes this path, so
      // a nine-field email came back as nine independent lines with an identical
      // fieldCount and an identical completion card — the one thing that changed
      // was the only thing nothing measured.
      //
      // BUILT PER FIELD, INSIDE THE LOOP, from two sources — and that is the one
      // way this differs from the two call sites it copies. googleDocs.js's
      // scoped redraft and pipeline.js's template regenerate both read siblings
      // from copy that ALREADY EXISTS in the document, so they can build the list
      // once and filter self per iteration. This is a FIRST draft: nothing exists
      // yet and the copy accumulates as the loop runs, so the list has to be
      // rebuilt each time or every field would see the same empty set.
      //
      //   `out`   fields already finished this pass — their FINAL copy, post-rescue
      //   `byKey` fields not yet reached — their BATCH copy, when the batch parsed
      //
      // The second source is what makes this worth doing for the COMMON case
      // rather than only for a total parse failure. A single field missing or
      // over its limit inside an otherwise-good batch takes this same path, and
      // today it is redrafted blind while its eight finished siblings sit in the
      // very map being read one line above. With both sources it now sees all of
      // them: the earlier ones as written, the later ones as drafted.
      //
      // On a total parse failure byKey is empty, so this degrades to "everything
      // drafted so far" — field 1 sees nothing, field 9 sees eight. Asymmetric,
      // and still strictly more than the nothing it had.
      //
      // Same shape as the other two call sites: [{ fieldName, copy }], self
      // excluded, empties dropped (siblingContextBlock drops them anyway, but a
      // list of blanks would be a misleading thing to hand it).
      const finished = new Map(out.map((d) => [d.fieldName, d.copy]));
      const siblings = fields
        .filter((s) => s.fieldName !== f.fieldName)
        .map((s) => ({
          fieldName: s.fieldName,
          copy: finished.has(s.fieldName)
            ? String(finished.get(s.fieldName) || '').trim()
            // cleanDraft, because that is what this value becomes when its own
            // turn comes — context should be what will be written, not the raw
            // string with its fences and labels still on it.
            : cleanDraft(byKey.get(s.fieldName.trim().toLowerCase()) || '').trim(),
        }))
        .filter((s) => s.copy);

      try {
        copy = await generateFieldDraft({
          assetType,
          // The rescue gets the same brief the batch had. Without it a field that
          // fell out of a failed batch would be the ONE field in the asset drafted
          // without the campaign's own words — silently, and only sometimes.
          brief,
          // Same rule, same reason: the rescued field must not be the only one in
          // the asset drafted without the reference figures, or told a different
          // story about where its direction came from.
          enrichedFromReferences,
          referenceStats,
          // Threaded for the same reason, and it is not only tidiness: without it
          // the A/B's BEFORE arm silently gets the inference block back on every
          // field the batch missed, so the arm measures a mixture and reports it
          // as a control. Caught by running the script against a stubbed
          // transport before trusting a single number out of it.
          funnelInference,
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
          siblings,
          // No currentCopy, deliberately. This is a first draft, not a revision —
          // currentCopyBlock's own rule is that a first draft has none and must
          // not be told there is. The over-limit case is the near-miss: the batch
          // DID produce something, but it is being replaced rather than revised.
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
        rescueFailureKind = geminiErrorKind(err);
        console.warn(
          `[gemini] field fallback failed for ${assetType} / ${f.fieldName}: ${err.message} — ` +
            (unenforced
              ? `keeping the batch draft OVER ITS LIMIT and unenforced (${describeLength(copy, f.charMax, f.fieldType)})`
              : 'no copy for this field')
        );
      }
    }

    // AND THE OTHER WAY A DRAFT LEAVES HERE OVER ITS LIMIT: a rescue that
    // SUCCEEDS. generateFieldDraft has no post-hoc word enforcement — its ceiling
    // is null on a word field, deliberately, because the only trim available
    // counts characters — so nothing between there and here shortens a long word
    // body. The catch above only covers the rescue THROWING; this covers it
    // returning, and re-covers the throw case for free.
    //
    // A character field cannot reach this line over its limit: trimToCeiling
    // guarantees compliance on that path. So in practice this is the word fields,
    // which had nothing. It is the report that changes, not the copy — the draft
    // is still kept and still written, it just stops being counted as clean.
    if (!unenforced && overLimit(copy, f.charMax, f.fieldType)) {
      unenforced = true;
      console.warn(
        `[gemini] ${assetType} / ${f.fieldName} drafted OVER ITS LIMIT and unenforced ` +
          `(${describeLength(copy, f.charMax, f.fieldType)}) — a word field has no post-hoc trim`
      );
    }

    // THE CALLER'S OWN IDENTITY FOR THIS FIELD, ECHOED BACK UNREAD.
    //
    // `fieldName` does NOT identify a field. googleDocs.js derives it by
    // stripping the bracket off a label, so "Headline [50]" and "Headline [60]"
    // under one asset both arrive here as "Headline" — and this loop pushes one
    // entry per field regardless, so two entries come back with the same name.
    // The caller used to key them back to a document position BY NAME, which
    // collapsed them (last wins) and gave both the same insertIndex/deleteEnd.
    // Phase 1 then issued that delete range twice in one batch, and the second
    // one cut through whatever had moved into those indices.
    //
    // insertIndex is the label paragraph's endIndex, so it is distinct for every
    // field in a document and needs no composition to stay unique. This function
    // treats both values as OPAQUE: it never reads them, it only hands them back
    // so the caller can resolve a draft to the field it was drafted for.
    const entry = { fieldName: f.fieldName, copy, insertIndex: f.insertIndex, deleteEnd: f.deleteEnd };
    if (unenforced) {
      entry.unenforced = true;
      // Same wording as the log line just above — one call, one vocabulary, so
      // the surfaced marker and the server log never describe the overage
      // differently. googleDocs.js carries this string through untouched.
      entry.unenforcedDetail = describeLength(copy, f.charMax, f.fieldType);
    }
    // WHY ONLY WHEN THERE IS NO COPY, AND ONLY WHEN SOMETHING ACTUALLY FAILED.
    // A field the batch simply omitted and the rescue returned empty for is a
    // model result, not a transport failure, and labelling it 'unknown' would put
    // a "check your billing" sentence in front of a writer whose key is fine.
    const failure = rescueFailureKind || batchFailureKind;
    if (!copy && failure) entry.failure = failure;
    out.push(entry);
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
    ...JSON_ENVELOPE_RULE,
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
  // Null on a word field. This name reaches trimToCeiling below, and the old
  // `Number(charMax) > 0` form fed it a WORD count: a variation on a 120-word
  // field was cut to 120 CHARACTERS and the rest discarded, with nothing logged.
  // The over-limit TEST is overLimit(), in the field's own unit — the two are
  // separate because a word variation can be genuinely over (worth re-drafting)
  // and still must never be character-trimmed.
  const ceiling = trimCeiling(charMax, fieldType);
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

    // Missing or over the limit IN ITS OWN UNIT → fall back to the single-field
    // generator with this doorway injected as revision direction (reuses its
    // rewrite + trim). This used to be `copy.length > ceiling`, which called
    // every correct word-field variation too long and re-drafted all of them.
    if (!copy || overLimit(copy, charMax, fieldType)) {
      const doorwayDirection = [direction, `Use the "${doorway}" angle — ${DOORWAYS[doorway] || ''}`]
        .filter(Boolean)
        .join('. ');
      try {
        copy = await generateFieldDraft({
          assetType,
          fieldName,
          charMax,
          // Both were missing, so the re-draft asked a 120-word field for 120
          // characters — while buildVariationsPrompt above asked the same field
          // for words. The two prompts now agree.
          charMin,
          fieldType,
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
    // Last-resort trim, characters only — `ceiling` is null on a word field, so
    // this cannot fire there. A char-field variation is still trimmed even when
    // the fallback above threw, so a failed fallback leaves no over-limit copy on
    // this path.
    if (copy && ceiling && copy.length > ceiling) copy = trimToCeiling(copy, ceiling);

    // Which leaves the word fields, on both endings — the re-draft threw and the
    // model's own variation was kept, or the re-draft returned and is still long.
    // Neither is trimmed, by design, so the only honest thing left is to say so.
    //
    // KNOWN GAP: `unenforced` on a variation is INERT. The batch drafter's flag
    // is collected into a summary line by its caller in core/, which names the
    // fields, but the riff/regenerate path has no per-field report to put this in
    // — googleDocs.generateDraft returns { title, fieldCount, url } and
    // buildVariantBlock reads only .copy and .doorway. So the warning below is the
    // only surfacing today, and riff can still write over-limit word copy into the
    // copy doc without the writer being told in the UI. Bounded: word fields are
    // the two body fields, and riff is a copy-doc affordance, so nothing reaches a
    // client deliverable this way. Wiring it out means giving that path a report
    // it does not currently have.
    const stillOver = copy && overLimit(copy, charMax, fieldType);
    if (stillOver) {
      console.warn(
        `[gemini] variation ${fieldName}/${doorway} is OVER ITS LIMIT and unenforced ` +
          `(${describeLength(copy, charMax, fieldType)}) — a word field has no post-hoc trim`
      );
    }
    if (copy) out.push(stillOver ? { doorway, copy, unenforced: true } : { doorway, copy });
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
    ...FUNNEL_STAGE_INFERENCE,
    FUNNEL_STAGE_FOR_REVIEW,
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
  // Failure classification. `geminiErrorKind` reads the class off a thrown error,
  // `worstGeminiKind` reduces a run's worth of them, `geminiFailureSentence` is
  // the ONE user-facing wording — Slack and the web both render this, so a
  // reworded cause cannot say two things on two surfaces.
  geminiErrorKind,
  worstGeminiKind,
  geminiFailureSentence,
  // Exposed for unit tests only.
  classifyGeminiStatus,
  GEMINI_FAILURE_SENTENCES,
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
  // The composed guidance line — both draft prompts go through it, so the
  // built-in craft rule cannot be displaced by the field carrying a note.
  fieldGuidanceFor,
  // Bounded one-line sample of a model response, for failure logs. Exported for
  // tests only — no caller outside this file needs it.
  sampleForLog,
  // The labelled brief block and its cap. Exported for tests only.
  briefBlock,
  MAX_BRIEF_CHARS,
  derivedCampaignLines,
  // The attributed figures block and its cap. Exported for tests only.
  referenceStatsBlock,
  MAX_REFERENCE_STATS,
  // The ONE definition of funnel stage, shared by the draft and review prompts,
  // plus each prompt's own consequence clause. Exported so a test can assert
  // both prompts carry the same definition rather than two that have drifted.
  FUNNEL_STAGE_INFERENCE,
  FUNNEL_STAGE_FOR_DRAFT,
  FUNNEL_STAGE_FOR_REVIEW,
  // The response-envelope rule both JSON copy prompts emit. Exported for tests
  // only — no caller has a reason to reach for it.
  JSON_ENVELOPE_RULE,
  siblingContextBlock,
  overLimit,
  // The measure/trim primitives generateFieldDraft's own ladder is built from.
  // Exported so the insert/append path in googleDocs.js can run the identical
  // ladder on an already-generated variation instead of reimplementing it.
  trimCeiling,
  trimToCeiling,
  describeLength,
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
