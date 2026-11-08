// IMI ONE round 1: feeds -> inbox -> record -> decision on the record -> outcomes,
// all brand-scoped. Real SQLite from the repo's schema files (v9 + v10 included).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/index.ts';
import { makeD1 } from './helpers/d1.ts';
import { feeds } from '../src/intel.ts';

const OWNER = 'rama@iddav.com', CREATOR = 'writer@iddav.com', AD_OWNER = 'owner@antardrishti.com', STRANGER = 'x@else.com';
function world() {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  const m = (id: string, ws: string, email: string, role: string) => run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?,?,?,?,?,'seed','2026-11-01')", id, 'tnt-rama', ws, email, role);
  m('m1', 'ws-iddav', OWNER, 'owner'); m('m2', 'ws-iddav', CREATOR, 'creator'); m('m3', 'ws-antardrishti', AD_OWNER, 'owner');
  run(`INSERT INTO outcome_items (id, code, domain, decision_code, action_taken, actual_outcome, date_evaluated, evaluator, retrospective, attribution_confidence_level, attribution_confidence_reason, resulting_learning_json, workspace_id)
       VALUES ('o1','OUT-0001','x','DEC-0001','IDDAV-ONLY action','up','2026-11-05','x','none','low','r','[]','ws-iddav'),
              ('o2','OUT-0002','x','DEC-0002','AD-ONLY action','flat','2026-11-05','x','none','low','r','[]','ws-antardrishti')`);
  return { DB, ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined } as any;
}
const call = async (env: any, who: string | null, method: string, path: string, body?: unknown) => {
  const w = who ? createWorker({ devIdentity: who }) : createWorker();
  const r = await w.fetch(new Request(`http://localhost:8787${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: (await r.json().catch(() => null)) as any };
};

test('feeds: every source is read on the server; one failing source never blanks the rest', async () => {
  const f = (async (url: string) => {
    const u = String(url);
    if (u.includes('gbif')) return new Response(JSON.stringify({ results: [{ key: 1, scientificName: 'Panthera tigris', eventDate: '2026-11-01', stateProvince: 'Maharashtra' }] }));
    if (u.includes('inaturalist')) throw new Error('timeout');
    if (u.includes('openalex')) return new Response(JSON.stringify({ results: [{ id: 'https://openalex.org/W1', title: 'Tiger corridors', publication_date: '2026-10-01', publication_year: 2026 }] }));
    if (u.includes('crossref')) return new Response(JSON.stringify({ message: { items: [{ DOI: '10.1/x', title: ['Buffer zone tourism'], published: { 'date-parts': [[2026, 9, 1]] } }] } }));
    if (u.includes('mongabay')) return new Response('<rss><channel><item><title>Tiger census &amp; corridors</title><link>https://m.example/1</link><pubDate>Wed, 05 Nov 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;tiger&lt;/p&gt;</description></item></channel></rss>');
    return new Response('no', { status: 404 });
  }) as unknown as typeof fetch;
  const r = await feeds('Panthera tigris unique-q1', { newsKeywords: ['tiger'] }, f);
  assert.deepEqual([...new Set(r.items.map((i) => i.source))].sort(), ['Crossref', 'GBIF', 'Mongabay', 'OpenAlex']);
  assert.equal(r.sources.find((s) => s.name === 'iNaturalist')!.ok, false);
  assert.equal(r.items[0].date, '2026-11-05', 'newest first');
  assert.equal(r.items.find((i) => i.source === 'Mongabay')!.title, 'Tiger census & corridors');
  assert.ok(r.sources.some((s) => s.name === 'eBird' && /key/.test(s.note!)), 'key-needing sources say so instead of failing silently');
});

test('inbox: capture, list and triage stay inside the brand', async () => {
  const env = world();
  const a = await call(env, OWNER, 'POST', '/v1/workspaces/ws-iddav/inbox', { summary: 'IDDAV-ONLY road detour adds 20 minutes', type: 'observation' });
  assert.equal(a.status, 201);
  await call(env, AD_OWNER, 'POST', '/v1/workspaces/ws-antardrishti/inbox', { summary: 'AD-ONLY sign-up spike', type: 'evidence' });
  const list = await call(env, OWNER, 'GET', '/v1/workspaces/ws-iddav/inbox');
  assert.deepEqual(list.data.map((x: any) => x.summary), ['IDDAV-ONLY road detour adds 20 minutes']);
  assert.equal((await call(env, AD_OWNER, 'GET', '/v1/workspaces/ws-iddav/inbox')).status, 404, 'other brand: not found');
  assert.equal((await call(env, AD_OWNER, 'POST', `/v1/workspaces/ws-antardrishti/inbox/${a.data.id}/status`, { status: 'verified' })).status, 404, 'cannot touch another brand\u2019s item via its own brand');
  assert.equal((await call(env, OWNER, 'POST', `/v1/workspaces/ws-iddav/inbox/${a.data.id}/status`, { status: 'verified' })).status, 200);
  assert.equal((await call(env, OWNER, 'POST', '/v1/workspaces/ws-iddav/inbox', { summary: 'x' })).status, 400);
});

test('a feed item captured into the inbox keeps its source and link', async () => {
  const env = world();
  const r = await call(env, OWNER, 'POST', '/v1/workspaces/ws-iddav/inbox', { summary: 'Tiger census', feedSource: 'Mongabay', url: 'https://m.example/1', category: 'News', type: 'evidence' });
  const item = (await call(env, OWNER, 'GET', '/v1/workspaces/ws-iddav/inbox')).data.find((x: any) => x.id === r.data.id);
  assert.deepEqual([item.feed_source, item.source_reference, item.origin], ['Mongabay', 'https://m.example/1', 'secondary_external']);
});

test('promote to record, then decide on the record itself (owner only, history kept)', async () => {
  const env = world();
  const inb = await call(env, OWNER, 'POST', '/v1/workspaces/ws-iddav/inbox', { summary: 'Guests ask about winter safari dates' });
  const rec = await call(env, OWNER, 'POST', `/v1/workspaces/ws-iddav/inbox/${inb.data.id}/promote`);
  assert.equal(rec.status, 201);
  const again = await call(env, OWNER, 'POST', `/v1/workspaces/ws-iddav/inbox/${inb.data.id}/promote`);
  assert.deepEqual([again.status, again.data.id], [200, rec.data.id], 'a retry returns the same record');
  assert.equal((await call(env, CREATOR, 'POST', `/v1/workspaces/ws-iddav/records/${rec.data.id}/decision`, { choice: 'take_action', reason: 'clear demand', requestId: 'req-creator-1' })).status, 403, 'creators cannot decide');
  assert.equal((await call(env, AD_OWNER, 'POST', `/v1/workspaces/ws-iddav/records/${rec.data.id}/decision`, { choice: 'take_action', reason: 'x y z', requestId: 'req-ad-00001' })).status, 404);
  assert.equal((await call(env, OWNER, 'POST', `/v1/workspaces/ws-iddav/records/${rec.data.id}/decision`, { choice: 'maybe', reason: 'xyz', requestId: 'req-bad-0001' })).status, 400);
  assert.equal((await call(env, OWNER, 'POST', `/v1/workspaces/ws-iddav/records/${rec.data.id}/decision`, { choice: 'monitor', reason: '', requestId: 'req-bad-0002' })).status, 400);
  const d = await call(env, OWNER, 'POST', `/v1/workspaces/ws-iddav/records/${rec.data.id}/decision`, { choice: 'create_content', reason: 'Post the winter dates this week', requestId: 'req-owner-001' });
  assert.equal(d.status, 201); assert.equal(d.data.decidedBy, OWNER);
  const list = (await call(env, CREATOR, 'GET', '/v1/workspaces/ws-iddav/records')).data;
  assert.deepEqual([list[0].status, list[0].decision, list[0].decided_by], ['decided', 'create_content', OWNER]);
  const ev = env.DB.raw.prepare('SELECT actor, to_status FROM decision_events').all();
  assert.deepEqual(ev.map((e: any) => [e.actor, e.to_status]), [[OWNER, 'decided']]);
  assert.throws(() => env.DB.raw.exec('DELETE FROM decision_events'), /append-only/, 'the decision history cannot be erased');
});

test('outcomes are listed per brand; people without results permission are refused', async () => {
  const env = world();
  assert.deepEqual((await call(env, OWNER, 'GET', '/v1/workspaces/ws-iddav/outcomes')).data.map((o: any) => o.action_taken), ['IDDAV-ONLY action']);
  assert.equal((await call(env, CREATOR, 'GET', '/v1/workspaces/ws-iddav/outcomes')).status, 403);
  assert.equal((await call(env, STRANGER, 'GET', '/v1/workspaces/ws-iddav/outcomes')).status, 404);
  assert.equal((await call(env, null, 'GET', '/v1/workspaces/ws-iddav/outcomes')).status, 503, 'no sign-in: fails closed');
});


// ---------------------------------------------------------------- review corrections (P0/P1)

test('P0: promoting the same item twice at once creates exactly one record', async () => {
  const env = world();
  const inb = await call(env, OWNER, 'POST', '/v1/workspaces/ws-iddav/inbox', { summary: 'Same item, two clicks' });
  const [a, b] = await Promise.all([1, 2].map(() => call(env, OWNER, 'POST', `/v1/workspaces/ws-iddav/inbox/${inb.data.id}/promote`)));
  assert.equal(a.data.id, b.data.id);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM intelligence_records WHERE source_inbox_id = ?').get(inb.data.id).n, 1);
});

test('P0: codes are unique under simultaneous writes (atomic counter, not COUNT+1)', async () => {
  const env = world();
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => call(env, OWNER, 'POST', '/v1/workspaces/ws-iddav/inbox', { summary: `Item number ${i}` })));
  const codes = rs.map((r) => r.data.code);
  assert.equal(new Set(codes).size, 8, codes.join(','));
});

test('P0: records get their domain from the brand settings, not a hardcoded Iddav value', async () => {
  const env = world();
  const ad = await call(env, AD_OWNER, 'POST', '/v1/workspaces/ws-antardrishti/inbox', { summary: 'Sign-ups rose after the eclipse explainer' });
  const iddav = await call(env, OWNER, 'POST', '/v1/workspaces/ws-iddav/inbox', { summary: 'Tiger seen near the gate' });
  const dom = (id: string) => env.DB.raw.prepare('SELECT domain FROM inbox_items WHERE id = ?').get(id).domain;
  assert.equal(dom(ad.data.id), 'ws-antardrishti');
  assert.equal(dom(iddav.data.id), 'iddav-marketing-intelligence');
});

test('P0: guessed ids from another brand cannot be read, changed, promoted or decided', async () => {
  const env = world();
  const inb = await call(env, OWNER, 'POST', '/v1/workspaces/ws-iddav/inbox', { summary: 'IDDAV private finding' });
  const rec = await call(env, OWNER, 'POST', `/v1/workspaces/ws-iddav/inbox/${inb.data.id}/promote`);
  const p = '/v1/workspaces/ws-antardrishti';
  assert.equal((await call(env, AD_OWNER, 'POST', `${p}/inbox/${inb.data.id}/status`, { status: 'archived' })).status, 404);
  assert.equal((await call(env, AD_OWNER, 'POST', `${p}/inbox/${inb.data.id}/promote`)).status, 404);
  assert.equal((await call(env, AD_OWNER, 'POST', `${p}/records/${rec.data.id}/decision`, { choice: 'archive', reason: 'not ours', requestId: 'req-cross-001' })).status, 404);
  assert.deepEqual((await call(env, AD_OWNER, 'GET', `${p}/records/${rec.data.id}/decisions`)).data, []);
  assert.ok(!JSON.stringify((await call(env, AD_OWNER, 'GET', `${p}/records`)).data).includes('IDDAV private'));
  const row = env.DB.raw.prepare('SELECT status FROM inbox_items WHERE id = ?').get(inb.data.id);
  assert.equal(row.status, 'promoted', 'unchanged by the other brand');
});

test('P0: rows with no brand are quarantined: no brand can see them', async () => {
  const env = world();
  env.DB.raw.prepare(`INSERT INTO inbox_items (id, code, domain, type, date, summary, origin, submitted_by, submitter_role, retrospective, status, full_text)
    VALUES ('legacy-1','INB-0999','x','observation','2026-01-01','LEGACY unassigned','primary_internal','x','x','none','pending','x')`).run();
  for (const [who, ws] of [[OWNER, 'ws-iddav'], [AD_OWNER, 'ws-antardrishti']]) {
    assert.ok(!JSON.stringify((await call(env, who, 'GET', `/v1/workspaces/${ws}/inbox`)).data).includes('LEGACY'));
  }
});

test('P0: a retried decision is recognised; a new decision supersedes the old one; history is kept', async () => {
  const env = world();
  const inb = await call(env, OWNER, 'POST', '/v1/workspaces/ws-iddav/inbox', { summary: 'Winter dates demand' });
  const rec = await call(env, OWNER, 'POST', `/v1/workspaces/ws-iddav/inbox/${inb.data.id}/promote`);
  const url = `/v1/workspaces/ws-iddav/records/${rec.data.id}/decision`;
  const first = await call(env, OWNER, 'POST', url, { choice: 'monitor', reason: 'wait a week', requestId: 'req-rev-0001' });
  const retry = await call(env, OWNER, 'POST', url, { choice: 'monitor', reason: 'wait a week', requestId: 'req-rev-0001' });
  assert.deepEqual([first.status, retry.status, retry.data.code], [201, 200, first.data.code], 'the retry returns the same decision');
  const [x, y] = await Promise.all([1, 2].map(() => call(env, OWNER, 'POST', url, { choice: 'monitor', reason: 'wait a week', requestId: 'req-rev-0002' })));
  assert.equal(x.data.code, y.data.code, 'simultaneous retries also give one decision');
  await call(env, OWNER, 'POST', url, { choice: 'create_content', reason: 'demand confirmed', requestId: 'req-rev-0003' });
  const hist = (await call(env, OWNER, 'GET', `/v1/workspaces/ws-iddav/records/${rec.data.id}/decisions`)).data;
  assert.equal(hist.length, 3);
  assert.deepEqual(hist.filter((h: any) => !h.superseded_by).map((h: any) => h.decision), ['create_content'], 'one current decision');
  const list = (await call(env, OWNER, 'GET', '/v1/workspaces/ws-iddav/records')).data;
  assert.deepEqual([list[0].decision, list[0].decision_count], ['create_content', 3]);
  assert.equal((await call(env, OWNER, 'POST', url, { choice: 'monitor', reason: 'no id' })).status, 400, 'a request id is required');
});

test('P1: a feed item keeps its full provenance and is captured once per brand', async () => {
  const env = world();
  const item = { summary: 'Tiger census', feedSource: 'Mongabay', sourceItemId: 'mongabay-https://m.example/1', url: 'https://m.example/1',
    category: 'News', type: 'evidence', publishedAt: '2026-11-05', retrievedAt: '2026-11-08T10:00:00Z', evidenceClass: 'reporting', fullText: 'Full article summary' };
  const a = await call(env, OWNER, 'POST', '/v1/workspaces/ws-iddav/inbox', item);
  const b = await call(env, OWNER, 'POST', '/v1/workspaces/ws-iddav/inbox', item);
  assert.deepEqual([a.status, b.status, b.data.id], [201, 200, a.data.id], 'the second capture is recognised as the same item');
  assert.equal((await call(env, AD_OWNER, 'POST', '/v1/workspaces/ws-antardrishti/inbox', item)).status, 201, 'another brand may capture it separately');
  const row = env.DB.raw.prepare('SELECT feed_source, source_item_id, published_at, retrieved_at, evidence_class, full_text FROM inbox_items WHERE id = ?').get(a.data.id);
  assert.deepEqual({ ...row }, { feed_source: 'Mongabay', source_item_id: 'mongabay-https://m.example/1', published_at: '2026-11-05', retrieved_at: '2026-11-08T10:00:00Z', evidence_class: 'reporting', full_text: 'Full article summary' });
  const rec = await call(env, OWNER, 'POST', `/v1/workspaces/ws-iddav/inbox/${a.data.id}/promote`);
  const obs = (await call(env, OWNER, 'GET', '/v1/workspaces/ws-iddav/records')).data.find((r: any) => r.id === rec.data.id).observation;
  assert.deepEqual([obs.source, obs.publishedAt, obs.evidenceClass], ['Mongabay', '2026-11-05', 'reporting'], 'provenance travels to the record');
});

test('P1: feeds use each brand\'s server-side area: Iddav searches around Tadoba, a brand with no area is labelled worldwide', async () => {
  const urls: string[] = [];
  const f = (async (u: string) => { urls.push(String(u)); return new Response(String(u).includes('mongabay') ? '<rss><channel></channel></rss>' : '{"results":[]}'); }) as unknown as typeof fetch;
  const iddav = await feeds('Panthera tigris q-area', { lat: 20.2167, lng: 79.3667, radiusKm: 60 }, f);
  assert.ok(urls.some((u) => u.includes('gbif') && u.includes('geo_distance=20.2167,79.3667,60km')));
  assert.ok(urls.some((u) => u.includes('inaturalist') && u.includes('lat=20.2167') && u.includes('radius=60')));
  assert.match(iddav.scope, /60 km/);
  urls.length = 0;
  const none = await feeds('Panthera tigris q-world', {}, f);
  assert.ok(urls.some((u) => u.includes('gbif') && !u.includes('geo_distance') && !u.includes('country=')));
  assert.match(none.scope, /Worldwide/);
});
