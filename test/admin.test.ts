// IMI ONE round 4: Brand settings: members, Brand Facts, profile, AI services, activity.
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
    VALUES ('r1', 'INT-0001', 'x', 'evidence', 'Founder story', 'open', '2026-11-01', '2026-11-01', 'seed', 'owner_admin', '{}', 'provisional', 'ws-iddav')`);
  return { DB, POSTERS: { put: async () => {}, get: async () => null }, ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined } as any;
}
const call = async (env: any, who: string, method: string, path: string, body?: unknown) => {
  const r = await createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) as any };
};
const W = '/v1/workspaces/ws-iddav';

test('members: owners only; added people can sign in to the brand; removed people cannot', async () => {
  const env = world();
  assert.equal((await call(env, CREATOR, 'GET', `${W}/members`)).status, 403);
  assert.equal((await call(env, OWNER, 'POST', `${W}/members`, { email: 'not-an-email', role: 'viewer' })).status, 400);
  assert.equal((await call(env, OWNER, 'POST', `${W}/members`, { email: 'x@y.com', role: 'king' })).status, 400);
  const added = await call(env, OWNER, 'POST', `${W}/members`, { email: 'Shail@Iddav.com', role: 'manager' });
  assert.deepEqual([added.status, added.data.email], [201, 'shail@iddav.com'], 'stored lower-case');
  assert.equal((await call(env, OWNER, 'POST', `${W}/members`, { email: 'shail@iddav.com', role: 'viewer' })).status, 409);
  assert.deepEqual((await call(env, 'shail@iddav.com', 'GET', '/v1/workspaces')).data.map((w: any) => w.id), ['ws-iddav']);
  await call(env, OWNER, 'POST', `${W}/members/${added.data.id}/role`, { role: 'viewer' });
  assert.equal((await call(env, 'shail@iddav.com', 'GET', '/v1/me')).data.roles['ws-iddav'], 'viewer');
  await call(env, OWNER, 'POST', `${W}/members/${added.data.id}/revoke`);
  assert.equal((await call(env, 'shail@iddav.com', 'GET', `${W}/today`)).status, 404, 'removed: locked out at once');
  const log = env.DB.raw.prepare('SELECT actor, subject_email, change FROM member_events ORDER BY created_at, rowid').all();
  assert.deepEqual(log.map((l: any) => l.change), ['added:manager', 'role:manager->viewer', 'revoked']);
  assert.ok(log.every((l: any) => l.actor === OWNER));
  assert.throws(() => env.DB.raw.exec('DELETE FROM member_events'), /append-only/);
});

test('members: a brand never loses its last owner', async () => {
  const env = world();
  assert.equal((await call(env, OWNER, 'POST', `${W}/members/m1/role`, { role: 'manager' })).status, 409);
  assert.equal((await call(env, OWNER, 'POST', `${W}/members/m1/revoke`)).status, 409);
  await call(env, OWNER, 'POST', `${W}/members`, { email: 'second@iddav.com', role: 'owner' });
  assert.equal((await call(env, OWNER, 'POST', `${W}/members/m1/role`, { role: 'manager' })).status, 200, 'fine once another owner exists');
  assert.equal((await call(env, AD_OWNER, 'POST', '/v1/workspaces/ws-antardrishti/members/m2/revoke')).status, 404, 'other brands cannot touch these members');
});

test('Brand Facts: owners add and retire; every prompt carries them, wrong forms included', async () => {
  const env = world();
  assert.equal((await call(env, CREATOR, 'POST', `${W}/brand-facts`, { statement: 'Something true here' })).status, 403);
  const f = await call(env, OWNER, 'POST', `${W}/brand-facts`, { statement: 'The founder has 27 years of total experience, 5 of them in the forest at Sri Antra.', wrongForms: ['27 years in the forest'] });
  assert.equal(f.status, 201);
  assert.equal((await call(env, CREATOR, 'GET', `${W}/brand-facts`)).data.length, 1, 'everyone in the brand can read the facts');
  const prov = (await call(env, OWNER, 'GET', `${W}/ai-providers`)).data[0];
  const p = await call(env, CREATOR, 'POST', `${W}/records/r1/prompt`, { providerId: prov.id });
  assert.ok(p.data.prompt.includes('BRAND FACTS') && p.data.prompt.includes('5 of them in the forest') && p.data.prompt.includes('Never write: "27 years in the forest"'));
  await call(env, OWNER, 'POST', `${W}/brand-facts/${f.data.id}/retire`);
  assert.deepEqual((await call(env, OWNER, 'GET', `${W}/brand-facts`)).data, []);
  assert.equal((await call(env, AD_OWNER, 'GET', '/v1/workspaces/ws-antardrishti/brand-facts')).data.length, 0, 'facts belong to one brand');
});

test('profile: owners edit description, headline limit and feed subject; the Tadoba area is kept', async () => {
  const env = world();
  assert.equal((await call(env, CREATOR, 'POST', `${W}/profile`, { description: 'x' })).status, 403);
  assert.equal((await call(env, OWNER, 'POST', `${W}/profile`, { maxHeadlineWords: 99 })).status, 400);
  const p = await call(env, OWNER, 'POST', `${W}/profile`, { description: 'Eco-lodge in the Tadoba buffer zone.', maxHeadlineWords: 10, feedQuery: 'Panthera pardus', newsKeywords: ['Leopard', 'tadoba'] });
  assert.deepEqual([p.data.description, p.data.maxHeadlineWords, p.data.feedQuery, p.data.newsKeywords], ['Eco-lodge in the Tadoba buffer zone.', 10, 'Panthera pardus', ['leopard', 'tadoba']]);
  assert.match(p.data.area, /60 km around 20.2167, 79.3667/, 'location settings untouched');
});

test('AI services can be switched off; a switched-off service cannot be used', async () => {
  const env = world();
  const prov = (await call(env, OWNER, 'GET', `${W}/ai-providers`)).data[0];
  assert.equal((await call(env, CREATOR, 'POST', `${W}/ai-providers/${prov.id}/toggle`, { enabled: false })).status, 403);
  await call(env, OWNER, 'POST', `${W}/ai-providers/${prov.id}/toggle`, { enabled: false });
  assert.equal((await call(env, OWNER, 'POST', `${W}/records/r1/prompt`, { providerId: prov.id })).status, 400);
});

test('activity: decisions, AI hand-offs and member changes in one list, owners only, one brand', async () => {
  const env = world();
  await call(env, OWNER, 'POST', `${W}/records/r1/decision`, { choice: 'monitor', reason: 'watch it', requestId: 'req-act-00001' });
  const prov = (await call(env, OWNER, 'GET', `${W}/ai-providers`)).data[0];
  await call(env, OWNER, 'POST', `${W}/records/r1/prompt`, { providerId: prov.id });
  await call(env, OWNER, 'POST', `${W}/members`, { email: 'new@iddav.com', role: 'viewer' });
  const a = await call(env, OWNER, 'GET', `${W}/activity`);
  assert.deepEqual([...new Set(a.data.map((x: any) => x.kind))].sort(), ['ai', 'decision', 'member']);
  assert.equal((await call(env, CREATOR, 'GET', `${W}/activity`)).status, 403);
  assert.equal((await call(env, AD_OWNER, 'GET', `${W}/activity`)).status, 404);
});
