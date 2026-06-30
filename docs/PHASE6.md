# Phase 6 — Bidirectional Copy-Design Sync

## The Problem

Every current tool assumes copy flows one direction — writer to designer, done. Designers routinely edit copy inside Figma for layout reasons. A headline breaks a text layer at a certain length so they trim it inline. That change is now invisible to the copywriter, inconsistent with the approved doc, and undetectable by anyone without manually auditing both artifacts. No systematic solution currently exists for this.

## The Feature

Quillio watches both the copy doc and the Figma file continuously after creation. When either artifact changes it surfaces the delta to the appropriate person in Slack with a one-click sync action available.

**Copy doc changes → designer notification:**
A Slack message to the designer identifying which assets are affected and offering one-click sync to Figma. Designer never needs to open the copy doc or find the right layer manually.

**Figma copy changes → copywriter notification:**
A Slack message to the copywriter identifying what was changed in Figma versus the approved doc. Creative Manager also notified — approved copy being edited after sign-off is a brand integrity and compliance issue. One-click sync available to reconcile in either direction.

Neither the designer nor the copywriter needs to open the other's artifact at any point. The inconsistency surfaces in Slack. The resolution happens in Slack. One click.

## Why This Is Structurally Unique

No other tool can do this because no other tool owns both artifacts. Quillio wrote the copy doc. Quillio generated the Figma file. It knows authoritatively at all times whether they are in sync — not by parsing or guessing but because it created both from the same source of truth.

This creates a passive audit trail for post-approval copy changes without requiring any formal process. Leadership and Creative Managers gain visibility into production integrity as a natural byproduct.

## The Broader Implication

Most tools are generation tools — they perform an action and exit. Quillio becomes a persistent operational layer for the entire life of a campaign. This is subscription-worthy product behavior. It reframes the value from "tool that writes copy" to "system that keeps creative production coherent from brief to final asset."

## Phase 6 Build Order

1. Figma file change detection — webhook or polling to detect text layer edits in project Figma files
2. Copy doc change detection — Google Docs revision API to detect changes to copy fields
3. Delta computation — compare current Figma text layer values against approved copy doc values
4. Role-appropriate Slack notifications — copywriter notified of Figma changes, designer notified of doc changes, Creative Manager notified of any post-approval edits
5. One-click sync — Slack button to push doc copy to Figma or pull Figma copy to doc
6. Audit trail — log all copy changes with timestamp, role, and direction to project record in Postgres
7. Creative Manager dashboard — web app view showing sync status across all active projects

## Dependencies

- Requires Phase 4 (Figma integration) to be complete
- Requires approval workflow (Phase 3) to be complete
- Figma webhooks require Figma OAuth per tenant
- Google Docs revision API requires existing Google OAuth per user (already built in Phase 3)
