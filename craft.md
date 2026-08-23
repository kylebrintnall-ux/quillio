# craft.md — Copy Craft Playbook

<!--
  MAINTAINER NOTES (stripped before this file reaches a prompt — HTML comments
  are removed by loadGuide() in src/services/gemini.js).

  This is the CRAFT half of the split guide. It ALWAYS loads, for every tenant,
  and is never replaced by tenant content. Its companion, voice.md, is the BRAND
  half and IS replaced by a tenant's saved guide. See "Craft and brand voice" in
  CLAUDE.md.

  Structural coupling: the "## 7. Writing Across Mediums" heading text and its
  "### " subsection titles are parsed by parseVoice / mediumKeywordsForAsset in
  src/services/gemini.js so only the relevant medium is injected per asset.
  Rename either and you must update mediumKeywordsForAsset too. Keep the CTA
  library and the universal words-to-cut list outside the mediums section so
  they stay universal.

  ==========================================================================
  BEFORE YOU ADD AN EXAMPLE: FORM OR FACT?
  ==========================================================================

  An example in this file WILL be reproduced — as syntax, and sometimes as the
  literal string. That is measured, not feared. What decides whether that is
  harmless or harmful is WHAT THE EXAMPLE DEMONSTRATES:

    FORM   — a transformation, a structure, a punctuation contrast. Reproducing
             it verbatim asserts nothing, so the cost of reproduction is zero.
             "We built this" not "this was built."  (active voice)
             "Start where the work is" — not "…is."  (terminal punctuation)

    FACT   — a quantity, a duration, a date, a price, a named deliverable.
             Reproducing it asserts something, and the model has no way to know
             the assertion is false. THESE DO NOT BELONG IN THIS FILE.

  The four that were removed, and what each produced in a measured run:

    "Save 4 hours a week"        §1.7   \
    "3 ways," "in 10 minutes"    §2.54  /  → "in 60 seconds" (a duration in no
                                            input), "Starting in 10 minutes"
                                            about a real event with no stated
                                            time, "3 practical frameworks"
    "Get the 2026 Benchmark"     §2 by-length, and twice more in the terminal-
                                 punctuation bullet → "Get the 2026 Content Ops
                                 Benchmark", a document the client does not have,
                                 in 4 of 5 drafts
    "Get the Guide"              §4 gloss → "Get the Guide" in 4 of 5 drafts with
                                 no reference material anywhere in the prompt

  Note the asymmetry that makes this worth a rule rather than a habit: the FORM
  examples have been in the file just as long and have never produced anything.

  THE CTA LIBRARY IS NOT AN ILLUSTRATION AND IS NOT COVERED BY THIS. It is a
  menu, and every entry sits under a heading naming the DESTINATION it is valid
  for, so reaching one means first believing that destination exists. The §4
  gloss was unconditioned — a named artefact presented as the winner of a general
  contrast — which is why the gloss went and the library stayed.

  If a rule cannot be stated without a fact-shaped example, that is a signal
  about the rule, not a reason to keep the example.
-->

> **How good copy works** — universal craft, independent of any one brand:
> headline, body and CTA principles, the approved CTA library, character
> discipline, the phrasing that weakens any copy, and how each medium behaves.
>
> This playbook always applies. Brand voice — how a given company *sounds* —
> is supplied separately and wins on tone and word choice; craft governs
> structure. Neither decides what fields exist or their character limits: those
> come from the asset library, and those limits always win.

-----

## 1. Universal Copy Principles (apply everywhere)

1. **Lead with the benefit, not the feature.** The reader cares what it does for them, not what it is.
1. **Active voice.** "We built this" not "this was built."
1. **Cut adverbs and intensifiers.** "Very," "really," "extremely," "actually" — almost always deletable.
1. **One idea per line.** Especially in short formats. Don't cram.
1. **Front-load the important words.** First 3-5 words do the heavy lifting — every format truncates eventually.
1. **Write to one person.** "You," singular. Not "users" or "customers."
1. **Specifics beat generalities.** Name the thing the reader would recognise — "the Monday reforecast" beats "your workflow."
1. **Read it aloud.** If you stumble or run out of breath, rewrite it.
1. **Cut the throat-clear.** Delete openers like "In today's world…" or "We're excited to announce…"
1. **No jargon unless the audience speaks it.** Match the reader's vocabulary, not your internal one.

-----

## 2. Headlines

**Purpose:** Stop the scroll, earn the next line. The headline does one job — make the reader want more.

**Best practices:**

- Make a promise, ask a question, or create a curiosity gap
- Concrete and specific over vague and aspirational. A number is the sharpest specific of all — when you were given one.
- Avoid setup-and-punchline where the limit is too tight to land the payoff — a
  truncated joke is worse than none. That is a constraint on structure, not on
  punctuation: a mark that makes a line turn is not a setup.
- Don't waste characters on your brand name unless it IS the hook

**By length:**

- **Ultra-short (≤30 chars, e.g. Google Display, Meta headline):** One idea. One benefit. No setup.
- **Short (40-70 chars, e.g. LinkedIn headline):** Benefit + light context. Room for a value prop.
- **Medium (90+ chars, e.g. Google long headline):** Can stand alone as a complete thought; make full use of it.

**Terminal punctuation — apply this consistently, do not decide per field.**

A headline is a display line, not a sentence in a paragraph. The default is **no
full stop**:

- **No terminal period** on ad headlines, display headlines, social headlines,
  banner and OOH headlines, subject lines, pre-headers, eyebrows, section
  headings, or any headline that is a fragment or a single clause. "Start where
  the work is" — not "Start where the work is."
- **A question mark or exclamation mark still applies** where the headline
  genuinely is a question or an exclamation. The rule removes the period, not
  punctuation that carries meaning. Use exclamation marks sparingly.
- **Punctuate the period when the headline is two or more sentences**, which
  only the longer formats have room for. Then every sentence takes its stop,
  including the last: "Your data is scattered. We put it back together."
- **Never end a headline with an ellipsis** to imply continuation. If the line
  does not stand on its own, rewrite it.
- **Within one asset, be consistent.** If two headlines sit together — a
  headline and a graphic headline, three carousel cards, five display variants —
  they take the same treatment. A doc where some end in a period and some do not
  reads as unfinished, whichever convention is right.

Where mediums differ:

- **Email subject lines and pre-headers:** never a period. Punctuation there
  costs a character and reads as formal.
- **Print / OOH:** no period. The line is set large; a full stop is visual noise.
- **Sales / 1:1 outreach:** the subject line follows the headline rule, but the
  body is correspondence, not display copy — full sentences, fully punctuated.
- **Body copy, offer bodies, descriptions and legal lines are NOT headlines.**
  They are prose and take normal sentence punctuation, always.
- **CTAs are not headlines either** — see Section 4. They take no terminal
  punctuation at all.

**Internal punctuation.** A headline may take a colon, an em dash or a question
mark where the mark earns its place. The rule above removes a full stop; it does
not remove punctuation that does work inside the line.

None of these marks is preferred, expected, or a target. Most headlines need
none. This is a permission, not an instruction: use one where the line turns, and
nothing where it does not.

-----

## 3. Body Copy

**Purpose:** Build the case. Expand the headline's promise into a reason to act.

**Best practices:**

- First sentence earns the second. Hook before you explain.
- One core message — don't list every feature
- Short sentences. Vary rhythm but default to brief.
- Concrete proof over adjectives (data, outcomes, specifics)
- End by pointing toward the action
- In truncated formats (Meta primary text, LinkedIn intro), put everything that matters before the "see more" cutoff

<!--
  BULLETS — why this rule is here, and what it is NOT.

  It is ADDITIVE. Before this, craft.md said nothing anywhere about bullets,
  lists, line breaks or white space. The only near-miss was §2's "they are prose
  and take normal sentence punctuation", which is a terminal-punctuation
  exemption for body copy, not a format mandate — do not read it as one.

  IT DOES NOT TOUCH "One core message — don't list every feature" ABOVE. That
  rule constrains how many things the copy covers; this one constrains how
  parallel material is laid out. A three-bullet body making ONE argument does
  not violate it, and a running-prose body enumerating eight features still
  does. If a future edit tries to reconcile them, they were never in conflict.

  IT IS THE MECHANISM TWO asset_directions ALREADY ASSUME. One-Pager reads
  "Scannable in 30 seconds. Problem, solution, proof, CTA. Nothing extra." and
  Battle Card reads "Arm the rep, not the reader. Crisp, confident, scannable
  under pressure." Both ask for scannable and neither says what scannable looks
  like. Both are also null-routed by mediumKeywordsForAsset, so they receive all
  eight medium sections and nothing tailored — this section is the whole of the
  guidance they get on the point.

  NO WORKED EXAMPLE, DELIBERATELY. See the FORM/FACT note at the top of this
  file: a worked bullet set would be FACT-shaped (a named proof point, a figure)
  and the measured behaviour of this file is that such examples are reproduced
  as literal strings. There is no bullet set here for that reason.

  The ONE concrete instance — "a nurture email with three proof points" — names
  an ASSET and a COUNT, and the count is the same three the rule above states.
  It asserts nothing a model could reproduce as a false claim, which is the test
  the FORM/FACT note actually applies. It is here because a heading saying email
  is the best case without saying what that looks like is the same gap One-Pager
  and Battle Card already have — "scannable" with no mechanism behind it.
-->

**Bullets — when the brief supplies parallel points.** Where the brief gives
three or more genuinely parallel points of value — features, proof points,
differentiators, objections — set them as three bullets, not as prose.

**The condition is the brief, not the field.** Length is not the trigger. One
idea developed stays prose; forcing prose into a list to look scannable is worse
than the prose was.

**Three is the shape.** Two reads as an incomplete pair. Five or more becomes the
wall of text with different punctuation.

**Bullets do not exempt the rules above.** The first bullet still earns the
second, each still carries concrete proof over adjectives, and the body still
ends by pointing toward the action — the bullets are the middle of the case, not
the whole of it.

**Email is where this works best, not an exception.** A nurture email with three
proof points is the strongest case for bullets anywhere in this playbook. The
frame does not change: context in a sentence, the ask in a sentence, the next
step in a sentence. The bullets are what the material between them becomes.

**By medium:** see Section 7.

-----

## 4. CTA Copy

**Purpose:** Tell the reader exactly what happens next. The CTA is a promise about the click.

**Core rule:** The CTA must match the destination. What the button says should be exactly what the reader gets. Mismatched CTAs kill trust and conversion.

**Best practices:**

- Action verb first ("Get," "See," "Start," "Download")
- Set expectation for what's on the other side
- Specific beats generic — name the action and where it lands, never "Click Here"
- First person can lift response ("Start my trial") — test it
- Keep it short; most CTA fields cap at 15-25 chars

### Approved CTA Library by Destination

**→ Landing page / website (general):**
Learn More · See How It Works · Explore · Discover More · Get the Details

**→ Gated content (whitepaper, report, guide):**
Download the Guide · Get the Report · Read the Whitepaper · Get Your Copy · Access the Research

**→ Webinar / event registration:**
Register Now · Save My Seat · Reserve a Spot · Sign Up Free · Register Free

**→ Video content:**
Watch Now · Watch the Demo · See It in Action · Play Video

**→ Free trial / product signup:**
Start Free Trial · Start Free · Try It Free · Get Started · Start My Trial

**→ Demo request (sales-assisted):**
Get a Demo · Request a Demo · See a Demo · Book a Demo · Talk to Sales

**→ Purchase / transaction:**
Buy Now · Shop Now · Get Started · Add to Cart · Upgrade Now

**→ Newsletter / subscription:**
Subscribe · Join the List · Get Updates · Sign Up

**→ Contact / lead form:**
Contact Us · Get in Touch · Request Info · Talk to an Expert

**→ App install:**
Get the App · Download Free · Install Now

> Rule of thumb: lower-commitment destinations (content, video) can use softer CTAs ("Learn More"); higher-commitment destinations (purchase, demo) should be direct and set clear expectations.

-----

## 5. Character Count Discipline

Two numbers matter for every field: the **hard limit** (where the platform rejects or truncates) and the **recommended length** (where it performs best). Write to the recommended, never exceed the hard limit.

- **Google Ads:** hard-rejects copy over the limit. Never go over.
- **Meta:** silently truncates with "…See More." Everything critical goes before the cutoff (~125 chars primary text).
- **LinkedIn:** truncates on mobile around 150 chars intro text even though the field allows more.
- **Twitter/X:** links consume 23 characters regardless of actual URL length.

When a field has both a recommended and a max, write to the recommended. Platforms show those numbers because that's what performs.

-----

## 6. Words & Phrases to Cut (universal)

These weaken copy in any voice. Cutting them is craft, not brand preference — a brand's own vocabulary rules sit on top of this list, never instead of it.

**Generic filler — delete or replace with something concrete:**

- "Leverage," "synergy," "best-in-class," "world-class," "cutting-edge," "revolutionary," "game-changing," "seamless," "robust," "innovative" (when unearned)
- "Solutions," "empower," "unlock," "elevate," "supercharge," "next-level," "state-of-the-art," "industry-leading," "turnkey," "holistic"
- Unearned superlatives: "the best," "the only," "#1" without a citable basis

**Throat-clears — delete the opener, start at the news:**

- "In today's fast-paced world…" and every variant of it
- "We're excited to announce…" / "We're thrilled to share…" (lead with the news, not your excitement)
- "As you know…" / "It goes without saying…" (then don't say it)

**Hedges that drain a claim:** "may help," "can potentially," "one of the leading," "arguably," "we believe" — either make the claim or cut the sentence. A hedge weakens a claim you could state plainly. Saying less than you know is a hedge; saying only what you know is not — if you were never given the number, "starts soon" is the accurate line, not the weak one.

**Prefer:**

- Plain verbs over nominalizations ("decide" not "make a decision")
- Concrete nouns over abstractions
- The reader's words over internal jargon

-----

## 7. Writing Across Mediums

Different placements demand different copy behavior, even for the same campaign.

### Paid Social — general

Interruptive. The reader didn't ask for this. Earn attention in the first line. Lead with tension, insight, or benefit — never with brand throat-clearing.

**LinkedIn (paid):** Professional but human. B2B audience, so data and role-relevant pain points land. Intro text ~150 chars before truncation; hook in line one. Headline ~70 chars, benefit-led.

**Meta — Facebook/Instagram (paid):** Visual-first; copy supports the creative. Primary text 125 chars visible — front-load everything. Headline 27-40 chars. Instagram skews shorter and more visual than Facebook. Design for the most restrictive placement (Instagram) and it works everywhere.

**Twitter/X (paid):** Conversational, real voice, native to the feed. 280 chars but shorter performs better (under 100 chars wins engagement). Account for the 23-char link cost.

### Organic Social

**The key difference from paid:** organic is permission-based — these people chose to follow you. You can be more conversational, more brand-personality-forward, less hard-sell. Paid earns the click; organic builds the relationship. Don't run paid copy as organic or it reads like an ad in the feed.

- Emoji acceptable where on-brand
- URL typically at the end
- Engagement-first: ask, share, react — don't always sell

### Google Display

Push advertising — interrupts browsing. Awareness and interest, not the hard close. Short headline (30) carries the message universally; long headline (90) should stand alone since description sometimes doesn't render. Personalize for remarketing ("Still thinking about it?").

### Google Search

Pull advertising — the reader is actively looking. Match the search intent. Include the keyword. Be direct and functional — clever underperforms here. Headlines 30 chars, descriptions 90 chars; write all 15 headlines to give the algorithm room.

### Email

**Subject line:** the whole job is the open. Curiosity or benefit, no clickbait. ~50 chars to avoid inbox truncation.
**Pre-header:** extends the subject, doesn't repeat it.
**Body:** one clear message, scannable, building to a single primary CTA. Secondary offers come after and read as lighter.
**CTA buttons:** match the destination (see Section 4).

**One ask per email.** Multiple asks kill reply rates — the reader has to choose,
and choosing is work, so they do nothing. If a second thing genuinely needs saying,
it goes after the ask and reads as lighter, or it goes in a different email.

**Structure beats length.** Context in one or two sentences. The ask in one. The
next step in one. A well-structured 150-word email outperforms a poorly structured
60-word one, so length targets are a budget for that structure, not a score to
minimise. Analysis of 40M emails puts the response sweet spot at 75–100 words;
past 200, response falls below 40%.

**Longer bodies click less.** The relationship is consistent enough to plan
around: as body length goes up, click-through goes down. It holds in a
peer-reviewed study of 1,679 promotional campaigns across 50 countries, and in
every practitioner dataset published since. Treat length as something you spend,
not something you fill — if a sentence isn't earning the click, it's costing it.

**Proof before pitch.** Earn the right to ask. A result, a name, a number, a
specific observation — something that shows you did the work — and then the ask.
Asking first spends credibility you haven't established.

**Specific over general.** One real detail about their business beats every
adjective available to you. "Your three new AEs in Denver" lands; "your growing
sales organisation" does not. If a sentence would be equally true of any recipient,
it is doing no work.

**Failure modes, by name:**
- *The wall of text* — 300+ words with no paragraph breaks. It reads as effort
  demanded rather than offered, and it gets scanned for the ask and abandoned.
- *The over-apologizer* — "sorry to bother you", "I know you're busy", "just
  circling back". Every hedge is a reason to deprioritise the email; you wrote it
  because it's worth reading, so write like it.
- *The multi-ask* — "book a call, or download this, or reply with a time." Three
  asks is zero asks.

### Print / Out-of-Home

No click, no link — the copy has to do everything. Fewer words, bigger idea. Memorable over detailed. The reader sees it for seconds — one message, cleanly delivered. Include a clear, simple way to act (URL, QR, search term).

### Sales / 1:1 Outreach

Peer-to-peer, not corporate. Personalized and role-relevant. No marketing speak. Reads like one human emailing another. One clear ask. Everything in the Email section above applies here first — one ask, proof before pitch, specific over general, and the three failure modes.

**Cold is a different product from marketing email.** Cold outreach is plain text
with a 1:1 feel and it is asking for a REPLY. Marketing email is branded HTML and
it is asking for a CLICK. They are not the same thing written to different lengths:
branded HTML is currently underperforming in B2B outbound precisely because it
announces itself as a campaign, and a campaign does not get a reply.

Write cold as though you typed it in your mail client and hit send: no hero image,
no button, no footer of social icons. A link is a link. The signature is a name.

**Length:** 50–100 words for cold outreach, 25–75 for a follow-up. Those are budgets
for context / ask / next step, not targets to pad toward.

### Confirmation / Post-Conversion

Warm, affirming, low-pressure. Confirm what they just did, set expectations for what's next. The selling is done — now reassure and guide.
