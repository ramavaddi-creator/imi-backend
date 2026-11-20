// IMI ONE round 11.1: photos and videos on a content pack; a draft uses one; labels real vs AI-made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorker } from '../src/index.ts';
import { makeD1 } from './helpers/d1.ts';

const KIT_SEED = readFileSync('schema_v17.sql', 'utf8').split('-- ---------------------------------------------------------------- starting Brand Kits')[1].split('\n').slice(1).join('\n');
const REPLY = `IDEA MAP\nHOOK: Who was at the kill?\n=== carousel ===\nHEADLINE: Who was at the kill?\nSLIDES:\n1. x\n=== reel_script ===\nHEADLINE: Watch the cubs at dawn\nSCRIPT: beat 1\nCAPTION: Mornings.`;

function world() {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT OR IGNORE INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  DB.raw.exec(KIT_SEED);
  for (const [id, ws, email, role] of [['m1', 'ws-iddav', 'owner@iddav.com', 'owner'], ['m2', 'ws-iddav', 'viewer@iddav.com', 'viewer'], ['m3', 'ws-antardrishti', 'ad@x.com', 'owner']])
    run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, 'tnt-rama', ?, ?, ?, 'seed', '2026-11-01')", id, ws, email, role);
  run(`INSERT INTO ai_providers (id, workspace_id, name, url, created_by, created_at) VALUES ('p1', 'ws-iddav', 'ChatGPT', 'https://chatgpt.com/', 'seed', '2026-11-01')`);
  const store = new Map<string, { bytes: number; type: string }>();
  const POSTERS = {
    put: async (k: string, b: any, o: any) => { const buf = b instanceof ArrayBuffer ? b : await new Response(b).arrayBuffer(); store.set(k, { bytes: buf.byteLength, type: o?.httpMetadata?.contentType }); },
    get: async (k: string) => (store.has(k) ? { body: new Uint8Array(store.get(k)!.bytes) } : null),
    delete: async (k: string) => { store.delete(k); },
  };
  return { DB, store, env: { DB, POSTERS } as any };
}
async function call(env: any, who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) {
  const r = await createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, { method, headers, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) }), env);
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.arrayBuffer(), type: ct };
}
const W = '/v1/workspaces/ws-iddav';
const file = (n: number) => new Uint8Array(n).fill(7);
const upload = (w: any, pack: string, type: string, origin: string | null, n = 4000, who = 'owner@iddav.com') =>
  call(w.env, who, 'PUT', `${W}/packs/${pack}/media?${origin ? `origin=${origin}&` : ''}name=clip`, file(n), { 'Content-Type': type, 'Content-Length': String(n) });

async function pack(w: any) {
  return (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs`, { input: { kind: 'typed_idea', text: 'Guests at Shedegaon gate saw Jahanvi and cubs on a nilgai kill.' }, formats: ['carousel', 'reel_script'] })).data;
}

test('photos and videos upload to a pack privately, each labelled real or AI-made; wrong type, no label or too large are refused', async () => {
  const w = world();
  const p = await pack(w);
  assert.equal((await upload(w, p.id, 'image/jpeg', 'real')).status, 201);
  const v = await upload(w, p.id, 'video/mp4', 'real', 9000);
  assert.equal(v.status, 201);
  assert.equal((await upload(w, p.id, 'image/png', 'ai_made')).status, 201);
  assert.equal((await upload(w, p.id, 'image/jpeg', null)).status, 400, 'real or AI-made must be stated');
  assert.equal((await upload(w, p.id, 'application/pdf', 'real')).status, 415);
  const big = await call(w.env, 'owner@iddav.com', 'PUT', `${W}/packs/${p.id}/media?origin=real`, file(200), { 'Content-Type': 'video/mp4', 'Content-Length': String(96 * 1024 * 1024) });
  assert.equal(big.status, 413, 'the declared size is checked before anything is stored');
  const got = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/packs/${p.id}`)).data;
  assert.deepEqual(got.media.map((m: any) => [m.kind, m.label]), [['image', 'Real photo'], ['video', 'Real video'], ['image', 'AI-made, not a photograph']]);
  assert.ok([...w.store.keys()].every((k) => k.startsWith(`packs/ws-iddav/${p.id}/`)));
  const one = await call(w.env, 'viewer@iddav.com', 'GET', `${W}/packs/${p.id}/media/${got.media[1].id}`);
  assert.deepEqual([one.status, one.type], [200, 'video/mp4']);
  assert.equal((await upload(w, p.id, 'image/jpeg', 'real', 4000, 'viewer@iddav.com')).status, 403, 'viewers cannot upload');
});

test('the prompt tells the AI what files exist, to use them, and to label AI-made ones', async () => {
  const w = world();
  const p = await pack(w);
  await upload(w, p.id, 'image/jpeg', 'real'); await upload(w, p.id, 'video/mp4', 'real'); await upload(w, p.id, 'image/png', 'ai_made');
  const pr = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/prompt`, { providerId: 'p1' })).data;
  assert.match(pr.prompt, /1 real photo\(s\), 1 real video\(s\), 1 AI-made/);
  assert.match(pr.prompt, /Never describe details you cannot see/);
  assert.match(pr.prompt, /labelled "AI-made"/);
});

test('a pack draft uses a pack file: new version, approval cleared, AI-made flag carried; a used file cannot be removed', async () => {
  const w = world();
  const p = await pack(w);
  const vid = (await upload(w, p.id, 'video/mp4', 'real')).data[0];
  const ai = (await upload(w, p.id, 'image/png', 'ai_made')).data[1];
  const drafted = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/bring-back`, { pasted: REPLY })).data;
  const reel = drafted.drafts.find((d: any) => d.template_key === 'reel_script');
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${reel.id}/approve`, { version: reel.version });
  const used = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${reel.id}/use-media`, { mediaId: vid.id })).data;
  assert.deepEqual([used.status, used.version, used.mediaType, used.aiGenerated], ['draft', reel.version + 1, 'video/mp4', false], 'approval is cleared: the owner approves the post with its file');
  const car = drafted.drafts.find((d: any) => d.template_key === 'carousel');
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${car.id}/use-media`, { mediaId: ai.id })).data.aiGenerated, true);
  const media = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/drafts/${reel.id}/media`));
  assert.deepEqual([media.status, media.type], [200, 'video/mp4']);
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/media/${vid.id}/remove`)).status, 409);
  const spare = (await upload(w, p.id, 'image/jpeg', 'real')).data[2];
  const after = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/media/${spare.id}/remove`)).data;
  assert.equal(after.length, 2);
  assert.equal(w.store.size, 2, 'the unused file is deleted from storage');
});

test('another brand cannot upload to, list, read, remove or use Iddav pack files (404)', async () => {
  const w = world();
  const p = await pack(w);
  const m = (await upload(w, p.id, 'image/jpeg', 'real')).data[0];
  assert.equal((await upload(w, p.id, 'image/jpeg', 'real', 4000, 'ad@x.com')).status, 404);
  for (const [meth, path] of [['GET', `${W}/packs/${p.id}/media`], ['GET', `${W}/packs/${p.id}/media/${m.id}`], ['POST', `${W}/packs/${p.id}/media/${m.id}/remove`]])
    assert.equal((await call(w.env, 'ad@x.com', meth, path, meth === 'POST' ? {} : undefined)).status, 404, `${meth} ${path}`);
  assert.equal((await call(w.env, 'ad@x.com', 'GET', `/v1/workspaces/ws-antardrishti/packs/${p.id}/media/${m.id}`)).status, 404);
});

test('a video can also be uploaded straight onto a draft', async () => {
  const w = world();
  const p = await pack(w);
  const d = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/bring-back`, { pasted: REPLY })).data.drafts[0];
  const r = await call(w.env, 'owner@iddav.com', 'PUT', `${W}/drafts/${d.id}/media`, file(5000), { 'Content-Type': 'video/quicktime', 'Content-Length': '5000' });
  assert.deepEqual([r.status, r.data.mediaType], [200, 'video/quicktime']);
});
