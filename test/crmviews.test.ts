// IMI ONE round 7: CRM views; scope from the verified role, filtering done by the CRM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/index.ts';
import { makeD1 } from './helpers/d1.ts';

function world() {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  for (const [id, ws, email, role] of [['m1', 'ws-iddav', 'owner@iddav.com', 'owner'], ['m2', 'ws-iddav', 'mgr@iddav.com', 'manager'], ['m3', 'ws-iddav', 'sales@iddav.com', 'sales'],
    ['m4', 'ws-iddav', 'creator@iddav.com', 'creator'], ['m5', 'ws-antardrishti', 'ad@x.com', 'owner']])
    run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, 'tnt-rama', ?, ?, ?, 'seed', '2026-11-01')", id, ws, email, role);
  const seen: string[] = [];
  const CRM_SERVICE = { fetch: async (_u: string, init?: RequestInit) => { const h = new Headers(init?.headers); seen.push(`${h.get('x-imi-feed-key')}|${h.get('x-imi-scope') ?? ''}`); return new Response(JSON.stringify({ stages: [{ status: 'new', n: 2 }], open: [] })); } };
  return { env: { DB, CRM_URL: 'https://crm.internal', CRM_SERVICE_KEY: 'feed', CRM_SERVICE, CRM_PUBLIC_URL: 'https://crm.example', ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined } as any, seen };
}
const get = (env: any, who: string, ws = 'ws-iddav') => createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787/v1/workspaces/${ws}/crm/pipeline`), env).then(async (r) => ({ status: r.status, data: await r.json() as any }));

test('the scope sent to the CRM follows the verified role: owner money+margin, manager money, sales none', async () => {
  const { env, seen } = world();
  const o = await get(env, 'owner@iddav.com');
  assert.deepEqual([o.status, o.data.crmUrl, o.data.source], [200, 'https://crm.example', 'Iddav CRM']);
  await get(env, 'mgr@iddav.com'); await get(env, 'sales@iddav.com');
  assert.deepEqual(seen, ['feed|money,margin', 'feed|money', 'feed|']);
});

test('people without results permission, other brands and brands without a CRM are refused', async () => {
  const { env, seen } = world();
  assert.equal((await get(env, 'creator@iddav.com')).status, 403);
  assert.equal((await get(env, 'ad@x.com')).status, 404);
  assert.equal((await get(env, 'ad@x.com', 'ws-antardrishti')).status, 404, 'Antardrishti has no CRM');
  assert.deepEqual(seen, [], 'the CRM was never asked');
});
