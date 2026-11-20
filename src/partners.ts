// IMI ONE round 14: Build 5, partner and corporate outreach (patterns borrowed from Harvey, not its code).
//
//   Find:     prospects added by hand, from a CSV file, or from OpenStreetMap (free open data, business listings only).
//   Check:    one look at the prospect's website (no AI): reachable, a business email, words that show a fit, the city.
//             The score comes with its reasons.
//   Write:    a 3-email sequence per segment, written with AI (Send to AI, or direct through the AI budget gate),
//             checked against Brand Facts and approved by an owner.
//   Send:     an outbox with a daily limit. A person sends each email from their own mail app and marks it sent.
//             IMI ONE never sends email itself.
//   Replies:  logged by hand; any reply stops the sequence; an opt-out is kept for ever.
//   Measure:  stages from contacted to partner. Partner bookings come from the CRM once it is linked.

import type { Env } from './env';
import { HttpError, now } from './http';
import type { Membership } from './tenancy';
import { listFacts } from './admin';
import { redact } from './create';
import { activeLinks } from './links';
import { checkText, getKit } from './engine';
import { aiGate, getBudget, costInr } from './aibudget';
import { io, redact as redactSecrets } from './search';

const iso = () => new Date().toISOString();
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;
export const SEQUENCE_PROMPT_VERSION = 'imi-partners-1.0 (2026-11-20)';

// ---------------------------------------------------------------- profile

export interface Segment { key: string; label: string; offer: string; keywords: string[]; osm: boolean }
export interface PartnerProfile { segments: Segment[]; cities: string[]; dailyLimit: number; senderName: string; optOutLine: string }

// OpenStreetMap tags for segments it covers well. Companies' HR teams and event planners are rarely listed there.
const OSM_TAGS: Record<string, string[]> = {
  travel_agent: ['["shop"="travel_agency"]', '["office"="travel_agent"]', '["office"="tour_operator"]'],
  school: ['["amenity"="school"]'],
};

export const DEFAULT_PROFILE: PartnerProfile = {
  segments: [
    { key: 'corporate', label: 'Companies planning team offsites', offer: '', keywords: ['offsite', 'team outing', 'employee engagement', 'retreat', 'corporate', 'leadership'], osm: false },
    { key: 'travel_agent', label: 'Travel agents and tour operators', offer: '', keywords: ['tour', 'holiday', 'package', 'wildlife', 'safari', 'nature'], osm: true },
    { key: 'events', label: 'Wedding and event planners', offer: '', keywords: ['wedding', 'destination', 'event', 'celebration', 'venue'], osm: false },
    { key: 'school', label: 'Schools (nature and life-skills camps)', offer: '', keywords: ['excursion', 'field trip', 'camp', 'outdoor', 'nature', 'cbse', 'icse'], osm: true },
  ],
  cities: [], dailyLimit: 15, senderName: '',
  optOutLine: 'If this is not relevant, reply "no thanks" and we will not write again.',
};

export async function getProfile(env: Env, ws: string) {
  const r = await env.DB.prepare('SELECT profile_json, updated_by, updated_at FROM partner_profiles WHERE workspace_id = ?').bind(ws).first<any>();
  return r ? { profile: JSON.parse(r.profile_json) as PartnerProfile, updatedBy: r.updated_by, updatedAt: r.updated_at, saved: true }
    : { profile: DEFAULT_PROFILE, updatedBy: null, updatedAt: null, saved: false };
}

export function validateProfile(b: any): PartnerProfile {
  const segs: Segment[] = (Array.isArray(b?.segments) ? b.segments : []).slice(0, 8).map((s: any) => {
    const key = clip(s?.key, 30).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    return { key, label: clip(s?.label, 80), offer: clip(s?.offer, 600), keywords: (Array.isArray(s?.keywords) ? s.keywords : []).map((k: unknown) => clip(k, 40).toLowerCase()).filter(Boolean).slice(0, 15), osm: !!OSM_TAGS[key] };
  }).filter((s: Segment) => s.key && s.label);
  if (!segs.length) throw new HttpError(400, 'Add at least one kind of partner.');
  if (new Set(segs.map((s) => s.key)).size !== segs.length) throw new HttpError(400, 'Each kind of partner needs its own key.');
  const dailyLimit = b?.dailyLimit === undefined ? 15 : Number(b.dailyLimit);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 40) throw new HttpError(400, 'Daily limit: a whole number from 1 to 40. Keep it low so each email is personal.');
  const optOutLine = clip(b?.optOutLine, 200) || DEFAULT_PROFILE.optOutLine;
  if (!/(no thanks|unsubscribe|opt out|not write again|stop)/i.test(optOutLine)) throw new HttpError(400, 'The opt-out line must tell people how to stop the emails, for example: reply "no thanks".');
  return {
    segments: segs, cities: (Array.isArray(b?.cities) ? b.cities : []).map((c: unknown) => clip(c, 40)).filter(Boolean).slice(0, 12),
    dailyLimit, senderName: clip(b?.senderName, 80), optOutLine,
  };
}

export async function saveProfile(env: Env, ws: string, who: string, body: any) {
  const p = validateProfile(body);
  await env.DB.prepare(`INSERT INTO partner_profiles (workspace_id, profile_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET profile_json = excluded.profile_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(ws, JSON.stringify(p), who, iso()).run();
  return getProfile(env, ws);
}

const segmentOf = (p: PartnerProfile, key: string) => {
  const s = p.segments.find((x) => x.key === key);
  if (!s) throw new HttpError(400, 'Choose one of the kinds of partner in the profile.');
  return s;
};

// ---------------------------------------------------------------- prospects

const host = (url: string | null) => { try { return url ? new URL(url).hostname.replace(/^www\./, '').toLowerCase() : null; } catch { return null; } };
const cleanUrl = (raw: unknown) => {
  const s = clip(raw, 300); if (!s) return null;
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); return u.protocol.startsWith('http') ? u.toString().replace(/\/$/, '') : null; } catch { return null; }
};

async function suppressed(env: Env, ws: string, email: string | null) {
  if (!email) return false;
  const e = email.toLowerCase(), d = `@${e.split('@')[1]}`;
  return !!(await env.DB.prepare('SELECT 1 FROM outreach_suppressions WHERE workspace_id = ? AND value IN (?, ?)').bind(ws, e, d).first());
}

async function duplicateOf(env: Env, ws: string, p: { email: string | null; website: string | null; name: string; city: string | null; sourceRef?: string | null }) {
  if (p.sourceRef && await env.DB.prepare('SELECT 1 FROM prospects WHERE workspace_id = ? AND source_ref = ?').bind(ws, p.sourceRef).first()) return true;
  if (p.email && await env.DB.prepare('SELECT 1 FROM prospects WHERE workspace_id = ? AND lower(email) = ?').bind(ws, p.email.toLowerCase()).first()) return true;
  const h = host(p.website);
  if (h) {
    const { results } = await env.DB.prepare('SELECT website FROM prospects WHERE workspace_id = ? AND website IS NOT NULL').bind(ws).all<any>();
    if ((results ?? []).some((r) => host(r.website) === h)) return true;
  }
  return !!(await env.DB.prepare('SELECT 1 FROM prospects WHERE workspace_id = ? AND lower(name) = ? AND lower(coalesce(city, \'\')) = ?').bind(ws, p.name.toLowerCase(), (p.city ?? '').toLowerCase()).first());
}

function readProspect(b: any, segments: Segment[]) {
  const name = clip(b?.name, 120);
  if (name.length < 2) throw new HttpError(400, 'Give the organisation\'s name.');
  const segment = clip(b?.segment, 30);
  if (!segments.some((s) => s.key === segment)) throw new HttpError(400, `Unknown kind of partner "${segment}".`);
  const email = clip(b?.email, 160).toLowerCase() || null;
  if (email && !EMAIL.test(email)) throw new HttpError(400, `"${email}" is not an email address.`);
  return { name, segment, email, website: cleanUrl(b?.website), phone: clip(b?.phone, 30) || null, city: clip(b?.city, 60) || null, contactPerson: clip(b?.contactPerson ?? b?.contact_person, 80) || null, notes: clip(b?.notes, 500) || null };
}

async function insertProspect(env: Env, ws: string, who: string, p: ReturnType<typeof readProspect>, source: 'manual' | 'csv' | 'osm', sourceRef: string | null = null) {
  const at = iso(), id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO prospects (id, workspace_id, segment, name, contact_person, email, website, phone, city, source, source_ref, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, ws, p.segment, p.name, p.contactPerson, p.email, p.website, p.phone, p.city, source, sourceRef, p.notes, who, at, at).run();
  return id;
}

export async function addProspect(env: Env, ws: string, who: string, body: any) {
  const { profile } = await getProfile(env, ws);
  const p = readProspect(body, profile.segments);
  if (await suppressed(env, ws, p.email)) throw new HttpError(409, 'This address asked not to be contacted. It cannot be added again.');
  if (await duplicateOf(env, ws, p)) throw new HttpError(409, 'This organisation is already in the list.');
  return getProspect(env, ws, await insertProspect(env, ws, who, p, 'manual'));
}

// A simple CSV reader: a header row, commas, and double quotes around fields that contain commas.
export function parseCsv(text: string) {
  const rows: string[][] = []; let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const clean = rows.filter((r) => r.some((x) => x.trim()));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export async function importCsv(env: Env, ws: string, who: string, body: any) {
  const rows = parseCsv(clip(body?.csv, 200_000));
  if (!rows.length) throw new HttpError(400, 'No rows found. The first line must name the columns: name, segment, email, website, phone, city, contact_person.');
  if (rows.length > 500) throw new HttpError(400, 'At most 500 rows at a time.');
  const { profile } = await getProfile(env, ws);
  const out = { added: 0, duplicates: 0, optedOut: 0, errors: [] as { row: number; error: string }[] };
  for (let i = 0; i < rows.length; i++) {
    try {
      const p = readProspect({ ...rows[i], segment: rows[i].segment || body?.segment }, profile.segments);
      if (await suppressed(env, ws, p.email)) { out.optedOut++; continue; }
      if (await duplicateOf(env, ws, p)) { out.duplicates++; continue; }
      await insertProspect(env, ws, who, p, 'csv'); out.added++;
    } catch (e) { out.errors.push({ row: i + 2, error: e instanceof Error ? e.message : 'invalid' }); }
  }
  return { ...out, errors: out.errors.slice(0, 20) };
}

// OpenStreetMap (Overpass API): business listings in one city for segments it covers. Free, no key, owner-triggered.
export async function discover(env: Env, ws: string, who: string, body: any) {
  const { profile } = await getProfile(env, ws);
  const seg = segmentOf(profile, clip(body?.segment, 30));
  const tags = OSM_TAGS[seg.key];
  if (!tags) throw new HttpError(400, 'OpenStreetMap does not list this kind of partner well. Add them by hand or from a CSV file.');
  const city = clip(body?.city, 60).replace(/[^\p{L}\p{N} .'-]/gu, '');
  if (city.length < 2) throw new HttpError(400, 'Give a city.');
  const query = `[out:json][timeout:25];area["name"="${city}"]["boundary"="administrative"]->.a;(${tags.map((t) => `nwr(area.a)${t};`).join('')});out tags center 80;`;
  let data: any;
  try {
    const res = await io.fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'IMI-ONE partner finder (owner-triggered)' }, body: `data=${encodeURIComponent(query)}` });
    if (!res.ok) throw new Error(`OpenStreetMap answered ${res.status}`);
    data = await res.json();
  } catch (e) { throw new HttpError(502, `OpenStreetMap could not be reached (${e instanceof Error ? e.message : 'error'}). Try again in a few minutes.`); }
  const out = { found: 0, added: 0, duplicates: 0, withoutContact: 0, attribution: '© OpenStreetMap contributors (ODbL)' };
  for (const el of (data?.elements ?? []).slice(0, 80)) {
    const t = el.tags ?? {};
    if (!t.name) continue;
    out.found++;
    const email = clip(t.email ?? t['contact:email'], 160).toLowerCase().split(/[;,]/)[0] || null;
    const website = cleanUrl(t.website ?? t['contact:website'] ?? t.url);
    if (!email && !website) { out.withoutContact++; continue; }
    const p = { name: clip(t.name, 120), segment: seg.key, email: email && EMAIL.test(email) ? email : null, website, phone: clip(t.phone ?? t['contact:phone'], 30) || null, city: clip(t['addr:city'], 60) || city, contactPerson: null, notes: null };
    const ref = `osm:${el.type}/${el.id}`;
    if (await suppressed(env, ws, p.email) || await duplicateOf(env, ws, { ...p, sourceRef: ref })) { out.duplicates++; continue; }
    await insertProspect(env, ws, who, p, 'osm', ref); out.added++;
  }
  return out;
}

const prospectRow = (r: any) => ({
  id: r.id, segment: r.segment, name: r.name, contactPerson: r.contact_person, email: r.email, website: r.website, phone: r.phone, city: r.city, source: r.source,
  score: r.score, signals: JSON.parse(r.signals_json || '[]'), checkedAt: r.checked_at, checkError: r.check_error, stage: r.stage, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
});

export async function listProspects(env: Env, ws: string, q: URLSearchParams) {
  const seg = q.get('segment'), stage = q.get('stage');
  const { results } = await env.DB.prepare(`SELECT * FROM prospects WHERE workspace_id = ? AND (? IS NULL OR segment = ?) AND (? IS NULL OR stage = ?) AND stage != 'archived'
    ORDER BY coalesce(score, -1) DESC, created_at DESC LIMIT 300`).bind(ws, seg, seg, stage, stage).all<any>();
  return (results ?? []).map(prospectRow);
}

export async function getProspect(env: Env, ws: string, id: string) {
  const r = await env.DB.prepare('SELECT * FROM prospects WHERE id = ? AND workspace_id = ?').bind(id, ws).first<any>();
  if (!r) throw new HttpError(404, 'Prospect not found');
  const { results: msgs } = await env.DB.prepare('SELECT id, step, subject, body, status, due_at, sent_at, sent_by, to_email FROM outreach_messages WHERE prospect_id = ? AND workspace_id = ? ORDER BY step').bind(id, ws).all<any>();
  const { results: replies } = await env.DB.prepare('SELECT outcome, note, logged_by, logged_at FROM outreach_replies WHERE prospect_id = ? AND workspace_id = ? ORDER BY logged_at DESC').bind(id, ws).all<any>();
  return { ...prospectRow(r), messages: msgs ?? [], replies: replies ?? [] };
}

// ---------------------------------------------------------------- website check (no AI)

export async function checkProspect(env: Env, ws: string, id: string) {
  const r = await env.DB.prepare('SELECT * FROM prospects WHERE id = ? AND workspace_id = ?').bind(id, ws).first<any>();
  if (!r) throw new HttpError(404, 'Prospect not found');
  const { profile } = await getProfile(env, ws);
  const seg = profile.segments.find((s) => s.key === r.segment);
  const signals: { points: number; why: string }[] = [];
  let html = '', error: string | null = null, foundEmail: string | null = null;
  if (r.website) {
    try {
      const res = await io.fetch(r.website, { headers: { 'user-agent': 'IMI-ONE partner check (one visit to the home page)' }, redirect: 'follow' } as RequestInit);
      if (!res.ok) throw new Error(`the website answered ${res.status}`);
      html = (await res.text()).slice(0, 400_000);
    } catch (e) { error = e instanceof Error ? e.message : 'not reachable'; }
  } else error = 'no website';
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  if (html) signals.push({ points: 20, why: 'Website reachable' });
  if (html) {
    const emails = [...new Set((html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((e) => e.toLowerCase()))].filter((e) => !/\.(png|jpg|jpeg|gif|webp|svg)$/.test(e) && !/example|sentry|wixpress|domain\.com/.test(e));
    const h = host(r.website);
    foundEmail = emails.find((e) => h && e.endsWith(`@${h}`)) ?? emails.find((e) => /^(info|contact|hello|enquir|sales|bookings?|hr|events?|admin|office)/.test(e)) ?? null;
  }
  if (r.email || foundEmail) signals.push({ points: 20, why: r.email ? 'Business email known' : `Business email on the website: ${foundEmail}` });
  const hits = (seg?.keywords ?? []).filter((k) => text.includes(k));
  if (hits.length) signals.push({ points: Math.min(40, hits.length * 10), why: `Fit words on the website: ${hits.slice(0, 6).join(', ')}` });
  const cityHit = r.city && profile.cities.some((c) => c.toLowerCase() === String(r.city).toLowerCase());
  if (cityHit) signals.push({ points: 20, why: `In a target city: ${r.city}` });
  const score = Math.min(100, signals.reduce((a, s) => a + s.points, 0));
  await env.DB.prepare('UPDATE prospects SET score = ?, signals_json = ?, checked_at = ?, check_error = ?, email = coalesce(email, ?), updated_at = ? WHERE id = ?')
    .bind(score, JSON.stringify(signals), iso(), error, foundEmail && !(await suppressed(env, ws, foundEmail)) ? foundEmail : null, iso(), id).run();
  return getProspect(env, ws, id);
}

// ---------------------------------------------------------------- sequences

const STEPS = [{ step: 1, delayDays: 0, key: 'email_1', what: 'First email: who we are, why them, one clear ask (a reply or a 15-minute call).' },
  { step: 2, delayDays: 4, key: 'email_2', what: 'Follow-up 4 days later if there is no reply: one new reason or proof, the same ask.' },
  { step: 3, delayDays: 7, key: 'email_3', what: 'Last follow-up 7 days after that: a polite close, the door left open.' }];
const PLACEHOLDERS = ['{organisation}', '{city}', '{name}'];

async function sequencePrompt(env: Env, m: Membership, segKey: string) {
  const ws = m.workspace_id;
  const { profile } = await getProfile(env, ws);
  const seg = segmentOf(profile, segKey);
  if (seg.offer.length < 20) throw new HttpError(400, 'First write what you offer this kind of partner (in the partner profile). The AI must not invent offers or prices.');
  const kit = (await getKit(env, ws)).current?.kit;
  const facts = await listFacts(env, ws);
  const body = [
    `You write business emails to organisations for ${m.name}. ${kit?.description ?? ''}`.trim(),
    kit?.voice ? `Voice: ${kit.voice}` : '',
    '',
    `WHO WE ARE WRITING TO: ${seg.label}. These are businesses, not consumers.`,
    `WHAT WE OFFER THEM (the only offer; never invent prices, discounts or commissions): ${seg.offer}`,
    '',
    'RULES:',
    '- Each email under 120 words. Plain text. No emojis. One clear ask.',
    `- Write ${PLACEHOLDERS.join(', ')} exactly where the organisation's name, its city and the person's name go.`,
    '- Do not write a signature, a website link or an opt-out line: they are added automatically.',
    ...(kit?.compliance ?? []).map((c) => `- ${c}`),
    '- Use only facts stated here or in the Brand Facts.',
    ...(facts.length ? ['', 'BRAND FACTS (state them exactly; never use the wrong forms):', ...facts.map((f) => `- ${f.statement}${f.wrongForms.length ? ` Never write: ${f.wrongForms.map((w) => `"${w}"`).join(', ')}.` : ''}`)] : []),
    '',
    'WRITE EXACTLY THREE SECTIONS IN THIS FORM:',
    ...STEPS.flatMap((s) => [`=== ${s.key} ===`, `(${s.what})`, 'SUBJECT: <one line>', '<the email body>', '']),
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  return redact(body.join('\n'));
}

export function parseSequenceReply(text: string) {
  const marks = [...text.matchAll(/^===\s*(email_[123])\s*===\s*$/gm)];
  const emails: { step: number; delayDays: number; subject: string; body: string }[] = [];
  marks.forEach((mk, i) => {
    const s = STEPS.find((x) => x.key === mk[1])!;
    if (emails.some((e) => e.step === s.step)) return;
    const chunk = text.slice((mk.index ?? 0) + mk[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined).replace(/^\s*\([^)]*\)[^\n]*\n/, '').trim();
    const sub = chunk.match(/^\s*SUBJECT:\s*(.+)$/mi);
    if (!sub) return;
    const body = chunk.replace(sub[0], '').trim();
    if (body.length < 20) return;
    emails.push({ step: s.step, delayDays: s.delayDays, subject: sub[1].trim().slice(0, 150), body: body.slice(0, 2000) });
  });
  return emails.sort((a, b) => a.step - b.step);
}

export async function sequenceChecks(env: Env, ws: string, emails: { subject: string; body: string }[]) {
  const out: { step: number; level: 'block' | 'warn'; code: string; message: string }[] = [];
  for (const [i, e] of emails.entries()) {
    for (const c of await checkText(env, ws, { headline: e.subject, caption: e.body }, null, null)) out.push({ step: i + 1, ...c });
    for (const ph of e.body.match(/\{[^}]{1,30}\}/g) ?? []) if (!PLACEHOLDERS.includes(ph)) out.push({ step: i + 1, level: 'block', code: 'placeholder', message: `${ph} is not a known placeholder; use ${PLACEHOLDERS.join(', ')}.` });
    if (/\[(name|company|your|insert)[^\]]*\]/i.test(`${e.subject} ${e.body}`)) out.push({ step: i + 1, level: 'block', code: 'placeholder', message: 'A [bracketed] blank is left in the text. Fill it in or use a placeholder such as {organisation}.' });
    if (/₹|rs\.?\s?\d|inr|\d+\s?%\s?(off|discount|commission)/i.test(e.body)) out.push({ step: i + 1, level: 'warn', code: 'price', message: 'This email mentions a price, discount or commission. Check it matches what you actually offer.' });
  }
  return out;
}

const seqRow = (r: any) => ({ id: r.id, segment: r.segment, version: r.version, emails: JSON.parse(r.emails_json), source: r.source, status: r.status, createdBy: r.created_by, createdAt: r.created_at, approvedBy: r.approved_by, approvedAt: r.approved_at });

export async function listSequences(env: Env, ws: string) {
  const { results } = await env.DB.prepare("SELECT * FROM outreach_sequences WHERE workspace_id = ? AND status != 'replaced' ORDER BY segment, version DESC").bind(ws).all<any>();
  const out: any[] = [];
  for (const r of results ?? []) { const s = seqRow(r); out.push({ ...s, checks: await sequenceChecks(env, ws, s.emails) }); }
  return out;
}

async function saveSequence(env: Env, ws: string, who: string, segment: string, emails: ReturnType<typeof parseSequenceReply>, source: string) {
  if (emails.length !== 3) throw new HttpError(400, 'Three emails were not found. The reply must contain "=== email_1 ===", "=== email_2 ===" and "=== email_3 ===", each followed by "SUBJECT: ...".');
  const v = ((await env.DB.prepare('SELECT MAX(version) AS v FROM outreach_sequences WHERE workspace_id = ? AND segment = ?').bind(ws, segment).first<any>())?.v ?? 0) + 1;
  await env.DB.batch([
    env.DB.prepare("UPDATE outreach_sequences SET status = 'replaced' WHERE workspace_id = ? AND segment = ? AND status = 'draft'").bind(ws, segment),
    env.DB.prepare('INSERT INTO outreach_sequences (id, workspace_id, segment, version, emails_json, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), ws, segment, v, JSON.stringify(emails), source, who, iso()),
  ]);
  return listSequences(env, ws);
}

export async function sequencePromptFor(env: Env, m: Membership, body: any) {
  const prov = await env.DB.prepare('SELECT name, url FROM ai_providers WHERE id = ? AND workspace_id = ? AND enabled = 1').bind(String(body?.providerId ?? ''), m.workspace_id).first<any>();
  if (!prov) throw new HttpError(400, 'Choose an AI service from the list.');
  const { text, count } = await sequencePrompt(env, m, clip(body?.segment, 30));
  return { prompt: text, redactions: count, provider: prov.name, url: prov.url };
}

export async function bringBackSequence(env: Env, ws: string, who: string, body: any) {
  const { profile } = await getProfile(env, ws);
  const seg = segmentOf(profile, clip(body?.segment, 30));
  let source = 'Send to AI';
  if (body?.providerId) { const pr = await env.DB.prepare('SELECT name FROM ai_providers WHERE id = ? AND workspace_id = ?').bind(String(body.providerId), ws).first<any>(); if (pr) source = pr.name; }
  return saveSequence(env, ws, who, seg.key, parseSequenceReply(clip(body?.pasted, 20000)), source);
}

export async function generateSequence(env: Env, m: Membership, who: string, body: any) {
  const ws = m.workspace_id;
  await aiGate(env, { workspace: ws, provider: 'anthropic', kind: 'text', user: who });
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(409, 'No AI key is set on this server. Use "Send to AI" instead.');
  const seg = clip(body?.segment, 30);
  const { text } = await sequencePrompt(env, m, seg);
  const model = env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const t0 = Date.now();
  let status: 'ok' | 'error' = 'ok', error: string | null = null, reply = '', uin: number | null = null, uout: number | null = null;
  try {
    const res = await io.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'user', content: text }] }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`The AI service answered ${res.status}: ${j?.error?.message ?? ''}`);
    reply = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    uin = j.usage?.input_tokens ?? null; uout = j.usage?.output_tokens ?? null;
  } catch (e) { status = 'error'; error = redactSecrets(e instanceof Error ? e.message : String(e)); }
  const b = await getBudget(env, ws);
  await env.DB.prepare(`INSERT INTO ai_calls (id, kind, task, provider, model, prompt_version, params_json, input_tokens, output_tokens, images, latency_ms, status, error, entity_type, entity_id, created_at, workspace_id, user_email, cost_inr)
    VALUES (?, 'text', 'partner_sequence', 'anthropic', ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'outreach_sequence', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), model, SEQUENCE_PROMPT_VERSION, JSON.stringify({ segment: seg }), uin, uout, Date.now() - t0, status, error, seg, now(), ws, who,
      status === 'ok' ? costInr(b.prices, 'anthropic', { inputTokens: uin ?? Math.ceil(text.length / 4), outputTokens: uout ?? 900 }) : 0).run();
  if (status === 'error') throw new HttpError(502, error ?? 'The AI service failed.');
  return saveSequence(env, ws, who, seg, parseSequenceReply(reply), 'Claude (direct, budget-checked)');
}

export async function editSequence(env: Env, ws: string, who: string, id: string, body: any) {
  const r = await env.DB.prepare('SELECT * FROM outreach_sequences WHERE id = ? AND workspace_id = ?').bind(id, ws).first<any>();
  if (!r) throw new HttpError(404, 'Sequence not found');
  const emails = (Array.isArray(body?.emails) ? body.emails : []).slice(0, 3).map((e: any, i: number) => ({ step: i + 1, delayDays: STEPS[i].delayDays, subject: clip(e?.subject, 150), body: clip(e?.body, 2000) }))
    .filter((e: any) => e.subject && e.body.length >= 20);
  return saveSequence(env, ws, who, r.segment, emails, `${seqRow(r).source}, edited`);
}

export async function approveSequence(env: Env, ws: string, who: string, id: string) {
  const r = await env.DB.prepare("SELECT * FROM outreach_sequences WHERE id = ? AND workspace_id = ? AND status = 'draft'").bind(id, ws).first<any>();
  if (!r) throw new HttpError(404, 'Draft sequence not found');
  const blocks = (await sequenceChecks(env, ws, JSON.parse(r.emails_json))).filter((c) => c.level === 'block');
  if (blocks.length) throw new HttpError(409, `Fix these first: ${blocks.map((b) => `email ${b.step}: ${b.message}`).join(' ')}`);
  await env.DB.batch([
    env.DB.prepare("UPDATE outreach_sequences SET status = 'replaced' WHERE workspace_id = ? AND segment = ? AND status = 'approved'").bind(ws, r.segment),
    env.DB.prepare("UPDATE outreach_sequences SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").bind(who, iso(), id),
  ]);
  return listSequences(env, ws);
}

// ---------------------------------------------------------------- preparing, the outbox and replies

async function brandName(env: Env, ws: string) { return (await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(ws).first<any>())?.name ?? ''; }

export async function prepare(env: Env, ws: string, who: string, body: any) {
  const ids: string[] = (Array.isArray(body?.prospectIds) ? body.prospectIds : []).map(String).slice(0, 100);
  if (!ids.length) throw new HttpError(400, 'Choose the prospects to prepare emails for.');
  const { profile } = await getProfile(env, ws);
  const site = (await activeLinks(env, ws)).find((l) => l.kind === 'website');
  const brand = await brandName(env, ws);
  const out = { prepared: 0, skipped: [] as { id: string; reason: string }[] };
  for (const id of ids) {
    const p = await env.DB.prepare('SELECT * FROM prospects WHERE id = ? AND workspace_id = ?').bind(id, ws).first<any>();
    if (!p) { out.skipped.push({ id, reason: 'not found' }); continue; }
    if (!p.email) { out.skipped.push({ id, reason: 'no email address' }); continue; }
    if (p.stage !== 'new') { out.skipped.push({ id, reason: `already ${p.stage.replace('_', ' ')}` }); continue; }
    if (await suppressed(env, ws, p.email)) { out.skipped.push({ id, reason: 'opted out' }); continue; }
    if (await env.DB.prepare('SELECT 1 FROM outreach_messages WHERE prospect_id = ?').bind(id).first()) { out.skipped.push({ id, reason: 'emails already prepared' }); continue; }
    const seq = await env.DB.prepare("SELECT * FROM outreach_sequences WHERE workspace_id = ? AND segment = ? AND status = 'approved'").bind(ws, p.segment).first<any>();
    if (!seq) { out.skipped.push({ id, reason: 'no approved sequence for this kind of partner' }); continue; }
    let link: string | null = null;
    if (site) { const u = new URL(site.url); u.searchParams.set('utm_source', 'email'); u.searchParams.set('utm_medium', 'outreach'); u.searchParams.set('utm_campaign', `partner_${p.segment}`); link = u.toString(); }
    const fill = (s: string) => s.replaceAll('{organisation}', p.name).replaceAll('{city}', p.city ?? 'your city').replaceAll('{name}', p.contact_person ?? `${p.name} team`);
    const sig = [profile.senderName, brand].filter(Boolean).join(', ');
    const footer = ['', '--', ...(sig ? [sig] : []), ...(link ? [link] : []), '', profile.optOutLine].join('\n');
    const at = iso();
    await env.DB.batch((JSON.parse(seq.emails_json) as any[]).map((e) => env.DB.prepare(`INSERT INTO outreach_messages (id, workspace_id, prospect_id, sequence_id, step, delay_days, to_email, subject, body, status, due_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), ws, id, seq.id, e.step, e.delayDays, p.email, fill(e.subject), `${fill(e.body)}\n${footer}`, e.step === 1 ? 'ready' : 'waiting', e.step === 1 ? at : null, who, at)));
    out.prepared++;
  }
  return out;
}

const startOfDay = () => `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

export async function outbox(env: Env, ws: string) {
  const { profile } = await getProfile(env, ws);
  const sentToday = (await env.DB.prepare("SELECT COUNT(*) AS n FROM outreach_messages WHERE workspace_id = ? AND status = 'sent' AND sent_at >= ?").bind(ws, startOfDay()).first<any>())?.n ?? 0;
  const left = Math.max(0, profile.dailyLimit - sentToday);
  const { results } = await env.DB.prepare(`SELECT m.id, m.step, m.to_email, m.subject, m.body, m.due_at, p.id AS prospect_id, p.name, p.segment, p.city, p.score FROM outreach_messages m JOIN prospects p ON p.id = m.prospect_id
    WHERE m.workspace_id = ? AND m.status = 'ready' AND m.due_at <= ? AND p.stage IN ('new', 'contacted') ORDER BY m.step DESC, coalesce(p.score, 0) DESC, m.due_at LIMIT 200`).bind(ws, iso()).all<any>();
  const due: any[] = [];
  for (const r of results ?? []) if (!(await suppressed(env, ws, r.to_email))) due.push(r);
  return { dailyLimit: profile.dailyLimit, sentToday, left, due: due.length, messages: due.slice(0, left),
    note: 'Send each email yourself from your own mailbox, then mark it sent. Follow-ups wait for their day and stop as soon as a reply is logged.' };
}

export async function markSent(env: Env, ws: string, who: string, id: string) {
  const m = await env.DB.prepare("SELECT * FROM outreach_messages WHERE id = ? AND workspace_id = ? AND status = 'ready'").bind(id, ws).first<any>();
  if (!m) throw new HttpError(404, 'This email is not waiting to be sent.');
  if (await suppressed(env, ws, m.to_email)) throw new HttpError(409, 'This address opted out. The email was not marked sent.');
  const o = await outbox(env, ws);
  if (o.left <= 0) throw new HttpError(429, `Today's limit of ${o.dailyLimit} emails is reached. The rest wait for tomorrow.`);
  const at = iso();
  const next = await env.DB.prepare("SELECT id, delay_days FROM outreach_messages WHERE prospect_id = ? AND step = ? AND status = 'waiting'").bind(m.prospect_id, m.step + 1).first<any>();
  const stmts = [
    env.DB.prepare("UPDATE outreach_messages SET status = 'sent', sent_by = ?, sent_at = ? WHERE id = ?").bind(who, at, id),
    env.DB.prepare("UPDATE prospects SET stage = 'contacted', updated_at = ? WHERE id = ? AND stage = 'new'").bind(at, m.prospect_id),
  ];
  if (next) stmts.push(env.DB.prepare("UPDATE outreach_messages SET status = 'ready', due_at = ? WHERE id = ?").bind(new Date(Date.parse(at) + next.delay_days * 86400_000).toISOString(), next.id));
  await env.DB.batch(stmts);
  return outbox(env, ws);
}

export async function skipMessage(env: Env, ws: string, id: string) {
  const m = await env.DB.prepare("SELECT * FROM outreach_messages WHERE id = ? AND workspace_id = ? AND status = 'ready'").bind(id, ws).first<any>();
  if (!m) throw new HttpError(404, 'This email is not waiting to be sent.');
  await env.DB.prepare("UPDATE outreach_messages SET status = 'skipped' WHERE prospect_id = ? AND status IN ('ready', 'waiting')").bind(m.prospect_id).run();
  return outbox(env, ws);
}

const OUTCOME_STAGE: Record<string, string> = { interested: 'replied', meeting: 'meeting', partner: 'partner', not_now: 'replied', not_interested: 'not_interested', opt_out: 'opted_out', bounced: 'archived', other: 'replied' };

export async function logReply(env: Env, ws: string, who: string, id: string, body: any) {
  const p = await env.DB.prepare('SELECT * FROM prospects WHERE id = ? AND workspace_id = ?').bind(id, ws).first<any>();
  if (!p) throw new HttpError(404, 'Prospect not found');
  const outcome = String(body?.outcome ?? '');
  if (!OUTCOME_STAGE[outcome]) throw new HttpError(400, 'Choose what the reply was.');
  const at = iso();
  const stmts = [
    env.DB.prepare('INSERT INTO outreach_replies (id, workspace_id, prospect_id, outcome, note, logged_by, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), ws, id, outcome, clip(body?.note, 1000) || null, who, at),
    // Any reply stops the follow-ups: nobody gets "just checking in" after they have answered.
    env.DB.prepare("UPDATE outreach_messages SET status = 'stopped' WHERE prospect_id = ? AND status IN ('ready', 'waiting')").bind(id),
    env.DB.prepare('UPDATE prospects SET stage = ?, updated_at = ? WHERE id = ?').bind(OUTCOME_STAGE[outcome], at, id),
  ];
  if (outcome === 'opt_out' && p.email) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO outreach_suppressions (workspace_id, value, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(ws, p.email.toLowerCase(), 'replied: opt out', who, at));
  await env.DB.batch(stmts);
  return getProspect(env, ws, id);
}

const MANUAL_STAGES = ['new', 'contacted', 'replied', 'meeting', 'partner', 'not_interested', 'archived'];
export async function setStage(env: Env, ws: string, id: string, body: any) {
  const stage = String(body?.stage ?? '');
  if (!MANUAL_STAGES.includes(stage)) throw new HttpError(400, 'Unknown stage.');
  const p = await env.DB.prepare('SELECT stage FROM prospects WHERE id = ? AND workspace_id = ?').bind(id, ws).first<any>();
  if (!p) throw new HttpError(404, 'Prospect not found');
  if (p.stage === 'opted_out') throw new HttpError(409, 'This organisation opted out. It stays that way.');
  const stmts = [env.DB.prepare('UPDATE prospects SET stage = ?, updated_at = ? WHERE id = ?').bind(stage, iso(), id)];
  if (!['new', 'contacted'].includes(stage)) stmts.push(env.DB.prepare("UPDATE outreach_messages SET status = 'stopped' WHERE prospect_id = ? AND status IN ('ready', 'waiting')").bind(id));
  await env.DB.batch(stmts);
  return getProspect(env, ws, id);
}

export async function suppress(env: Env, ws: string, who: string, body: any) {
  let v = clip(body?.value, 160).toLowerCase();
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) v = `@${v}`;
  if (!(EMAIL.test(v) || /^@[a-z0-9.-]+\.[a-z]{2,}$/.test(v))) throw new HttpError(400, 'Give an email address or a domain such as @company.com.');
  const at = iso();
  await env.DB.prepare('INSERT OR IGNORE INTO outreach_suppressions (workspace_id, value, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(ws, v, clip(body?.reason, 200) || 'added by hand', who, at).run();
  // Stop anything already prepared for that address or domain.
  const { results } = await env.DB.prepare("SELECT id, email FROM prospects WHERE workspace_id = ? AND email IS NOT NULL AND stage NOT IN ('opted_out')").bind(ws).all<any>();
  for (const p of results ?? []) {
    const e = String(p.email).toLowerCase();
    if (e === v || e.endsWith(v.startsWith('@') ? v : '\u0000')) await env.DB.batch([
      env.DB.prepare("UPDATE prospects SET stage = 'opted_out', updated_at = ? WHERE id = ?").bind(at, p.id),
      env.DB.prepare("UPDATE outreach_messages SET status = 'stopped' WHERE prospect_id = ? AND status IN ('ready', 'waiting')").bind(p.id),
    ]);
  }
  return listSuppressions(env, ws);
}

export async function listSuppressions(env: Env, ws: string) {
  const { results } = await env.DB.prepare('SELECT value, reason, created_by, created_at FROM outreach_suppressions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 500').bind(ws).all<any>();
  return results ?? [];
}

// ---------------------------------------------------------------- summary, Today and the daily run

export async function summary(env: Env, ws: string) {
  const prof = await getProfile(env, ws);
  const { results } = await env.DB.prepare('SELECT stage, COUNT(*) AS n FROM prospects WHERE workspace_id = ? GROUP BY stage').bind(ws).all<any>();
  const stages = Object.fromEntries((results ?? []).map((r) => [r.stage, r.n]));
  const sent = (await env.DB.prepare("SELECT COUNT(*) AS n FROM outreach_messages WHERE workspace_id = ? AND status = 'sent'").bind(ws).first<any>())?.n ?? 0;
  const replied = (await env.DB.prepare('SELECT COUNT(DISTINCT prospect_id) AS n FROM outreach_replies WHERE workspace_id = ?').bind(ws).first<any>())?.n ?? 0;
  const o = await outbox(env, ws);
  return {
    ...prof, stages, emailsSent: sent, organisationsReplied: replied, outboxReady: Math.min(o.due, o.left), sentToday: o.sentToday,
    partnerBookings: { value: null, status: 'unavailable', note: 'Partner bookings are counted from the CRM once it is linked. Until then, track partners and meetings here.' },
  };
}

export async function outreachReminder(env: Env, ws: string) {
  try {
    const o = await outbox(env, ws);
    const n = Math.min(o.due, o.left);
    if (!n) return [];
    return [{ id: 'outreach-ready', kind: 'send_outreach', subject: `${n}`, title: `${n} partner email${n === 1 ? '' : 's'} ready to send`,
      why: `Send them from your own mailbox and mark each one sent. Today's limit: ${o.dailyLimit}.`, action: { label: 'Open the outbox', screen: 'create', ref: 'partners' } }];
  } catch { return []; }
}

// The daily run checks up to 10 new prospects' websites per brand. It never prepares or sends email.
export async function dailyChecks(env: Env, perBrand = 10) {
  const { results } = await env.DB.prepare("SELECT id, workspace_id FROM prospects WHERE checked_at IS NULL AND website IS NOT NULL AND stage = 'new' ORDER BY created_at LIMIT 200").all<any>();
  const count: Record<string, number> = {};
  let done = 0;
  for (const r of results ?? []) {
    if ((count[r.workspace_id] = (count[r.workspace_id] ?? 0) + 1) > perBrand) continue;
    try { await checkProspect(env, r.workspace_id, r.id); done++; } catch { /* recorded on the next attempt */ }
  }
  return done;
}
