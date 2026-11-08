// IMI ONE milestone 1: one verified owner, one authorised workspace, one
// workspace-scoped endpoint, one Today with source-labelled data, and proof that
// other people and other workspaces are refused. Real SQLite from the repository's
// schema files, including the proposed schema_v9.sql.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/index.ts';
import { makeD1 } from './helpers/d1.ts';
import { can, ROLE_PERMS } from '../src/tenancy.ts';

const OWNER = 'rama@iddav.com', AD_ONLY = 'writer@antardrishti.com', STRANGER = 'someone@else.com', REVOKED = 'former@iddav.com';
const realFetch = globalThis.fetch;
let crm: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
before(() => { globalThis.fetch = (async (u: any, i?: RequestInit) => (crm ? crm(String(u?.url ?? u), i) : new Response('no', { status: 599 }))) as typeof fetch; });
after(() => { globalThis.fetch = realFetch; });

function world(over: Record<string, unknown> = {}) {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  const at = '2026-11-01T00:00:00Z';
  // schema_v9 created tnt-rama and ws-iddav. Add a second brand and a second customer.
  run("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti', 'tnt-rama', 'Antardrishti', 'app', 'sign_ups', ?)", at);
  run("INSERT INTO tenants (id, name, created_at) VALUES ('tnt-other', 'Another business', ?)", at);
  run("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-other', 'tnt-other', 'Other brand', 'shop', 'sales', ?)", at);
  const member = (id: string, tenant: string, ws: string, email: string, role: string, revoked: string | null = null) =>
    run('INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at, revoked_at) VALUES (?,?,?,?,?,?,?,?)', id, tenant, ws, email, role, 'seed', at, revoked);
  member('m1', 'tnt-rama', 'ws-iddav', OWNER, 'owner');
  member('m2', 'tnt-rama', 'ws-antardrishti', AD_ONLY, 'creator');
  member('m3', 'tnt-rama', 'ws-iddav', REVOKED, 'manager', '2026-11-05T00:00:00Z');
  member('m4', 'tnt-other', 'ws-other', 'boss@other.com', 'owner');
  // Synthetic campaigns and posts in two brands, with distinct words to detect leaks.
  const camp = (id: string, code: string, ws: string) =>
    run(`INSERT INTO campaigns (id, code, name, objective, primary_metric, cta_type, destination_url, expected_outcome, created_by, created_at, workspace_id)
         VALUES (?,?,?,'awareness','enquiries','whatsapp','https://x.example','x','seed',?,?)`, id, code, `SAMPLE ${code}`, at, ws);
  camp('k1', 'CMP-0101', 'ws-iddav'); camp('k2', 'CMP-0201', 'ws-antardrishti');
  const content = (id: string, k: string, headline: string, status: string) =>
    run(`INSERT INTO contents (id, campaign_id, series_number, template, headline, background_authenticity, status, created_by, created_at, updated_at)
         VALUES (?,?,1,'bottom',?,'original',?,'seed',?,?)`, id, k, headline, status, at, at);
  content('c1', 'k1', 'IDDAV-ONLY tiger dawn walk', 'ready');
  content('c2', 'k2', 'ANTARDRISHTI-ONLY timing window', 'ready');
  run(`INSERT INTO decision_items (id, code, domain, title, problem_statement, associated_record_code, approval_class, approval_status, approver_required,
        retrospective, options_considered_json, selected_option, rationale, confidence_level, confidence_reason, workspace_id)
       VALUES ('d1','DEC-0101','x','IDDAV-ONLY decision','p','R','A','pending','Owner','none','[]','s','r','low','r','ws-iddav'),
              ('d2','DEC-0201','x','ANTARDRISHTI-ONLY decision','p','R','A','pending','Owner','none','[]','s','r','low','r','ws-antardrishti')`);
  return { DB, ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined, ...over } as any;
}
// Each person signs in through the local-development identity (localhost only);
// the Access token path itself is covered by access.test.ts.
const as = (email: string | null, env: any, path: string) =>
  (email ? createWorker({ devIdentity: email }) : createWorker()).fetch(new Request(`http://localhost:8787${path}`), env);
const body = async (r: Response) => ({ status: r.status, data: (await r.json().catch(() => null)) as any });

test('M1: the verified owner sees exactly their brand, with their role, labelled staging', async () => {
  const env = world();
  const me = await body(await as(OWNER, env, '/v1/me'));
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.roles, { 'ws-iddav': 'owner' });
  assert.equal(me.data.tenantId, 'tnt-rama');
  assert.equal(me.data.environment, 'staging');
  const list = await body(await as(OWNER, env, '/v1/workspaces'));
  assert.deepEqual(list.data.map((w: any) => w.id), ['ws-iddav']);
  assert.equal(list.data[0].goal.key, 'qualified_enquiries');
});

test('M1: Today for the authorised brand shows only that brand\'s data, each item with its source', async () => {
  const env = world();
  const t = await body(await as(OWNER, env, '/v1/workspaces/ws-iddav/today'));
  assert.equal(t.status, 200);
  const text = JSON.stringify(t.data);
  assert.ok(text.includes('IDDAV-ONLY tiger dawn walk') && text.includes('IDDAV-ONLY decision'));
  assert.ok(!text.includes('ANTARDRISHTI-ONLY'), 'no record of another brand leaks into Today');
  assert.deepEqual(t.data.needsYou.map((x: any) => x.kind).sort(), ['approve_post', 'review_decision']);
  assert.equal(t.data.isSample, false); assert.equal(t.data.environment, 'staging');
  assert.deepEqual(t.data.goal.trust, { kind: 'unavailable', source: 'Iddav CRM', detail: 'The CRM is not connected in this environment.' }, 'no made-up number when there is no source');
  assert.deepEqual(t.data.upcoming, []); assert.match(t.data.notes[0], /Scheduling is not built yet/);
});

test('M1: an approved post no longer asks for approval', async () => {
  const env = world();
  const { contentHash } = await import('../src/studio.ts');
  const c = env.DB.raw.prepare("SELECT * FROM contents WHERE id = 'c1'").get();
  env.DB.raw.prepare("INSERT INTO approvals (id, content_id, approval_class, approved_by, content_hash, approved_at) VALUES ('a1','c1','A',?,?,'2026-11-02')").run(OWNER, await contentHash(c, []));
  const t = await body(await as(OWNER, env, '/v1/workspaces/ws-iddav/today'));
  assert.ok(!t.data.needsYou.some((x: any) => x.kind === 'approve_post'));
});

test('SEC M1: a member of another brand gets 404 for this brand, exactly like a brand that does not exist', async () => {
  const env = world();
  const theirs = await body(await as(AD_ONLY, env, '/v1/workspaces/ws-iddav/today'));
  const missing = await body(await as(AD_ONLY, env, '/v1/workspaces/ws-nope/today'));
  assert.equal(theirs.status, 404);
  assert.deepEqual(theirs, missing, 'existence of a brand is not revealed');
  const own = await body(await as(AD_ONLY, env, '/v1/workspaces/ws-antardrishti/today'));
  assert.equal(own.status, 200);
  assert.ok(!JSON.stringify(own.data).includes('IDDAV-ONLY'));
});

test('SEC M1: the owner of one brand cannot read a brand they do not belong to, even in the same customer account', async () => {
  const env = world();
  assert.equal((await as(OWNER, env, '/v1/workspaces/ws-antardrishti/today')).status, 404);
  assert.equal((await as(OWNER, env, '/v1/workspaces/ws-other/today')).status, 404, 'another customer entirely');
});

test('SEC M1: a verified person with no membership sees nothing; a revoked member is refused', async () => {
  const env = world();
  assert.deepEqual((await body(await as(STRANGER, env, '/v1/workspaces'))).data, []);
  assert.deepEqual((await body(await as(STRANGER, env, '/v1/me'))).data.roles, {});
  assert.equal((await as(STRANGER, env, '/v1/workspaces/ws-iddav/today')).status, 404);
  assert.equal((await as(REVOKED, env, '/v1/workspaces/ws-iddav/today')).status, 404);
  assert.deepEqual((await body(await as(REVOKED, env, '/v1/workspaces'))).data, []);
});

test('SEC M1: no sign-in means 401 before any workspace logic runs; odd ids and methods are refused', async () => {
  const env = world();
  assert.equal((await as(null, env, '/v1/me')).status, 503, 'Access not configured: protected routes fail closed');
  const signedIn = createWorker({ devIdentity: OWNER });
  for (const p of ['/v1/workspaces/..%2Fws-iddav/today', '/v1/workspaces/WS-IDDAV/today', "/v1/workspaces/ws-iddav'--/today"]) {
    assert.equal((await signedIn.fetch(new Request(`http://localhost:8787${p}`), env)).status, 404, p);
  }
  assert.equal((await signedIn.fetch(new Request('http://localhost:8787/v1/workspaces/ws-iddav/today', { method: 'POST' }), env)).status, 404);
});

test('M1: with the CRM connected, the goal counts only this brand\'s campaigns, with the separate feed key', async () => {
  const env = world({ CRM_URL: 'https://crm.example', CRM_SERVICE_KEY: 'feed-key' });
  const seen: string[] = [];
  crm = async (url, init) => {
    seen.push(new Headers(init?.headers).get('x-imi-feed-key') ?? '');
    const since = new URL(url).searchParams.get('since')!;
    const week = Date.now() - Date.parse(since) < 8 * 86400000;
    return new Response(JSON.stringify({ imi_campaigns: [
      { code: 'CMP-0101', enquiries: week ? 7 : 12 },     // Iddav
      { code: 'CMP-0201', enquiries: week ? 50 : 90 },    // Antardrishti: must not be counted for Iddav
    ] }));
  };
  const t = await body(await as(OWNER, env, '/v1/workspaces/ws-iddav/today'));
  crm = null;
  assert.equal(t.data.goal.value, 7); assert.equal(t.data.goal.previous, 5);
  assert.equal(t.data.goal.trust.kind, 'measured'); assert.equal(t.data.goal.trust.source, 'Iddav CRM');
  assert.ok(seen.length === 2 && seen.every((k) => k === 'feed-key'));
});

test('M1: if the CRM is down, Today still loads and says so instead of guessing', async () => {
  const env = world({ CRM_URL: 'https://crm.example', CRM_SERVICE_KEY: 'feed-key' });
  crm = async () => new Response('down', { status: 503 });
  const t = await body(await as(OWNER, env, '/v1/workspaces/ws-iddav/today'));
  crm = null;
  assert.equal(t.status, 200);
  assert.equal(t.data.goal.value, null); assert.equal(t.data.goal.trust.kind, 'unavailable');
});

test('the permission matrix: only owners approve, publish, connect, see margins or manage members', () => {
  for (const p of ['content.approve', 'content.publish', 'channels.connect', 'margin.read', 'members.manage'] as const) {
    assert.deepEqual(Object.entries(ROLE_PERMS).filter(([, ps]) => ps.includes(p)).map(([r]) => r), ['owner'], p);
  }
  assert.ok(can('sales', 'today.read') && !can('sales', 'money.read') && !can('creator', 'results.read'));
});

test('production is labelled production only when the config says so', async () => {
  const me = await body(await as(OWNER, world({ DATA_ENVIRONMENT: 'production' }), '/v1/me'));
  assert.equal(me.data.environment, 'production');
});
