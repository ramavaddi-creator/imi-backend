// IMI ONE round 1: the intelligence loop, brand-scoped.
//   Feeds (public sources, read on the server) -> Inbox -> Record -> Decision
//   (made on the record itself, owner only, append-only history) -> Outcome.
// Every query carries the workspace; nothing crosses brands.

import { XMLParser } from 'fast-xml-parser';
import type { Env } from './env';
import { HttpError } from './http';

export type FeedItem = { id: string; sourceItemId: string; title: string; summary: string; date: string; source: string; category: string; url: string; evidenceClass: string };
export type FeedSource = { name: string; ok: boolean; count: number; note?: string };

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const strip = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '\u2019').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ feeds

type Fetcher = typeof fetch;
const get = async (f: Fetcher, url: string, accept = 'application/json') => {
  const res = await f(url, { headers: { Accept: accept, 'User-Agent': 'IMI-ONE/1.0 (+https://iddavwildstay.com)' }, signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  return accept === 'application/json' ? res.json() : res.text();
};

// A brand's feed profile (server-side, from workspaces.feed_profile_json): subject and area.
export type FeedProfile = { query?: string; lat?: number; lng?: number; radiusKm?: number; country?: string; newsKeywords?: string[] };
const EVIDENCE: Record<string, string> = { GBIF: 'observation_record', iNaturalist: 'observation_record', OpenAlex: 'research', Crossref: 'research', Mongabay: 'reporting' };

type RawItem = Omit<FeedItem, 'sourceItemId' | 'evidenceClass'>;
const SOURCES: { name: string; category: string; run: (f: Fetcher, q: string, p: FeedProfile) => Promise<RawItem[]> }[] = [
  { name: 'GBIF', category: 'Biodiversity', run: async (f, q, p) => {
    const where = p.lat != null && p.lng != null ? `&geo_distance=${p.lat},${p.lng},${p.radiusKm ?? 50}km` : p.country ? `&country=${p.country}` : '';
    const d: any = await get(f, `https://api.gbif.org/v1/occurrence/search?scientificName=${encodeURIComponent(q)}${where}&limit=6`);
    return (d.results ?? []).map((r: any) => ({ id: `gbif-${r.key}`, title: `${r.scientificName ?? q} recorded${r.eventDate ? ` on ${String(r.eventDate).slice(0, 10)}` : ''}${r.stateProvince ? ` in ${r.stateProvince}` : ''}`,
      summary: [r.basisOfRecord, r.datasetName].filter(Boolean).join(' · '), date: String(r.eventDate ?? '').slice(0, 10), source: 'GBIF', category: 'Biodiversity', url: `https://www.gbif.org/occurrence/${r.key}` }));
  } },
  { name: 'iNaturalist', category: 'Biodiversity', run: async (f, q, p) => {
    const where = p.lat != null && p.lng != null ? `&lat=${p.lat}&lng=${p.lng}&radius=${p.radiusKm ?? 50}` : '';
    const d: any = await get(f, `https://api.inaturalist.org/v1/observations?q=${encodeURIComponent(q)}${where}&per_page=6&order=desc&order_by=observed_on`);
    return (d.results ?? []).map((r: any) => ({ id: `inat-${r.id}`, title: `${r.taxon?.preferred_common_name ?? r.taxon?.name ?? q} observed${r.observed_on ? ` on ${r.observed_on}` : ''}`,
      summary: clip(r.place_guess, 160), date: String(r.observed_on ?? ''), source: 'iNaturalist', category: 'Biodiversity', url: `https://www.inaturalist.org/observations/${r.id}` }));
  } },
  { name: 'OpenAlex', category: 'Research', run: async (f, q) => {
    const d: any = await get(f, `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=6&sort=publication_date:desc`);
    return (d.results ?? []).map((r: any) => ({ id: `openalex-${String(r.id).split('/').pop()}`, title: clip(r.title ?? r.display_name, 240),
      summary: `${r.publication_year ?? ''} · cited by ${r.cited_by_count ?? 0}`, date: String(r.publication_date ?? ''), source: 'OpenAlex', category: 'Research', url: r.doi ?? r.id }));
  } },
  { name: 'Crossref', category: 'Research', run: async (f, q) => {
    const d: any = await get(f, `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=6&sort=published&order=desc`);
    return (d.message?.items ?? []).map((r: any) => {
      const parts = r.published?.['date-parts']?.[0] ?? r.created?.['date-parts']?.[0] ?? [];
      return { id: `crossref-${r.DOI}`, title: clip(Array.isArray(r.title) ? r.title[0] : r.title, 240), summary: clip(Array.isArray(r['container-title']) ? r['container-title'][0] : '', 160),
        date: parts.length ? parts.map((x: number) => String(x).padStart(2, '0')).join('-') : '', source: 'Crossref', category: 'Research', url: `https://doi.org/${r.DOI}` };
    });
  } },
  { name: 'Mongabay', category: 'News', run: async (f, q, p) => {
    const parser = new XMLParser({ ignoreAttributes: false });
    const out: RawItem[] = [];
    const words = [...q.toLowerCase().split(/\s+/).filter((w) => w.length > 3), ...(p.newsKeywords ?? []).map((w) => w.toLowerCase())];
    for (const url of ['https://india.mongabay.com/feed/', 'https://news.mongabay.com/feed/']) {
      const xml = String(await get(f, url, 'application/rss+xml, application/xml, text/xml'));
      const items = parser.parse(xml)?.rss?.channel?.item;
      for (const it of (Array.isArray(items) ? items : items ? [items] : []).slice(0, 15)) {
        const title = strip(String(it.title ?? '')), summary = strip(String(it.description ?? '')).slice(0, 220);
        const hay = `${title} ${summary}`.toLowerCase();
        if (words.length && !words.some((w) => hay.includes(w))) continue; // only items that mention the brand's subject or area
        out.push({ id: `mongabay-${String(it.link)}`, title, summary, date: it.pubDate ? new Date(it.pubDate).toISOString().slice(0, 10) : '', source: 'Mongabay', category: 'News', url: String(it.link) });
      }
    }
    return out.slice(0, 8);
  } },
];

const cache = new Map<string, { at: number; body: { items: FeedItem[]; sources: FeedSource[]; scope: string; retrievedAt: string } }>();
export const parseProfile = (json: unknown): FeedProfile => { try { return typeof json === 'string' ? JSON.parse(json) : {}; } catch { return {}; } };

export async function feeds(query: string, profile: FeedProfile = {}, f: Fetcher = fetch) {
  const q = clip(query, 80) || profile.query || 'Panthera tigris';
  const key = `${q}|${JSON.stringify(profile)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.body;
  const retrievedAt = new Date().toISOString();
  const results = await Promise.all(SOURCES.map(async (s) => {
    try {
      const items = (await s.run(f, q, profile)).map((i) => ({ ...i, sourceItemId: i.id, evidenceClass: EVIDENCE[s.name] ?? 'unverified' }));
      return { items, src: { name: s.name, ok: true, count: items.length } };
    } catch (e) { return { items: [] as FeedItem[], src: { name: s.name, ok: false, count: 0, note: (e as Error).message.slice(0, 80) } }; }
  }));
  const items = results.flatMap((r) => r.items).filter((i) => i.title).sort((a, b) => b.date.localeCompare(a.date));
  const scope = profile.lat != null ? `Within ${profile.radiusKm ?? 50} km of the brand's location` : profile.country ? `Country: ${profile.country}` : 'Worldwide (no area set for this brand)';
  const body = { items, retrievedAt, scope, sources: [...results.map((r) => r.src),
    { name: 'eBird', ok: false, count: 0, note: 'Needs a server key and written permission for commercial use' },
    { name: 'NASA FIRMS', ok: false, count: 0, note: 'Needs a free FIRMS key on the server' }] };
  cache.set(key, { at: Date.now(), body });
  return body;
}

// ------------------------------------------------------------------ codes, guard, brand settings

// Atomic code allocation (INB-0001...): one UPDATE...RETURNING, never COUNT(*)+1.
export async function allocCode(env: Env, prefix: 'INB' | 'INT' | 'DEC') {
  const r = await env.DB.prepare('INSERT INTO code_counters (name, n) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1 RETURNING n').bind(prefix).first<{ n: number }>();
  return `${prefix}-${String(r!.n).padStart(4, '0')}`;
}
const GUARD = 'INSERT INTO write_guard (x) SELECT 1 WHERE changes() = 0';
const guardTripped = (e: unknown) => /CHECK constraint failed/i.test(String(e));
const uniqueHit = (e: unknown) => /UNIQUE constraint failed/i.test(String(e));
export type WsInfo = { id: string; domain: string };

// ------------------------------------------------------------------ inbox

const INBOX_STATUS = ['pending', 'verified', 'disputed', 'ignored', 'archived', 'promoted'];

export async function listInbox(env: Env, ws: string, status: string | null) {
  const s = status && INBOX_STATUS.includes(status) ? status : null;
  const { results } = await env.DB.prepare(
    `SELECT id, code, type, date, summary, full_text, origin, status, submitted_by, source_category, source_reference, feed_source, source_item_id,
       published_at, retrieved_at, evidence_class, promoted_record_id, created_at
     FROM inbox_items WHERE workspace_id = ? ${s ? 'AND status = ?' : "AND status NOT IN ('archived','promoted','ignored')"} ORDER BY created_at DESC LIMIT 100`)
    .bind(...(s ? [ws, s] : [ws])).all();
  return results ?? [];
}

export async function captureInbox(env: Env, ws: WsInfo, who: string, body: any) {
  const summary = clip(body?.summary, 300);
  if (summary.length < 3) throw new HttpError(400, 'Write a short summary.');
  const type = ['observation', 'evidence', 'question', 'outcome'].includes(body?.type) ? body.type : 'observation';
  const fromFeed = !!body?.feedSource;
  const sourceItemId = fromFeed ? clip(body?.sourceItemId, 300) || null : null;
  const evidence = fromFeed ? (['official', 'research', 'observation_record', 'reporting', 'opinion'].includes(body?.evidenceClass) ? body.evidenceClass : 'unverified') : 'unverified';
  if (sourceItemId) {
    const dup = await env.DB.prepare('SELECT id, code FROM inbox_items WHERE workspace_id = ? AND feed_source = ? AND source_item_id = ?').bind(ws.id, clip(body.feedSource, 60), sourceItemId).first<any>();
    if (dup) return { id: dup.id, code: dup.code, duplicate: true };
  }
  const id = crypto.randomUUID();
  const code = await allocCode(env, 'INB');
  try {
    await env.DB.prepare(`INSERT INTO inbox_items (id, code, domain, type, date, summary, origin, submitted_by, submitter_role, retrospective, status, full_text,
        source_reference, source_category, source_type, feed_source, source_item_id, published_at, retrieved_at, evidence_class, workspace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'member', 'none', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, code, ws.domain, type, now().slice(0, 10), summary, fromFeed ? 'secondary_external' : 'primary_internal', who,
        clip(body?.fullText, 4000) || summary, clip(body?.url, 500) || null, clip(body?.category, 60) || null,
        fromFeed ? 'feed' : 'manual', fromFeed ? clip(body.feedSource, 60) : null, sourceItemId,
        clip(body?.publishedAt, 40) || null, fromFeed ? clip(body?.retrievedAt, 40) || new Date().toISOString() : null, evidence, ws.id, now()).run();
  } catch (e) {
    if (uniqueHit(e) && sourceItemId) {
      const dup = await env.DB.prepare('SELECT id, code FROM inbox_items WHERE workspace_id = ? AND feed_source = ? AND source_item_id = ?').bind(ws.id, clip(body.feedSource, 60), sourceItemId).first<any>();
      if (dup) return { id: dup.id, code: dup.code, duplicate: true };
    }
    throw e;
  }
  return { id, code, duplicate: false };
}

export async function setInboxStatus(env: Env, ws: string, id: string, status: string) {
  if (!['verified', 'disputed', 'ignored', 'archived', 'pending'].includes(status)) throw new HttpError(400, 'Unknown status.');
  const r = await env.DB.prepare("UPDATE inbox_items SET status = ? WHERE id = ? AND workspace_id = ? AND status <> 'promoted'").bind(status, id, ws).run();
  if (!(r as any).meta?.changes) throw new HttpError(404, 'Inbox item not found');
}

// Promote: one record per inbox item. The status change and the record are one batch;
// a second request (at the same moment, or a retry) gets the same record back.
export async function promoteInbox(env: Env, ws: WsInfo, id: string, who: string) {
  const item = await env.DB.prepare('SELECT * FROM inbox_items WHERE id = ? AND workspace_id = ?').bind(id, ws.id).first<any>();
  if (!item) throw new HttpError(404, 'Inbox item not found');
  const existing = async () => {
    const r = await env.DB.prepare('SELECT id, code FROM intelligence_records WHERE source_inbox_id = ? AND workspace_id = ?').bind(id, ws.id).first<any>();
    return r ? { id: r.id, code: r.code, existing: true } : null;
  };
  if (item.status === 'promoted') { const r = await existing(); if (r) return r; }
  const rid = crypto.randomUUID();
  const code = await allocCode(env, 'INT');
  const observation = {
    rawStatement: item.full_text || item.summary, source: item.feed_source, sourceReference: item.source_reference, sourceItemId: item.source_item_id,
    publishedAt: item.published_at, retrievedAt: item.retrieved_at, evidenceClass: item.evidence_class, inboxCode: item.code,
  };
  try {
    await env.DB.batch([
      // Order matters: references are checked, so the record exists before the item points at it.
      env.DB.prepare("UPDATE inbox_items SET status = 'promoted' WHERE id = ? AND workspace_id = ? AND status <> 'promoted'").bind(id, ws.id),
      env.DB.prepare(GUARD),
      env.DB.prepare(`INSERT INTO intelligence_records (id, code, domain, record_type, title, status, created_at, updated_at, author, author_role, observation_json,
          learning_strength, source_category, verification_status, workspace_id, source_inbox_id)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, 'member', ?, 'provisional', ?, ?, ?, ?)`)
        .bind(rid, code, ws.domain, item.type, clip(item.summary, 200), now(), now(), who, JSON.stringify(observation), item.source_category,
          item.status === 'verified' ? 'verified' : 'unverified', ws.id, id),
      env.DB.prepare('UPDATE inbox_items SET promoted_record_id = ? WHERE id = ? AND workspace_id = ?').bind(rid, id, ws.id),
    ]);
  } catch (e) {
    if (guardTripped(e) || uniqueHit(e)) { const r = await existing(); if (r) return r; }
    throw e;
  }
  return { id: rid, code, existing: false };
}

// ------------------------------------------------------------------ records + decision on the record

// The four decisions in the Master Requirements (section 2.3). A decision says what to do with
// the finding; it is NOT approval to publish. Content made from it still needs its own
// owner approval (approvals table) before it can go out.
export const CHOICES = ['create_content', 'take_action', 'monitor', 'archive'] as const;
const REQ_RE = /^[A-Za-z0-9-]{8,64}$/;

export async function listRecords(env: Env, ws: string) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.code, r.record_type, r.title, r.status, r.created_at, r.updated_at, r.author, r.observation_json, r.verification_status, r.source_category,
       d.code AS decision_code, d.selected_option AS decision, d.rationale AS decision_reason, d.approved_by AS decided_by, d.approved_at AS decided_at,
       (SELECT COUNT(*) FROM decision_items x WHERE x.record_id = r.id) AS decision_count,
       (SELECT COUNT(*) FROM contents c WHERE c.source_record_id = r.id) AS draft_count
     FROM intelligence_records r
     LEFT JOIN decision_items d ON d.record_id = r.id AND d.superseded_by IS NULL
     WHERE r.workspace_id = ? ORDER BY r.updated_at DESC LIMIT 100`).bind(ws).all<any>();
  return (results ?? []).map((r) => ({ ...r, observation: safeJson(r.observation_json), observation_json: undefined }));
}

export async function decisionHistory(env: Env, ws: string, recordId: string) {
  const { results } = await env.DB.prepare(
    `SELECT d.code, d.selected_option AS decision, d.rationale AS reason, d.approved_by AS decided_by, d.approved_at AS decided_at, d.superseded_by
     FROM decision_items d JOIN intelligence_records r ON r.id = d.record_id WHERE d.record_id = ? AND r.workspace_id = ? ORDER BY d.rowid`).bind(recordId, ws).all();
  return results ?? [];
}

export async function decideOnRecord(env: Env, ws: WsInfo, recordId: string, who: string, body: any) {
  const choice = body?.choice;
  if (!CHOICES.includes(choice)) throw new HttpError(400, 'Choose: create content, take a business action, monitor, or archive.');
  const reason = clip(body?.reason, 500);
  if (reason.length < 3) throw new HttpError(400, 'Say why, in a few words.');
  const requestId = String(body?.requestId ?? '');
  if (!REQ_RE.test(requestId)) throw new HttpError(400, 'Missing request id.');
  const rec = await env.DB.prepare('SELECT id, code, title FROM intelligence_records WHERE id = ? AND workspace_id = ?').bind(recordId, ws.id).first<any>();
  if (!rec) throw new HttpError(404, 'Record not found');
  const replay = async () => {
    const d = await env.DB.prepare('SELECT id, code, selected_option, approved_by, approved_at, record_id, workspace_id FROM decision_items WHERE request_id = ?').bind(requestId).first<any>();
    if (!d) return null;
    if (d.record_id !== rec.id || d.workspace_id !== ws.id) throw new HttpError(409, 'That request id was already used for something else.');
    return { id: d.id, code: d.code, choice: d.selected_option, decidedBy: d.approved_by, decidedAt: d.approved_at, replayed: true };
  };
  const seen = await replay();
  if (seen) return seen;
  const id = crypto.randomUUID(), at = now();
  const code = await allocCode(env, 'DEC');
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO decision_items (id, code, domain, title, problem_statement, associated_record_code, approval_class, approval_status, approver_required,
          approved_by, approved_at, retrospective, options_considered_json, selected_option, rationale, confidence_level, confidence_reason, workspace_id, record_id, request_id)
        VALUES (?, ?, ?, ?, ?, ?, 'A', 'approved', 'Owner', ?, ?, 'none', ?, ?, ?, 'medium', ?, ?, ?, ?)`)
        .bind(id, code, ws.domain, clip(rec.title, 200), clip(rec.title, 500), rec.code, who, at, JSON.stringify(CHOICES), choice, reason, reason, ws.id, rec.id, requestId),
      // Then any earlier current decision on this record is superseded by it (kept, never otherwise edited).
      env.DB.prepare('UPDATE decision_items SET superseded_by = ? WHERE record_id = ? AND workspace_id = ? AND superseded_by IS NULL AND id <> ?').bind(id, rec.id, ws.id, id),
      env.DB.prepare('INSERT INTO decision_events (id, decision_id, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), id, 'none', 'decided', who, `${choice}: ${reason}`, at),
      env.DB.prepare("UPDATE intelligence_records SET status = 'decided', updated_at = ? WHERE id = ? AND workspace_id = ?").bind(at, rec.id, ws.id),
    ]);
  } catch (e) {
    if (uniqueHit(e)) { const r = await replay(); if (r) return r; }
    throw e;
  }
  return { id, code, choice, decidedBy: who, decidedAt: at, replayed: false };
}

// ------------------------------------------------------------------ outcomes

export async function listOutcomes(env: Env, ws: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, code, decision_code, action_taken, actual_outcome, date_evaluated, evaluator, attribution_confidence_level, attribution_confidence_reason
     FROM outcome_items WHERE workspace_id = ? ORDER BY date_evaluated DESC LIMIT 100`).bind(ws).all();
  return results ?? [];
}

function safeJson(s: unknown) { try { return typeof s === 'string' ? JSON.parse(s) : null; } catch { return null; } }
