// IMI ONE round 12: season and demand calendar (design 4.5 g) and the four-week baseline (4.5 h).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/index.ts';
import worker from '../src/index.ts';
import { seasonReminders, takeSnapshot, weeklySnapshots, baseline } from '../src/season.ts';
import { makeD1 } from './helpers/d1.ts';

function world() {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  for (const [id, ws, email, role] of [['m1', 'ws-iddav', 'owner@iddav.com', 'owner'], ['m2', 'ws-iddav', 'creator@iddav.com', 'creator'], ['m3', 'ws-antardrishti', 'ad@x.com', 'owner']])
    run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, 'tnt-rama', ?, ?, ?, 'seed', '2026-11-01')", id, ws, email, role);
  return { DB, env: { DB } as any };
}
async function call(env: any, who: string, method: string, path: string, body?: unknown) {
  const r = await createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: r.status, data: await r.json() as any };
}
const W = '/v1/workspaces/ws-iddav';
const plus = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

test('season dates: owners add them with a source; validation; creators and other brands cannot change them', async () => {
  const w = world();
  const ok = await call(w.env, 'owner@iddav.com', 'POST', `${W}/events`, { title: 'Core zone closes for monsoon', kind: 'closure', startDate: '2027-07-01', endDate: '2027-09-30', source: 'Tadoba official notice, 2027' });
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.data[0].title, ok.data[0].source, ok.data[0].remindDays], ['Core zone closes for monsoon', 'Tadoba official notice, 2027', [30, 14, 7]]);
  for (const bad of [{ title: 'x', kind: 'closure', startDate: '2027-07-01' }, { title: 'Holiday', kind: 'party', startDate: '2027-07-01' }, { title: 'Holiday', kind: 'holiday', startDate: '01-07-2027' },
    { title: 'Holiday', kind: 'holiday', startDate: '2027-07-05', endDate: '2027-07-01' }])
    assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/events`, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call(w.env, 'creator@iddav.com', 'POST', `${W}/events`, { title: 'Diwali', kind: 'holiday', startDate: '2027-10-29' })).status, 403);
  assert.equal((await call(w.env, 'creator@iddav.com', 'GET', `${W}/events`)).data.length, 1, 'everyone in the brand can read them');
  for (const [m, p] of [['GET', `${W}/events`], ['POST', `${W}/events`], ['POST', `${W}/events/${ok.data[0].id}/retire`]])
    assert.equal((await call(w.env, 'ad@x.com', m, p, m === 'POST' ? { title: 'x', kind: 'other', startDate: '2027-01-01' } : undefined)).status, 404);
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/events/${ok.data[0].id}/retire`)).data.length, 0);
});

test('reminders follow the 30/14/7 steps, end on the day, and skip retired or far dates', async () => {
  const w = world();
  const add = (title: string, d: string, kind = 'season') => call(w.env, 'owner@iddav.com', 'POST', `${W}/events`, { title, kind, startDate: d });
  await add('Safari season opens', '2026-10-21'); await add('Long weekend', '2026-10-07', 'long_weekend'); await add('Diwali', '2026-10-03', 'holiday'); await add('Far away', '2026-12-20');
  const r = await seasonReminders(w.env, 'ws-iddav', '2026-10-01');
  assert.deepEqual(r.map((x: any) => x.title), ['Diwali: in 2 days', 'Long weekend: in 6 days', 'Safari season opens: in 20 days']);
  assert.match(r[0].why, /\(7-day reminder\)/); assert.match(r[2].why, /\(30-day reminder\)/);
  assert.equal((await seasonReminders(w.env, 'ws-iddav', '2026-10-03'))[0].title, 'Diwali: today');
  assert.equal((await seasonReminders(w.env, 'ws-antardrishti', '2026-10-01')).length, 0, 'another brand sees none');
  await add('Soon', plus(5));
  const today = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/today`)).data;
  assert.ok(today.needsYou.some((n: any) => n.kind === 'prepare_season' && n.title === 'Soon: in 5 days'));
});

test('the calendar includes the dates that overlap its month', async () => {
  const w = world();
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/events`, { title: 'Core zone closed', kind: 'closure', startDate: '2027-07-01', endDate: '2027-09-30' });
  assert.equal((await call(w.env, 'owner@iddav.com', 'GET', `${W}/calendar?month=2027-08`)).data.events.length, 1);
  assert.equal((await call(w.env, 'owner@iddav.com', 'GET', `${W}/calendar?month=2027-10`)).data.events.length, 0);
});

test('Today shows a broken Google connection with the kind the app draws (fix_connection)', async () => {
  const w = world();
  w.DB.raw.prepare("INSERT INTO google_connections (id, workspace_id, connector, status, last_error, updated_at) VALUES ('g1','ws-iddav','search_console','needs_reconnect','Reconnect.','2026-11-20')").run();
  const t = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/today`)).data;
  assert.equal(t.needsYou[0].kind, 'fix_connection');
});

test('baseline: started once by an owner; one snapshot per week, kept as taken; comparison only when complete, never guessed', async () => {
  const w = world();
  assert.equal((await call(w.env, 'creator@iddav.com', 'POST', `${W}/baseline/start`, {})).status, 403);
  w.DB.raw.prepare("INSERT INTO baselines (workspace_id, started_at, started_by, weeks) VALUES ('ws-iddav', '2026-10-01T09:00:00Z', 'owner@iddav.com', 4)").run();
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/baseline/start`, {})).status, 409, 'never restarted');
  // Search Console figures for five weeks (Mon 28 Sep to Sun 1 Nov 2026).
  for (let i = 0; i < 35; i++) {
    const d = new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10);
    w.DB.raw.prepare("INSERT INTO search_daily (workspace_id, date, impressions, clicks, position, run_id, retrieved_at) VALUES ('ws-iddav', ?, ?, ?, 5, 'r', 'x')").run(d, 100 + Math.floor(i / 7) * 70, 10);
  }
  const mondays = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'].map((d) => new Date(`${d}T03:15:00Z`));
  for (const m of mondays.slice(0, 2)) assert.equal((await takeSnapshot(w.env, 'ws-iddav', null, m)).taken, true);
  assert.equal((await takeSnapshot(w.env, 'ws-iddav', null, mondays[1])).taken, false, 'a week is taken once');
  let b = await baseline(w.env, 'ws-iddav');
  assert.deepEqual([b.collected, b.ready, b.comparison], [1, false, null], 'the week before the start does not count');
  assert.equal((await weeklySnapshots(w.env, new Date('2026-10-14T03:15:00Z'))).length, 0, 'only on Mondays');
  for (const m of mondays.slice(2)) await weeklySnapshots(w.env, m);
  b = await baseline(w.env, 'ws-iddav');
  assert.deepEqual([b.collected, b.ready], [4, true]);
  const search = b.comparison!.find((c: any) => c.stage === 'search')!;
  assert.deepEqual([search.baselineWeeklyAverage, search.latestWeek, search.weeksAfter], [1925, null, 0], 'whole weeks from Mon 5 Oct: (1190 + 1680 + 2170 + 2660) / 4');
  const enq = b.comparison!.find((c: any) => c.stage === 'enquiries')!;
  assert.equal(enq.baselineWeeklyAverage, null, 'no CRM here: unavailable, not 0');
  assert.throws(() => w.DB.raw.prepare("UPDATE funnel_snapshots SET figures_json = '{}'").run(), /kept as taken/);
  const api = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/baseline`)).data;
  assert.match(api.caveat, /Monday enquiry/);
  assert.equal((await call(w.env, 'ad@x.com', 'GET', `${W}/baseline`)).status, 404);
});

test('the scheduled run takes Monday snapshots after the fetches', async () => {
  const w = world();
  w.DB.raw.prepare("INSERT INTO baselines (workspace_id, started_at, started_by, weeks) VALUES ('ws-iddav', '2026-01-01T00:00:00Z', 'o', 4)").run();
  const waits: Promise<unknown>[] = [];
  await (worker as any).scheduled({}, w.env, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
  const n = (w.DB.raw.prepare('SELECT COUNT(*) AS n FROM funnel_snapshots').get() as any).n;
  assert.equal(n, new Date().getUTCDay() === 1 ? 1 : 0);
});
