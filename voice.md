# Quillio Brand Voice

<!--
PLACEHOLDER — replace the guidance below with your real brand voice.

This file is loaded once at startup and injected into Quillio's draft-generation
prompts as the OVERALL brand identity and writing principles. It informs every
field draft. The Google Sheet's per-field "Tone Notes" remain the field-specific
tactical direction — both are respected together.

How loading works (see loadVoiceGuide in src/services/gemini.js):
  - Everything inside HTML comments like this one is stripped and never sent to
    the model.
  - While the file contains only headings + this comment (i.e. it's unfilled),
    it's treated as empty and NOTHING is injected — drafts behave as before.
  - As soon as you add real text under the headings, it starts being injected.
  - Edit takes effect on the next deploy/restart (it's read at startup).

Suggested structure — delete this comment and write your own content:

## Brand voice
Who the brand is: personality, 3–5 voice adjectives, the audience, what we
sound like and explicitly do NOT sound like.

## Tone principles
How we modulate tone (e.g. confident but not arrogant; warm but concise).
What to emphasize, what to avoid.

## Copy best practices
Concrete rules: active voice, sentence case for headlines, no jargon/buzzwords,
lead with the benefit, one idea per line, avoid exclamation marks, etc.

## Do / Don't
On-brand vs off-brand example phrasings, so the model has something to anchor on.
-->
