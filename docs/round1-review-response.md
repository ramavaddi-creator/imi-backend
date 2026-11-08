# IMI ONE Round 1: response to the patch review

Status: revised, **not deployed**. No production data, database, Worker, secret or
setting was read or changed while preparing this revision. The schema files are
proposals; they were run only inside the automated tests.

## Corrections

| # | Finding | Change | Test |
|---|---|---|---|
| 1 | Migration assigned every row to Iddav | `schema_v10.sql` and `schema_v9.sql` no longer assign brands. Rows without a brand are invisible to every brand (quarantined) until assigned by `scripts/assign-workspaces.sql`, after the read-only inventory (`scripts/inventory.sql`) and founder approval of the mapping. | rows with no brand are quarantined |
| 2 | Promotion not concurrency-safe | The status change and the new record are one batch, with a guard that rolls it back if the item was already promoted; the database also allows only one record per inbox item (unique index). A second request at the same moment, or a retry, returns the same record (200). | promoting twice at once creates one record |
| 3 | Codes from COUNT(*)+1 | Atomic counter (`code_counters`, one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`), started after the highest existing code. | 8 simultaneous captures get 8 different codes |
| 4 | Hardcoded Iddav domain | Domain comes from `workspaces.record_domain` (server-side); a brand without one uses its workspace id. | Antardrishti items are not labelled Iddav |
| 5 | Cross-brand guessed ids | Every query is scoped by workspace in SQL; another brand gets 404 and nothing changes. | read, status, promote, decide, history via guessed ids |
| 6 | Decisions not idempotent | Each decision carries a client request id (unique in the database). A retry, or two identical requests at once, returns the same decision. A new decision supersedes the previous one (`superseded_by`), which is kept; the history endpoint lists all. | retries, simultaneous retries, revisions |
| 7 | Provenance | Inbox items keep the source's own item id, link, publication date, retrieval time, evidence class (official, research, observation record, reporting, opinion, unverified) and full text. All of it travels into the record. The same source item is captured once per brand. | provenance kept, duplicates recognised |
| 9 | Feeds not targeted | Each brand has a server-side feed profile (subject, location, radius, news keywords). Iddav: Panthera tigris within 60 km of Tadoba for GBIF and iNaturalist; Mongabay items must mention the subject or area. Brands without a profile are labelled "Worldwide". | area parameters per brand |
| 12 | Decision vs publishing approval | A decision records what to do with a finding. It never approves content: drafts made from it (`contents.source_record_id`) still need the separate owner approval before publishing. Decision events use the status `decided`. | |
| 13 | Linking | record → decision (`record_id`) → draft (`contents.source_record_id`) → publication (existing) → outcome (`decision_code`). The records list shows decision and draft counts. | |
| 14 | Attribution | Author, submitter and decision maker are always the verified Access email from the server; nothing is taken from the request body. | existing SEC tests |
| 15 | Real staging auth | Verified on Cloudflare (8 Nov): `/v1/me` returned the Access-verified email; all 10 smoke checks on both staging Workers returned 302 to Access without sign-in; preview URLs are off. | staging S1, S3 |

Not yet done (P1 #8, #10, #11): durable ingestion, the live inventory, and source licensing sign-off. See below.

## Migration and rollback

Staging: apply `schema_v10.sql` to `imi-db-staging` only. Production (later, with approval):
1. `npx wrangler d1 export imi-db --remote --output imi-db-before-v10.sql`
2. Run `scripts/inventory.sql`; produce the mapping report; founder approves the mapping.
3. Apply `schema_v9.sql`, then `schema_v10.sql`, then the approved `assign-workspaces.sql`.
4. Deploy the Worker.

Rollback: redeploy the previous Worker version (`wrangler rollback`). All schema changes are additive, so the old code keeps working. If data must be restored, use the export from step 1.

## API contract (round 1)

All routes need a verified Cloudflare Access identity and a membership of the brand; a brand you do not belong to answers 404.

| Method and path | Permission | Notes |
|---|---|---|
| GET `/v1/workspaces/:ws/feed?q=` | today.read | `{ items[], sources[], scope, retrievedAt }`; each item has `sourceItemId`, `evidenceClass` |
| GET `/v1/workspaces/:ws/inbox?status=` | today.read | open items by default |
| POST `/v1/workspaces/:ws/inbox` | content.create | 201 new, 200 if the same source item was already captured |
| POST `/v1/workspaces/:ws/inbox/:id/status` | content.create | `verified, disputed, ignored, archived, pending` |
| POST `/v1/workspaces/:ws/inbox/:id/promote` | content.create | 201 new record, 200 the existing record |
| GET `/v1/workspaces/:ws/records` | today.read | with current decision, decision count, draft count |
| GET `/v1/workspaces/:ws/records/:id/decisions` | today.read | full history including superseded |
| POST `/v1/workspaces/:ws/records/:id/decision` | decide (owners) | `{ choice, reason, requestId }`; 201 new, 200 replayed |
| GET `/v1/workspaces/:ws/outcomes` | results.read | |

## Sources: terms to confirm before production

| Source | Use here | To confirm |
|---|---|---|
| GBIF | occurrence metadata and link | dataset licences vary (CC0, CC BY, CC BY-NC); show attribution |
| iNaturalist | observation metadata and link | observation licences are often CC BY-NC; API rate limits |
| OpenAlex | research metadata | CC0; polite rate limits |
| Crossref | research metadata | metadata is open; add a contact email for the polite pool |
| Mongabay | headline, short summary, link | RSS reading; no republishing of articles without permission |
| eBird | not enabled | commercial use needs written permission from the Cornell Lab |
| NASA FIRMS | not enabled | free key; detections are satellite hotspots, not confirmed fires |

## Remaining gaps against Addendum 03

- Durable ingestion: feed registry table, scheduled collection (Worker cron), cursors, retries and failure monitoring. Today feeds are fetched on request and cached for 10 minutes.
- Live inventory and history migration (needs the founder's go-ahead for the read-only export).
- Social media reading (Meta in development mode), Send to AI, Bring back from AI, publishing link-up, outcome reminders.
- Antardrishti calculation feeds (needs the Antardrishti code), competitor watch, events and foresight.
