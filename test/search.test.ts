// IMI ONE round 9: Build 3 measurement. Read-only Google connectors with five states, sync-run audit
// records and failure recovery, hand-entered Business Profile figures, the funnel, and bound encryption.
// Design references: 4.4 states, 4.7 measurement, 4.8 contribution, 4.9 A1-A8, 2.4 encryption, T14-T21.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/index.ts';
import worker from '../src/index.ts';
import { io, redact } from '../src/search.ts';
import { sealBound, openBound } from '../src/crypto.ts';
import { makeD1 } from './helpers/d1.ts';

const KEY1 = Buffer.alloc(32, 7).toString('base64');
const KEY2 = Buffer.alloc(32, 9).toString('base64');
const SITE = 'https://www.iddavwildstay.com/';
const REFRESH = '1//refresh-SECRET-abcdefghijklmnop';
const ACCESS = 'ya29.access-SECRET-xyz';

// ---------- a fake Google ----------
type Plan = { token?: number[]; daily?: (number | 'rows')[]; queries?: number[]; ga?: number[]; events?: number[] };
let google: { calls: string[]; plan: Plan; dailyRows: any[]; revoked: boolean; failQueries: boolean };
function resetGoogle() {
  google = { calls: [], plan: {}, revoked: false, failQueries: false,
    dailyRows: [{ keys: ['2026-11-10'], impressions: 120, clicks: 9, position: 7.5 }, { keys: ['2026-11-11'], impressions: 140, clicks: 11, position: 6.9 }] };
}
const next = (k: keyof Plan) => (google.plan[k] as any[] | undefined)?.shift();
io.sleep = async () => {};
io.fetch = async (input: any, init?: RequestInit) => {
  const url = String(input);
  google.calls.push(`${url} ${init?.headers ? JSON.stringify(init.headers) : ''}`);
  const reply = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  if (url === 'https://oauth2.googleapis.com/token') {
    const p = new URLSearchParams(String(init?.body));
    const forced = next('token'); if (forced) return reply(forced, forced === 400 ? { error: 'invalid_grant' } : 'busy');
    if (p.get('grant_type') === 'authorization_code') return reply(200, { access_token: ACCESS, refresh_token: REFRESH, scope: p.get('code') === 'no-scope' ? 'openid' : 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly' });
    if (google.revoked) return reply(400, { error: 'invalid_grant', error_description: `Token ${REFRESH} has been revoked` });
    if (p.get('refresh_token') !== REFRESH) return reply(400, { error: 'invalid_grant' });
    return reply(200, { access_token: ACCESS, expires_in: 3599 });
  }
  const auth = (init?.headers as any)?.Authorization;
  if (auth !== `Bearer ${ACCESS}`) return reply(401, 'no auth');
  if (url.includes('searchAnalytics/query')) {
    const body = JSON.parse(String(init?.body));
    if (body.dimensions[0] === 'date') { const f = next('daily'); if (f && f !== 'rows') return reply(f, 'Google error'); return reply(200, { rows: google.dailyRows }); }
    if (google.failQueries) return reply(500, 'backend error');
    const f = next('queries'); if (f) return reply(f, 'Google error');
    return reply(200, { rows: [{ keys: ['tadoba resort'], impressions: 80, clicks: 6, position: 5.1 }, { keys: ['stay near moharli gate'], impressions: 30, clicks: 3, position: 3.2 }] });
  }
  if (url.includes('analyticsdata.googleapis.com')) {
    const body = JSON.parse(String(init?.body));
    if (body.dimensions[1].name === 'sessionSourceMedium') {
      const f = next('ga'); if (f) return reply(f, f === 403 ? '{"error":{"status":"PERMISSION_DENIED","message":"User does not have sufficient permissions for this property."}}' : 'err');
      return reply(200, { rowCount: 3, rows: [
        { dimensionValues: [{ value: '20261110' }, { value: 'google / organic' }], metricValues: [{ value: '40' }] },
        { dimensionValues: [{ value: '20261110' }, { value: '(direct) / (none)' }], metricValues: [{ value: '25' }] },
        { dimensionValues: [{ value: '20261111' }, { value: 'google / organic' }], metricValues: [{ value: '35' }] }] });
    }
    return reply(200, { rows: [
      { dimensionValues: [{ value: '20261110' }, { value: 'whatsapp_tap' }], metricValues: [{ value: '14' }] },
      { dimensionValues: [{ value: '20261111' }, { value: 'enquiry_submitted' }], metricValues: [{ value: '2' }] }] });
  }
  return reply(404, 'unknown');
};

// ---------- a small world ----------
function world(extra: Record<string, unknown> = {}) {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  for (const [id, ws, email, role] of [['m1', 'ws-iddav', 'owner@iddav.com', 'owner'], ['m2', 'ws-iddav', 'mgr@iddav.com', 'manager'], ['m3', 'ws-iddav', 'sales@iddav.com', 'sales'],
    ['m4', 'ws-antardrishti', 'ad@x.com', 'owner'], ['m5', 'ws-iddav', 'owner2@iddav.com', 'owner']])
    run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, 'tnt-rama', ?, ?, ?, 'seed', '2026-11-01')", id, ws, email, role);
  run(`INSERT INTO campaigns (id, code, name, objective, primary_metric, cta_type, destination_url, expected_outcome, created_by, created_at, workspace_id)
       VALUES ('c1','CMP-0001','Winter','enquiries','qualified_enquiries','whatsapp','https://iddavwildstay.com','more enquiries','seed','2026-11-01','ws-iddav')`);
  const crmSeen: string[] = [];
  let margin: any = { contribution: 41000, known: true };
  const CRM_SERVICE = { fetch: async (u: string, init?: RequestInit) => {
    const h = new Headers(init?.headers); const path = new URL(u).pathname; crmSeen.push(`${path}|${h.get('x-imi-scope') ?? ''}`);
    if (path === '/integrations/imi/pipeline') {
      const sc = (h.get('x-imi-scope') ?? '').split(',');
      return new Response(JSON.stringify({ stages: [{ status: 'new', n: 6 }, { status: 'quoted', n: 3 }, { status: 'booked', n: 2 }, { status: 'stay_completed', n: 1 }, { status: 'lost', n: 2 }],
        open: [], ...(sc.includes('money') ? { money: { booked_value: 54000, received: 20000 } } : {}), ...(sc.includes('margin') ? { margin } : {}) }));
    }
    return new Response(JSON.stringify({ imi_campaigns: [
      { code: 'CMP-0001', enquiries: 7, tracked: 7, booked: 2, by_tag: { GB: { enquiries: 3, booked: 1, booked_value: 18000 }, IG: { enquiries: 4, booked: 1, booked_value: 16000 } } },
      { code: 'CMP-9999', enquiries: 50, tracked: 50, by_tag: { GB: { enquiries: 50, booked: 9, booked_value: 1 } } }] }));
  } };
  const env = { DB, CONNECTIONS_KEY: KEY1, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret-SHOULD-NOT-LEAK', OWNER_EMAILS: 'owner@iddav.com',
    CRM_URL: 'https://crm.internal', CRM_SERVICE_KEY: 'feed', CRM_SERVICE, APP_URL: 'https://app.example', ...extra } as any;
  return { env, DB, crmSeen, setMargin: (m: any) => { margin = m; } };
}

async function call(env: any, who: string, method: string, path: string, body?: unknown) {
  const r = await createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await r.text();
  let data: any = text; try { data = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, data, text };
}
const W = '/v1/workspaces/ws-iddav';

// Owner sets the site and signs in with Google (fake), returns the connected world.
async function connected(connector: 'search_console' | 'ga4' = 'search_console', w = world()) {
  const res = connector === 'ga4' ? '123456789' : SITE;
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/${connector}`, { resource: res })).status, 200);
  const start = await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/${connector}/oauth-start`);
  assert.equal(start.status, 200);
  const state = new URL(start.data.url).searchParams.get('state')!;
  const cb = await call(w.env, 'owner@iddav.com', 'GET', `/oauth/google-measure/callback?state=${state}&code=good`);
  assert.equal(cb.status, 200, cb.text);
  return w;
}
const states = async (env: any, c: string) => (await call(env, 'owner@iddav.com', 'GET', `${W}/google`)).data.connectors.find((x: any) => x.connector === c).states.map((s: any) => s.value);

beforeEach(() => resetGoogle());

// ---------- connection states (A6) ----------
test('A6: each connector shows its five states independently; signing in does not imply API enabled, access or data', async () => {
  const w = world();
  assert.deepEqual(await states(w.env, 'search_console'), ['yes', 'unknown', 'no', 'unknown', 'no']);
  await connected('search_console', w);
  assert.deepEqual(await states(w.env, 'search_console'), ['yes', 'unknown', 'yes', 'unknown', 'no'], 'authorised only');
  assert.deepEqual(await states(w.env, 'ga4'), ['yes', 'unknown', 'no', 'unknown', 'no'], 'GA4 untouched');
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/business_profile`, { apiEnabled: true });
  assert.deepEqual(await states(w.env, 'business_profile'), ['yes', 'yes', 'no', 'unknown', 'no'], 'owner confirmation of one state only');
  const run = await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`);
  assert.equal(run.data.status, 'complete');
  assert.deepEqual(await states(w.env, 'search_console'), ['yes', 'yes', 'yes', 'yes', 'yes'], 'a successful call proves states 2, 4 and 5');
});

test('OAuth: read-only scope requested, one-time state, same person, owner only, and a missing scope is refused', async () => {
  const w = world();
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console`, { resource: SITE });
  const start = await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/oauth-start`);
  const u = new URL(start.data.url);
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/webmasters.readonly');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:8787/oauth/google-measure/callback');
  const state = u.searchParams.get('state')!;
  assert.equal((await call(w.env, 'owner2@iddav.com', 'GET', `/oauth/google-measure/callback?state=${state}&code=good`)).status, 400, 'a different person cannot finish it');
  assert.equal((await call(w.env, 'owner@iddav.com', 'GET', `/oauth/google-measure/callback?state=${state}&code=good`)).status, 400, 'state is single-use');
  const s2 = new URL((await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/oauth-start`)).data.url).searchParams.get('state');
  const noScope = await call(w.env, 'owner@iddav.com', 'GET', `/oauth/google-measure/callback?state=${s2}&code=no-scope`);
  assert.equal(noScope.status, 400); assert.match(noScope.text, /did not grant read access/);
  assert.equal((await call(w.env, 'mgr@iddav.com', 'POST', `${W}/google/search_console/oauth-start`)).status, 403, 'managers cannot connect');
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/business_profile/oauth-start`)).status, 409, 'Business Profile is by hand for now');
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console`, { resource: 'not a site' })).status, 400);
});

// ---------- secrets and encryption (T10, 2.4) ----------
test('T10: the token is encrypted with AAD and a key version, and never appears in any response, run or error', async () => {
  const w = await connected();
  const row = w.DB.raw.prepare("SELECT * FROM google_connections WHERE connector = 'search_console'").get() as any;
  assert.equal(row.key_version, 1);
  assert.ok(!row.token_ciphertext.includes('refresh'));
  const aad = `ws-iddav|google:search_console|${SITE}`;
  assert.deepEqual(await openBound(w.env, aad, row.token_ciphertext, 1), { refresh_token: REFRESH });
  await assert.rejects(openBound(w.env, `ws-antardrishti|google:search_console|${SITE}`, row.token_ciphertext, 1), 'copied to another brand: fails');
  await assert.rejects(openBound(w.env, 'ws-iddav|google:search_console|https://other.example/', row.token_ciphertext, 1), 'bound to the account');
  const a = await sealBound(w.env, aad, { x: 1 }), b = await sealBound(w.env, aad, { x: 1 });
  assert.notEqual(a.ciphertext.slice(0, 16), b.ciphertext.slice(0, 16), 'fresh nonce every time');
  google.revoked = true;
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`);
  const everything = JSON.stringify([(await call(w.env, 'owner@iddav.com', 'GET', `${W}/google`)).data, (await call(w.env, 'owner@iddav.com', 'GET', `${W}/google/runs`)).data, w.DB.raw.prepare('SELECT * FROM sync_runs').all()]);
  for (const secret of [REFRESH, ACCESS, 'csecret-SHOULD-NOT-LEAK', 'refresh-SECRET', 'access-SECRET']) assert.ok(!everything.includes(secret), `no ${secret}`);
  assert.equal(redact('Authorization: Bearer ya29.abc.def refresh_token=1//0abcdefghijklmnop'), 'Authorization: Bearer [hidden] refresh_token=[hidden]');
});

test('key rotation: every sign-in is re-encrypted with the new key, verified, and recorded as a run', async () => {
  const w = await connected();
  await connected('ga4', w);
  const env2 = { ...w.env, CONNECTIONS_KEY_V2: KEY2 };
  assert.equal((await call(env2, 'owner2@iddav.com', 'POST', '/v1/admin/google/rotate-keys')).status, 403, 'platform owner only');
  const r = await call(env2, 'owner@iddav.com', 'POST', '/v1/admin/google/rotate-keys');
  assert.deepEqual([r.data.currentKeyVersion, r.data.reEncrypted, r.data.failed, r.data.safeToRemoveOldKeys], [2, 2, 0, true]);
  const without1 = { ...env2, CONNECTIONS_KEY: undefined };
  assert.equal((await call(without1, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).data.status, 'complete', 'works after the old key is removed');
  assert.ok(w.DB.raw.prepare("SELECT 1 FROM sync_runs WHERE connector = 'key_rotation' AND status = 'complete'").get());
});

// ---------- sync behaviour and failure recovery (T14-T21) ----------
test('A1 and T17: Search Console data lands in the Iddav brand only; a repeated sync changes nothing', async () => {
  const w = await connected();
  const r1 = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).data;
  assert.deepEqual([r1.status, r1.items_new, r1.items_changed], ['complete', 2, 0]);
  const r2 = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).data;
  assert.deepEqual([r2.status, r2.items_new, r2.items_changed, r2.items_unchanged], ['complete', 0, 0, 2]);
  assert.equal((w.DB.raw.prepare('SELECT COUNT(*) AS n FROM search_daily').get() as any).n, 2);
  assert.deepEqual(w.DB.raw.prepare('SELECT DISTINCT workspace_id FROM search_daily').all().map((x: any) => x.workspace_id), ['ws-iddav']);
  google.dailyRows[0].clicks = 10;
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).data.items_changed, 1, 'Google revisions are taken');
});

test('A5 and T21: another brand cannot see or touch Iddav search data, and the scheduler keeps brands apart', async () => {
  const w = await connected();
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`);
  for (const [m, p] of [['GET', `${W}/google`], ['GET', `${W}/funnel`], ['GET', `${W}/google/runs`], ['POST', `${W}/google/search_console/sync`], ['POST', `${W}/google/nonsense/sync`], ['GET', `${W}/google/business_profile/manual`]])
    assert.equal((await call(w.env, 'ad@x.com', m, p)).status, 404, `${m} ${p}`);
  const ad = await call(w.env, 'ad@x.com', 'GET', '/v1/workspaces/ws-antardrishti/google');
  assert.deepEqual(ad.data.connectors.map((c: any) => c.status), ['not_connected', 'not_connected', 'not_connected']);
  assert.equal((await call(w.env, 'ad@x.com', 'GET', '/v1/workspaces/ws-antardrishti/funnel')).data.stages.find((s: any) => s.key === 'search').status, 'unavailable');
  const waits: Promise<unknown>[] = [];
  await (worker as any).scheduled({}, w.env, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(w.DB.raw.prepare("SELECT DISTINCT workspace_id FROM sync_runs WHERE trigger = 'schedule'").all().map((x: any) => x.workspace_id), ['ws-iddav']);
  assert.equal((w.DB.raw.prepare("SELECT COUNT(*) AS n FROM search_daily WHERE workspace_id != 'ws-iddav'").get() as any).n, 0);
});

test('T14: a rate limit pauses and retries without losing or duplicating data; the retry is recorded', async () => {
  const w = await connected();
  google.plan.daily = [429, 503];
  const r = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).data;
  assert.equal(r.status, 'complete');
  assert.equal(r.retries.length, 2);
  assert.equal((w.DB.raw.prepare('SELECT COUNT(*) AS n FROM search_daily').get() as any).n, 2);
});

test('T16 and T20: a failure part-way records a partial run; the next run resumes, fills the gap, and links to it', async () => {
  const w = await connected();
  google.failQueries = true;
  const p = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).data;
  assert.equal(p.status, 'partial', 'daily rows saved, top searches failed');
  assert.match(p.error_summary, /Google answered 500/);
  google.failQueries = false;
  const ok = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).data;
  assert.deepEqual([ok.status, ok.trigger, ok.resumed_from_run_id, ok.items_new], ['complete', 'retry', p.id, 0]);
  assert.equal((w.DB.raw.prepare('SELECT COUNT(*) AS n FROM search_queries').get() as any).n, 2);
  google.plan.daily = [503, 503, 503];
  const out = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).data;
  assert.equal(out.status, 'failed', 'Google unreachable');
  google.dailyRows.push({ keys: ['2026-11-12'], impressions: 90, clicks: 4, position: 8 });
  const after = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).data;
  assert.deepEqual([after.status, after.resumed_from_run_id, after.items_new], ['complete', out.id, 1], 'the gap is filled and recorded');
});

test('T18: a run killed mid-way is marked failed and the next run proceeds', async () => {
  const w = await connected();
  w.DB.raw.prepare("INSERT INTO sync_runs (id, workspace_id, connector, started_at, trigger, status) VALUES ('stuck','ws-iddav','search_console','2026-11-01T00:00:00Z','manual','running')").run();
  const r = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).data;
  assert.equal(r.status, 'complete');
  assert.equal(r.resumed_from_run_id, 'stuck');
  assert.match((w.DB.raw.prepare("SELECT error_summary FROM sync_runs WHERE id = 'stuck'").get() as any).error_summary, /Interrupted/);
});

test('T15 and T19: revoked or removed permission marks "needs reconnect", shows on Today, keeps history read-only', async () => {
  const w = await connected();
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`);
  google.revoked = true;
  const r = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).data;
  assert.equal(r.status, 'failed');
  const list = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/google`)).data.connectors[0];
  assert.equal(list.status, 'needs_reconnect');
  assert.equal(list.states[2].value, 'no');
  const today = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/today`)).data;
  assert.equal(today.needsYou[0].id, 'google-search_console');
  assert.equal((w.DB.raw.prepare('SELECT COUNT(*) AS n FROM search_daily').get() as any).n, 2, 'history kept');
  const d = await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/disconnect`);
  assert.equal(d.data.status, 'revoked');
  assert.equal((w.DB.raw.prepare("SELECT token_ciphertext FROM google_connections WHERE connector = 'search_console'").get() as any).token_ciphertext, null);
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`)).status, 409);
});

test('GA4 without property access: state 4 becomes "no" (not a reconnect) and nothing is written', async () => {
  const w = await connected('ga4');
  google.plan.ga = [403];
  const r = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/ga4/sync`)).data;
  assert.equal(r.status, 'failed');
  assert.deepEqual(await states(w.env, 'ga4'), ['yes', 'yes', 'yes', 'no', 'no']);
});

test('T12: no write action against Google exists; every Google call is a read', async () => {
  const w = await connected();
  await connected('ga4', w);
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`);
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/ga4/sync`);
  const hosts = google.calls.map((c) => c.split(' ')[0]);
  assert.ok(hosts.every((u) => u === 'https://oauth2.googleapis.com/token' || u.includes('/searchAnalytics/query') || u.endsWith(':runReport')), hosts.join('\n'));
});

// ---------- hand-entered Business Profile (A3) ----------
test('A3: Business Profile figures are entered by hand, labelled so, append-only, and corrections supersede', async () => {
  const w = world();
  assert.equal((await call(w.env, 'mgr@iddav.com', 'POST', `${W}/google/business_profile/manual`, { month: '2026-10', figures: { calls: 3 } })).status, 403);
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/business_profile/manual`, { month: '2030-01', figures: { calls: 3 } })).status, 400, 'no future months');
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/business_profile/manual`, { month: '2026-10', figures: { calls: -1 } })).status, 400);
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/business_profile/manual`, { month: '2026-10', figures: { views_search: 300, views_maps: 200, calls: 5 } });
  const fix = await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/business_profile/manual`, { month: '2026-10', figures: { calls: 6 }, note: 'misread' });
  assert.equal(fix.status, 201);
  const calls = fix.data.entries.filter((e: any) => e.metric === 'calls');
  assert.deepEqual(calls.map((e: any) => [e.value, e.current]), [[6, true], [5, false]]);
  assert.ok(fix.data.entries.every((e: any) => e.entry === 'entered by hand'));
  assert.throws(() => w.DB.raw.prepare('DELETE FROM manual_metrics').run(), /append-only/);
  const maps = (await call(w.env, 'mgr@iddav.com', 'GET', `${W}/funnel`)).data.stages.find((s: any) => s.key === 'maps');
  assert.deepEqual([maps.status, maps.entry, maps.value, maps.month], ['entered_by_hand', 'entered by hand', 500, '2026-10']);
});

// ---------- the funnel (A2, A4, A7, A8) ----------
test('A4 and A7: each stage has its own source; WhatsApp taps are never enquiries; attributed, unattributed and unknown are separate', async () => {
  const w = await connected();
  await connected('ga4', w);
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/search_console/sync`);
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/google/ga4/sync`);
  const f = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/funnel?days=90`)).data;
  const by = Object.fromEntries(f.stages.map((s: any) => [s.key, s]));
  assert.deepEqual(Object.keys(by), ['search', 'maps', 'visits', 'whatsapp_taps', 'form_events', 'enquiries', 'quotes', 'bookings', 'revenue', 'contribution']);
  assert.deepEqual([by.search.source, by.visits.source, by.enquiries.source], ['Google Search Console', 'Google Analytics 4', 'Iddav CRM']);
  assert.deepEqual([by.search.value, by.search.secondary.value, by.visits.value, by.visits.secondary.value], [260, 20, 75, 100]);
  assert.equal(by.whatsapp_taps.kind, 'interaction');
  assert.equal(by.whatsapp_taps.value, 14);
  assert.equal(by.enquiries.value, 14, 'the CRM count, not 14 taps + 14 enquiries, and not forced to match visits');
  assert.deepEqual(by.enquiries.attribution, { attributedGoogle: 3, attributedOther: 4, unattributed: 7, unknown: by.enquiries.attribution.unknown });
  assert.ok(by.enquiries.attribution.unknown.length > 10);
  assert.deepEqual([by.quotes.value, by.bookings.value, by.bookings.attribution.attributedGoogle], [6, 3, 1]);
  assert.equal(by.revenue.attribution.attributedGoogle, 18000, "another brand's campaign (CMP-9999) is not counted");
  assert.deepEqual(by.search.topSearches.map((q: any) => q.query), ['tadoba resort', 'stay near moharli gate']);
  assert.equal(f.costPerBooking.value, null);
  assert.ok(f.rules.some((r: string) => /never an enquiry/.test(r)));
});

test('A8: contribution only for owners, and "incomplete" (no number) when any cost is missing; money follows the role', async () => {
  const w = world();
  const stages = async (who: string) => Object.fromEntries((await call(w.env, who, 'GET', `${W}/funnel`)).data.stages.map((s: any) => [s.key, s]));
  const owner = await stages('owner@iddav.com');
  assert.deepEqual([owner.contribution.status, owner.contribution.value, owner.contribution.ownerOnly], ['measured', 41000, true]);
  w.setMargin({ contribution: 41000, known: false });
  const inc = (await stages('owner@iddav.com')).contribution;
  assert.deepEqual([inc.status, inc.value], ['incomplete', null]);
  const mgr = await stages('mgr@iddav.com');
  assert.ok(!mgr.contribution && mgr.revenue, 'manager: money yes, margin no');
  const sales = await stages('sales@iddav.com');
  assert.ok(!sales.contribution && !sales.revenue, 'sales: neither');
  assert.deepEqual(w.crmSeen.filter((s) => s.startsWith('/integrations/imi/pipeline')).slice(-3), ['/integrations/imi/pipeline|money,margin', '/integrations/imi/pipeline|money', '/integrations/imi/pipeline|']);
});

test('A2: the funnel carries no personal details, and a CRM outage shows as unavailable, not zero', async () => {
  const w = world();
  const text = JSON.stringify((await call(w.env, 'owner@iddav.com', 'GET', `${W}/funnel`)).data);
  for (const word of ['phone', 'email', '@', 'name"']) assert.ok(!text.includes(word), word);
  w.env.CRM_SERVICE = { fetch: async () => new Response('down', { status: 502 }) };
  const e = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/funnel`)).data.stages.find((s: any) => s.key === 'enquiries');
  assert.deepEqual([e.status, e.value], ['unavailable', null]);
});
