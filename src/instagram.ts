// IMI ONE round 10: Build 1, Instagram read-only (design section 2).
//
// Reads, for one brand's own Instagram professional account: identity, posts (with paging) and the
// insights Meta makes available. Nothing is ever written to Instagram: every call is a GET.
//
//   Auth adapter      Instagram Login token, pasted once by the owner into IMI ONE's own form
//                     (never into a chat), encrypted and bound to brand + account, refreshed before
//                     it expires (60 days; refreshable once at least 24 hours old).
//   Account check     the owner types the expected username; any other account is refused.
//   Sync              newest posts until known ones are reached, then older posts from a saved cursor,
//                     so a failed page resumes where it stopped and nothing is duplicated.
//   Metrics           Meta's own names; history is append-only; a metric Meta does not return is
//                     "unavailable", never 0; Meta's own reasons (e.g. under 5 story viewers) are kept.
//   Audit             every sync is a sync_runs row: complete, partial or failed.

import type { Env } from './env';
import { HttpError, now } from './http';
import { sealBound, openBound } from './crypto';
import { io, redact } from './search';

const HOST = 'https://graph.instagram.com';
const PAGE_LIMIT = 25;
const NEW_PAGES_MAX = 4;        // newest posts per run
const BACKFILL_PAGES_MAX = 3;   // older posts per run
const INSIGHT_POSTS_MAX = 30;   // posts whose insights are refreshed per run (published in the last 60 days)

// Meta's current names (Instagram Login, 2025-26). "impressions" is deprecated; "views" replaces it.
const MEDIA_METRICS: Record<string, string[]> = {
  FEED: ['reach', 'views', 'saved', 'shares', 'total_interactions', 'likes', 'comments', 'profile_visits', 'follows'],
  REELS: ['reach', 'views', 'saved', 'shares', 'total_interactions', 'likes', 'comments', 'ig_reels_avg_watch_time'],
  STORY: ['reach', 'views', 'shares', 'total_interactions', 'replies', 'navigation'],
};
const ACCOUNT_DAY_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'profile_links_taps'];
export const METRIC_LABELS: Record<string, string> = {
  reach: 'Accounts reached', views: 'Views', saved: 'Saves', saves: 'Saves', shares: 'Shares', total_interactions: 'Interactions',
  likes: 'Likes', comments: 'Comments', profile_visits: 'Profile visits', follows: 'Follows', ig_reels_avg_watch_time: 'Average watch time (ms)',
  replies: 'Replies', navigation: 'Story navigation', accounts_engaged: 'Accounts engaged', profile_links_taps: 'Profile link taps',
};

const iso = () => new Date().toISOString();
const dayStr = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const aad = (ws: string, accountId: string) => `${ws}|instagram|${accountId}`;

export class MetaError extends Error {
  constructor(public kind: 'reconnect' | 'permission' | 'limitation' | 'unsupported' | 'rate' | 'outage' | 'other', message: string, public code = 0) { super(redact(message)); }
}

function classify(status: number, body: string): MetaError {
  let e: any = {};
  try { e = JSON.parse(body).error ?? {}; } catch { /* not JSON */ }
  const code = Number(e.code) || 0, msg = String(e.message ?? body ?? '');
  if (code === 190 || status === 401) return new MetaError('reconnect', 'Instagram no longer accepts this sign-in (expired, revoked or password changed). Reconnect.', code);
  if (code === 10 && /viewer/i.test(msg)) return new MetaError('limitation', 'Meta does not show insights for stories with fewer than 5 viewers.', code);
  if (code === 10 || (code >= 200 && code < 300)) return new MetaError('permission', 'A permission was removed or never granted (instagram_business_basic / instagram_business_manage_insights). Reconnect and allow it.', code);
  if ([4, 17, 32, 613].includes(code) || status === 429) return new MetaError('rate', 'Instagram asked IMI ONE to slow down (rate limit).', code);
  if (code === 100) return new MetaError('unsupported', `Instagram did not accept the request: ${msg}`, code);
  if (status >= 500 || code === 1 || code === 2) return new MetaError('outage', `Instagram answered ${status}.`, code);
  return new MetaError('other', `Instagram answered ${status}: ${msg}`, code);
}

// Every Instagram call is a GET with the token in the query (Meta's documented form). Rate limits and
// outages are retried with waits; every retry is recorded on the run. The token never reaches a log.
async function iget(path: string, params: Record<string, string>, token: string, retries: string[]): Promise<any> {
  const url = new URL(path.startsWith('http') ? path : `${HOST}${path}`);
  if (url.origin !== HOST) throw new MetaError('other', 'Refused to follow a link outside graph.instagram.com.');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try { res = await io.fetch(url.toString(), { method: 'GET' }); }
    catch { res = new Response('network error', { status: 503 }); }
    if (res.ok) return res.json();
    const err = classify(res.status, await res.text().catch(() => ''));
    if ((err.kind === 'rate' || err.kind === 'outage') && attempt < io.retryDelaysMs.length) {
      retries.push(`${new Date().toISOString().slice(11, 19)} ${err.kind}, retried`);
      await io.sleep(io.retryDelaysMs[attempt]);
      continue;
    }
    throw err;
  }
}

// ---------- the auth adapter (v1: Instagram Login token; Unified Login is assessed later) ----------

interface AuthAdapter {
  method: string;
  getToken(env: Env, row: any): Promise<string>;
  refresh(env: Env, row: any, retries: string[]): Promise<'refreshed' | 'not_due' | 'too_new'>;
}

const instagramLogin: AuthAdapter = {
  method: 'instagram_login',
  async getToken(env, row) {
    if (!row?.token_ciphertext) throw new MetaError('reconnect', 'Not connected.');
    try { return (await openBound<{ token: string }>(env as any, aad(row.workspace_id, row.external_account_id), row.token_ciphertext, row.key_version)).token; }
    catch { throw new MetaError('reconnect', 'The stored sign-in could not be opened for this brand and account. Reconnect.'); }
  },
  // Refresh when the expiry is unknown or within 15 days, and the token is at least 24 hours old.
  async refresh(env, row, retries) {
    const age = Date.now() - Date.parse(row.token_obtained_at ?? 0);
    const left = row.token_expires_at ? Date.parse(row.token_expires_at) - Date.now() : null;
    if (left !== null && left > 15 * 86400_000) return 'not_due';
    if (age < 24 * 3600_000) return 'too_new';
    const t = await iget('/refresh_access_token', { grant_type: 'ig_refresh_token' }, await this.getToken(env, row), retries);
    if (!t.access_token) throw new MetaError('other', 'Instagram did not return a refreshed token.');
    const sealed = await sealBound(env as any, aad(row.workspace_id, row.external_account_id), { token: t.access_token });
    const expires = new Date(Date.now() + (Number(t.expires_in) || 60 * 86400) * 1000).toISOString();
    await env.DB.prepare('UPDATE social_accounts SET token_ciphertext = ?, key_version = ?, token_obtained_at = ?, token_expires_at = ?, updated_at = ? WHERE id = ?')
      .bind(sealed.ciphertext, sealed.keyVersion, iso(), expires, now(), row.id).run();
    Object.assign(row, { token_ciphertext: sealed.ciphertext, key_version: sealed.keyVersion, token_obtained_at: iso(), token_expires_at: expires });
    return 'refreshed';
  },
};

// ---------- connection ----------

async function account(env: Env, ws: string) {
  return env.DB.prepare("SELECT * FROM social_accounts WHERE workspace_id = ? AND platform = 'instagram'").bind(ws).first<any>();
}

function publicView(r: any) {
  const daysLeft = r?.token_expires_at ? Math.floor((Date.parse(r.token_expires_at) - Date.now()) / 86400_000) : null;
  return {
    platform: 'instagram', status: r?.status ?? 'not_connected', username: r?.username ?? null, expectedUsername: r?.expected_username ?? null,
    accountId: r?.external_account_id ?? null, accountType: r?.account_type ?? null, authMethod: r?.auth_method ?? 'instagram_login',
    followers: r?.followers_count ?? null, mediaCount: r?.media_count ?? null, permissions: JSON.parse(r?.permissions_json || '{}'),
    tokenExpiresAt: r?.token_expires_at ?? null, tokenDaysLeft: daysLeft, lastSyncAt: r?.last_sync_at ?? null, lastError: r?.last_error ?? null,
    connectedBy: r?.connected_by ?? null, connectedAt: r?.connected_at ?? null, lastTest: r?.last_test_json ? JSON.parse(r.last_test_json) : null,
    readOnly: true, excluded: ['publishing', 'comments', 'messages', 'webhooks', 'ads', 'Threads', 'WhatsApp'],
  };
}

export async function getAccount(env: Env, ws: string) {
  const r = await account(env, ws);
  const lastRun = r ? await env.DB.prepare("SELECT id, status, trigger, started_at, finished_at, error_summary FROM sync_runs WHERE workspace_id = ? AND connector = 'instagram' ORDER BY started_at DESC LIMIT 1").bind(ws).first() : null;
  return { ...publicView(r), lastRun: lastRun ?? null };
}

const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

// The owner pastes a token generated for this brand's own account. It is checked against Instagram
// (and against the username the owner expects) before anything is stored.
export async function connect(env: Env, ws: string, email: string, body: any) {
  const token = String(body?.token ?? '').trim();
  const expected = String(body?.expectedUsername ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!USERNAME_RE.test(expected)) throw new HttpError(400, 'Type the Instagram username this brand uses, for example iddav_wildstay.');
  if (token.length < 20 || /\s/.test(token)) throw new HttpError(400, 'That does not look like an Instagram access token.');
  const retries: string[] = [];
  let me: any;
  try { me = await iget('/me', { fields: 'user_id,username,account_type,followers_count,media_count' }, token, retries); }
  catch (e) { throw new HttpError(400, e instanceof MetaError && e.kind === 'reconnect' ? 'Instagram did not accept this token. Generate a new one and try again.' : (e instanceof Error ? redact(e.message) : 'Instagram could not be reached.')); }
  const accountId = String(me.user_id ?? me.id ?? '');
  const username = String(me.username ?? '').toLowerCase();
  if (!accountId || !username) throw new HttpError(400, 'Instagram did not say which account this token belongs to.');
  if (username !== expected) throw new HttpError(409, `This token belongs to @${username}, not @${expected}. Nothing was saved.`);
  if (me.account_type && !['BUSINESS', 'MEDIA_CREATOR'].includes(String(me.account_type))) throw new HttpError(409, 'This is not a Professional (business or creator) account, so Instagram gives no insights.');
  const other = await env.DB.prepare("SELECT workspace_id FROM social_accounts WHERE platform = 'instagram' AND external_account_id = ? AND workspace_id != ?").bind(accountId, ws).first();
  if (other) throw new HttpError(409, 'This Instagram account is already connected to another brand. One account belongs to one brand only.');
  const sealed = await sealBound(env as any, aad(ws, accountId), { token });
  const existing = await account(env, ws);
  const at = iso();
  if (existing) {
    if (existing.external_account_id && existing.external_account_id !== accountId) {
      // A different account for this brand: the old account's history stays, read-only, under its own id.
      throw new HttpError(409, 'This brand is already linked to a different Instagram account. Disconnect it first.');
    }
    await env.DB.prepare(`UPDATE social_accounts SET external_account_id = ?, username = ?, expected_username = ?, account_type = ?, token_ciphertext = ?, key_version = ?,
      token_obtained_at = ?, token_expires_at = NULL, permissions_json = ?, status = 'connected', followers_count = ?, media_count = ?, last_error = NULL,
      connected_by = ?, connected_at = ?, updated_at = ? WHERE id = ?`)
      .bind(accountId, username, expected, me.account_type ?? null, sealed.ciphertext, sealed.keyVersion, at, JSON.stringify({ basic: true }),
        me.followers_count ?? null, me.media_count ?? null, email, at, now(), existing.id).run();
  } else {
    await env.DB.prepare(`INSERT INTO social_accounts (id, workspace_id, platform, external_account_id, username, expected_username, account_type, token_ciphertext, key_version,
      token_obtained_at, permissions_json, status, followers_count, media_count, connected_by, connected_at, updated_at)
      VALUES (?, ?, 'instagram', ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), ws, accountId, username, expected, me.account_type ?? null, sealed.ciphertext, sealed.keyVersion, at, JSON.stringify({ basic: true }),
        me.followers_count ?? null, me.media_count ?? null, email, at, now()).run();
  }
  return getAccount(env, ws);
}

export async function disconnect(env: Env, ws: string) {
  const r = await account(env, ws);
  if (!r) throw new HttpError(404, 'Not connected');
  // The sign-in is removed; posts and figures already fetched stay, read-only.
  await env.DB.prepare("UPDATE social_accounts SET token_ciphertext = NULL, key_version = NULL, token_expires_at = NULL, status = 'revoked', updated_at = ? WHERE id = ?").bind(now(), r.id).run();
  return getAccount(env, ws);
}

// ---------- synchronisation ----------

interface Counts { pages: number; new: number; unchanged: number; changed: number; failed: number }

async function saveMetric(env: Env, r: any, mediaId: string | null, metric: string, value: number, period: string, periodEnd: string, runId: string, c: Counts) {
  const last = await env.DB.prepare(`SELECT value FROM social_metrics WHERE account_id = ? AND media_id IS ? AND metric = ? AND period = ? AND period_end = ? ORDER BY retrieved_at DESC, rowid DESC LIMIT 1`)
    .bind(r.id, mediaId, metric, period, periodEnd).first<{ value: number }>();
  if (last && last.value === value) { c.unchanged++; return; }
  await env.DB.prepare('INSERT INTO social_metrics (id, workspace_id, account_id, media_id, metric, value, period, period_end, run_id, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), r.workspace_id, r.id, mediaId, metric, value, period, periodEnd, runId, iso()).run();
  if (last) c.changed++; else c.new++;
}

const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count';

// Saves one page of posts. Returns how many were already known.
async function savePage(env: Env, r: any, items: any[], runId: string, c: Counts): Promise<number> {
  let known = 0;
  for (const m of items) {
    const ext = String(m.id ?? '');
    if (!/^\d{5,30}$/.test(ext)) { c.failed++; continue; }
    const old = await env.DB.prepare('SELECT like_count, comments_count, caption FROM social_media WHERE account_id = ? AND external_media_id = ?').bind(r.id, ext).first<any>();
    const like = m.like_count == null ? null : Number(m.like_count), com = m.comments_count == null ? null : Number(m.comments_count);
    const caption = m.caption == null ? null : String(m.caption).slice(0, 2200);
    if (!old) {
      await env.DB.prepare(`INSERT INTO social_media (id, workspace_id, account_id, external_media_id, media_type, media_product_type, caption, permalink, published_at, like_count, comments_count, first_seen_run_id, retrieved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), r.workspace_id, r.id, ext, m.media_type ?? null, m.media_product_type ?? null, caption,
        typeof m.permalink === 'string' && m.permalink.startsWith('https://www.instagram.com/') ? m.permalink : null, m.timestamp ?? null, like, com, runId, iso()).run();
      c.new++;
    } else {
      known++;
      if (old.like_count === like && old.comments_count === com && old.caption === caption) c.unchanged++;
      else {
        await env.DB.prepare('UPDATE social_media SET like_count = ?, comments_count = ?, caption = ?, retrieved_at = ? WHERE account_id = ? AND external_media_id = ?').bind(like, com, caption, iso(), r.id, ext).run();
        c.changed++;
      }
    }
  }
  return known;
}

async function mediaInsights(env: Env, r: any, token: string, runId: string, c: Counts, retries: string[]) {
  const since = new Date(Date.now() - 60 * 86400_000).toISOString();
  const { results } = await env.DB.prepare(`SELECT id, external_media_id, media_product_type FROM social_media WHERE account_id = ? AND (published_at IS NULL OR published_at >= ?)
    ORDER BY published_at DESC LIMIT ${INSIGHT_POSTS_MAX}`).bind(r.id, since).all<any>();
  for (const m of results ?? []) {
    const wanted = MEDIA_METRICS[String(m.media_product_type ?? 'FEED')] ?? MEDIA_METRICS.FEED;
    let data: any[] | null = null;
    try { data = (await iget(`/${m.external_media_id}/insights`, { metric: wanted.join(',') }, token, retries)).data ?? []; }
    catch (e) {
      if (!(e instanceof MetaError)) throw e;
      if (e.kind === 'limitation') { await limitation(env, r, m.id, e.message, runId); continue; }
      if (e.kind !== 'unsupported') throw e;
      // One metric Meta does not offer for this post makes the whole request fail: ask one by one.
      data = [];
      for (const metric of wanted) {
        try { data.push(...((await iget(`/${m.external_media_id}/insights`, { metric }, token, retries)).data ?? [])); }
        catch (e2) { if (!(e2 instanceof MetaError) || !['unsupported', 'limitation'].includes(e2.kind)) throw e2; }
      }
    }
    for (const d of data ?? []) {
      const v = d?.values?.[0]?.value ?? d?.total_value?.value;
      if (typeof d?.name === 'string' && typeof v === 'number') await saveMetric(env, r, m.id, d.name, v, 'lifetime', 'lifetime', runId, c);
    }
  }
}

async function limitation(env: Env, r: any, mediaId: string, reason: string, runId: string) {
  await env.DB.prepare('INSERT INTO social_limitations (account_id, media_id, reason, run_id) VALUES (?, ?, ?, ?) ON CONFLICT (account_id, media_id) DO UPDATE SET reason = excluded.reason, run_id = excluded.run_id')
    .bind(r.id, mediaId, reason, runId).run();
}

// Account figures per day for the last 7 complete days (Meta may revise up to 48 hours later).
async function accountInsights(env: Env, r: any, token: string, runId: string, c: Counts, retries: string[]) {
  for (let back = 2; back <= 8; back++) {
    const date = dayStr(-back);
    const since = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000), until = since + 86400;
    const d = await iget(`/${r.external_account_id}/insights`, { metric: ACCOUNT_DAY_METRICS.join(','), period: 'day', metric_type: 'total_value', since: String(since), until: String(until) }, token, retries);
    for (const x of d.data ?? []) {
      const v = x?.total_value?.value ?? x?.values?.[0]?.value;
      if (typeof x?.name === 'string' && typeof v === 'number') await saveMetric(env, r, null, x.name, v, 'day', date, runId, c);
    }
  }
}

// One Instagram sync for one brand. The workspace comes from the caller (route or scheduler), never from
// Instagram's answer, so a job for one brand can never write another brand's rows.
export async function runSync(env: Env, ws: string, trigger: 'manual' | 'schedule' | 'retry', by: string | null) {
  const r = await account(env, ws);
  if (!r?.token_ciphertext || r.status === 'revoked' || r.status === 'not_connected') throw new HttpError(409, 'Connect the Instagram account first.');
  await env.DB.prepare(`UPDATE sync_runs SET status = 'failed', finished_at = ?, error_summary = 'Interrupted before it finished; the next run continues from where it stopped.'
    WHERE workspace_id = ? AND connector = 'instagram' AND status = 'running' AND started_at < ?`).bind(iso(), ws, new Date(Date.now() - 15 * 60_000).toISOString()).run();
  if (await env.DB.prepare("SELECT 1 FROM sync_runs WHERE workspace_id = ? AND connector = 'instagram' AND status = 'running'").bind(ws).first())
    throw new HttpError(409, 'An Instagram fetch is already running.');
  const lastOk = await env.DB.prepare("SELECT started_at FROM sync_runs WHERE workspace_id = ? AND connector = 'instagram' AND status = 'complete' ORDER BY started_at DESC LIMIT 1").bind(ws).first<{ started_at: string }>();
  const resumed = await env.DB.prepare(`SELECT id FROM sync_runs WHERE workspace_id = ? AND connector = 'instagram' AND status IN ('partial','failed') AND started_at > ? ORDER BY started_at DESC LIMIT 1`)
    .bind(ws, lastOk?.started_at ?? '').first<{ id: string }>();
  const runId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO sync_runs (id, workspace_id, connector, started_at, trigger, status, window_start, window_end, resumed_from_run_id, started_by)
    VALUES (?, ?, 'instagram', ?, ?, 'running', ?, ?, ?, ?)`).bind(runId, ws, iso(), resumed ? 'retry' : trigger, dayStr(-8), dayStr(-2), resumed?.id ?? null, by).run();
  const c: Counts = { pages: 0, new: 0, unchanged: 0, changed: 0, failed: 0 };
  const retries: string[] = [], notes: string[] = [];
  let status: 'complete' | 'partial' | 'failed' = 'complete', error: string | null = null;
  const perms = JSON.parse(r.permissions_json || '{}');
  try {
    const refreshed = await instagramLogin.refresh(env, r, retries).catch((e) => { if (e instanceof MetaError && e.kind === 'reconnect') throw e; notes.push(`Token refresh failed: ${e instanceof Error ? e.message : 'error'}`); return 'failed'; });
    if (refreshed === 'refreshed') notes.push('Sign-in renewed for 60 days.');
    const token = await instagramLogin.getToken(env, r);
    const me = await iget('/me', { fields: 'user_id,username,account_type,followers_count,media_count' }, token, retries);
    if (String(me.user_id ?? me.id) !== r.external_account_id) throw new MetaError('reconnect', 'The token now belongs to a different Instagram account. Reconnect.');
    perms.basic = true;
    await env.DB.prepare('UPDATE social_accounts SET username = ?, followers_count = ?, media_count = ?, updated_at = ? WHERE id = ?')
      .bind(String(me.username ?? r.username).toLowerCase(), me.followers_count ?? null, me.media_count ?? null, now(), r.id).run();
    // Newest posts until a page is entirely known. When no older history is pending, the "older posts start
    // here" cursor is saved after every page, so a failure part-way is fetched again next run (no gap).
    const olderPending = r.backfill_cursor;
    let page = await iget(`/${r.external_account_id}/media`, { fields: MEDIA_FIELDS, limit: String(PAGE_LIMIT) }, token, retries);
    for (let i = 0; ; i++) {
      c.pages++;
      const items = Array.isArray(page.data) ? page.data : [];
      const known = await savePage(env, r, items, runId, c);
      const next = page.paging?.next && page.paging?.cursors?.after ? String(page.paging.cursors.after) : null;
      const caughtUp = items.length > 0 && known === items.length;
      if (!olderPending) {
        r.backfill_cursor = caughtUp ? null : next;
        await env.DB.prepare('UPDATE social_accounts SET backfill_cursor = ? WHERE id = ?').bind(r.backfill_cursor, r.id).run();
      }
      if (!next || caughtUp || i === NEW_PAGES_MAX - 1) break;
      page = await iget(`/${r.external_account_id}/media`, { fields: MEDIA_FIELDS, limit: String(PAGE_LIMIT), after: next }, token, retries);
    }
    // Older posts, a few pages per run, from the saved cursor (a failed page is fetched again next time).
    for (let i = 0; i < BACKFILL_PAGES_MAX && r.backfill_cursor; i++) {
      const p = await iget(`/${r.external_account_id}/media`, { fields: MEDIA_FIELDS, limit: String(PAGE_LIMIT), after: r.backfill_cursor }, token, retries);
      c.pages++;
      await savePage(env, r, Array.isArray(p.data) ? p.data : [], runId, c);
      r.backfill_cursor = p.paging?.cursors?.after && p.paging?.next ? p.paging.cursors.after : null;
      await env.DB.prepare('UPDATE social_accounts SET backfill_cursor = ? WHERE id = ?').bind(r.backfill_cursor, r.id).run();
    }
    try {
      await mediaInsights(env, r, token, runId, c, retries);
      await accountInsights(env, r, token, runId, c, retries);
      perms.insights = true;
    } catch (e) {
      if (e instanceof MetaError && e.kind === 'permission') { perms.insights = false; throw e; }
      throw e;
    }
    if (c.failed) { status = 'partial'; error = `${c.failed} items from Instagram could not be read.`; }
    await env.DB.prepare(`UPDATE social_accounts SET status = 'connected', permissions_json = ?, last_error = NULL, last_sync_at = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(perms), iso(), now(), r.id).run();
  } catch (e) {
    const m = e instanceof MetaError ? e : new MetaError('other', e instanceof Error ? e.message : String(e));
    error = m.message;
    status = c.new + c.changed + c.unchanged > 0 ? 'partial' : 'failed';
    const reconnect = m.kind === 'reconnect' || m.kind === 'permission';
    await env.DB.prepare(`UPDATE social_accounts SET ${reconnect ? "status = 'needs_reconnect', " : ''}permissions_json = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(perms), m.message, now(), r.id).run();
  }
  await env.DB.prepare(`UPDATE sync_runs SET status = ?, finished_at = ?, pages_fetched = ?, items_new = ?, items_unchanged = ?, items_changed = ?, items_failed = ?, retries_json = ?, error_summary = ? WHERE id = ?`)
    .bind(status, iso(), c.pages, c.new, c.unchanged, c.changed, c.failed, JSON.stringify(retries), [error, ...notes].filter(Boolean).map((x) => redact(String(x))).join(' ') || null, runId).run();
  const done = await env.DB.prepare('SELECT * FROM sync_runs WHERE id = ?').bind(runId).first<any>();
  return { ...done, retries: JSON.parse(done?.retries_json || '[]'), retries_json: undefined };
}

export async function syncAllInstagram(env: Env) {
  const { results } = await env.DB.prepare("SELECT workspace_id FROM social_accounts WHERE platform = 'instagram' AND status = 'connected'").all<{ workspace_id: string }>();
  const out: unknown[] = [];
  for (const x of results ?? []) {
    try { out.push(await runSync(env, x.workspace_id, 'schedule', null)); }
    catch (e) { out.push({ workspace_id: x.workspace_id, error: e instanceof Error ? redact(e.message) : 'failed' }); }
  }
  return out;
}

// ---------- reading ----------

export async function listMedia(env: Env, ws: string, limitRaw: string | null) {
  const r = await account(env, ws);
  if (!r) return { media: [], metricLabels: METRIC_LABELS };
  const limit = Math.min(100, Math.max(1, Number(limitRaw) || 30));
  const { results } = await env.DB.prepare(`SELECT m.id, m.external_media_id, m.media_type, m.media_product_type, m.caption, m.permalink, m.published_at, m.like_count, m.comments_count, m.retrieved_at, l.reason AS limitation
    FROM social_media m LEFT JOIN social_limitations l ON l.media_id = m.id WHERE m.workspace_id = ? AND m.account_id = ? ORDER BY m.published_at DESC LIMIT ?`).bind(ws, r.id, limit).all<any>();
  const media: unknown[] = [];
  for (const m of results ?? []) {
    const { results: mets } = await env.DB.prepare(`SELECT metric, value, retrieved_at FROM social_metrics s WHERE media_id = ? AND period = 'lifetime'
      AND retrieved_at = (SELECT MAX(retrieved_at) FROM social_metrics x WHERE x.media_id = s.media_id AND x.metric = s.metric AND x.period = 'lifetime')`).bind(m.id).all<any>();
    const wanted = MEDIA_METRICS[String(m.media_product_type ?? 'FEED')] ?? MEDIA_METRICS.FEED;
    const got = Object.fromEntries((mets ?? []).map((x) => [x.metric, x]));
    media.push({
      id: m.id, mediaType: m.media_type, productType: m.media_product_type, caption: m.caption ? String(m.caption).slice(0, 140) : null, permalink: m.permalink,
      publishedAt: m.published_at, likes: m.like_count, comments: m.comments_count, retrievedAt: m.retrieved_at, limitation: m.limitation ?? null,
      metrics: wanted.map((name) => (got[name] ? { name, value: got[name].value, retrievedAt: got[name].retrieved_at, status: 'measured' } : { name, value: null, status: 'unavailable' })),
    });
  }
  return { media, metricLabels: METRIC_LABELS, source: 'Instagram (Meta)', note: 'Figures are Meta\'s own and may arrive up to 48 hours late. "Unavailable" means Meta did not return it; it is not zero.' };
}

export async function accountMetrics(env: Env, ws: string, daysRaw: string | null) {
  const r = await account(env, ws);
  const days = Math.min(90, Math.max(7, Number(daysRaw) || 28));
  if (!r) return { days: [], metrics: ACCOUNT_DAY_METRICS };
  const { results } = await env.DB.prepare(`SELECT period_end AS date, metric, value FROM social_metrics s WHERE account_id = ? AND media_id IS NULL AND period = 'day' AND period_end >= ?
    AND retrieved_at = (SELECT MAX(retrieved_at) FROM social_metrics x WHERE x.account_id = s.account_id AND x.media_id IS NULL AND x.metric = s.metric AND x.period = 'day' AND x.period_end = s.period_end)
    ORDER BY period_end DESC`).bind(r.id, dayStr(-days)).all<any>();
  const byDay: Record<string, Record<string, number>> = {};
  for (const x of results ?? []) (byDay[x.date] ??= {})[x.metric] = x.value;
  return { metrics: ACCOUNT_DAY_METRICS, labels: METRIC_LABELS, days: Object.entries(byDay).map(([date, values]) => ({ date, values })), source: 'Instagram (Meta)' };
}

// ---------- the connection test (design 2.6), run against the real account; the report is redacted ----------

export async function connectionTest(env: Env, ws: string) {
  const r = await account(env, ws);
  if (!r?.token_ciphertext) throw new HttpError(409, 'Connect the Instagram account first.');
  const checks: { id: string; name: string; result: 'pass' | 'fail' | 'blocked'; endpoint: string; detail: string }[] = [];
  const add = (id: string, name: string, result: 'pass' | 'fail' | 'blocked', endpoint: string, detail: string) => checks.push({ id, name, result, endpoint, detail: redact(detail) });
  const retries: string[] = [];
  let token = '';
  try { token = await instagramLogin.getToken(env, r); } catch (e) { add('T1', 'Token validation', 'fail', '-', e instanceof Error ? e.message : 'error'); }
  let me: any = null;
  if (token) {
    try { me = await iget('/me', { fields: 'user_id,username,account_type' }, token, retries); add('T1', 'Token validation', 'pass', 'GET /me', 'Instagram accepted the stored token.'); }
    catch (e) { add('T1', 'Token validation', 'fail', 'GET /me', e instanceof Error ? e.message : 'error'); }
  }
  const id = me ? String(me.user_id ?? me.id) : '';
  add('T3', 'Identity', me && id === r.external_account_id && String(me.username).toLowerCase() === r.expected_username ? 'pass' : me ? 'fail' : 'blocked', 'GET /me',
    me ? `Account ${id} (@${String(me.username).toLowerCase()}), expected @${r.expected_username}.` : 'Token not accepted.');
  let first: any = null;
  if (me) {
    try {
      first = await iget(`/${id}/media`, { fields: MEDIA_FIELDS, limit: '5' }, token, retries);
      add('T4', 'Media', (first.data ?? []).length ? 'pass' : 'fail', 'GET /{id}/media', `${(first.data ?? []).length} recent posts returned.`);
    } catch (e) { add('T4', 'Media', 'fail', 'GET /{id}/media', e instanceof Error ? e.message : 'error'); }
    if (first?.paging?.next && first?.paging?.cursors?.after) {
      try {
        const second = await iget(`/${id}/media`, { fields: 'id', limit: '5', after: first.paging.cursors.after }, token, retries);
        const overlap = (second.data ?? []).some((x: any) => (first.data ?? []).some((y: any) => y.id === x.id));
        add('T6', 'Pagination', !overlap ? 'pass' : 'fail', 'GET /{id}/media?after=', `Second page: ${(second.data ?? []).length} posts, ${overlap ? 'overlapping' : 'no overlap'}.`);
      } catch (e) { add('T6', 'Pagination', 'fail', 'GET /{id}/media?after=', e instanceof Error ? e.message : 'error'); }
    } else add('T6', 'Pagination', first ? 'blocked' : 'fail', 'GET /{id}/media', 'Only one page of posts exists, so paging cannot be shown yet.');
    try {
      const day = dayStr(-2), since = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
      const ins = await iget(`/${id}/insights`, { metric: 'reach', period: 'day', metric_type: 'total_value', since: String(since), until: String(since + 86400) }, token, retries);
      add('T2', 'Permissions', 'pass', 'GET /me + GET /{id}/insights', 'instagram_business_basic and instagram_business_manage_insights proven by successful calls.');
      add('T5', 'Insights', 'pass', 'GET /{id}/insights', (ins.data ?? []).length ? 'Account insights returned.' : 'Insights call accepted; Meta returned no figure for that day (shown as unavailable).');
    } catch (e) {
      const perm = e instanceof MetaError && e.kind === 'permission';
      add('T2', 'Permissions', perm ? 'fail' : 'blocked', 'GET /{id}/insights', perm ? 'instagram_business_manage_insights is missing.' : (e instanceof Error ? e.message : 'error'));
      add('T5', 'Insights', 'fail', 'GET /{id}/insights', e instanceof Error ? e.message : 'error');
    }
  } else {
    add('T2', 'Permissions', 'blocked', '-', 'Token not accepted.');
  }
  try { await iget('/me', { fields: 'id' }, 'IMI-ONE-TEST-INVALID-TOKEN', []); add('T7', 'Bad token', 'fail', 'GET /me', 'An invalid token was accepted.'); }
  catch (e) { add('T7', 'Bad token', e instanceof MetaError && e.kind === 'reconnect' ? 'pass' : 'fail', 'GET /me', 'An invalid token is refused and handled without exposing anything.'); }
  const dup = await env.DB.prepare('SELECT COUNT(*) AS n FROM (SELECT external_media_id FROM social_media WHERE account_id = ? GROUP BY external_media_id HAVING COUNT(*) > 1)').bind(r.id).first<{ n: number }>();
  add('T8', 'Deduplication', dup?.n ? 'fail' : 'pass', 'database', dup?.n ? `${dup.n} duplicated posts.` : 'No post is stored twice.');
  const leak = await env.DB.prepare("SELECT COUNT(*) AS n FROM social_media WHERE account_id = ? AND workspace_id != ?").bind(r.id, ws).first<{ n: number }>();
  const shared = await env.DB.prepare("SELECT COUNT(*) AS n FROM social_accounts WHERE external_account_id = ? AND workspace_id != ?").bind(r.external_account_id, ws).first<{ n: number }>();
  add('T9', 'Brand isolation', leak?.n || shared?.n ? 'fail' : 'pass', 'database', 'This account and its posts belong to this brand only; other brands receive 404.');
  const report = { checks, ranAt: iso(), retries: retries.length };
  const text = JSON.stringify(report);
  add('T10', 'Secrets', token && text.includes(token) ? 'fail' : 'pass', 'report', 'The token is not in this report, any response, log or the browser.');
  add('T11', 'Dashboard', 'pass', 'IMI ONE', 'Every figure is shown with its source (Instagram) and retrieval time.');
  add('T12', 'Write protection', 'pass', 'code', 'IMI ONE has no Instagram publish, delete, comment or message call; every request is a GET.');
  checks.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const final = { checks, ranAt: report.ranAt, passed: checks.filter((x) => x.result === 'pass').length, total: checks.length };
  await env.DB.prepare('UPDATE social_accounts SET last_test_json = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(final), now(), r.id).run();
  return final;
}

// Today: an Instagram sign-in that stopped working, or that will expire within 7 days without a refresh.
export async function needsAttention(env: Env, ws: string) {
  const r = await account(env, ws);
  if (!r || r.status === 'revoked' || r.status === 'not_connected') return [];
  const soon = r.token_expires_at && Date.parse(r.token_expires_at) - Date.now() < 7 * 86400_000;
  if (r.status !== 'needs_reconnect' && !soon) return [];
  return [{ id: 'instagram', kind: 'connection', subject: 'Instagram', title: r.status === 'needs_reconnect' ? 'Instagram needs reconnecting' : 'Instagram sign-in expires within 7 days',
    why: r.last_error || 'Renewal did not succeed. Reconnect to keep figures current.', action: { label: 'Open Social', screen: 'intelligence', ref: 'social' } }];
}

// Key rotation for Instagram tokens (same procedure as Google, design 2.4).
export async function rotateInstagramKeys(env: Env, current: number) {
  const { results } = await env.DB.prepare('SELECT * FROM social_accounts WHERE token_ciphertext IS NOT NULL').all<any>();
  let moved = 0, already = 0, failed = 0;
  for (const r of results ?? []) {
    if (r.key_version === current) { already++; continue; }
    try {
      const a = aad(r.workspace_id, r.external_account_id);
      const secret = await openBound(env as any, a, r.token_ciphertext, r.key_version);
      const sealed = await sealBound(env as any, a, secret);
      await openBound(env as any, a, sealed.ciphertext, sealed.keyVersion);
      await env.DB.prepare('UPDATE social_accounts SET token_ciphertext = ?, key_version = ?, updated_at = ? WHERE id = ?').bind(sealed.ciphertext, sealed.keyVersion, now(), r.id).run();
      moved++;
    } catch { failed++; }
  }
  return { moved, already, failed };
}
