// IMI ONE round 13: the brand's official links, tracked links, and link checks on drafts and pack prompts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorker } from '../src/index.ts';
import { normaliseLink } from '../src/links.ts';
import { makeD1 } from './helpers/d1.ts';

const KIT_SEED = readFileSync('schema_v17.sql', 'utf8').split('-- ---------------------------------------------------------------- starting Brand Kits')[1].split('\n').slice(1).join('\n');
function world() {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT OR IGNORE INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  DB.raw.exec(KIT_SEED);
  for (const [id, ws, email, role] of [['m1', 'ws-iddav', 'owner@iddav.com', 'owner'], ['m2', 'ws-iddav', 'creator@iddav.com', 'creator'], ['m3', 'ws-antardrishti', 'ad@x.com', 'owner']])
    run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, 'tnt-rama', ?, ?, ?, 'seed', '2026-11-01')", id, ws, email, role);
  run(`INSERT INTO ai_providers (id, workspace_id, name, url, created_by, created_at) VALUES ('p1', 'ws-iddav', 'Claude', 'https://claude.ai/new', 'seed', '2026-11-01')`);
  return { DB, env: { DB } as any };
}
async function call(env: any, who: string, method: string, path: string, body?: unknown) {
  const r = await createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: r.status, data: await r.json() as any };
}
const W = '/v1/workspaces/ws-iddav';
const setLink = (w: any, kind: string, url: string, verified = false) => call(w.env, 'owner@iddav.com', 'POST', `${W}/links`, { kind, url, verified });

test('links are cleaned when saved: another tool\'s tracking removed, https, WhatsApp needs a country code, placeholders refused', () => {
  const r = normaliseLink('google_review', 'https://search.google.com/local/writereview?placeid=ChIJTQWwJwAx0z0RR3J_Qs6yHhw&utm_source=chatgpt.com');
  assert.equal(r.url, 'https://search.google.com/local/writereview?placeid=ChIJTQWwJwAx0z0RR3J_Qs6yHhw');
  assert.match(r.notes[0], /utm_source/);
  assert.equal(normaliseLink('whatsapp', 'https://wa.me/917013352302?utm_source=chatgpt.com').url, 'https://wa.me/917013352302');
  assert.equal(normaliseLink('whatsapp', '+91 70133 52302').url, 'https://wa.me/917013352302');
  assert.throws(() => normaliseLink('whatsapp', '7013352302'), /country code/);
  assert.equal(normaliseLink('website', 'www.iddavwildstay.com').url, 'https://www.iddavwildstay.com');
  assert.equal(normaliseLink('website', 'http://iddavwildstay.com/').url, 'https://iddavwildstay.com');
  assert.equal(normaliseLink('email', 'IddavWildStay@Gmail.com').url, 'mailto:iddavwildstay@gmail.com');
  assert.match(normaliseLink('linkedin', 'https://in.linkedin.com/in/iddav-wildstay-tadoba-443002399?utm_source=chatgpt.com').notes.join(' '), /personal LinkedIn profile/);
  assert.equal(normaliseLink('instagram', 'instagram.com/iddav_wildstay?igsh=abc').url, 'https://instagram.com/iddav_wildstay');
  for (const [k, u, why] of [['instagram', 'https://facebook.com/iddav', /not a instagram link/], ['website', 'https://instagram.com/iddav_wildstay', /own website/],
    ['facebook', 'Iddav WildStay — active, exact URL not verified', /placeholder/], ['website', 'https://your-site.com', /placeholder/], ['google_review', 'https://search.google.com/local/writereview', /placeid/], ['email', 'not-an-email', /not an email/]] as const)
    assert.throws(() => normaliseLink(k, u), why, `${k} ${u}`);
});

test('one link per kind; a change keeps history and clears "checked"; only owners change; other brands see nothing', async () => {
  const w = world();
  let r = await setLink(w, 'website', 'https://www.iddavwildstay.com', true);
  assert.equal(r.status, 201);
  assert.deepEqual([r.data.links[0].kind, r.data.links[0].verified], ['website', true]);
  r = await setLink(w, 'instagram', 'https://instagram.com/iddav_wildstay');
  const ig = r.data.links.find((l: any) => l.kind === 'instagram');
  assert.equal(ig.verified, false, 'not checked until an owner confirms');
  r = await call(w.env, 'owner@iddav.com', 'POST', `${W}/links/${ig.id}/verify`);
  assert.equal(r.data.links.find((l: any) => l.kind === 'instagram').verified, true);
  r = await setLink(w, 'instagram', 'https://instagram.com/iddavwildstay');
  assert.equal(r.data.links.find((l: any) => l.kind === 'instagram').verified, false, 'a changed link must be checked again');
  assert.equal((w.DB.raw.prepare("SELECT COUNT(*) AS n FROM brand_links WHERE kind = 'instagram'").get() as any).n, 2, 'the old link stays in history');
  assert.equal((await call(w.env, 'creator@iddav.com', 'POST', `${W}/links`, { kind: 'email', url: 'a@b.com' })).status, 403);
  assert.equal((await call(w.env, 'creator@iddav.com', 'GET', `${W}/links`)).data.links.length, 2, 'everyone in the brand can read them');
  for (const [m, p] of [['GET', `${W}/links`], ['POST', `${W}/links`], ['POST', `${W}/links/${ig.id}/retire`]])
    assert.equal((await call(w.env, 'ad@x.com', m, p, m === 'POST' ? { kind: 'email', url: 'a@b.com' } : undefined)).status, 404);
  assert.equal((await setLink(w, 'facebook', 'Iddav WildStay — active, exact URL not verified')).status, 400);
});

test('tracked links: one per place, built from the website; WhatsApp links carry a reference; a campaign name can be added', async () => {
  const w = world();
  assert.match((await call(w.env, 'owner@iddav.com', 'GET', `${W}/links`)).data.note, /website link first/);
  await setLink(w, 'website', 'https://www.iddavwildstay.com/?utm_source=chatgpt.com');
  await setLink(w, 'whatsapp', 'https://wa.me/917013352302?utm_source=chatgpt.com');
  const t = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/links`)).data.tracked;
  const gbp = t.find((x: any) => x.placement === 'business_profile');
  assert.equal(gbp.url, 'https://www.iddavwildstay.com/?utm_source=google&utm_medium=organic&utm_campaign=gbp');
  assert.equal(t.find((x: any) => x.placement === 'instagram_bio').url, 'https://www.iddavwildstay.com/?utm_source=instagram&utm_medium=social&utm_campaign=bio');
  assert.equal(t.find((x: any) => x.placement === 'qr_print').whatsapp, `https://wa.me/917013352302?text=${encodeURIComponent('Hello Iddav WildStay, I would like to know more. (ref: QR)')}`);
  assert.ok(t.every((x: any) => !x.url.includes('chatgpt')));
  const c = (await call(w.env, 'owner@iddav.com', 'GET', `${W}/links?campaign=Monsoon Offer 2027`)).data.tracked.find((x: any) => x.placement === 'whatsapp');
  assert.match(c.url, /utm_campaign=monsoon_offer_2027$/);
  assert.equal(c.ref, 'WA-MONSOON-OFFER-2027');
});

test('pack prompts carry the brand\'s own links (not redacted) and Instagram formats are told links are not clickable', async () => {
  const w = world();
  const p0 = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs`, { input: { kind: 'typed_idea', text: 'Monsoon is when the buffer zone turns green; we stay open.' }, formats: ['caption', 'whatsapp_status'] })).data;
  assert.match((await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p0.id}/prompt`, { providerId: 'p1' })).data.prompt, /LINKS: none saved/);
  await setLink(w, 'website', 'https://www.iddavwildstay.com', true);
  await setLink(w, 'whatsapp', '+91 70133 52302', true);
  await setLink(w, 'google_review', 'https://search.google.com/local/writereview?placeid=ChIJTQWwJwAx0z0RR3J_Qs6yHhw', true);
  const p = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs`, { input: { kind: 'typed_idea', text: 'Monsoon is when the buffer zone turns green; call 98765 43210 for details.' }, formats: ['caption', 'story'] })).data;
  const pr = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/prompt`, { providerId: 'p1' })).data;
  assert.match(pr.prompt, /WhatsApp for enquiries: \+917013352302 \(where links can be clicked: https:\/\/wa\.me\/917013352302\?text=.*IG-BIO/);
  assert.match(pr.prompt, /Story link sticker: https:\/\/www\.iddavwildstay\.com\/\?utm_source=instagram&utm_medium=social&utm_campaign=story/);
  assert.match(pr.prompt, /link in bio/);
  assert.match(pr.prompt, /placeid=ChIJTQWwJwAx0z0RR3J_Qs6yHhw/);
  assert.match(pr.prompt, /\[phone removed\]/, 'other numbers in the idea are still removed');
  assert.ok(pr.prompt.indexOf('LINKS (') < pr.prompt.indexOf('IDEA MAP'));
});

test('drafts warn (never block) on links that are not the brand\'s own, not checked, or carry another tool\'s tracking', async () => {
  const w = world();
  await setLink(w, 'website', 'https://www.iddavwildstay.com', true);
  await setLink(w, 'whatsapp', '917013352302', true);
  await setLink(w, 'instagram', 'https://instagram.com/iddav_wildstay');
  const reply = `IDEA MAP
HOOK: Green season?

=== caption ===
HEADLINE: Who stays when the rains come?
CAPTION: Book at https://www.iddavwildstay.com/stay?utm_source=instagram&utm_medium=social&utm_campaign=bio or WhatsApp https://wa.me/919999999999. Follow instagram.com/iddav_wildstay and see https://www.iddavwildstay.com/?utm_source=chatgpt.com plus https://randomsite.in/x. Mail hello@other.com.
`;
  const p = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs`, { input: { kind: 'typed_idea', text: 'Monsoon green season.' }, formats: ['caption'] })).data;
  const b = (await call(w.env, 'owner@iddav.com', 'POST', `${W}/packs/${p.id}/bring-back`, { pasted: reply, providerId: 'p1' })).data;
  const codes = b.drafts[0].checks.map((c: any) => c.code);
  assert.ok(codes.includes('link_not_official'), 'the wrong WhatsApp number');
  assert.ok(codes.includes('link_unchecked'), 'Instagram not checked yet');
  assert.ok(codes.includes('link_tracking'), 'utm_source=chatgpt.com');
  assert.ok(codes.includes('link_unknown'), 'an unknown site and an email with none saved');
  assert.ok(!b.drafts[0].checks.some((c: any) => c.message.includes('utm_source=instagram')), 'our own tracked link is fine');
  assert.ok(b.drafts[0].checks.every((c: any) => c.level === 'warn'));
  const d = b.drafts[0];
  assert.equal((await call(w.env, 'owner@iddav.com', 'POST', `${W}/drafts/${d.id}/approve`, { version: d.version })).status, 200, 'link warnings do not block approval');
});
