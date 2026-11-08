// IMI ONE round 2: Send to AI -> Bring back -> draft -> approval -> Mark as posted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/index.ts';
import { makeD1 } from './helpers/d1.ts';

const OWNER = 'rama@iddav.com', CREATOR = 'writer@iddav.com', AD_OWNER = 'owner@antardrishti.com', RESEARCH = 'lead@manas.org';
function world() {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01'), ('ws-manas','tnt-rama','MANAS','research','screener_completions','2026-11-01')");
  const m = (id: string, ws: string, email: string, role: string) => run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, 'tnt-rama', ?, ?, ?, 'seed', '2026-11-01')", id, ws, email, role);
  m('m1', 'ws-iddav', OWNER, 'owner'); m('m2', 'ws-iddav', CREATOR, 'creator'); m('m3', 'ws-antardrishti', AD_OWNER, 'owner'); m('m4', 'ws-manas', RESEARCH, 'owner');
  const rec = (id: string, ws: string, statement: string) => run(`INSERT INTO intelligence_records (id, code, domain, record_type, title, status, created_at, updated_at, author, author_role, observation_json, learning_strength, workspace_id)
    VALUES (?, ?, 'x', 'evidence', ?, 'open', '2026-11-01', '2026-11-01', 'seed', 'owner_admin', ?, 'provisional', ?)`, id, `INT-${id}`, `Tiger corridor study ${id}`,
    JSON.stringify({ rawStatement: statement, source: 'Mongabay', sourceReference: 'https://m.example/1', publishedAt: '2026-11-05', evidenceClass: 'reporting' }), ws);
  rec('r1', 'ws-iddav', 'Guests asked; contact ranger@example.com or +91 98765 43210 for permits.');
  rec('r2', 'ws-manas', 'Screener answers from volunteers.');
  const store = new Map<string, { body: ArrayBuffer; type: string }>();
  const POSTERS = { put: async (k: string, b: ArrayBuffer, o: any) => { store.set(k, { body: b, type: o?.httpMetadata?.contentType }); },
    get: async (k: string) => (store.has(k) ? { body: store.get(k)!.body } : null) };
  return { env: { DB, POSTERS, ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined } as any, store };
}
const call = async (env: any, who: string, method: string, path: string, body?: unknown, raw?: { type: string; data: Uint8Array }) => {
  const init: RequestInit = { method };
  if (raw) { init.headers = { 'Content-Type': raw.type }; init.body = raw.data; }
  else if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
  const r = await createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, init), env);
  const type = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: type.includes('json') ? await r.json() as any : null };
};
const W = '/v1/workspaces/ws-iddav';

test('AI providers: ChatGPT, Claude and Gemini by default; only owners add more; https only; no duplicates', async () => {
  const { env } = world();
  const list = await call(env, CREATOR, 'GET', `${W}/ai-providers`);
  assert.deepEqual(list.data.map((p: any) => p.name), ['ChatGPT', 'Claude', 'Gemini']);
  assert.equal((await call(env, CREATOR, 'POST', `${W}/ai-providers`, { name: 'Perplexity', url: 'https://www.perplexity.ai/' })).status, 403);
  assert.equal((await call(env, OWNER, 'POST', `${W}/ai-providers`, { name: 'Perplexity', url: 'http://www.perplexity.ai/' })).status, 400);
  assert.equal((await call(env, OWNER, 'POST', `${W}/ai-providers`, { name: 'Perplexity', url: 'https://www.perplexity.ai/' })).status, 201);
  assert.equal((await call(env, OWNER, 'POST', `${W}/ai-providers`, { name: 'Perplexity', url: 'https://x.example/' })).status, 409);
  assert.deepEqual((await call(env, AD_OWNER, 'GET', '/v1/workspaces/ws-antardrishti/ai-providers')).data.map((p: any) => p.name), ['ChatGPT', 'Claude', 'Gemini'], 'each brand has its own list');
});

test('Send to AI: the full record goes, personal details are removed, and the hand-off is logged', async () => {
  const { env } = world();
  const p = (await call(env, OWNER, 'GET', `${W}/ai-providers`)).data.find((x: any) => x.name === 'Gemini');
  await call(env, OWNER, 'POST', `${W}/records/r1/decision`, { choice: 'create_content', reason: 'Strong conservation story', requestId: 'req-ai-00001' });
  const r = await call(env, CREATOR, 'POST', `${W}/records/r1/prompt`, { providerId: p.id, format: 'carousel', audience: 'wildlife travellers', tone: 'calm' });
  assert.equal(r.status, 200);
  for (const part of ['Tiger corridor study r1', 'Source: Mongabay (https://m.example/1)', 'Published: 2026-11-05', 'Our decision: Create a post or campaign', 'Format: carousel', 'HEADLINE:', 'CAPTION:', 'mark it [suggestion]'])
    assert.ok(r.data.prompt.includes(part), `prompt includes ${part}`);
  assert.ok(!r.data.prompt.includes('ranger@example.com') && !r.data.prompt.includes('98765'), 'email and phone removed');
  assert.deepEqual([r.data.redactions, r.data.provider, r.data.url, r.data.dataClass], [2, 'Gemini', 'https://gemini.google.com/app', 'public source']);
  const log = env.DB.raw.prepare('SELECT provider, redactions, created_by FROM ai_handoffs').all();
  assert.deepEqual(log.map((l: any) => [l.provider, l.redactions, l.created_by]), [['Gemini', 2, CREATOR]]);
});

test('Send to AI: refused for research brands, records of other brands, and unknown providers', async () => {
  const { env } = world();
  const mp = (await call(env, RESEARCH, 'GET', '/v1/workspaces/ws-manas/ai-providers')).data[0];
  assert.equal((await call(env, RESEARCH, 'POST', '/v1/workspaces/ws-manas/records/r2/prompt', { providerId: mp.id })).status, 403);
  const ap = (await call(env, AD_OWNER, 'GET', '/v1/workspaces/ws-antardrishti/ai-providers')).data[0];
  assert.equal((await call(env, AD_OWNER, 'POST', '/v1/workspaces/ws-antardrishti/records/r1/prompt', { providerId: ap.id })).status, 404);
  assert.equal((await call(env, OWNER, 'POST', `${W}/records/r1/prompt`, { providerId: 'nope' })).status, 400);
});

test('Bring back: a pasted AI reply becomes a draft linked to its record, and appears on Today', async () => {
  const { env } = world();
  const p = (await call(env, OWNER, 'GET', `${W}/ai-providers`)).data[0];
  const d = await call(env, CREATOR, 'POST', `${W}/drafts`, { recordId: 'r1', providerId: p.id, pasted: 'Sure! Here it is.\nHEADLINE: Where do tigers walk at night?\nCAPTION: A new study maps the corridors.\n#Tadoba' });
  assert.equal(d.status, 201);
  assert.deepEqual([d.data.headline, d.data.caption, d.data.source], ['Where do tigers walk at night?', 'A new study maps the corridors.\n#Tadoba', 'ChatGPT']);
  const list = (await call(env, OWNER, 'GET', `${W}/drafts?record=r1`)).data;
  assert.deepEqual([list.length, list[0].record_code, list[0].status], [1, 'INT-r1', 'draft']);
  const today = (await call(env, OWNER, 'GET', `${W}/today`)).data;
  assert.ok(today.needsYou.some((n: any) => n.kind === 'approve_post' && n.subject === 'Where do tigers walk at night?'));
  assert.ok(today.needsYou.some((n: any) => n.kind === 'review_decision' && n.action.ref === 'r1'), 'the record awaiting a decision is on Today');
  assert.equal((await call(env, CREATOR, 'POST', `${W}/drafts`, { headline: 'x' })).status, 400);
});

test('Approval: owner only, on the version they saw; editing clears it; posting needs approval and an https link', async () => {
  const { env } = world();
  const d = (await call(env, CREATOR, 'POST', `${W}/drafts`, { recordId: 'r1', headline: 'Night corridors', caption: 'Caption v1' })).data;
  assert.equal((await call(env, CREATOR, 'POST', `${W}/drafts/${d.id}/approve`, { version: 1 })).status, 403, 'creators cannot approve');
  assert.equal((await call(env, OWNER, 'POST', `${W}/drafts/${d.id}/posted`, { url: 'https://instagram.com/p/x' })).status, 409, 'not before approval');
  assert.equal((await call(env, OWNER, 'POST', `${W}/drafts/${d.id}/approve`, { version: 2 })).status, 409, 'wrong version');
  const ok = await call(env, OWNER, 'POST', `${W}/drafts/${d.id}/approve`, { version: 1 });
  assert.deepEqual([ok.status, ok.data.approvedBy], [200, OWNER]);
  await call(env, CREATOR, 'POST', `${W}/drafts/${d.id}/edit`, { caption: 'Caption v2' });
  let row = env.DB.raw.prepare('SELECT status, version, approved_by FROM drafts WHERE id = ?').get(d.id);
  assert.deepEqual({ ...row }, { status: 'draft', version: 2, approved_by: null }, 'editing clears the approval');
  await call(env, OWNER, 'POST', `${W}/drafts/${d.id}/approve`, { version: 2 });
  assert.equal((await call(env, OWNER, 'POST', `${W}/drafts/${d.id}/posted`, { url: 'http://instagram.com/p/x' })).status, 400);
  const posted = await call(env, OWNER, 'POST', `${W}/drafts/${d.id}/posted`, { url: 'https://instagram.com/p/abc', channel: 'Instagram' });
  assert.equal(posted.data.status, 'posted');
  row = env.DB.raw.prepare('SELECT posted_url, posted_by, posted_channel FROM drafts WHERE id = ?').get(d.id);
  assert.deepEqual({ ...row }, { posted_url: 'https://instagram.com/p/abc', posted_by: OWNER, posted_channel: 'Instagram' });
  assert.equal((await call(env, CREATOR, 'POST', `${W}/drafts/${d.id}/edit`, { caption: 'late change' })).status, 409, 'posted drafts are not edited');
});

test('Images brought back are private, labelled AI-made when they are, and clear the approval', async () => {
  const { env, store } = world();
  const d = (await call(env, OWNER, 'POST', `${W}/drafts`, { headline: 'Poster', caption: 'Caption' })).data;
  await call(env, OWNER, 'POST', `${W}/drafts/${d.id}/approve`, { version: 1 });
  const png = new Uint8Array(200); png[0] = 0x89;
  assert.equal((await call(env, OWNER, 'PUT', `${W}/drafts/${d.id}/media?ai=1`, undefined, { type: 'image/gif', data: png })).status, 415);
  const up = await call(env, OWNER, 'PUT', `${W}/drafts/${d.id}/media?ai=1`, undefined, { type: 'image/png', data: png });
  assert.deepEqual([up.status, up.data.aiGenerated], [200, true]);
  assert.ok([...store.keys()][0].startsWith(`drafts/ws-iddav/${d.id}/`));
  const row = env.DB.raw.prepare('SELECT status, ai_generated_media FROM drafts WHERE id = ?').get(d.id);
  assert.deepEqual({ ...row }, { status: 'draft', ai_generated_media: 1 }, 'a new image needs a new approval');
  const img = await call(env, CREATOR, 'GET', `${W}/drafts/${d.id}/media`);
  assert.deepEqual([img.status, img.headers.get('cache-control')], [200, 'private, no-store']);
  assert.equal((await call(env, AD_OWNER, 'GET', `/v1/workspaces/ws-antardrishti/drafts/${d.id}/media`)).status, 404, 'other brands cannot reach it');
});

test('Drafts of one brand are invisible to another', async () => {
  const { env } = world();
  const d = (await call(env, OWNER, 'POST', `${W}/drafts`, { headline: 'IDDAV-ONLY', caption: 'x y' })).data;
  assert.deepEqual((await call(env, AD_OWNER, 'GET', '/v1/workspaces/ws-antardrishti/drafts')).data, []);
  assert.equal((await call(env, AD_OWNER, 'POST', `/v1/workspaces/ws-antardrishti/drafts/${d.id}/approve`, { version: 1 })).status, 404);
});
