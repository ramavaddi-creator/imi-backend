// IMI ONE round 8: the shared jyotisha-core engine and the daily Panchangam in the
// intelligence-to-content workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createWorker } from '../src/index.ts';
import { makeD1 } from './helpers/d1.ts';
import { feeds } from '../src/intel.ts';

test('the vendored jyotisha-core files are byte-identical to the released version (no local edits)', () => {
  const lines = readFileSync('vendor/jyotisha-core/MANIFEST.sha256', 'utf8').trim().split('\n');
  assert.ok(lines.length >= 7);
  for (const l of lines) {
    const [hash, file] = l.trim().split(/\s+/);
    assert.equal(createHash('sha256').update(readFileSync(`vendor/jyotisha-core/${file}`)).digest('hex'), hash, file);
  }
});

const none = (async () => new Response('{"results":[]}')) as unknown as typeof fetch;
const J = { place: 'Hyderabad', lat: 17.385, lng: 78.4867, tz: 'Asia/Kolkata' };

test('a brand with a Jyotisha location gets today and tomorrow as calculated Panchangam items; others get none', async () => {
  const r = await feeds('panchang-q1', { jyotisha: J, newsKeywords: ['astrology'] }, none);
  const p = r.items.filter((i) => i.source === 'Panchangam (calculated)');
  assert.equal(p.length, 2);
  assert.ok(p.every((i) => i.evidenceClass === 'calculation' && i.title.includes('Hyderabad') && /Sunrise \d\d:\d\d/.test(i.summary)));
  const detail = JSON.parse((p[0] as any).detail);
  assert.equal(detail.provenance.location.tz, 'Asia/Kolkata');
  assert.equal(r.sources[0].name, 'Panchangam');
  const plain = await feeds('panchang-q2', {}, none);
  assert.equal(plain.items.filter((i) => i.source === 'Panchangam (calculated)').length, 0);
});

test('through the workflow: capture (as calculation, with provenance) -> record -> decision -> Send to AI with the tradition rule', async () => {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  run(readFileSync('config_antardrishti_panchang.sql', 'utf8').replace(/--.*\n/g, ''));
  assert.match(DB.raw.prepare("SELECT feed_profile_json FROM workspaces WHERE id = 'ws-antardrishti'").get().feed_profile_json, /Asia\/Kolkata/);
  assert.equal(DB.raw.prepare("SELECT feed_profile_json FROM workspaces WHERE id = 'ws-iddav'").get().feed_profile_json.includes('jyotisha'), false, 'Iddav untouched');
  run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES ('m1','tnt-rama','ws-antardrishti','owner@antardrishti.com','owner','seed','2026-11-01')");
  const env = { DB, POSTERS: { put: async () => {}, get: async () => null }, ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined } as any;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await createWorker({ devIdentity: 'owner@antardrishti.com' }).fetch(new Request(`http://localhost:8787/v1/workspaces/ws-antardrishti${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), env);
    return { status: r.status, data: await r.json() as any };
  };
  const realFetch = globalThis.fetch; globalThis.fetch = none;
  try {
    const feed = (await call('GET', '/feed?q=panchang-q3')).data;
    const item = feed.items.find((i: any) => i.source === 'Panchangam (calculated)');
    const cap = await call('POST', '/inbox', { summary: item.title, type: 'evidence', feedSource: item.source, sourceItemId: item.sourceItemId, category: item.category,
      publishedAt: item.date, retrievedAt: feed.retrievedAt, evidenceClass: item.evidenceClass, fullText: item.detail });
    const row = DB.raw.prepare('SELECT evidence_class, source_category, full_text FROM inbox_items WHERE id = ?').get(cap.data.id);
    assert.deepEqual([row.evidence_class, row.source_category], [null, 'calculation'], 'a calculation is not stored as evidence');
    assert.match(row.full_text, /"ayanamsha":"Lahiri/);
    const rec = await call('POST', `/inbox/${cap.data.id}/promote`);
    await call('POST', `/records/${rec.data.id}/decision`, { choice: 'create_content', reason: 'Daily Panchangam post', requestId: 'req-pan-00001' });
    const prov = (await call('GET', '/ai-providers')).data[0];
    const prompt = (await call('POST', `/records/${rec.data.id}/prompt`, { providerId: prov.id })).data.prompt;
    assert.match(prompt, /astronomical calculation/);
    assert.match(prompt, /never as predictions or claims of effect/);
  } finally { globalThis.fetch = realFetch; }
});
