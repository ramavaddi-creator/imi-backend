# DEC-IMI-002 — Content Studio and Connections pilot ahead of Phase 0 exit

| Field | Value |
| --- | --- |
| Decision ID | DEC-IMI-002 |
| Owner / approver | Rama Krishna Vaddi |
| Class | B (brand/commercial); live wildlife or behaviour claims stay Class A per item |
| Status | **Draft — effective only when Rama records the date and signs below** |
| Affects | IMI Master Requirements v2.0: Part A §12, §17 gate; Part B §10, §12; CILA-AT-30 |

## Decision

Authorise a limited pilot of Content Studio and platform Connections before the
Phase 0 exit gate, because the owner needs to start testing real publishing
paths now. The Phase 0 gate itself is **not** waived.

## Authorised in this pilot

- Content Studio: campaigns, grounded AI drafting (Claude or ChatGPT), poster
  composition, per-channel captions, owner approval, test and live posting.
- Connections: Facebook, Instagram, Threads, LinkedIn, Google Business Profile,
  YouTube, Telegram, WhatsApp Business, Claude, ChatGPT.
- Enquiries (CRM inside IMI): manual and website-form enquiry capture, stages
  to booking, automatic campaign attribution, campaign funnel, outcome bridge.
- Claude/ChatGPT drafting for WhatsApp Status, the Iddav website and Google Ads
  (copy-only), and prompts for outside creative tools (Gemini, Google Flow,
  Runway, Adobe Firefly, Canva, CapCut, ChatGPT, Claude) with import of the
  finished poster or video, including video posting to Instagram Reels,
  Facebook, Threads, Telegram and YouTube.
- D1 migrations `schema_v5.sql`, `schema_v6.sql` and `schema_v7.sql`, and the R2 bucket `imi-posters`.

## Conditions (all built into the software)

1. Every live post needs a recorded owner approval tied to a hash of the exact
   poster and captions, plus the owner PIN. Any edit voids the approval.
2. AI may state as fact only the linked approved decision/record and the
   owner-stated facts; drafts that cite unknown evidence are rejected.
3. Original photos are the default. AI backgrounds are landscape atmosphere only
   (no animals, people or buildings) and carry an "AI-generated" label on the
   poster and in every caption.
4. AI video or images made in outside tools are labelled "Made with AI" in every
   caption; if they show animals the content needs Class A approval with a
   domain review note (PR-05/06, FR-BRD-007). Website and Google Ads copy is
   never auto-published.
5. One publication record and one adapted caption per channel, each with a
   tracked link; every test, publish and manual record is in an audit log.
6. Monthly AI caps (default 60 images, 600 text drafts) and a log of every call.
7. Manual posting stays available for every channel and is recorded the same way.

## Not authorised by this decision

- Automated collectors, analytics ingestion, AI learning promotion or any
  predictive model (remain Phase 2+).
- Paid advertising spend from IMI (ads are bought in each ad manager; IMI only
  issues tracked links).
- Treating pilot campaigns and outcomes as the ledger of record. They are pilot
  data until the Phase 0 exit (10 reviewed cases, manifest, DEC-IDDAV-001 audit,
  commercial truth fields, schema review) is signed.

## Personal data (Enquiries)

- Guest names, phones and messages stay in the Enquiries tables, are never sent
  to AI providers, and can be erased per guest ("Delete personal data").
- Website enquiries require the guest's consent to be contacted; marketing
  consent is a separate, optional tick.
- Before live capture, Rama records a retention period for enquiries
  (spec §21): ______ months after last contact.

## Spec amendments this decision also asks Rama to settle

- CIL-NFR-001 requires Cloudflare Access on all internal routes. Either enable
  Access (allow `/media/*` and `/oauth/*` through) or amend the requirement.
- TFR-REU-002/007 keep staff-operations data out of IMI tables; the Enterprise
  Suite decision says one shared backend. Record which wins.

## Review

Review this pilot after the first campaign's outcome window closes, or 60 days
from the effective date, whichever is sooner.

Effective date: ____________   Signed: ____________ (Rama Krishna Vaddi)
