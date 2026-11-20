// IMI ONE round 9: Build 3, search and guest acquisition, measurement first (design sections 4.4, 4.7, 4.8).
//
// Read-only Google connectors per brand:
//   search_console  queries, impressions, clicks, position          scope webmasters.readonly
//   ga4             sessions by source, enquiry and WhatsApp events  scope analytics.readonly
//   business_profile hand-entered monthly figures until Google grants API access
//
// Every connector shows five separate connection states; one never implies the next.
// Every synchronisation leaves a sync_runs record (complete | partial | failed).
// Tokens are encrypted, bound to brand + connector + account, and never leave the Worker.
// The funnel shows each stage with its own source; stages are never forced to match.

import type { Env } from './env';
import { HttpError, now } from './http';
import { sealBound, openBound, keyring } from './crypto';
import { can, type Role } from './tenancy';
import { crmFetch, crmMode } from './crm_bridge';
import { legacyWorkspace } from './aibudget';
import { rotateInstagramKeys } from './instagram';

export type Connector = 'search_console' | 'ga4' | 'business_profile';
export const CONNECTORS: Connector[] = ['search_console', 'ga4', 'business_profile'];

const SCOPES: Record<Connector, string> = {
  search_console: 'https://www.googleapis.com/auth/webmasters.readonly',
  ga4: 'https://www.googleapis.com/auth/analytics.readonly',
  business_profile: 'https://www.googleapis.com/auth/business.manage',
};

const INFO: Record<Connector, { name: string; api: string; resourceLabel: string; resourceHelp: string; approvalNote: string }> = {
  search_console: {
    name: 'Google Search Console', api: 'Google Search Console API',
    resourceLabel: 'Site', resourceHelp: 'Exactly as Search Console shows it: https://www.iddavwildstay.com/ or sc-domain:iddavwildstay.com',
    approvalNote: 'The Google account you sign in with must have access to this site in Search Console.',
  },
  ga4: {
    name: 'Google Analytics 4', api: 'Google Analytics Data API',
    resourceLabel: 'Property ID', resourceHelp: 'GA4 Admin → Property settings → Property ID (numbers only).',
    approvalNote: 'The Google account you sign in with needs at least Viewer access to this property.',
  },
  business_profile: {
    name: 'Google Business Profile', api: 'Business Profile Performance API',
    resourceLabel: 'Listing', resourceHelp: 'The listing name exactly as on Google Maps.',
    approvalNote: 'Google must approve API access first; until then quota may be zero. Enter monthly figures by hand meanwhile.',
  },
};

// Business Profile figures a person can read off the Performance page. Messaging clicks are
// listed but marked unconfirmed (design 4.4: confirm in Google's documentation first).
export const MANUAL_METRICS: Record<string, string> = {
  views_search: 'Profile views from Google Search',
  views_maps: 'Profile views from Google Maps',
  calls: 'Call button taps',
  website_clicks: 'Website clicks',
  direction_requests: 'Direction requests',
  messaging_clicks: 'Messaging clicks (metric to confirm)',
};

// Tags on IMI campaign links that mean Google (GB = Google Business post; utm_source google / google_ads).
const GOOGLE_TAGS = new Set(['GB', 'GOOGLE', 'GOOGLE_ADS', 'GOOGLE_BUSINESS', 'GSC', 'ORGANIC']);
// The CRM's stages (iddav-crm): new, contacted, qualified, quote_sent, follow_up, booked, stay_completed, review_referral, lost.
const BOOKED_STATUSES = new Set(['booked', 'stay_completed', 'review_referral']);
const QUOTED_STATUSES = new Set(['quote_sent', 'follow_up']);

// ---------- small utilities ----------

// Tests replace these; production uses the real fetch and real waits.
export const io = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  retryDelaysMs: [2000, 8000],
};

const iso = () => new Date().toISOString();
const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

// Nothing secret ever reaches a log, an error or the browser.
export function redact(text: string): string {
  return String(text)
    .replace(/("?(access_token|refresh_token|client_secret|code)"?\s*[:=]\s*"?)[^"&\s,}]+/gi, '$1[hidden]')
    .replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, 'Bearer [hidden]')
    .replace(/ya29\.[A-Za-z0-9._\-]+/g, '[hidden token]')
    .replace(/1\/\/[A-Za-z0-9._\-]{10,}/g, '[hidden token]')
    .slice(0, 300);
}

class GoogleError extends Error {
  constructor(public kind: 'reconnect' | 'disabled' | 'no_access' | 'rate' | 'outage' | 'other', message: string, public status = 0) { super(redact(message)); }
}

function classify(status: number, body: string): GoogleError {
  const b = body.toLowerCase();
  if (status === 401 || b.includes('invalid_grant') || b.includes('invalid_token')) return new GoogleError('reconnect', 'Google no longer accepts this sign-in (expired, revoked or permission removed). Reconnect.', status);
  if (status === 403 && (b.includes('service_disabled') || b.includes('has not been used') || b.includes('is disabled'))) return new GoogleError('disabled', 'The API is not enabled in the Google Cloud project.', status);
  if (status === 403 && (b.includes('insufficient') || b.includes('scope'))) return new GoogleError('reconnect', 'The granted permission is missing (it may have been removed). Reconnect and allow read access.', status);
  if (status === 403) return new GoogleError('no_access', 'The signed-in Google account cannot read this site or property.', status);
  if (status === 429) return new GoogleError('rate', 'Google asked IMI ONE to slow down (rate limit).', status);
  if (status >= 500) return new GoogleError('outage', `Google answered ${status}.`, status);
  return new GoogleError('other', `Google answered ${status}: ${body}`, status);
}

// One Google call with retries for rate limits and outages; every retry is recorded on the run.
async function gcall(url: string, init: RequestInit, retries: string[]): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try { res = await io.fetch(url, init); }
    catch { res = new Response('network error', { status: 503 }); }
    if (res.ok) return res.json();
    const err = classify(res.status, await res.text().catch(() => ''));
    if ((err.kind === 'rate' || err.kind === 'outage') && attempt < io.retryDelaysMs.length) {
      retries.push(`${new Date().toISOString().slice(11, 19)} ${err.kind} (${res.status}), retried`);
      await io.sleep(io.retryDelaysMs[attempt]);
      continue;
    }
    throw err;
  }
}

// ---------- connections ----------

const aad = (ws: string, c: Connector, resource: string | null) => `${ws}|google:${c}|${resource ?? ''}`;

async function row(env: Env, ws: string, c: Connector) {
  return env.DB.prepare('SELECT * FROM google_connections WHERE workspace_id = ? AND connector = ?').bind(ws, c).first<any>();
}

async function ensureRow(env: Env, ws: string, c: Connector) {
  const r = await row(env, ws, c);
  if (r) return r;
  await env.DB.prepare('INSERT INTO google_connections (id, workspace_id, connector, updated_at) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), ws, c, now()).run();
  return row(env, ws, c);
}

export function parseConnector(raw: string): Connector {
  if ((CONNECTORS as string[]).includes(raw)) return raw as Connector;
  throw new HttpError(404, 'Unknown connector');
}

type Tri = 'yes' | 'no' | 'unknown';
const tri = (v: string): Tri => (v === 'confirmed' || v === 'proven' ? 'yes' : v === 'no' ? 'no' : 'unknown');

// The five states, each with how we know. Never one implies the next.
async function states(env: Env, r: any, c: Connector) {
  const firstData = await env.DB.prepare(
    `SELECT finished_at FROM sync_runs WHERE workspace_id = ? AND connector = ? AND status IN ('complete','partial') AND items_new + items_unchanged + items_changed > 0 ORDER BY started_at LIMIT 1`)
    .bind(r?.workspace_id ?? '', c).first<{ finished_at: string }>();
  const authorised = !!r?.token_ciphertext && r?.status !== 'revoked' && String(r?.scopes ?? '').split(' ').includes(SCOPES[c]);
  const how = (v: string) => (v === 'proven' ? 'Proven by a successful Google call' : v === 'confirmed' ? 'Confirmed by the owner' : v === 'no' ? 'Google said no' : 'Not yet known');
  return [
    { n: 1, key: 'api_available', label: 'API available', value: 'yes' as Tri, how: `${INFO[c].api} exists for this purpose` },
    { n: 2, key: 'api_enabled', label: 'API enabled', value: tri(r?.api_enabled ?? 'unknown'), how: how(r?.api_enabled ?? 'unknown') },
    { n: 3, key: 'user_authorised', label: 'User authorised', value: (authorised && r.status === 'connected' ? 'yes' : 'no') as Tri,
      how: authorised ? (r.status === 'needs_reconnect' ? 'Granted, but Google stopped accepting it: reconnect' : `Signed in, read-only permission granted`) : 'Not signed in' },
    { n: 4, key: 'access_approved', label: c === 'business_profile' ? 'Access approved' : 'Property access', value: tri(r?.access_approved ?? 'unknown'), how: `${how(r?.access_approved ?? 'unknown')}. ${INFO[c].approvalNote}` },
    { n: 5, key: 'first_data', label: 'First data', value: (firstData ? 'yes' : 'no') as Tri, how: firstData ? `First retrieval ${firstData.finished_at}` : 'No successful retrieval yet' },
  ];
}

function publicView(r: any) {
  return {
    status: r?.status ?? 'not_connected', resource: r?.resource ?? null, settings: JSON.parse(r?.settings_json || '{}'),
    lastSyncAt: r?.last_sync_at ?? null, lastError: r?.last_error ?? null, connectedBy: r?.connected_by ?? null, connectedAt: r?.connected_at ?? null,
  };
}

export async function listConnections(env: Env, ws: string, origin: string) {
  const out: unknown[] = [];
  for (const c of CONNECTORS) {
    const r = await row(env, ws, c);
    const lastRun = await env.DB.prepare('SELECT id, status, trigger, started_at, finished_at, error_summary FROM sync_runs WHERE workspace_id = ? AND connector = ? ORDER BY started_at DESC LIMIT 1').bind(ws, c).first();
    out.push({
      connector: c, ...INFO[c], scope: SCOPES[c], readOnly: c !== 'business_profile',
      method: c === 'business_profile' ? 'manual' : 'oauth',
      ...publicView(r), states: await states(env, r, c), lastRun: lastRun ?? null,
      oauthReady: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      redirectUri: `${origin}/oauth/google-measure/callback`,
    });
  }
  return { connectors: out, redirectUri: `${origin}/oauth/google-measure/callback` };
}

const RESOURCE_RE: Record<Connector, RegExp> = {
  search_console: /^(https?:\/\/[a-z0-9.-]+\.[a-z]{2,}\/?[^\s]*|sc-domain:[a-z0-9.-]+\.[a-z]{2,})$/i,
  ga4: /^\d{5,15}$/,
  business_profile: /^.{2,120}$/,
};

// Owner settings: which site / property, GA4 event names, and the two states only a person can confirm.
export async function updateConnection(env: Env, ws: string, c: Connector, body: any) {
  const r = await ensureRow(env, ws, c);
  const sets: string[] = [], vals: unknown[] = [];
  if (body?.resource !== undefined) {
    const res = String(body.resource ?? '').trim();
    if (!RESOURCE_RE[c].test(res)) throw new HttpError(400, `${INFO[c].resourceLabel}: ${INFO[c].resourceHelp}`);
    if (res !== r.resource) {
      // The token is bound to the account it was granted for: a new site or property needs a fresh sign-in.
      sets.push('resource = ?', 'token_ciphertext = NULL', 'key_version = NULL', 'scopes = NULL', "access_approved = 'unknown'",
        `status = CASE WHEN token_ciphertext IS NULL THEN status ELSE 'not_connected' END`);
      vals.push(res);
    }
  }
  if (body?.settings !== undefined) {
    const s = body.settings ?? {};
    const name = (v: unknown, d: string) => { const t = String(v ?? d).trim(); if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(t)) throw new HttpError(400, 'GA4 event names use letters, numbers and _ only.'); return t; };
    sets.push('settings_json = ?');
    vals.push(JSON.stringify(c === 'ga4' ? { enquiryEvent: name(s.enquiryEvent, 'enquiry_submitted'), whatsappEvent: name(s.whatsappEvent, 'whatsapp_tap') } : {}));
  }
  for (const k of ['apiEnabled', 'accessApproved'] as const) {
    if (body?.[k] === undefined) continue;
    const col = k === 'apiEnabled' ? 'api_enabled' : 'access_approved';
    if (r[col] === 'proven' && body[k] === true) continue; // proof outranks a confirmation
    sets.push(`${col} = ?`); vals.push(body[k] === true ? 'confirmed' : 'unknown');
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to change.');
  await env.DB.prepare(`UPDATE google_connections SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, now(), r.id).run();
  return publicView(await row(env, ws, c));
}

export async function oauthStart(env: Env, ws: string, c: Connector, email: string, origin: string) {
  if (c === 'business_profile') throw new HttpError(409, 'Business Profile is entered by hand until Google approves API access.');
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError(409, 'The Google sign-in app is not set up on this server yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).');
  const r = await ensureRow(env, ws, c);
  if (!r.resource) throw new HttpError(409, `Enter the ${INFO[c].resourceLabel.toLowerCase()} first.`);
  keyring(env as any); // fail before sending anyone to Google if tokens could not be stored
  const state = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO oauth_states (state, platform, settings_json, created_at) VALUES (?, ?, ?, ?)')
    .bind(state, 'google-measure', JSON.stringify({ workspace: ws, connector: c, resource: r.resource, initiatedBy: email }), now()).run();
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/oauth/google-measure/callback`, response_type: 'code',
    scope: SCOPES[c], access_type: 'offline', prompt: 'consent', state,
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` };
}

function page(env: Env, ok: boolean, message: string): Response {
  const back = `${env.APP_URL || ''}/#/intelligence/search`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>IMI ONE</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.3rem">${ok ? 'Connected' : 'Not connected'}</h1><p>${esc(message)}</p><p><a href="${esc(back)}">Back to IMI ONE</a></p></body>`,
    { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Google sends the signed-in owner's browser here. Protected by sign-in (policy.ts), the one-time
// state, the same person check, and a fresh owner check of the brand named in the state.
export async function oauthCallback(request: Request, env: Env, email: string | null): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  const st = await env.DB.prepare("SELECT * FROM oauth_states WHERE state = ? AND platform = 'google-measure'").bind(state).first<any>();
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ? OR created_at < ?').bind(state, new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').slice(0, 19)).run();
  if (!st) return page(env, false, 'This sign-in link expired or was already used. Start again from IMI ONE.');
  const s = JSON.parse(st.settings_json || '{}') as { workspace: string; connector: Connector; resource: string; initiatedBy: string };
  if (!email || email !== s.initiatedBy) return page(env, false, 'This connection was started by a different signed-in person. Start again from IMI ONE.');
  const owner = await env.DB.prepare("SELECT role FROM memberships WHERE workspace_id = ? AND email = ? AND revoked_at IS NULL").bind(s.workspace, email).first<{ role: Role }>();
  if (!owner || !can(owner.role, 'channels.connect')) return page(env, false, 'Only an owner of this brand can connect Google.');
  const code = url.searchParams.get('code');
  if (!code) return page(env, false, url.searchParams.get('error') === 'access_denied' ? 'You cancelled the Google sign-in.' : 'Google did not complete the sign-in.');
  const r = await row(env, s.workspace, s.connector);
  if (!r || r.resource !== s.resource) return page(env, false, 'The site or property changed while you were signing in. Start again.');
  try {
    const tok = await gcall('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: `${url.origin}/oauth/google-measure/callback`, grant_type: 'authorization_code' }),
    }, []);
    const granted = String(tok.scope ?? '').split(' ');
    if (!granted.includes(SCOPES[s.connector])) return page(env, false, 'Google did not grant read access. Try again and tick the permission.');
    if (!tok.refresh_token) return page(env, false, 'Google did not return a lasting sign-in. Remove IMI ONE from your Google account permissions, then try again.');
    const sealed = await sealBound(env as any, aad(s.workspace, s.connector, s.resource), { refresh_token: tok.refresh_token });
    await env.DB.prepare(`UPDATE google_connections SET token_ciphertext = ?, key_version = ?, scopes = ?, status = 'connected', last_error = NULL,
      connected_by = ?, connected_at = ?, updated_at = ? WHERE id = ?`).bind(sealed.ciphertext, sealed.keyVersion, granted.join(' '), email, now(), now(), r.id).run();
    return page(env, true, `${INFO[s.connector].name} is connected (read-only). Press "Fetch now" in IMI ONE to get the first data.`);
  } catch (e) {
    return page(env, false, e instanceof Error ? redact(e.message) : 'Google sign-in failed.');
  }
}

export async function disconnect(env: Env, ws: string, c: Connector) {
  const r = await row(env, ws, c);
  if (!r) throw new HttpError(404, 'Not connected');
  // History stays (read-only); only the sign-in is removed.
  await env.DB.prepare("UPDATE google_connections SET token_ciphertext = NULL, key_version = NULL, scopes = NULL, status = 'revoked', updated_at = ? WHERE id = ?").bind(now(), r.id).run();
  return publicView(await row(env, ws, c));
}

async function accessToken(env: Env, r: any, retries: string[]): Promise<string> {
  let secret: { refresh_token: string };
  try { secret = await openBound(env as any, aad(r.workspace_id, r.connector, r.resource), r.token_ciphertext, r.key_version); }
  catch { throw new GoogleError('reconnect', 'The stored sign-in could not be opened for this brand and account. Reconnect.'); }
  const t = await gcall('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID ?? '', client_secret: env.GOOGLE_CLIENT_SECRET ?? '', refresh_token: secret.refresh_token, grant_type: 'refresh_token' }),
  }, retries);
  if (!t.access_token) throw new GoogleError('reconnect', 'Google did not return an access token. Reconnect.');
  return t.access_token;
}

// ---------- synchronisation ----------

interface Counts { pages: number; new: number; unchanged: number; changed: number; failed: number }

async function upsert(env: Env, sql: { find: string; insert: string; update: string }, key: unknown[], values: unknown[], same: (old: any) => boolean, counts: Counts) {
  const old = await env.DB.prepare(sql.find).bind(...key).first<any>();
  if (!old) { await env.DB.prepare(sql.insert).bind(...key, ...values).run(); counts.new++; return; }
  if (same(old)) { counts.unchanged++; return; }
  await env.DB.prepare(sql.update).bind(...values, ...key).run(); counts.changed++;
}

async function syncSearchConsole(env: Env, r: any, token: string, runId: string, start: string, end: string, counts: Counts, retries: string[]) {
  const base = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(r.resource)}/searchAnalytics/query`;
  const ask = (body: object) => gcall(base, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, retries);
  // Daily totals, paged (startRow) so nothing is cut off.
  for (let startRow = 0; ; startRow += 1000) {
    const d = await ask({ startDate: start, endDate: end, dimensions: ['date'], rowLimit: 1000, startRow, dataState: 'final' });
    counts.pages++;
    const rows = Array.isArray(d.rows) ? d.rows : [];
    for (const x of rows) {
      const date = String(x.keys?.[0] ?? ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { counts.failed++; continue; }
      const imp = Math.round(Number(x.impressions) || 0), clk = Math.round(Number(x.clicks) || 0), pos = x.position == null ? null : Number(x.position);
      await upsert(env, {
        find: 'SELECT impressions, clicks, position FROM search_daily WHERE workspace_id = ? AND date = ?',
        insert: 'INSERT INTO search_daily (workspace_id, date, impressions, clicks, position, run_id, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        update: 'UPDATE search_daily SET impressions = ?, clicks = ?, position = ?, run_id = ?, retrieved_at = ? WHERE workspace_id = ? AND date = ?',
      }, [r.workspace_id, date], [imp, clk, pos, runId, iso()], (o) => o.impressions === imp && o.clicks === clk && (o.position ?? null) === pos, counts);
    }
    if (rows.length < 1000) break;
  }
  // Top 50 searches for the whole window; replaced as a set for this exact period.
  const q = await ask({ startDate: start, endDate: end, dimensions: ['query'], rowLimit: 50, dataState: 'final' });
  counts.pages++;
  const qrows = (Array.isArray(q.rows) ? q.rows : []).filter((x: any) => typeof x.keys?.[0] === 'string');
  const stmts = [env.DB.prepare('DELETE FROM search_queries WHERE workspace_id = ? AND period_start = ? AND period_end = ?').bind(r.workspace_id, start, end)];
  for (const x of qrows) stmts.push(env.DB.prepare('INSERT INTO search_queries (workspace_id, period_start, period_end, query, impressions, clicks, position, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(r.workspace_id, start, end, String(x.keys[0]).slice(0, 200), Math.round(Number(x.impressions) || 0), Math.round(Number(x.clicks) || 0), x.position == null ? null : Number(x.position), runId));
  await env.DB.batch(stmts);
}

async function syncGa4(env: Env, r: any, token: string, runId: string, start: string, end: string, counts: Counts, retries: string[]) {
  const settings = JSON.parse(r.settings_json || '{}');
  const events = [settings.enquiryEvent || 'enquiry_submitted', settings.whatsappEvent || 'whatsapp_tap'];
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(r.resource)}:runReport`;
  const ask = (body: object) => gcall(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, retries);
  const ymd = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '');
  for (let offset = 0; ; offset += 10000) {
    const d = await ask({ dateRanges: [{ startDate: start, endDate: end }], dimensions: [{ name: 'date' }, { name: 'sessionSourceMedium' }], metrics: [{ name: 'sessions' }], limit: 10000, offset });
    counts.pages++;
    const rows = Array.isArray(d.rows) ? d.rows : [];
    for (const x of rows) {
      const date = ymd(String(x.dimensionValues?.[0]?.value ?? '')), sm = String(x.dimensionValues?.[1]?.value ?? '(not set)').slice(0, 120);
      const n = Math.round(Number(x.metricValues?.[0]?.value) || 0);
      if (!date) { counts.failed++; continue; }
      await upsert(env, {
        find: 'SELECT sessions FROM web_daily WHERE workspace_id = ? AND date = ? AND source_medium = ?',
        insert: 'INSERT INTO web_daily (workspace_id, date, source_medium, sessions, run_id, retrieved_at) VALUES (?, ?, ?, ?, ?, ?)',
        update: 'UPDATE web_daily SET sessions = ?, run_id = ?, retrieved_at = ? WHERE workspace_id = ? AND date = ? AND source_medium = ?',
      }, [r.workspace_id, date, sm], [n, runId, iso()], (o) => o.sessions === n, counts);
    }
    if (offset + rows.length >= Number(d.rowCount ?? 0) || rows.length === 0) break;
  }
  const e = await ask({
    dateRanges: [{ startDate: start, endDate: end }], dimensions: [{ name: 'date' }, { name: 'eventName' }], metrics: [{ name: 'eventCount' }], limit: 10000,
    dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: events } } },
  });
  counts.pages++;
  for (const x of Array.isArray(e.rows) ? e.rows : []) {
    const date = ymd(String(x.dimensionValues?.[0]?.value ?? '')), name = String(x.dimensionValues?.[1]?.value ?? '');
    const n = Math.round(Number(x.metricValues?.[0]?.value) || 0);
    if (!date || !events.includes(name)) { counts.failed++; continue; }
    await upsert(env, {
      find: 'SELECT count FROM web_events WHERE workspace_id = ? AND date = ? AND event_name = ?',
      insert: 'INSERT INTO web_events (workspace_id, date, event_name, count, run_id, retrieved_at) VALUES (?, ?, ?, ?, ?, ?)',
      update: 'UPDATE web_events SET count = ?, run_id = ?, retrieved_at = ? WHERE workspace_id = ? AND date = ? AND event_name = ?',
    }, [r.workspace_id, date, name], [n, runId, iso()], (o) => o.count === n, counts);
  }
}

// One sync for one brand and one connector. The workspace comes from the caller (route or scheduler),
// never from Google's answer, so a job for one brand can never write another brand's rows.
export async function runSync(env: Env, ws: string, c: Connector, trigger: 'manual' | 'schedule' | 'retry', by: string | null) {
  if (c === 'business_profile') throw new HttpError(409, 'Business Profile figures are entered by hand until Google approves API access.');
  const r = await row(env, ws, c);
  if (!r?.token_ciphertext || r.status === 'revoked' || r.status === 'not_connected') throw new HttpError(409, 'Connect this Google account first.');
  // A run still "running" after 15 minutes was interrupted (Worker stopped): record it as failed.
  await env.DB.prepare(`UPDATE sync_runs SET status = 'failed', finished_at = ?, error_summary = 'Interrupted before it finished; the next run fills the gap.'
    WHERE workspace_id = ? AND connector = ? AND status = 'running' AND started_at < ?`).bind(iso(), ws, c, new Date(Date.now() - 15 * 60_000).toISOString()).run();
  if (await env.DB.prepare("SELECT 1 FROM sync_runs WHERE workspace_id = ? AND connector = ? AND status = 'running'").bind(ws, c).first())
    throw new HttpError(409, 'A fetch is already running for this connector.');
  const lastOk = await env.DB.prepare("SELECT started_at FROM sync_runs WHERE workspace_id = ? AND connector = ? AND status = 'complete' ORDER BY started_at DESC LIMIT 1").bind(ws, c).first<{ started_at: string }>();
  const resumed = await env.DB.prepare(`SELECT id FROM sync_runs WHERE workspace_id = ? AND connector = ? AND status IN ('partial','failed') AND started_at > ? ORDER BY started_at DESC LIMIT 1`)
    .bind(ws, c, lastOk?.started_at ?? '').first<{ id: string }>();
  // Google revises recent figures; a rolling 30-day window also fills any gap after an outage.
  const start = day(-31), end = day(-1);
  const runId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO sync_runs (id, workspace_id, connector, started_at, trigger, status, window_start, window_end, resumed_from_run_id, started_by)
    VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`).bind(runId, ws, c, iso(), resumed ? 'retry' : trigger, start, end, resumed?.id ?? null, by).run();
  const counts: Counts = { pages: 0, new: 0, unchanged: 0, changed: 0, failed: 0 };
  const retries: string[] = [];
  let status: 'complete' | 'partial' | 'failed' = 'complete', error: string | null = null;
  try {
    const token = await accessToken(env, r, retries);
    if (c === 'search_console') await syncSearchConsole(env, r, token, runId, start, end, counts, retries);
    else await syncGa4(env, r, token, runId, start, end, counts, retries);
    if (counts.failed) { status = 'partial'; error = `${counts.failed} rows from Google could not be read.`; }
    await env.DB.prepare(`UPDATE google_connections SET status = 'connected', api_enabled = 'proven', access_approved = 'proven', last_error = NULL, last_sync_at = ?, updated_at = ? WHERE id = ?`)
      .bind(iso(), now(), r.id).run();
  } catch (e) {
    const g = e instanceof GoogleError ? e : new GoogleError('other', e instanceof Error ? e.message : String(e));
    error = g.message;
    const wrote = counts.new + counts.changed + counts.unchanged > 0;
    status = wrote ? 'partial' : 'failed';
    const col = g.kind === 'reconnect' ? "status = 'needs_reconnect'" : g.kind === 'disabled' ? "api_enabled = 'no'" : g.kind === 'no_access' ? "access_approved = 'no', api_enabled = 'proven'" : null;
    await env.DB.prepare(`UPDATE google_connections SET ${col ? `${col}, ` : ''}last_error = ?, updated_at = ? WHERE id = ?`).bind(g.message, now(), r.id).run();
  }
  await env.DB.prepare(`UPDATE sync_runs SET status = ?, finished_at = ?, pages_fetched = ?, items_new = ?, items_unchanged = ?, items_changed = ?, items_failed = ?, retries_json = ?, error_summary = ? WHERE id = ?`)
    .bind(status, iso(), counts.pages, counts.new, counts.unchanged, counts.changed, counts.failed, JSON.stringify(retries), error ? redact(error) : null, runId).run();
  const done = await env.DB.prepare('SELECT * FROM sync_runs WHERE id = ?').bind(runId).first<any>();
  return { ...done, retries: JSON.parse(done?.retries_json || '[]'), retries_json: undefined };
}

// Daily scheduled fetch: each brand's connectors separately; one brand's failure never stops another's.
export async function syncAll(env: Env) {
  const { results } = await env.DB.prepare("SELECT workspace_id, connector FROM google_connections WHERE status = 'connected' AND connector != 'business_profile'").all<{ workspace_id: string; connector: Connector }>();
  const out: unknown[] = [];
  for (const x of results ?? []) {
    try { out.push(await runSync(env, x.workspace_id, x.connector, 'schedule', null)); }
    catch (e) { out.push({ workspace_id: x.workspace_id, connector: x.connector, error: e instanceof Error ? redact(e.message) : 'failed' }); }
  }
  return out;
}

export async function listRuns(env: Env, ws: string, c: Connector | 'instagram' | null) {
  const { results } = await env.DB.prepare(
    `SELECT id, connector, started_at, finished_at, trigger, status, pages_fetched, items_new, items_unchanged, items_changed, items_failed, retries_json, window_start, window_end, error_summary, resumed_from_run_id
     FROM sync_runs WHERE workspace_id = ? AND (? IS NULL OR connector = ?) ORDER BY started_at DESC LIMIT 30`).bind(ws, c, c).all<any>();
  return (results ?? []).map((x) => ({ ...x, retries: JSON.parse(x.retries_json || '[]'), retries_json: undefined }));
}

// Key rotation (design 2.4): re-encrypt every stored Google sign-in with the current key, prove each
// one opens, and record the rotation as a run. Old keys can be removed once this reports zero failures.
export async function rotateKeys(env: Env, by: string) {
  const ring = keyring(env as any);
  const runId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO sync_runs (id, workspace_id, connector, started_at, trigger, status, started_by) VALUES (?, '*', 'key_rotation', ?, 'rotation', 'running', ?)`).bind(runId, iso(), by).run();
  const { results } = await env.DB.prepare('SELECT * FROM google_connections WHERE token_ciphertext IS NOT NULL').all<any>();
  let moved = 0, already = 0, failed = 0;
  for (const r of results ?? []) {
    if (r.key_version === ring.current) { already++; continue; }
    try {
      const a = aad(r.workspace_id, r.connector, r.resource);
      const secret = await openBound(env as any, a, r.token_ciphertext, r.key_version);
      const sealed = await sealBound(env as any, a, secret);
      await openBound(env as any, a, sealed.ciphertext, sealed.keyVersion); // verify before replacing
      await env.DB.prepare('UPDATE google_connections SET token_ciphertext = ?, key_version = ?, updated_at = ? WHERE id = ?').bind(sealed.ciphertext, sealed.keyVersion, now(), r.id).run();
      moved++;
    } catch { failed++; }
  }
  // Instagram tokens (round 10) are rotated in the same run.
  const ig = await rotateInstagramKeys(env, ring.current);
  moved += ig.moved; already += ig.already; failed += ig.failed;
  const status = failed ? 'partial' : 'complete';
  await env.DB.prepare('UPDATE sync_runs SET status = ?, finished_at = ?, items_changed = ?, items_unchanged = ?, items_failed = ?, error_summary = ? WHERE id = ?')
    .bind(status, iso(), moved, already, failed, failed ? `${failed} sign-ins could not be re-encrypted; keep the old key until fixed.` : null, runId).run();
  return { currentKeyVersion: ring.current, reEncrypted: moved, alreadyCurrent: already, failed, safeToRemoveOldKeys: failed === 0 };
}

// ---------- hand-entered Business Profile figures ----------

export async function addManual(env: Env, ws: string, email: string, body: any) {
  const month = String(body?.month ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > iso().slice(0, 7)) throw new HttpError(400, 'Month as YYYY-MM, not in the future.');
  const figures = body?.figures && typeof body.figures === 'object' ? body.figures : {};
  const entries = Object.entries(figures).filter(([k, v]) => k in MANUAL_METRICS && v !== '' && v !== null && v !== undefined);
  if (!entries.length) throw new HttpError(400, 'Enter at least one figure.');
  const note = body?.note ? String(body.note).slice(0, 300) : null;
  const stmts: D1PreparedStatement[] = [];
  for (const [metric, raw] of entries) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 10_000_000) throw new HttpError(400, `${MANUAL_METRICS[metric]}: a whole number of 0 or more.`);
    const id = crypto.randomUUID();
    stmts.push(env.DB.prepare(`UPDATE manual_metrics SET superseded_by = ? WHERE workspace_id = ? AND connector = 'business_profile' AND month = ? AND metric = ? AND superseded_by IS NULL`).bind(id, ws, month, metric));
    stmts.push(env.DB.prepare(`INSERT INTO manual_metrics (id, workspace_id, connector, month, metric, value, note, entered_by, entered_at) VALUES (?, ?, 'business_profile', ?, ?, ?, ?, ?, ?)`)
      .bind(id, ws, month, metric, value, note, email, iso()));
  }
  await env.DB.batch(stmts);
  return listManual(env, ws);
}

export async function listManual(env: Env, ws: string) {
  const { results } = await env.DB.prepare(`SELECT id, month, metric, value, note, entered_by, entered_at, superseded_by FROM manual_metrics
    WHERE workspace_id = ? AND connector = 'business_profile' ORDER BY month DESC, metric, entered_at DESC`).bind(ws).all<any>();
  return { metrics: MANUAL_METRICS, entries: (results ?? []).map((x) => ({ ...x, label: MANUAL_METRICS[x.metric] ?? x.metric, current: !x.superseded_by, entry: 'entered by hand' })) };
}

// ---------- the funnel ----------

async function crmJson(env: Env, path: string, params: Record<string, string>, scope?: string) {
  const url = new URL(path, env.CRM_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await crmFetch(env, url.toString(), { headers: { 'x-imi-feed-key': env.CRM_SERVICE_KEY!, ...(scope ? { 'x-imi-scope': scope } : {}) }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`The CRM answered ${res.status}.`);
  return res.json() as Promise<any>;
}

async function freshness(env: Env, ws: string, c: Connector) {
  return env.DB.prepare(`SELECT status, finished_at FROM sync_runs WHERE workspace_id = ? AND connector = ? AND status != 'running' ORDER BY started_at DESC LIMIT 1`).bind(ws, c).first<{ status: string; finished_at: string }>();
}

export async function funnel(env: Env, ws: string, role: Role, daysRaw: string | null, window?: { start: string; end: string }) {
  const days = window ? Math.round((Date.parse(window.end) - Date.parse(window.start)) / 86400_000) + 1 : Math.min(90, Math.max(7, Number(daysRaw) || 28));
  const end = window?.end ?? day(-1), start = window?.start ?? day(-days);
  const since = `${start}T00:00:00Z`;
  const stages: any[] = [];
  const unavailable = (key: string, label: string, source: string, detail: string) => ({ key, label, source, status: 'unavailable', value: null, detail });

  // 1. Search (Search Console). Keyword figures stay here; they never claim a booking.
  const sc = await row(env, ws, 'search_console');
  const scRun = await freshness(env, ws, 'search_console');
  const s = await env.DB.prepare('SELECT COUNT(*) AS days, SUM(impressions) AS imp, SUM(clicks) AS clk FROM search_daily WHERE workspace_id = ? AND date BETWEEN ? AND ?').bind(ws, start, end).first<any>();
  if (s?.days) {
    const top = (await env.DB.prepare('SELECT query, impressions, clicks, position FROM search_queries WHERE workspace_id = ? ORDER BY period_end DESC, clicks DESC, impressions DESC LIMIT 10').bind(ws).all<any>()).results ?? [];
    stages.push({ key: 'search', label: 'Seen in Google Search', source: 'Google Search Console', kind: 'platform', status: scRun?.status === 'complete' ? 'measured' : scRun?.status ?? 'measured',
      value: s.imp, secondary: { label: 'Clicks to the website', value: s.clk }, daysWithData: s.days, retrievedAt: scRun?.finished_at ?? null,
      detail: 'What Google reports for the website. Keyword figures stay at this stage; they do not show which search led to a booking.', topSearches: top });
  } else stages.push(unavailable('search', 'Seen in Google Search', 'Google Search Console', sc?.status === 'connected' ? 'Connected; press "Fetch now" for the first data.' : 'Connect Search Console to see this.'));

  // 2. Maps (Business Profile, entered by hand until Google approves access).
  const gbp = (await env.DB.prepare(`SELECT month, metric, value, entered_at FROM manual_metrics WHERE workspace_id = ? AND connector = 'business_profile' AND superseded_by IS NULL
    AND month = (SELECT MAX(month) FROM manual_metrics WHERE workspace_id = ? AND connector = 'business_profile' AND superseded_by IS NULL)`).bind(ws, ws).all<any>()).results ?? [];
  if (gbp.length) {
    const f = Object.fromEntries(gbp.map((x) => [x.metric, x.value]));
    stages.push({ key: 'maps', label: 'Business Profile (Search and Maps)', source: 'Google Business Profile', kind: 'platform', status: 'entered_by_hand', entry: 'entered by hand',
      value: (f.views_search ?? 0) + (f.views_maps ?? 0), month: gbp[0].month, figures: gbp.map((x) => ({ metric: x.metric, label: MANUAL_METRICS[x.metric], value: x.value })),
      detail: `Monthly figures for ${gbp[0].month}, typed in from the Performance page. A different period from the other stages.` });
  } else stages.push(unavailable('maps', 'Business Profile (Search and Maps)', 'Google Business Profile', 'Enter last month\'s figures by hand until Google approves API access.'));

  // 3. Website visits and 4. WhatsApp taps (GA4).
  const ga = await row(env, ws, 'ga4');
  const gaRun = await freshness(env, ws, 'ga4');
  const v = await env.DB.prepare(`SELECT COUNT(DISTINCT date) AS days, SUM(sessions) AS all_s, SUM(CASE WHEN source_medium = 'google / organic' THEN sessions ELSE 0 END) AS g
    FROM web_daily WHERE workspace_id = ? AND date BETWEEN ? AND ?`).bind(ws, start, end).first<any>();
  const settings = JSON.parse(ga?.settings_json || '{}');
  if (v?.days) {
    stages.push({ key: 'visits', label: 'Website visits from Google Search', source: 'Google Analytics 4', kind: 'platform', status: gaRun?.status === 'complete' ? 'measured' : gaRun?.status ?? 'measured',
      value: v.g, secondary: { label: 'All website visits', value: v.all_s }, retrievedAt: gaRun?.finished_at ?? null,
      detail: 'Sessions GA4 records as google / organic. Visitors who refuse cookies are not counted, so this is lower than reality.' });
    const ev = async (name: string) => (await env.DB.prepare('SELECT SUM(count) AS n FROM web_events WHERE workspace_id = ? AND event_name = ? AND date BETWEEN ? AND ?').bind(ws, name, start, end).first<any>())?.n ?? 0;
    stages.push({ key: 'whatsapp_taps', label: 'WhatsApp button taps', source: 'Google Analytics 4', kind: 'interaction', status: 'measured', value: await ev(settings.whatsappEvent || 'whatsapp_tap'),
      detail: 'A tap opens WhatsApp. It is an interaction, not an enquiry: only the CRM counts enquiries.' });
    stages.push({ key: 'form_events', label: 'Enquiry form submissions (website)', source: 'Google Analytics 4', kind: 'interaction', status: 'measured', value: await ev(settings.enquiryEvent || 'enquiry_submitted'),
      detail: 'What the website recorded. The CRM figure below is the one that counts.' });
  } else {
    stages.push(unavailable('visits', 'Website visits from Google Search', 'Google Analytics 4', ga?.status === 'connected' ? 'Connected; press "Fetch now" for the first data.' : 'Connect GA4 to see this.'));
    stages.push(unavailable('whatsapp_taps', 'WhatsApp button taps', 'Google Analytics 4', 'Needs GA4 and a WhatsApp tap event on the website.'));
  }

  // 5 onwards: enquiries, quotes, bookings, revenue, contribution (Iddav CRM, the only one that counts these).
  const hasCrm = ws === legacyWorkspace(env) && crmMode(env);
  if (!hasCrm) {
    stages.push(unavailable('enquiries', 'Enquiries', 'CRM', 'This brand has no CRM connected, so enquiries and bookings cannot be shown.'));
  } else {
    const scope = [can(role, 'money.read') ? 'money' : '', can(role, 'margin.read') ? 'margin' : ''].filter(Boolean).join(',');
    try {
      const [pipe, outc] = await Promise.all([crmJson(env, '/integrations/imi/pipeline', { since }, scope), crmJson(env, '/integrations/imi/outcomes', { since })]);
      const { results: camps } = await env.DB.prepare('SELECT code FROM campaigns WHERE workspace_id = ?').bind(ws).all<{ code: string }>();
      const codes = new Set((camps ?? []).map((x) => x.code.toUpperCase()));
      const mine = (Array.isArray(outc?.imi_campaigns) ? outc.imi_campaigns : []).filter((c: any) => codes.has(String(c.code).toUpperCase()));
      const g = { enquiries: 0, booked: 0, value: 0 }, any = { enquiries: 0 };
      for (const c of mine) {
        any.enquiries += Number(c.tracked ?? c.enquiries) || 0;
        for (const [tag, sl] of Object.entries<any>(c.by_tag ?? {})) {
          if (!GOOGLE_TAGS.has(tag.toUpperCase())) continue;
          g.enquiries += Number(sl.enquiries) || 0; g.booked += Number(sl.booked) || 0; g.value += Number(sl.booked_value) || 0;
        }
      }
      const st = Array.isArray(pipe?.stages) ? pipe.stages : [];
      const total = st.reduce((n: number, x: any) => n + (Number(x.n) || 0), 0);
      const booked = st.filter((x: any) => BOOKED_STATUSES.has(x.status)).reduce((n: number, x: any) => n + (Number(x.n) || 0), 0);
      const quoted = st.filter((x: any) => QUOTED_STATUSES.has(x.status)).reduce((n: number, x: any) => n + (Number(x.n) || 0), 0);
      const retrievedAt = iso();
      stages.push({ key: 'enquiries', label: 'Enquiries', source: 'Iddav CRM', kind: 'crm', status: 'measured', value: total, retrievedAt,
        attribution: { attributedGoogle: g.enquiries, attributedOther: Math.max(0, any.enquiries - g.enquiries), unattributed: Math.max(0, total - any.enquiries),
          unknown: 'Phone calls and walk-ins that were never entered in the CRM cannot be counted.' },
        detail: 'Every enquiry recorded in the CRM in this period. "From Google" means it carried a Google-tagged IMI link or code.' });
      stages.push({ key: 'quotes', label: 'Quotes waiting or booked', source: 'Iddav CRM', kind: 'crm', status: 'measured', value: quoted + booked, retrievedAt,
        detail: 'Enquiries now at Quote sent, Follow-up or booked. An enquiry that was quoted and then lost is not included.' });
      stages.push({ key: 'bookings', label: 'Confirmed bookings', source: 'Iddav CRM', kind: 'crm', status: 'measured', value: booked, retrievedAt,
        attribution: { attributedGoogle: g.booked, unattributedOrOther: Math.max(0, booked - g.booked) }, detail: 'Booked, stayed or reviewed, from enquiries made in this period.' });
      if (can(role, 'money.read') && pipe?.money) {
        stages.push({ key: 'revenue', label: 'Booked value', source: 'Iddav CRM', kind: 'crm', status: 'measured', value: Number(pipe.money.booked_value) || 0, currency: 'INR', retrievedAt,
          attribution: { attributedGoogle: g.value }, detail: 'Value of confirmed bookings, before costs.' });
      }
      if (can(role, 'margin.read')) {
        const m = pipe?.margin;
        const complete = !!m && m.known === true;
        stages.push({ key: 'contribution', label: 'Contribution (after costs)', source: 'Iddav CRM', kind: 'crm', ownerOnly: true, retrievedAt,
          status: complete ? 'measured' : 'incomplete', value: complete ? Number(m.contribution) || 0 : null, currency: 'INR',
          detail: complete ? 'Revenue minus running costs, commission and ad cost, as recorded in the CRM.'
            : 'Incomplete: at least one cost (running costs, commission or ad cost) is not recorded in the CRM, so no figure is shown rather than a guess.' });
      }
    } catch (e) {
      stages.push(unavailable('enquiries', 'Enquiries', 'Iddav CRM', `The CRM could not be read just now (${e instanceof Error ? redact(e.message) : 'error'}). Try again in a minute.`));
    }
  }

  return {
    workspaceId: ws, period: { start, end, days }, stages,
    costPerBooking: { value: null, detail: 'Shown only once ad spend is recorded. No ads are running.' },
    rules: [
      'Each stage shows its own source and period. Numbers from different systems are not forced to match; differences are expected.',
      'A WhatsApp tap is an interaction, never an enquiry. Only the CRM counts enquiries and bookings.',
      'Search keywords stay at the search stage; they never claim a booking.',
      'Results are attributed (traceable Google link or code), unattributed (known, source not traceable) or unknown (not measurable).',
    ],
  };
}

// Today: a Google connection that stopped working is something the owner must fix.
export async function needsAttention(env: Env, ws: string) {
  const { results } = await env.DB.prepare(`SELECT connector, last_error FROM google_connections WHERE workspace_id = ? AND (status = 'needs_reconnect' OR api_enabled = 'no' OR access_approved = 'no')`).bind(ws).all<any>();
  return (results ?? []).map((x) => ({
    id: `google-${x.connector}`, kind: 'fix_connection', subject: INFO[x.connector as Connector].name, title: `${INFO[x.connector as Connector].name} needs attention`,
    why: x.last_error || 'The connection stopped working.', action: { label: 'Open Search', screen: 'intelligence', ref: 'search' },
  }));
}
