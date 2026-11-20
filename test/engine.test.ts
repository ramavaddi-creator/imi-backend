// IMI ONE round 11: Build 4, the Content Engine. Design 5.7 acceptance tests C1-C10, plus Route A and B.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorker } from '../src/index.ts';
import { io } from '../src/search.ts';
import { parsePackReply } from '../src/engine.ts';
import { makeD1 } from './helpers/d1.ts';

const KIT_SEED = readFileSync('schema_v17.sql', 'utf8').split('-- ---------------------------------------------------------------- starting Brand Kits')[1].split('\n').slice(1).join('\n');

let aiCalls: { url: string; body: any }[] = [];
let aiReply = '';
io.fetch = async (input: any, init?: RequestInit) => {
  aiCalls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
  return new Response(JSON.stringify({ content: [{ type: 'text', text: aiReply }], usage: { input_tokens: 1800, output_tokens: 1400 } }), { status: 200 });
};

const REPLY = `IDEA MAP
HOOK: Who walked the waterhole at dawn?
STORY: A tigress crossed the buffer-zone road at 5:40 am.
PROOF: Sri Antra is 5 km from the Moharli gate.
AUDIENCE: Families planning a Tadoba safari

=== carousel ===
HEADLINE: Who walked past at 5:40 am?
SLIDES:
1. Who walked past at 5:40 am?
2. Pugmarks by the waterhole
CAPTION: Save this for your Tadoba trip.

=== poster_text ===
HEADLINE: Dawn belongs to the forest here
CAPTION: Mornings at Sri Antra.

=== caption ===
HEADLINE: Why do guests wake at five?
CAPTION: Because the forest does. Share this with someone who needs a slower morning.
`;

function world() {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT OR IGNORE INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  run("INSERT OR IGNORE INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-manas','tnt-rama','MANAS','research','screener_completions','2026-11-01')");
  DB.raw.exec(KIT_SEED);
  for (const [id, ws, email, role] of [['m1', 'ws-iddav', 'owner@iddav.com', 'owner'], ['m2', 'ws-iddav', 'creator@iddav.com', 'creator'], ['m3', 'ws-antardrishti', 'ad@x.com', 'owner'], ['m4', 'ws-manas', 'mn@x.com', 'owner']])
    run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, 'tnt-rama', ?, ?, ?, 'seed', '2026-11-01')", id, ws, email, role);
  run(`INSERT INTO brand_facts (id, workspace_id, statement, wrong_forms_json, created_by, created_at) VALUES ('f1', 'ws-iddav', 'Rama has 27 years of total experience and 5 years in the forest.', '["27 years in the forest"]', 'seed', '2026-11-01')`);
  run(`INSERT INTO ai_providers (id, workspace_id, name, url, created_by, created_at) VALUES ('p1', 'ws-iddav', 'Claude', 'https://claude.ai/new', 'seed', '2026-11-01'), ('p2', 'ws-antardrishti', 'Claude', 'https://claude.ai/new', 'seed', '2026-11-01')`);
  return { DB, env: { DB } as any };
}
async function call(env: any, who: string, method: string, path: string, body?: unknown) {
  const r = await createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await r.text(); let data: any = text; try { data = JSON.parse(text); } catch { /* */ }
  return { status: r.status, data };
}
const W = '/v1/workspaces/ws-iddav';
const idea = { input: { kind: 'typed_idea', text: 'A tigress crossed the road near the lodge at dawn; guests heard alarm calls first.' }, formats: ['carousel', 'poster_text', 'caption'] };
async function drafted(w: any, reply = REPLY) {
  const p = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs`, idea)).data;
  const b = await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/bring-back`, { pasted: reply, providerId: 'p1' });
  assert.equal(b.status, 201, JSON.stringify(b.data));
  return b.data;
}

beforeEach(() => { aiCalls = []; aiReply = REPLY; });

test('C1: one idea creates one pack with one draft per format, all linked to the pack and labelled as an owner idea', async () => {
  const w = world();
  const p = await drafted(w);
  assert.equal(p.drafts.length, 3);
  assert.deepEqual(p.drafts.map((d: any) => d.template_key).sort(), ['caption', 'carousel', 'poster_text']);
  assert.equal(p.provenance.label, 'Owner idea, not evidence');
  assert.equal(p.sourceRecordId, null);
  assert.deepEqual(p.ideaMap, { hook: 'Who walked the waterhole at dawn?', story: 'A tigress crossed the buffer-zone road at 5:40 am.', proof: 'Sri Antra is 5 km from the Moharli gate.', audience: 'Families planning a Tadoba safari' });
  assert.ok(p.drafts.every((d: any) => d.brand_kit_version_id === 'bkv-iddav-1' && d.format_template_version_id));
  const list = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/drafts`)).data;
  assert.equal(list.filter((d: any) => d.pack_id === p.id).length, 3, 'the drafts appear in Drafts too');
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/bring-back`, { pasted: REPLY })).status, 409, 'a pack is drafted once');
});

test('C2 and C3: a Brand Fact wrong form blocks approval until fixed; a poster over the word limit is flagged', async () => {
  const w = world();
  const bad = REPLY.replace('Because the forest does.', 'Spend 27 years in the forest with us.').replace('Dawn belongs to the forest here', 'Dawn belongs to the forest here and every tiger knows your name today');
  const p = await drafted(w, bad);
  const cap = p.drafts.find((d: any) => d.template_key === 'caption');
  const poster = p.drafts.find((d: any) => d.template_key === 'poster_text');
  assert.equal(cap.checks[0].level, 'block');
  assert.match(cap.checks[0].message, /27 years in the forest/);
  assert.deepEqual(poster.checks.map((c: any) => [c.level, c.code]), [['warn', 'word_limit']]);
  const refused = await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${cap.id}/approve`, { version: cap.version });
  assert.equal(refused.status, 409); assert.match(refused.data.error, /Fix this before approving/);
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${cap.id}/edit`, { caption: 'Because the forest does. Share this with a friend.' });
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${cap.id}/approve`, { version: cap.version + 1 })).status, 200);
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${poster.id}/approve`, { version: poster.version })).status, 200, 'a warning does not block');
});

test('C4: no pack draft can be scheduled or posted without owner approval of its version', async () => {
  const w = world();
  const p = await drafted(w);
  const d = p.drafts[0];
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${d.id}/schedule`, { when: '2026-12-01T13:00:00Z', channel: 'Instagram' })).status, 409);
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${d.id}/posted`, { url: 'https://instagram.com/p/x', channel: 'Instagram' })).status, 409);
  assert.equal((await call(w.env, 'creator@iddav.com', 'POST', `${W}/drafts/${d.id}/approve`, { version: d.version })).status, 403, 'creators cannot approve');
  const plan = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/plan`, { apply: true })).data;
  assert.equal(plan.scheduled, 0, 'unapproved drafts are never scheduled by a plan');
  assert.equal((await call(w.env, 'creator@iddav.com', 'POST', `${W}/packs/${p.id}/plan`, { apply: true })).status, 403);
});

test('C5: with AI off or the budget too small, Route B refuses and nothing is sent to any provider', async () => {
  const w = world();
  w.env.ANTHROPIC_API_KEY = 'sk-test';
  const p = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs`, idea)).data;
  const off = await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/generate`);
  assert.equal(off.status, 403); assert.match(off.data.error, /switched off/);
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/ai-budget`, { enabled: true, monthlyCapInr: 1 });
  const est = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/packs/${p.id}/estimate`)).data;
  assert.equal(est.fits, false);
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/generate`)).status, 429);
  assert.equal(aiCalls.length, 0, 'no provider was called');
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/ai-budget`, { enabled: true, monthlyCapInr: 500 });
  const ok = await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/generate`);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.drafts.length, 3);
  assert.equal(ok.data.route, 'direct_ai');
  assert.equal(aiCalls.length, 1);
  const spent = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/ai-budget`)).data;
  assert.ok(spent.spentInr > 0 && spent.recent[0].task === 'content_pack', 'the call and its cost are logged against the brand');
});

test('C6: Antardrishti prompts carry "tradition, not prediction"; MANAS never sends research records and its prompts hold no research data', async () => {
  const w = world();
  const ad = (await call(w.env, 'ad@x.com', 'POST', '/v1/workspaces/ws-antardrishti/packs', { input: { kind: 'typed_idea', text: 'Explain what Ekadashi traditionally means for this week.' } })).data;
  const pr = (await call(w.env, 'ad@x.com', 'POST', `/v1/workspaces/ws-antardrishti/packs/${ad.id}/prompt`, { providerId: 'p2' })).data;
  assert.match(pr.prompt, /Tradition, not prediction/);
  assert.match(pr.prompt, /Owner idea, not evidence/);
  w.DB.raw.prepare(`INSERT INTO intelligence_records (id, code, domain, record_type, title, status, created_at, updated_at, author, author_role, observation_json, learning_strength, workspace_id)
    VALUES ('r-m', 'MAN-0001', 'manas', 'evidence', 'Participant 12 said they felt anxious', 'open', '2026-11-01', '2026-11-01', 'seed', 'owner_admin', '{}', 'provisional', 'ws-manas')`).run();
  const refused = await call(w.env, 'mn@x.com', 'POST', '/v1/workspaces/ws-manas/packs', { input: { kind: 'record', recordId: 'r-m' } });
  assert.equal(refused.status, 403);
  assert.equal((w.DB.raw.prepare("SELECT COUNT(*) AS n FROM content_packs WHERE workspace_id = 'ws-manas'").get() as any).n, 0);
});

test('C7: another brand cannot see or use Iddav\'s kit, packs or drafts (404)', async () => {
  const w = world();
  const p = await drafted(w);
  for (const [m, path] of [['GET', `${W}/brand-kit`], ['POST', `${W}/brand-kit`], ['GET', `${W}/packs`], ['GET', `${W}/packs/${p.id}`], ['POST', `${W}/packs/${p.id}/prompt`], ['POST', `${W}/packs/${p.id}/plan`], ['GET', `${W}/packs/${p.id}/estimate`]])
    assert.equal((await call(w.env, 'ad@x.com', m, path, m === 'POST' ? {} : undefined)).status, 404, `${m} ${path}`);
  assert.equal((await call(w.env, 'ad@x.com', 'GET', `/v1/workspaces/ws-antardrishti/packs/${p.id}`)).status, 404, 'not found under the other brand either');
});

test('C8: the plan follows the configured cadence and rotation; with no cadence it suggests no dates', async () => {
  const w = world();
  const p = await drafted(w);
  for (const d of p.drafts) await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${d.id}/approve`, { version: d.version });
  const plan = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/plan`, {})).data;
  const times = plan.items.map((i: any) => Date.parse(i.suggestedFor));
  assert.ok(times.every((t: number, i: number) => i === 0 || (t - times[i - 1]) / 86400_000 <= 3), 'never more than the 3-day gap');
  assert.ok(plan.items.every((i: any) => new Date(i.suggestedFor).toISOString().slice(11, 16) === '13:00'), '18:30 IST');
  const applied = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/plan`, { apply: true })).data;
  assert.equal(applied.scheduled, 3);
  const kit = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/brand-kit`)).data.current.kit;
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/brand-kit`, { kit: { ...kit, cadence: { maxGapDays: null, rotation: null, preferredTime: null } }, note: 'no rhythm' });
  const p2 = await drafted(w);
  const none = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p2.id}/plan`, {})).data;
  assert.ok(none.items.every((i: any) => i.suggestedFor === null));
  assert.match(none.note, /suggests no dates/);
});

test('C9: packs, drafts and approvals keep their Brand Kit and template versions after the kit changes', async () => {
  const w = world();
  const p = await drafted(w);
  const d = p.drafts.find((x: any) => x.template_key === 'caption');
  await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${d.id}/approve`, { version: d.version });
  const kit = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/brand-kit`)).data.current.kit;
  const v2 = await call(w.env, 'owner@iddav.com', 'POST', `${W}/brand-kit`, { kit: { ...kit, maxPosterWords: 8 }, note: 'shorter posters' });
  assert.equal(v2.status, 201);
  assert.equal(v2.data.current.version, 2);
  const again = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/packs/${p.id}`)).data;
  assert.equal(again.kit.version, 1, 'the pack stays on version 1');
  const row = w.DB.raw.prepare('SELECT brand_kit_version_id, approved_kit_version_id, approved_template_version_id, format_template_version_id FROM drafts WHERE id = ?').get(d.id) as any;
  assert.deepEqual([row.brand_kit_version_id, row.approved_kit_version_id, row.approved_template_version_id], ['bkv-iddav-1', 'bkv-iddav-1', row.format_template_version_id]);
  const newPack = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs`, idea)).data;
  assert.equal(newPack.kit.version, 2, 'new packs use the new version');
});

test('C10: Brand Kit and template versions cannot be edited or deleted, by any route or directly', async () => {
  const w = world();
  assert.throws(() => w.DB.raw.prepare("UPDATE brand_kit_versions SET kit_json = '{}'").run(), /immutable/);
  assert.throws(() => w.DB.raw.prepare('DELETE FROM brand_kit_versions').run(), /immutable/);
  assert.throws(() => w.DB.raw.prepare("UPDATE format_template_versions SET prompt_template = 'x'").run(), /immutable/);
  assert.throws(() => w.DB.raw.prepare('DELETE FROM format_template_versions').run(), /immutable/);
  for (const [m, path] of [['PATCH', `${W}/brand-kit`], ['DELETE', `${W}/brand-kit`], ['POST', `${W}/brand-kit/bkv-iddav-1`], ['DELETE', `${W}/brand-kit/bkv-iddav-1`]])
    assert.ok([404, 405].includes((await call(w.env, 'owner@iddav.com', m, path, m === 'DELETE' ? undefined : {})).status), `${m} ${path}`);
  assert.equal((await call(w.env, 'creator@iddav.com', 'POST', `${W}/brand-kit`, { kit: {} })).status, 403, 'only owners make new versions');
  const bad = await call(w.env, 'owner@iddav.com', 'POST', `${W}/brand-kit`, { kit: { formats: ['carousel'], visual: { colours: [{ name: 'x', hex: 'red' }] } } });
  assert.equal(bad.status, 400);
});

test('Route A prompt: the brand\'s rules, facts and formats are in it; personal data is redacted; the hand-off is logged', async () => {
  const w = world();
  const p = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs`, { ...idea, input: { kind: 'voice_note', text: 'Call me on 9876543210 or rama@example.com about the dawn tigress idea.' } })).data;
  assert.equal(p.provenance.kind, 'voice_note');
  const pr = (await call(w.env, 'creator@iddav.com', 'POST', `${W}/packs/${p.id}/prompt`, { providerId: 'p1' })).data;
  for (const s of ['=== carousel ===', '=== poster_text ===', '=== caption ===', 'IDEA MAP', 'at most 12 words', 'Never write: "27 years in the forest"', 'No promises of tiger sightings']) assert.ok(pr.prompt.includes(s), s);
  assert.ok(!pr.prompt.includes('9876543210') && !pr.prompt.includes('rama@example.com'));
  assert.equal(pr.redactions, 2);
  assert.match(pr.note, /own costs/);
  assert.equal((w.DB.raw.prepare('SELECT COUNT(*) AS n FROM pack_handoffs').get() as any).n, 1);
});

test('the reply parser takes only the pack\'s own formats, once each, and needs a headline', () => {
  const r = parsePackReply(`IDEA MAP\nHOOK: h\n=== caption ===\nHEADLINE: One\nCAPTION: x\n=== caption ===\nHEADLINE: Two\n=== ads ===\nHEADLINE: no\n=== story ===\nno headline here`, ['caption', 'story']);
  assert.deepEqual(r.sections.map((s) => [s.key, s.headline]), [['caption', 'One']]);
  assert.deepEqual(r.ideaMap, { hook: 'h' });
});
