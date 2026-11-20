// IMI ONE round 14: Build 5, partner and corporate outreach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorker } from '../src/index.ts';
import { io } from '../src/search.ts';
import { parseCsv, parseSequenceReply, dailyChecks } from '../src/partners.ts';
import { makeD1 } from './helpers/d1.ts';

const KIT_SEED = readFileSync('schema_v17.sql', 'utf8').split('-- ---------------------------------------------------------------- starting Brand Kits')[1].split('\n').slice(1).join('\n');
let fetched: string[] = [];
let pages: Record<string, { status: number; body: string }> = {};
io.fetch = async (input: any) => {
  const url = String(input); fetched.push(url);
  const p = pages[url] ?? Object.entries(pages).find(([k]) => url.startsWith(k))?.[1];
  return new Response(p?.body ?? 'not found', { status: p?.status ?? 404 });
};

function world() {
  fetched = []; pages = {};
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT OR IGNORE INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  DB.raw.exec(KIT_SEED);
  for (const [id, ws, email, role] of [['m1', 'ws-iddav', 'owner@iddav.com', 'owner'], ['m2', 'ws-iddav', 'creator@iddav.com', 'creator'], ['m3', 'ws-antardrishti', 'ad@x.com', 'owner']])
    run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, 'tnt-rama', ?, ?, ?, 'seed', '2026-11-01')", id, ws, email, role);
  run(`INSERT INTO brand_facts (id, workspace_id, statement, wrong_forms_json, created_by, created_at) VALUES ('f1', 'ws-iddav', 'Rama has 27 years of total experience and 5 years in the forest.', '["27 years in the forest"]', 'seed', '2026-11-01')`);
  run(`INSERT INTO ai_providers (id, workspace_id, name, url, created_by, created_at) VALUES ('p1', 'ws-iddav', 'Claude', 'https://claude.ai/new', 'seed', '2026-11-01')`);
  return { DB, env: { DB } as any };
}
async function call(env: any, who: string, method: string, path: string, body?: unknown) {
  const r = await createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: r.status, data: await r.json() as any };
}
const W = '/v1/workspaces/ws-iddav/partners';
const O = 'owner@iddav.com';
const PROFILE = {
  segments: [
    { key: 'travel_agent', label: 'Travel agents and tour operators', offer: 'A trade rate on yurt stays at Sri Antra near Tadoba, with safari booking help for their guests.', keywords: ['tour', 'wildlife', 'safari', 'package'] },
    { key: 'corporate', label: 'Companies planning team offsites', offer: 'Two-night team offsites in the forest buffer zone for groups of 10 to 24.', keywords: ['offsite', 'team'] },
  ],
  cities: ['Nagpur', 'Hyderabad'], dailyLimit: 2, senderName: 'Rama', optOutLine: 'If this is not relevant, reply "no thanks" and we will not write again.',
};
const SEQ = `=== email_1 ===
SUBJECT: Tadoba stays for {organisation}'s guests
Hello {name}, we run Sri Antra, a forest-edge stay near Tadoba. Many travellers from {city} ask agents like {organisation} for a quiet base near the tiger reserve. Could we send you our trade rates?

=== email_2 ===
SUBJECT: A quieter Tadoba base
Hello {name}, following up on my note. Our guests wake to alarm calls and walk to the buffer-zone gate. Would a short call this week suit {organisation}?

=== email_3 ===
SUBJECT: Closing the loop
Hello {name}, I will not write again after this. If {organisation} ever plans Tadoba trips from {city}, we would be glad to help.
`;

test('the partner profile: defaults until saved, an opt-out line is required, only owners change it, other brands see nothing', async () => {
  const w = world();
  const s = (await call(w.env, O, 'GET', W)).data;
  assert.equal(s.saved, false);
  assert.ok(s.profile.segments.some((x: any) => x.key === 'travel_agent' && x.osm));
  assert.equal(s.partnerBookings.status, 'unavailable', 'bookings come from the CRM, never guessed');
  assert.equal((await call(w.env, O, 'POST', `${W}/profile`, { ...PROFILE, optOutLine: 'Thanks!' })).status, 400);
  assert.equal((await call(w.env, O, 'POST', `${W}/profile`, { ...PROFILE, dailyLimit: 500 })).status, 400);
  assert.equal((await call(w.env, 'creator@iddav.com', 'POST', `${W}/profile`, PROFILE)).status, 403);
  const saved = (await call(w.env, O, 'POST', `${W}/profile`, PROFILE)).data;
  assert.deepEqual([saved.saved, saved.profile.dailyLimit, saved.profile.segments.length], [true, 2, 2]);
  for (const [m, p] of [['GET', W], ['GET', `${W}/prospects`], ['POST', `${W}/prospects`], ['GET', `${W}/outbox`]])
    assert.equal((await call(w.env, 'ad@x.com', m, p.replace('ws-iddav', 'ws-iddav'), m === 'POST' ? { name: 'X', segment: 'travel_agent' } : undefined)).status, 404);
});

test('prospects: by hand, from CSV and from OpenStreetMap; duplicates and opted-out addresses are never added twice', async () => {
  const w = world();
  await call(w.env, O, 'POST', `${W}/profile`, PROFILE);
  const a = await call(w.env, 'creator@iddav.com', 'POST', `${W}/prospects`, { name: 'Green Trails Tours', segment: 'travel_agent', email: 'Info@GreenTrails.in', website: 'greentrails.in', city: 'Nagpur' });
  assert.equal(a.status, 201);
  assert.deepEqual([a.data.email, a.data.website, a.data.stage, a.data.source], ['info@greentrails.in', 'https://greentrails.in', 'new', 'manual']);
  assert.equal((await call(w.env, O, 'POST', `${W}/prospects`, { name: 'Another', segment: 'travel_agent', website: 'https://www.greentrails.in/about' })).status, 409, 'same website');
  assert.equal((await call(w.env, O, 'POST', `${W}/prospects`, { name: 'X', segment: 'yoga' })).status, 400);
  await call(w.env, O, 'POST', `${W}/suppressions`, { value: 'stop@nomail.in' });
  assert.equal((await call(w.env, O, 'POST', `${W}/prospects`, { name: 'No Mail', segment: 'corporate', email: 'stop@nomail.in' })).status, 409);
  const csv = 'Name,Segment,Email,Website,City,Contact Person\n"Acme Tech, Pune",corporate,hr@acme.in,,Pune,Priya\nGreen Trails Tours,travel_agent,,,Nagpur,\nNo Mail,corporate,stop@nomail.in,,,\nBad,corporate,not-an-email,,,\n';
  assert.equal(parseCsv(csv)[0].name, 'Acme Tech, Pune');
  const imp = (await call(w.env, O, 'POST', `${W}/import`, { csv })).data;
  assert.deepEqual([imp.added, imp.duplicates, imp.optedOut, imp.errors.length, imp.errors[0].row], [1, 1, 1, 1, 5]);
  pages['https://overpass-api.de/api/interpreter'] = { status: 200, body: JSON.stringify({ elements: [
    { type: 'node', id: 1, tags: { name: 'Tiger Trails Travels', shop: 'travel_agency', website: 'http://tigertrails.in', email: 'book@tigertrails.in', 'addr:city': 'Nagpur' } },
    { type: 'node', id: 2, tags: { name: 'No Contact Travels', shop: 'travel_agency' } },
    { type: 'way', id: 3, tags: { name: 'Green Trails Tours', website: 'https://greentrails.in' } },
  ] }) };
  const d = await call(w.env, O, 'POST', `${W}/discover`, { segment: 'travel_agent', city: 'Nagpur' });
  assert.equal(d.status, 201);
  assert.deepEqual([d.data.found, d.data.added, d.data.withoutContact, d.data.duplicates], [3, 1, 1, 1]);
  assert.match(d.data.attribution, /OpenStreetMap contributors/);
  assert.equal((await call(w.env, O, 'POST', `${W}/discover`, { segment: 'travel_agent', city: 'Nagpur' })).data.added, 0, 'the same listing is not added twice');
  assert.equal((await call(w.env, O, 'POST', `${W}/discover`, { segment: 'corporate', city: 'Pune' })).status, 400, 'OpenStreetMap does not list HR teams');
  assert.equal((await call(w.env, 'creator@iddav.com', 'POST', `${W}/discover`, { segment: 'travel_agent', city: 'Nagpur' })).status, 403);
  assert.equal((await call(w.env, O, 'GET', `${W}/prospects`)).data.length, 3);
});

test('the website check scores with reasons and no AI; it can find a business email; the daily run checks new ones only', async () => {
  const w = world();
  await call(w.env, O, 'POST', `${W}/profile`, PROFILE);
  const p = (await call(w.env, O, 'POST', `${W}/prospects`, { name: 'Tiger Trails', segment: 'travel_agent', website: 'https://tigertrails.in', city: 'Nagpur' })).data;
  pages['https://tigertrails.in'] = { status: 200, body: '<html><script>var x="tour"</script><h1>Wildlife safari packages</h1><p>Write to <a href="mailto:info@tigertrails.in">info@tigertrails.in</a> or logo@2x.png</p></html>' };
  const c = (await call(w.env, O, 'POST', `${W}/prospects/${p.id}/check`)).data;
  assert.equal(c.email, 'info@tigertrails.in');
  assert.equal(c.score, 20 + 20 + 30 + 20, 'reachable + email + 3 fit words (wildlife, safari, package) + target city');
  assert.ok(c.signals.some((s: any) => /Fit words.*wildlife/.test(s.why)));
  assert.ok(!fetched.some((u) => u.includes('anthropic')), 'no AI call');
  const q = (await call(w.env, O, 'POST', `${W}/prospects`, { name: 'Down Site', segment: 'travel_agent', website: 'https://down.in' })).data;
  pages['https://down.in'] = { status: 500, body: '' };
  assert.equal(await dailyChecks(w.env), 1, 'only the unchecked one');
  const d = (await call(w.env, O, 'GET', `${W}/prospects/${q.id}`)).data;
  assert.deepEqual([d.score, d.checkError], [0, 'the website answered 500']);
});

test('sequences: the offer must be written first; three emails come back; a wrong Brand Fact or a [blank] blocks approval; only owners approve', async () => {
  const w = world();
  await call(w.env, O, 'POST', `${W}/profile`, { ...PROFILE, segments: [{ ...PROFILE.segments[0], offer: '' }] });
  assert.match((await call(w.env, O, 'POST', `${W}/sequences/prompt`, { segment: 'travel_agent', providerId: 'p1' })).data.error, /what you offer/);
  await call(w.env, O, 'POST', `${W}/profile`, PROFILE);
  const pr = (await call(w.env, 'creator@iddav.com', 'POST', `${W}/sequences/prompt`, { segment: 'travel_agent', providerId: 'p1' })).data;
  assert.match(pr.prompt, /trade rate on yurt stays/);
  assert.match(pr.prompt, /\{organisation\}/);
  assert.match(pr.prompt, /Never write: "27 years in the forest"/);
  assert.match(pr.prompt, /=== email_3 ===/);
  assert.equal(parseSequenceReply(SEQ).length, 3);
  const bad = SEQ.replace('we run Sri Antra', 'with 27 years in the forest, we run Sri Antra').replace('Closing the loop', 'Hi [Name]');
  let list = (await call(w.env, 'creator@iddav.com', 'POST', `${W}/sequences`, { segment: 'travel_agent', pasted: bad, providerId: 'p1' })).data;
  assert.equal(list[0].source, 'Claude');
  assert.deepEqual(list[0].checks.filter((c: any) => c.level === 'block').map((c: any) => c.code).sort(), ['placeholder', 'wrong_form']);
  assert.equal((await call(w.env, O, 'POST', `${W}/sequences/${list[0].id}/approve`)).status, 409);
  assert.equal((await call(w.env, O, 'POST', `${W}/sequences`, { segment: 'travel_agent', pasted: 'just some text' })).status, 400);
  list = (await call(w.env, O, 'POST', `${W}/sequences/${list[0].id}/edit`, { emails: parseSequenceReply(SEQ) })).data;
  assert.equal(list.length, 1, 'the bad draft is replaced');
  assert.deepEqual([list[0].version, list[0].checks.filter((c: any) => c.level === 'block').length], [2, 0]);
  assert.equal((await call(w.env, 'creator@iddav.com', 'POST', `${W}/sequences/${list[0].id}/approve`)).status, 403);
  assert.equal((await call(w.env, O, 'POST', `${W}/sequences/${list[0].id}/approve`)).data[0].status, 'approved');
  assert.equal((await call(w.env, O, 'POST', `${W}/sequences/generate`, { segment: 'travel_agent' })).status, 403, 'AI is off until an owner sets a budget');
});

test('outbox: merged emails with the opt-out line, a daily limit, follow-ups only after their day, any reply stops them, opt-outs are kept for ever', async () => {
  const w = world();
  w.DB.raw.prepare("INSERT INTO brand_links (id, workspace_id, kind, url, created_by, created_at) VALUES ('l1', 'ws-iddav', 'website', 'https://www.iddavwildstay.com', 'o', 'x')").run();
  await call(w.env, O, 'POST', `${W}/profile`, PROFILE);
  const add = async (name: string, email: string | null, city = 'Nagpur') => (await call(w.env, O, 'POST', `${W}/prospects`, { name, segment: 'travel_agent', email, city })).data.id;
  const ids = [await add('Tiger Trails', 'book@tigertrails.in'), await add('Jungle Jaunts', 'hi@jj.in', 'Pune'), await add('Safari Co', 'team@safari.co'), await add('No Email', null)];
  assert.match((await call(w.env, O, 'POST', `${W}/prepare`, { prospectIds: ids })).data.skipped[0].reason, /no approved sequence/);
  const seq = (await call(w.env, O, 'POST', `${W}/sequences`, { segment: 'travel_agent', pasted: SEQ })).data[0];
  await call(w.env, O, 'POST', `${W}/sequences/${seq.id}/approve`);
  const prep = (await call(w.env, 'creator@iddav.com', 'POST', `${W}/prepare`, { prospectIds: ids })).data;
  assert.deepEqual([prep.prepared, prep.skipped.map((s: any) => s.reason)], [3, ['no email address']]);
  let box = (await call(w.env, O, 'GET', `${W}/outbox`)).data;
  assert.deepEqual([box.due, box.left, box.messages.length], [3, 2, 2], 'only today\'s limit is shown');
  const m = box.messages.find((x: any) => x.name === 'Jungle Jaunts');
  assert.equal(m.subject, "Tadoba stays for Jungle Jaunts's guests");
  assert.match(m.body, /travellers from Pune ask agents like Jungle Jaunts/);
  assert.match(m.body, /Hello Jungle Jaunts team/);
  assert.match(m.body, /Rama, Iddav WildStay\nhttps:\/\/www\.iddavwildstay\.com\/\?utm_source=email&utm_medium=outreach&utm_campaign=partner_travel_agent/);
  assert.match(m.body, /reply "no thanks" and we will not write again\.$/);
  const today = (await call(w.env, O, 'GET', '/v1/workspaces/ws-iddav/today')).data;
  assert.ok(today.needsYou.some((n: any) => n.kind === 'send_outreach' && n.title === '2 partner emails ready to send'));
  assert.equal((await call(w.env, 'creator@iddav.com', 'POST', `${W}/messages/${m.id}/sent`)).status, 403, 'an owner sends');
  box = (await call(w.env, O, 'POST', `${W}/messages/${box.messages[0].id}/sent`)).data;
  box = (await call(w.env, O, 'POST', `${W}/messages/${box.messages[0].id}/sent`)).data;
  assert.deepEqual([box.sentToday, box.left, box.messages.length], [2, 0, 0]);
  const third = w.DB.raw.prepare("SELECT id FROM outreach_messages WHERE status = 'ready'").get() as any;
  assert.equal((await call(w.env, O, 'POST', `${W}/messages/${third.id}/sent`)).status, 429, 'the daily limit holds');
  const sentTo = (w.DB.raw.prepare("SELECT prospect_id FROM outreach_messages WHERE status = 'sent'").all() as any[]).map((r) => r.prospect_id);
  const follow = w.DB.raw.prepare("SELECT status, due_at FROM outreach_messages WHERE prospect_id = ? AND step = 2").get(sentTo[0]) as any;
  assert.equal(follow.status, 'ready');
  assert.ok(Date.parse(follow.due_at) - Date.now() > 3.9 * 86400_000, 'the follow-up waits 4 days');
  let p = (await call(w.env, O, 'POST', `${W}/prospects/${sentTo[0]}/reply`, { outcome: 'interested', note: 'Wants trade rates' })).data;
  assert.equal(p.stage, 'replied');
  assert.deepEqual(p.messages.map((x: any) => x.status), ['sent', 'stopped', 'stopped'], 'no "just checking in" after a reply');
  p = (await call(w.env, O, 'POST', `${W}/prospects/${sentTo[1]}/reply`, { outcome: 'opt_out' })).data;
  assert.equal(p.stage, 'opted_out');
  assert.equal((await call(w.env, O, 'POST', `${W}/prospects/${sentTo[1]}/stage`, { stage: 'new' })).status, 409);
  assert.equal((await call(w.env, O, 'POST', `${W}/prospects`, { name: 'Same again', segment: 'travel_agent', email: p.email })).status, 409);
  assert.throws(() => w.DB.raw.prepare('DELETE FROM outreach_suppressions').run(), /never contacted again/);
  await call(w.env, O, 'POST', `${W}/suppressions`, { value: 'safari.co' });
  const sc = (await call(w.env, O, 'GET', `${W}/prospects`)).data.find((x: any) => x.name === 'Safari Co');
  assert.equal(sc.stage, 'opted_out', 'a whole domain can opt out');
  assert.equal((await call(w.env, O, 'GET', `${W}/outbox`)).data.due, 0);
  const sum = (await call(w.env, O, 'GET', W)).data;
  assert.deepEqual([sum.emailsSent, sum.organisationsReplied, sum.stages.opted_out], [2, 2, 2]);
});
