// IMI ONE round 10: Build 1, Instagram read-only. Design 2.4-2.7: token handling, expected account,
// paging with resume, append-only metrics with "unavailable" never 0, refresh, connection test, T1-T21.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/index.ts';
import worker from '../src/index.ts';
import { io } from '../src/search.ts';
import { openBound } from '../src/crypto.ts';
import { makeD1 } from './helpers/d1.ts';

const KEY1 = Buffer.alloc(32, 7).toString('base64');
const KEY2 = Buffer.alloc(32, 9).toString('base64');
const TOKEN = 'IGAAtoken-SECRET-iddav-0123456789';
const TOKEN_AD = 'IGAAtoken-SECRET-antar-0123456789';
const ACC = '17841475745707276';

// ---------- a fake Instagram (graph.instagram.com) ----------
let meta: {
  calls: { method: string; url: string }[]; posts: any[]; failPage: number | null; failKind: number; rate: number;
  insightsPermission: boolean; revoked: Set<string>; refreshed: string | null; refreshFail: boolean; accounts: Record<string, { id: string; username: string }>;
};
function resetMeta(n = 60) {
  meta = { calls: [], failPage: null, failKind: 500, rate: 0, insightsPermission: true, revoked: new Set(), refreshed: null, refreshFail: false,
    accounts: { [TOKEN]: { id: ACC, username: 'iddav_wildstay' }, [TOKEN_AD]: { id: '17841400000000001', username: 'antardrishti' } },
    posts: Array.from({ length: n }, (_, i) => ({ id: String(18000000000 + n - i), caption: `Post ${n - i}`, media_type: i % 3 === 0 ? 'VIDEO' : 'IMAGE',
      media_product_type: i % 3 === 0 ? 'REELS' : i === 1 ? 'STORY' : 'FEED', permalink: `https://www.instagram.com/p/x${i}/`,
      timestamp: new Date(Date.now() - i * 86400_000).toISOString(), like_count: 10 + i, comments_count: i % 4 })) };
}
const err = (status: number, code: number, message: string) => new Response(JSON.stringify({ error: { message, type: 'OAuthException', code } }), { status });
io.sleep = async () => {};
io.fetch = async (input: any, init?: RequestInit) => {
  const u = new URL(String(input));
  meta.calls.push({ method: init?.method ?? 'GET', url: u.origin + u.pathname });
  if (u.origin !== 'https://graph.instagram.com') return new Response('not instagram', { status: 404 });
  const token = u.searchParams.get('access_token') ?? '';
  if (u.pathname === '/refresh_access_token') {
    if (meta.refreshFail) return err(400, 2, 'temporary');
    meta.refreshed = `${token}-R`; meta.accounts[meta.refreshed] = meta.accounts[token];
    return new Response(JSON.stringify({ access_token: meta.refreshed, token_type: 'bearer', expires_in: 5183944 }));
  }
  const who = meta.accounts[token];
  if (!who || meta.revoked.has(token)) return err(400, 190, `Invalid OAuth access token ${token}`);
  if (meta.rate > 0) { meta.rate--; return err(400, 4, 'Application request limit reached'); }
  if (u.pathname === '/me') return new Response(JSON.stringify({ user_id: who.id, username: who.username, account_type: 'BUSINESS', followers_count: 812, media_count: meta.posts.length }));
  if (u.pathname === `/${who.id}/media`) {
    const off = Number((u.searchParams.get('after') ?? 'c0').slice(1));
    const page = Math.floor(off / Number(u.searchParams.get('limit')));
    if (meta.failPage !== null && page === meta.failPage) { meta.failPage = null; return meta.failKind === 500 ? new Response('down', { status: 500 }) : err(400, meta.failKind, 'x'); }
    const lim = Number(u.searchParams.get('limit'));
    const data = meta.posts.slice(off, off + lim);
    const more = off + lim < meta.posts.length;
    return new Response(JSON.stringify({ data, paging: { cursors: { before: `c${off}`, after: `c${off + lim}` }, ...(more ? { next: `https://graph.instagram.com/${who.id}/media?after=c${off + lim}` } : {}) } }));
  }
  if (u.pathname === `/${who.id}/insights`) {
    if (!meta.insightsPermission) return err(403, 10, 'Application does not have permission for this action');
    return new Response(JSON.stringify({ data: [{ name: 'reach', period: 'day', total_value: { value: 300 } }, { name: 'views', period: 'day', total_value: { value: 900 } }] }));
  }
  const mi = u.pathname.match(/^\/(\d+)\/insights$/);
  if (mi) {
    if (!meta.insightsPermission) return err(403, 10, 'Application does not have permission for this action');
    const post = meta.posts.find((p) => p.id === mi[1]);
    if (!post) return err(400, 100, 'Unsupported get request');
    if (post.media_product_type === 'STORY') return err(400, 10, '(#10) Not enough viewers for the media to show insights');
    const metrics = String(u.searchParams.get('metric')).split(',');
    if (metrics.includes('follows') && post.media_product_type === 'FEED' && metrics.length > 1) return err(400, 100, '(#100) metric[8] must be one of the following values');
    if (metrics.length === 1 && metrics[0] === 'follows') return err(400, 100, 'unsupported');
    // Meta omits figures it does not have (here: shares on reels); it never sends them as 0.
    return new Response(JSON.stringify({ data: metrics.filter((m) => !(post.media_product_type === 'REELS' && m === 'shares'))
      .map((name) => ({ name, period: 'lifetime', values: [{ value: name === 'reach' ? 100 + Number(post.id.slice(-2)) : 7 }] })) }));
  }
  return err(400, 100, 'Unknown path');
};

function world() {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  for (const [id, ws, email, role] of [['m1', 'ws-iddav', 'owner@iddav.com', 'owner'], ['m2', 'ws-iddav', 'mgr@iddav.com', 'manager'], ['m4', 'ws-antardrishti', 'ad@x.com', 'owner']])
    run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, 'tnt-rama', ?, ?, ?, 'seed', '2026-11-01')", id, ws, email, role);
  return { DB, env: { DB, CONNECTIONS_KEY: KEY1, OWNER_EMAILS: 'owner@iddav.com' } as any };
}
async function call(env: any, who: string, method: string, path: string, body?: unknown) {
  const r = await createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await r.text();
  let data: any = text; try { data = JSON.parse(text); } catch { /* */ }
  return { status: r.status, data, text };
}
const W = '/v1/workspaces/ws-iddav/social';
const connect = (w: any, token = TOKEN, expectedUsername = 'iddav_wildstay') => call(w.env, 'owner@iddav.com', 'POST', `${W}/instagram/connect`, { token, expectedUsername });
const sync = async (w: any) => (await call(w.env, 'owner@iddav.com', 'POST', `${W}/instagram/sync`)).data;
const count = (w: any, sql: string) => (w.DB.raw.prepare(sql).get() as any).n;

beforeEach(() => resetMeta());

test('connect: only the expected account, only a professional account, owner only, one account per brand; token sealed with AAD', async () => {
  const w = world();
  const wrong = await connect(w, TOKEN, 'someone_else');
  assert.equal(wrong.status, 409); assert.match(wrong.data.error, /belongs to @iddav_wildstay, not @someone_else/);
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM social_accounts'), 0, 'nothing saved');
  assert.equal((await connect(w, 'IGAAbadtoken-000000000000')).status, 400, 'T7: a bad token is refused');
  assert.equal((await call(w.env, 'mgr@iddav.com', 'POST', `${W}/instagram/connect`, { token: TOKEN, expectedUsername: 'iddav_wildstay' })).status, 403);
  assert.equal((await call(w.env, 'ad@x.com', 'POST', `${W}/instagram/connect`, { token: TOKEN, expectedUsername: 'iddav_wildstay' })).status, 404);
  const ok = await connect(w, TOKEN, '@iddav_wildstay');
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.status, ok.data.username, ok.data.accountId, ok.data.readOnly], ['connected', 'iddav_wildstay', ACC, true]);
  const row = w.DB.raw.prepare('SELECT * FROM social_accounts').get() as any;
  assert.deepEqual(await openBound(w.env, `ws-iddav|instagram|${ACC}`, row.token_ciphertext, row.key_version), { token: TOKEN });
  await assert.rejects(openBound(w.env, `ws-antardrishti|instagram|${ACC}`, row.token_ciphertext, row.key_version), 'cannot be opened under another brand');
  const same = await call(w.env, 'ad@x.com', 'POST', '/v1/workspaces/ws-antardrishti/social/instagram/connect', { token: TOKEN, expectedUsername: 'iddav_wildstay' });
  assert.equal(same.status, 409); assert.match(same.data.error, /another brand/);
});

test('T4, T6, T8, T17: posts are fetched across pages, older posts continue from a cursor, nothing is duplicated, a repeat changes nothing', async () => {
  resetMeta(130);
  const w = world();
  await connect(w);
  const r1 = await sync(w);
  assert.equal(r1.status, 'complete');
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM social_media'), 130, '4 newest pages (100) + backfill pages');
  assert.equal((w.DB.raw.prepare('SELECT backfill_cursor FROM social_accounts').get() as any).backfill_cursor, null, 'history complete');
  const r2 = await sync(w);
  assert.equal(r2.status, 'complete');
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM social_media'), 130);
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM (SELECT external_media_id FROM social_media GROUP BY external_media_id HAVING COUNT(*) > 1)'), 0);
  const metricsBefore = count(w, 'SELECT COUNT(*) AS n FROM social_metrics');
  assert.equal((await sync(w)).items_new, 0);
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM social_metrics'), metricsBefore, 'unchanged figures add no history rows');
  meta.posts.unshift({ id: '18000000999', caption: 'New', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/new/', timestamp: new Date().toISOString(), like_count: 1, comments_count: 0 });
  const r4 = await sync(w);
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM social_media'), 131);
  assert.ok(r4.items_new >= 1);
});

test('T5 and "unavailable, never 0": Meta\'s own metric names; missing figures absent; story limits explained; unsupported metric asked one by one', async () => {
  const w = world();
  await connect(w);
  await sync(w);
  const list = (await call(w.env, 'mgr@iddav.com', 'GET', `${W}/instagram/media?limit=10`)).data;
  const reel = list.media.find((m: any) => m.productType === 'REELS');
  assert.deepEqual(reel.metrics.find((x: any) => x.name === 'shares'), { name: 'shares', value: null, status: 'unavailable' });
  assert.equal(reel.metrics.find((x: any) => x.name === 'reach').status, 'measured');
  const story = list.media.find((m: any) => m.productType === 'STORY');
  assert.match(story.limitation, /fewer than 5 viewers/);
  assert.ok(story.metrics.every((x: any) => x.value === null));
  const feed = list.media.find((m: any) => m.productType === 'FEED');
  assert.equal(feed.metrics.find((x: any) => x.name === 'reach').status, 'measured', 'the post still gets the metrics Meta does offer');
  assert.equal(feed.metrics.find((x: any) => x.name === 'follows').status, 'unavailable');
  assert.ok(!list.media.some((m: any) => m.metrics.some((x: any) => x.value === 0)));
  assert.equal(count(w, "SELECT COUNT(*) AS n FROM social_metrics WHERE metric = 'impressions'"), 0, 'the deprecated metric is never asked for');
  const acct = (await call(w.env, 'mgr@iddav.com', 'GET', `${W}/instagram/account-metrics?days=28`)).data;
  assert.equal(acct.days.length, 7);
  assert.deepEqual(acct.days[0].values, { reach: 300, views: 900 });
  assert.throws(() => w.DB.raw.prepare('UPDATE social_metrics SET value = 0').run(), /append-only/);
});

test('T14 and T16: rate limits are retried and recorded; a page failing part-way gives a partial run that the next run completes without duplicates', async () => {
  resetMeta(130);
  const w = world();
  await connect(w);
  meta.rate = 2;
  const a = await sync(w);
  assert.equal(a.status, 'complete'); assert.equal(a.retries.length, 2);
  const w2 = world(); resetMeta(130);
  await connect(w2);
  meta.failPage = 2; meta.failKind = 500;
  io.retryDelaysMs.splice(0, 2); // no retries for this case
  try {
    const p = await sync(w2);
    assert.equal(p.status, 'partial');
    assert.equal(count(w2, 'SELECT COUNT(*) AS n FROM social_media'), 50, 'pages 1 and 2 kept');
    const n = await sync(w2);
    assert.deepEqual([n.status, n.trigger, n.resumed_from_run_id], ['complete', 'retry', p.id]);
    assert.equal(count(w2, 'SELECT COUNT(*) AS n FROM social_media'), 125, 'continues from the saved cursor, 3 older pages per run');
    await sync(w2);
    assert.equal(count(w2, 'SELECT COUNT(*) AS n FROM social_media'), 130, 'the gap is filled');
    assert.equal((w2.DB.raw.prepare('SELECT backfill_cursor FROM social_accounts').get() as any).backfill_cursor, null);
    assert.equal(count(w2, 'SELECT COUNT(*) AS n FROM (SELECT external_media_id FROM social_media GROUP BY external_media_id HAVING COUNT(*) > 1)'), 0);
  } finally { io.retryDelaysMs.push(2000, 8000); }
});

test('T13: the sign-in is renewed once at least 24 hours old; an expiry within 7 days without renewal shows on Today', async () => {
  const w = world();
  await connect(w);
  await sync(w);
  assert.equal(meta.refreshed, null, 'too new to renew (Meta requires 24 hours)');
  w.DB.raw.prepare("UPDATE social_accounts SET token_obtained_at = '2026-01-01T00:00:00Z'").run();
  const r = await sync(w);
  assert.equal(meta.refreshed, `${TOKEN}-R`);
  assert.match(r.error_summary, /renewed for 60 days/);
  const row = w.DB.raw.prepare('SELECT * FROM social_accounts').get() as any;
  assert.deepEqual(await openBound(w.env, `ws-iddav|instagram|${ACC}`, row.token_ciphertext, row.key_version), { token: `${TOKEN}-R` });
  assert.ok(Date.parse(row.token_expires_at) > Date.now() + 59 * 86400_000);
  w.DB.raw.prepare("UPDATE social_accounts SET token_obtained_at = '2026-01-01T00:00:00Z', token_expires_at = ?").run(new Date(Date.now() + 3 * 86400_000).toISOString());
  meta.refreshFail = true;
  io.retryDelaysMs.splice(0, 2);
  try { assert.equal((await sync(w)).status, 'complete', 'a failed renewal does not stop the fetch'); } finally { io.retryDelaysMs.push(2000, 8000); }
  const today = (await call(w.env, 'owner@iddav.com', 'GET', '/v1/workspaces/ws-iddav/today')).data;
  assert.equal(today.needsYou[0].id, 'instagram');
  assert.match(today.needsYou[0].title, /expires within 7 days/);
});

test('T15 and T19: a removed permission or revoked access marks "needs reconnect", keeps history read-only, and shows on Today', async () => {
  const w = world();
  await connect(w);
  await sync(w);
  const kept = count(w, 'SELECT COUNT(*) AS n FROM social_media');
  meta.insightsPermission = false;
  const r = await sync(w);
  assert.equal(r.status, 'partial', 'posts refreshed, insights refused: never shown as complete');
  let acc = (await call(w.env, 'owner@iddav.com', 'GET', W)).data;
  assert.deepEqual([acc.status, acc.permissions.insights], ['needs_reconnect', false]);
  assert.match(acc.lastError, /permission/);
  assert.equal((await call(w.env, 'owner@iddav.com', 'GET', '/v1/workspaces/ws-iddav/today')).data.needsYou[0].id, 'instagram');
  meta.insightsPermission = true;
  await connect(w);
  meta.revoked.add(TOKEN);
  const f = await sync(w);
  assert.equal(f.status, 'failed');
  acc = (await call(w.env, 'owner@iddav.com', 'GET', W)).data;
  assert.equal(acc.status, 'needs_reconnect');
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM social_media'), kept, 'history kept');
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/instagram/disconnect`)).data.status, 'revoked');
  assert.equal((w.DB.raw.prepare('SELECT token_ciphertext FROM social_accounts').get() as any).token_ciphertext, null);
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/instagram/sync`)).status, 409);
  assert.equal((await call(w.env, 'mgr@iddav.com', 'GET', `${W}/instagram/media?limit=100`)).data.media.length, kept, 'still readable');
});

test('T18: a run killed mid-way is marked failed and the next run carries on', async () => {
  const w = world();
  await connect(w);
  w.DB.raw.prepare("INSERT INTO sync_runs (id, workspace_id, connector, started_at, trigger, status) VALUES ('stuck','ws-iddav','instagram','2026-11-01T00:00:00Z','manual','running')").run();
  const r = await sync(w);
  assert.deepEqual([r.status, r.resumed_from_run_id], ['complete', 'stuck']);
  assert.match((w.DB.raw.prepare("SELECT error_summary FROM sync_runs WHERE id = 'stuck'").get() as any).error_summary, /Interrupted/);
});

test('T9 and T21: other brands get 404; the scheduler keeps each brand\'s account and rows apart', async () => {
  const w = world();
  await connect(w);
  await call(w.env, 'ad@x.com', 'POST', '/v1/workspaces/ws-antardrishti/social/instagram/connect', { token: TOKEN_AD, expectedUsername: 'antardrishti' });
  for (const [m, p] of [['GET', W], ['GET', `${W}/instagram/media`], ['GET', `${W}/instagram/account-metrics`], ['GET', `${W}/runs`], ['POST', `${W}/instagram/sync`], ['POST', `${W}/instagram/test`], ['POST', `${W}/instagram/disconnect`]])
    assert.equal((await call(w.env, 'ad@x.com', m, p)).status, 404, `${m} ${p}`);
  const waits: Promise<unknown>[] = [];
  await (worker as any).scheduled({}, w.env, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
  const byWs = w.DB.raw.prepare('SELECT a.workspace_id AS a, m.workspace_id AS m, COUNT(*) AS n FROM social_media m JOIN social_accounts a ON a.id = m.account_id GROUP BY 1, 2').all() as any[];
  assert.ok(byWs.length === 2 && byWs.every((x) => x.a === x.m), JSON.stringify(byWs));
  assert.deepEqual((w.DB.raw.prepare("SELECT DISTINCT workspace_id FROM sync_runs WHERE trigger = 'schedule' ORDER BY 1").all() as any[]).map((x) => x.workspace_id), ['ws-antardrishti', 'ws-iddav']);
});

test('T1-T12 connection test on the real account produces a redacted report; T10: the token appears nowhere; T12: every Instagram call is a GET', async () => {
  resetMeta(30);
  const w = world();
  await connect(w);
  await sync(w);
  const t = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/instagram/test`)).data;
  const by = Object.fromEntries(t.checks.map((c: any) => [c.id, c.result]));
  assert.deepEqual(by, { T1: 'pass', T2: 'pass', T3: 'pass', T4: 'pass', T5: 'pass', T6: 'pass', T7: 'pass', T8: 'pass', T9: 'pass', T10: 'pass', T11: 'pass', T12: 'pass' });
  assert.equal(t.passed, 12);
  assert.equal((await call(w.env, 'mgr@iddav.com', 'POST', `${W}/instagram/test`)).status, 403);
  const everything = JSON.stringify([t, (await call(w.env, 'owner@iddav.com', 'GET', W)).data, (await call(w.env, 'owner@iddav.com', 'GET', `${W}/runs`)).data,
    (await call(w.env, 'owner@iddav.com', 'GET', `${W}/instagram/media?limit=100`)).data, w.DB.raw.prepare('SELECT * FROM sync_runs').all()]);
  assert.ok(!everything.includes('SECRET'), 'no token anywhere');
  assert.ok(meta.calls.every((c) => c.method === 'GET' && c.url.startsWith('https://graph.instagram.com/')), 'read-only');
  meta.revoked.add(TOKEN);
  const bad = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/instagram/test`)).data;
  assert.equal(bad.checks.find((c: any) => c.id === 'T1').result, 'fail');
  assert.ok(!JSON.stringify(bad).includes('SECRET'), 'Meta echoed the token in its error; the report hides it');
});

test('key rotation re-encrypts Instagram tokens too, verified, and the old key can then be removed', async () => {
  const w = world();
  await connect(w);
  const env2 = { ...w.env, CONNECTIONS_KEY_V2: KEY2 };
  const r = await call(env2, 'owner@iddav.com', 'POST', '/v1/admin/google/rotate-keys');
  assert.deepEqual([r.data.reEncrypted, r.data.failed], [1, 0]);
  const env3 = { ...env2, CONNECTIONS_KEY: undefined };
  assert.equal((await call(env3, 'owner@iddav.com', 'POST', `${W}/instagram/sync`)).data.status, 'complete');
});
