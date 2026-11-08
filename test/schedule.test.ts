// IMI ONE round 3: schedule an approved draft, the calendar, Today reminders, outcomes on posted drafts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/index.ts';
import { makeD1 } from './helpers/d1.ts';

const OWNER = 'rama@iddav.com', CREATOR = 'writer@iddav.com', AD_OWNER = 'owner@antardrishti.com';
function world() {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  const m = (id: string, ws: string, email: string, role: string) => run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, 'tnt-rama', ?, ?, ?, 'seed', '2026-11-01')", id, ws, email, role);
  m('m1', 'ws-iddav', OWNER, 'owner'); m('m2', 'ws-iddav', CREATOR, 'creator'); m('m3', 'ws-antardrishti', AD_OWNER, 'owner');
  run(`INSERT INTO intelligence_records (id, code, domain, record_type, title, status, created_at, updated_at, author, author_role, observation_json, learning_strength, workspace_id)
    VALUES ('r1', 'INT-0001', 'x', 'evidence', 'Winter dates demand', 'open', '2026-11-01', '2026-11-01', 'seed', 'owner_admin', '{}', 'provisional', 'ws-iddav')`);
  return { DB, POSTERS: { put: async () => {}, get: async () => null }, ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined } as any;
}
const call = async (env: any, who: string, method: string, path: string, body?: unknown) => {
  const r = await createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) as any };
};
const W = '/v1/workspaces/ws-iddav';
const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();
async function approvedDraft(env: any) {
  await call(env, OWNER, 'POST', `${W}/records/r1/decision`, { choice: 'create_content', reason: 'demand is clear', requestId: 'req-sched-0001' });
  const d = (await call(env, CREATOR, 'POST', `${W}/drafts`, { recordId: 'r1', headline: 'Which winter dates are left?', caption: 'Five weekends remain.' })).data;
  await call(env, OWNER, 'POST', `${W}/drafts/${d.id}/approve`, { version: 1 });
  return d.id as string;
}

test('scheduling: approved drafts only, a future time within a year, a known channel, owners only', async () => {
  const env = world();
  const unapproved = (await call(env, CREATOR, 'POST', `${W}/drafts`, { headline: 'Not yet', caption: 'Waiting' })).data;
  assert.equal((await call(env, OWNER, 'POST', `${W}/drafts/${unapproved.id}/schedule`, { when: inDays(2), channel: 'Instagram' })).status, 409);
  const id = await approvedDraft(env);
  assert.equal((await call(env, CREATOR, 'POST', `${W}/drafts/${id}/schedule`, { when: inDays(2), channel: 'Instagram' })).status, 403);
  assert.equal((await call(env, OWNER, 'POST', `${W}/drafts/${id}/schedule`, { when: inDays(-1), channel: 'Instagram' })).status, 400);
  assert.equal((await call(env, OWNER, 'POST', `${W}/drafts/${id}/schedule`, { when: inDays(400), channel: 'Instagram' })).status, 400);
  assert.equal((await call(env, OWNER, 'POST', `${W}/drafts/${id}/schedule`, { when: inDays(2), channel: 'MySpace' })).status, 400);
  const ok = await call(env, OWNER, 'POST', `${W}/drafts/${id}/schedule`, { when: inDays(2), channel: 'Instagram' });
  assert.equal(ok.status, 200);
  const target = inDays(5).slice(0, 10);
  const moved = await call(env, OWNER, 'POST', `${W}/drafts/${id}/schedule`, { date: target });
  assert.deepEqual([moved.data.scheduledFor.slice(0, 10), moved.data.scheduledFor.slice(11, 16), moved.data.channel], [target, ok.data.scheduledFor.slice(11, 16), 'Instagram'], 'moving keeps the time and channel');
  const today = (await call(env, OWNER, 'GET', `${W}/today`)).data;
  assert.deepEqual(today.upcoming.map((u: any) => [u.title, u.state, u.channels[0]]), [['Which winter dates are left?', 'manual', 'instagram']]);
  await call(env, CREATOR, 'POST', `${W}/drafts/${id}/edit`, { caption: 'Four weekends remain.' });
  const row = env.DB.raw.prepare('SELECT status, scheduled_for FROM drafts WHERE id = ?').get(id);
  assert.deepEqual({ ...row }, { status: 'draft', scheduled_for: null }, 'editing clears approval and schedule');
});

test('calendar: the month shows scheduled posts (you post these) and posted ones', async () => {
  const env = world();
  const a = await approvedDraft(env);
  const when = inDays(3);
  await call(env, OWNER, 'POST', `${W}/drafts/${a}/schedule`, { when, channel: 'Facebook' });
  const b = (await call(env, CREATOR, 'POST', `${W}/drafts`, { headline: 'Posted one', caption: 'Live already' })).data.id;
  await call(env, OWNER, 'POST', `${W}/drafts/${b}/approve`, { version: 1 });
  await call(env, OWNER, 'POST', `${W}/drafts/${b}/posted`, { url: 'https://instagram.com/p/1', channel: 'Instagram' });
  const month = when.slice(0, 7);
  const cal = (await call(env, OWNER, 'GET', `${W}/calendar?month=${month}`)).data;
  const states = Object.fromEntries(cal.posts.map((p: any) => [p.title, p.state]));
  assert.equal(states['Which winter dates are left?'], 'manual');
  if (new Date().toISOString().slice(0, 7) === month) assert.equal(states['Posted one'], 'published');
  assert.equal((await call(env, OWNER, 'GET', `${W}/calendar?month=nov`)).status, 400);
  assert.deepEqual((await call(env, AD_OWNER, 'GET', `/v1/workspaces/ws-antardrishti/calendar?month=${month}`)).data.posts, [], 'other brands see nothing');
});

test('Today: a scheduled post that is due asks to be posted', async () => {
  const env = world();
  const id = await approvedDraft(env);
  await call(env, OWNER, 'POST', `${W}/drafts/${id}/schedule`, { when: inDays(1), channel: 'Instagram' });
  env.DB.raw.prepare('UPDATE drafts SET scheduled_for = ? WHERE id = ?').run(inDays(-0.01), id);
  const t = (await call(env, OWNER, 'GET', `${W}/today`)).data;
  assert.ok(t.needsYou.some((n: any) => n.id === `due-${id}` && n.action.label === 'Post it now'));
});

test('outcomes: only for posted drafts, linked to the record decision, once per post; Today asks a week after posting', async () => {
  const env = world();
  const id = await approvedDraft(env);
  assert.equal((await call(env, CREATOR, 'POST', `${W}/drafts/${id}/outcome`, { summary: 'x y z', confidence: 'low', reason: 'too early' })).status, 409, 'not before posting');
  await call(env, OWNER, 'POST', `${W}/drafts/${id}/posted`, { url: 'https://instagram.com/p/2', channel: 'Instagram' });
  env.DB.raw.prepare("UPDATE drafts SET posted_at = datetime('now', '-8 days') WHERE id = ?").run(id);
  let t = (await call(env, OWNER, 'GET', `${W}/today`)).data;
  assert.ok(t.needsYou.some((n: any) => n.id === `results-${id}` && n.kind === 'review_learning'), 'reminder after a week');
  assert.equal((await call(env, CREATOR, 'POST', `${W}/drafts/${id}/outcome`, { summary: 'Six enquiries mentioned it', confidence: 'certain', reason: 'they said so' })).status, 400);
  assert.equal((await call(env, CREATOR, 'POST', `${W}/drafts/${id}/outcome`, { summary: 'Six enquiries mentioned it', confidence: 'medium', reason: 'they said so', enquiries: -1 })).status, 400);
  const o = await call(env, CREATOR, 'POST', `${W}/drafts/${id}/outcome`, { summary: 'Six enquiries mentioned the post', confidence: 'medium', reason: 'Guests quoted the caption', reach: 2400, enquiries: 6 });
  assert.equal(o.status, 201);
  assert.match(o.data.decisionCode, /^DEC-/, 'linked to the decision that led to the post');
  assert.equal((await call(env, CREATOR, 'POST', `${W}/drafts/${id}/outcome`, { summary: 'again', confidence: 'low', reason: 'dup' })).status, 409);
  const out = (await call(env, OWNER, 'GET', `${W}/outcomes`)).data;
  assert.deepEqual([out.length, out[0].evaluator, out[0].decision_code], [1, CREATOR, o.data.decisionCode]);
  t = (await call(env, OWNER, 'GET', `${W}/today`)).data;
  assert.ok(!t.needsYou.some((n: any) => n.id === `results-${id}`), 'the reminder goes once results are in');
  assert.equal((await call(env, AD_OWNER, 'POST', `/v1/workspaces/ws-antardrishti/drafts/${id}/outcome`, { summary: 'x y z', confidence: 'low', reason: 'x y z' })).status, 404);
});
