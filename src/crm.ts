// Iddav CRM — enquiries to bookings, inside IMI (one Worker, one database).
// Built to IMI Master Requirements v2 §5.2 and FR-CRM-001..010, kept simple:
//  - One record per enquiry, moved through stages; each move asks only for
//    what that stage needs (quote → amount; booked → value + room nights;
//    lost → reason).
//  - Attribution is automatic when the guest arrives through an IMI link:
//    WhatsApp ref codes and website UTMs map back to campaign, content and
//    channel ("tracked"). Otherwise the operator records how they heard.
//  - Campaign funnel and "Close outcome" turn CRM truth into an IMI Outcome.
//  - Personal data stays in the CRM: never sent to AI, deletable on request.

import type { Env } from './env';
import { json, HttpError, now, actor, sha256Hex, CORS_HEADERS } from './http';
import { requireOwner } from './policy';
import { crmMode, crmReadOnlyMessage, fetchCrmCampaign, crmTotals } from './crm_bridge';

export const STAGES = ['new', 'contacted', 'qualified', 'quoted', 'tentative', 'booked', 'stayed', 'lost', 'cancelled', 'nurture'];
const OPEN = new Set(['new', 'contacted', 'qualified', 'quoted', 'tentative']);
export const LOSS_REASONS = ['price', 'dates', 'safari', 'travel', 'property_fit', 'delayed_response', 'competitor', 'trust', 'no_response', 'other'];
export const INTAKE = ['whatsapp', 'call', 'website_form', 'instagram_dm', 'facebook_message', 'email', 'walk_in', 'referral', 'ota', 'other'];
export const ATTRIBUTION = ['tracked', 'self_reported', 'operator_attributed', 'unknown'];
export const SAFARI = ['undecided', 'none', 'buffer', 'core'];
const ABBR_TO_CHANNEL: Record<string, string> = {
  IG: 'instagram', FB: 'facebook', TH: 'threads', LI: 'linkedin', GB: 'google_business', YT: 'youtube', TG: 'telegram', WA: 'whatsapp',
  ST: 'whatsapp_status', WS: 'website', GA: 'google_ads',
};

const parse = (v: string | null | undefined, fb: any = undefined) => { try { return v ? JSON.parse(v) : fb; } catch { return fb; } };
const clean = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const dateOnly = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

async function nextCode(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    `INSERT INTO counters (name, value) VALUES ('enquiry', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`
  ).first<{ value: number }>();
  return `ENQ-${String(row!.value).padStart(4, '0')}`;
}

// Find an IMI reference in a message or a UTM set: "ref CMP-0003-2-IG", "CMP-0003-CHATGPT_ADS", utm_content=cmp-0003-2-ig.
async function resolveAttribution(env: Env, text: string, utm: Record<string, string>) {
  const hay = `${text} ${utm.utm_content || ''} ${utm.utm_campaign || ''}`;
  const m = hay.match(/\b(CMP-\d{4})(?:-(\d+))?(?:-([A-Z_]{2,20}))?\b/i);
  if (!m) return null;
  const campaign = await env.DB.prepare('SELECT id, code FROM campaigns WHERE code = ?').bind(m[1].toUpperCase()).first<any>();
  if (!campaign) return null;
  let contentId: string | null = null;
  if (m[2]) {
    const c = await env.DB.prepare('SELECT id FROM contents WHERE campaign_id = ? AND series_number = ?').bind(campaign.id, Number(m[2])).first<any>();
    contentId = c?.id || null;
  }
  const tag = (m[3] || utm.utm_source || '').toUpperCase();
  const channel = ABBR_TO_CHANNEL[tag] || (tag ? tag.toLowerCase() : null);
  return { campaignId: campaign.id, contentId, channel, ref: m[0].toUpperCase() };
}

async function logEvent(env: Env, enquiryId: string, kind: string, text: string, who: string, from?: string, to?: string) {
  await env.DB.prepare(
    'INSERT INTO enquiry_events (id, enquiry_id, kind, text, from_stage, to_stage, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), enquiryId, kind, text, from ?? null, to ?? null, who, now()).run();
}

function out(r: any) {
  const today = now().slice(0, 10);
  return {
    id: r.id, code: r.code, property: r.property, name: r.name || '', phone: r.phone || '', email: r.email || '',
    consentMarketing: r.consent_marketing === 1, intake: r.intake, firstMessage: r.first_message || '',
    refCode: r.ref_code || '', campaignId: r.campaign_id || null, campaignCode: r.campaign_code || null, campaignName: r.campaign_name || null,
    contentId: r.content_id || null, channel: r.channel || null, attribution: r.attribution, attributionNote: r.attribution_note || '',
    checkIn: r.check_in || '', checkOut: r.check_out || '', adults: r.adults, children: r.children, rooms: r.rooms,
    safari: r.safari, budgetNote: r.budget_note || '', interests: r.interests || '', segment: r.segment || '',
    stage: r.stage, owner: r.owner || '', nextAction: r.next_action || '', nextActionDue: r.next_action_due || '',
    overdue: Boolean(r.next_action_due && OPEN.has(r.stage) && r.next_action_due < today),
    dueToday: Boolean(r.next_action_due && OPEN.has(r.stage) && r.next_action_due === today),
    quoteAmount: r.quote_amount, quoteNights: r.quote_nights, quoteRooms: r.quote_rooms, quoteInclusions: r.quote_inclusions || '',
    quoteValidUntil: r.quote_valid_until || '', estContribution: r.est_contribution,
    bookedValue: r.booked_value, roomNights: r.room_nights, lostReason: r.lost_reason || '', lostNote: r.lost_note || '',
    firstContactedAt: r.first_contacted_at || null, createdAt: r.created_at, updatedAt: r.updated_at, piiDeleted: Boolean(r.pii_deleted_at),
  };
}

const SELECT = `SELECT e.*, c.code AS campaign_code, c.name AS campaign_name FROM enquiries e LEFT JOIN campaigns c ON c.id = e.campaign_id`;

async function getOne(env: Env, id: string) {
  const r = await env.DB.prepare(`${SELECT} WHERE e.id = ?`).bind(id).first<any>();
  if (!r) throw new HttpError(404, 'Enquiry not found.');
  return r;
}

async function create(env: Env, b: any, who: string, publicForm = false) {
  const message = clean(b.message ?? b.firstMessage, 4000);
  const utm: Record<string, string> = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) if (typeof b[k] === 'string') utm[k] = b[k].slice(0, 120);
  const auto = await resolveAttribution(env, `${message} ${clean(b.ref, 60)}`, utm);

  let campaignId = auto?.campaignId || null;
  let contentId = auto?.contentId || null;
  let channel = auto?.channel || null;
  let attribution = auto ? 'tracked' : 'unknown';
  if (!auto && !publicForm && b.campaignId) {
    const c = await env.DB.prepare('SELECT id FROM campaigns WHERE id = ?').bind(b.campaignId).first<any>();
    if (c) { campaignId = c.id; attribution = ATTRIBUTION.includes(b.attribution) && b.attribution !== 'tracked' ? b.attribution : 'operator_attributed'; }
  } else if (!auto && !publicForm && ATTRIBUTION.includes(b.attribution) && b.attribution !== 'tracked') {
    attribution = b.attribution;
  }
  if (!auto && !publicForm && typeof b.channel === 'string') channel = clean(b.channel, 40) || null;

  const name = clean(b.name, 120);
  const phone = clean(b.phone, 30).replace(/[^\d+]/g, '');
  const email = clean(b.email, 160).toLowerCase();
  if (!name && !phone && !email) throw new HttpError(400, 'Add a name, phone or email.');

  const id = crypto.randomUUID();
  const code = await nextCode(env);
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO enquiries (id, code, property, name, phone, email, consent_marketing, consent_recorded_at, intake, first_message,
       ref_code, campaign_id, content_id, channel, attribution, attribution_note, utm_json, check_in, check_out, adults, children,
       rooms, safari, budget_note, interests, segment, stage, owner, next_action, next_action_due, created_by, created_at, updated_at)
     VALUES (?, ?, 'sri_antra', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, code, name || null, phone || null, email || null, b.consentMarketing ? 1 : 0, b.consentMarketing ? ts : null,
    publicForm ? 'website_form' : INTAKE.includes(b.intake) ? b.intake : 'whatsapp', message || null,
    auto?.ref || null, campaignId, contentId, channel, attribution, clean(b.attributionNote, 300) || null,
    Object.keys(utm).length ? JSON.stringify(utm) : null, dateOnly(b.checkIn), dateOnly(b.checkOut),
    num(b.adults), num(b.children), num(b.rooms), SAFARI.includes(b.safari) ? b.safari : 'undecided',
    clean(b.budgetNote, 200) || null, clean(b.interests, 300) || null, clean(b.segment, 60) || null,
    clean(b.owner, 80) || null, publicForm ? 'Reply to website enquiry' : clean(b.nextAction, 200) || 'First reply',
    dateOnly(b.nextActionDue) || ts.slice(0, 10), who, ts, ts
  ).run();
  await logEvent(env, id, 'created', auto ? `Arrived via ${auto.ref} (tracked).` : publicForm ? 'Website enquiry form.' : 'Enquiry logged.', who);
  return id;
}

// ---------------------------------------------------------------- Public website form

export async function handlePublicEnquiry(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== '/public/enquiry') return null;
  // the website now sends enquiries to the CRM; a form still pointing here is told so instead of creating a second copy
  if (crmMode(env)) return json({ error: 'Enquiries are taken by the Iddav CRM now. Please use the enquiry form on iddavwildstay.com or WhatsApp us.' }, 410);
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  const ct = request.headers.get('Content-Type') || '';
  const b: any = ct.includes('application/json') ? await request.json().catch(() => ({})) : Object.fromEntries((await request.formData()).entries());
  if (b.website) return json({ ok: true }); // honeypot: bots fill hidden fields; pretend success
  if (b.consentContact !== true && b.consentContact !== 'on' && b.consentContact !== 'true') {
    return json({ error: 'Please agree to be contacted about your enquiry.' }, 400);
  }
  const ipHash = (await sha256Hex(`${request.headers.get('CF-Connecting-IP') || 'unknown'}|imi`)).slice(0, 24);
  const hourAgo = new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM public_submissions WHERE ip_hash = ? AND created_at > ?').bind(ipHash, hourAgo).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 5) return json({ error: 'Too many enquiries from this connection. Please WhatsApp us instead.' }, 429);
  await env.DB.prepare('INSERT INTO public_submissions (ip_hash, created_at) VALUES (?, ?)').bind(ipHash, now()).run();
  try {
    const id = await create(env, { ...b, consentMarketing: b.consentMarketing === true || b.consentMarketing === 'on' || b.consentMarketing === 'true' }, 'Website form', true);
    const r = await env.DB.prepare('SELECT code FROM enquiries WHERE id = ?').bind(id).first<any>();
    return json({ ok: true, reference: r.code });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    throw e;
  }
}

// ---------------------------------------------------------------- Internal routes

export async function handleCrmRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;
  let m: RegExpMatchArray | null;
  const who = () => actor(request, env.OWNER_PIN);

  // Where enquiries live. In CRM mode IMI shows the old records read-only and takes no new ones: there is one copy, in the CRM.
  if (method === 'GET' && path === '/api/crm/status') return json({ mode: crmMode(env) ? 'crm' : 'local', crmUrl: crmMode(env) ? env.CRM_URL : null });
  if (crmMode(env) && ((method === 'POST' && path === '/api/enquiries') || (method === 'PATCH' && /^\/api\/enquiries\/[^/]+$/.test(path)) || (method === 'POST' && /^\/api\/enquiries\/[^/]+\/(stage|notes)$/.test(path)))) {
    throw new HttpError(409, crmReadOnlyMessage(env));
  }

  if (method === 'GET' && path === '/api/crm/options') {
    const { results } = await env.DB.prepare('SELECT id, code, name FROM campaigns ORDER BY created_at DESC').all();
    return json({ stages: STAGES, lossReasons: LOSS_REASONS, intake: INTAKE, attribution: ATTRIBUTION, safari: SAFARI, campaigns: results || [] });
  }

  if (method === 'GET' && path === '/api/enquiries') {
    const view = url.searchParams.get('view') || 'open';
    const q = clean(url.searchParams.get('q') || '', 80);
    const where: string[] = [];
    const binds: any[] = [];
    if (view === 'open') where.push(`e.stage IN ('new','contacted','qualified','quoted','tentative')`);
    if (view === 'won') where.push(`e.stage IN ('booked','stayed')`);
    if (view === 'closed') where.push(`e.stage IN ('lost','cancelled','nurture')`);
    if (view === 'due') where.push(`e.stage IN ('new','contacted','qualified','quoted','tentative') AND e.next_action_due <= ?`), binds.push(now().slice(0, 10));
    if (q) { where.push('(e.name LIKE ? OR e.phone LIKE ? OR e.code LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(e.next_action_due, '9999') ASC, e.created_at DESC LIMIT 300`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all<any>();
    const counts = await env.DB.prepare(
      `SELECT SUM(CASE WHEN stage IN ('new','contacted','qualified','quoted','tentative') AND next_action_due < ? THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN stage IN ('new','contacted','qualified','quoted','tentative') AND next_action_due = ? THEN 1 ELSE 0 END) AS due_today,
              SUM(CASE WHEN stage = 'new' THEN 1 ELSE 0 END) AS new_count
       FROM enquiries`
    ).bind(now().slice(0, 10), now().slice(0, 10)).first<any>();
    return json({ items: (results || []).map(out), counts: { overdue: counts?.overdue || 0, dueToday: counts?.due_today || 0, new: counts?.new_count || 0 } });
  }

  if (method === 'POST' && path === '/api/enquiries') {
    const id = await create(env, await request.json<any>(), who());
    return json(out(await getOne(env, id)), 201);
  }

  if (method === 'GET' && (m = path.match(/^\/api\/enquiries\/([^/]+)$/))) {
    const r = await getOne(env, m[1]);
    const { results } = await env.DB.prepare('SELECT * FROM enquiry_events WHERE enquiry_id = ? ORDER BY created_at DESC').bind(r.id).all<any>();
    return json({
      ...out(r),
      events: (results || []).map((e) => ({ kind: e.kind, text: e.text, from: e.from_stage, to: e.to_stage, actor: e.actor, at: e.created_at })),
    });
  }

  if (method === 'PATCH' && (m = path.match(/^\/api\/enquiries\/([^/]+)$/))) {
    const r = await getOne(env, m[1]);
    if (r.pii_deleted_at) throw new HttpError(409, 'Personal data for this enquiry was deleted.');
    const b = await request.json<any>();
    const sets: string[] = [];
    const vals: any[] = [];
    const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    const txt: Record<string, [string, number]> = {
      name: ['name', 120], email: ['email', 160], budgetNote: ['budget_note', 200], interests: ['interests', 300],
      segment: ['segment', 60], owner: ['owner', 80], nextAction: ['next_action', 200], quoteInclusions: ['quote_inclusions', 500],
      attributionNote: ['attribution_note', 300],
    };
    for (const [k, [col, max]] of Object.entries(txt)) if (k in b) set(col, clean(b[k], max) || null);
    if ('phone' in b) set('phone', clean(b.phone, 30).replace(/[^\d+]/g, '') || null);
    for (const [k, col] of [['checkIn', 'check_in'], ['checkOut', 'check_out'], ['nextActionDue', 'next_action_due'], ['quoteValidUntil', 'quote_valid_until']]) {
      if (k in b) set(col, dateOnly(b[k]));
    }
    for (const [k, col] of [['adults', 'adults'], ['children', 'children'], ['rooms', 'rooms'], ['estContribution', 'est_contribution']]) {
      if (k in b) set(col, num(b[k]));
    }
    if ('safari' in b && SAFARI.includes(b.safari)) set('safari', b.safari);
    if ('consentMarketing' in b) { set('consent_marketing', b.consentMarketing ? 1 : 0); set('consent_recorded_at', now()); }
    if ('campaignId' in b && r.attribution !== 'tracked') {
      const c = b.campaignId ? await env.DB.prepare('SELECT id FROM campaigns WHERE id = ?').bind(b.campaignId).first<any>() : null;
      set('campaign_id', c?.id || null);
      set('attribution', c ? (ATTRIBUTION.includes(b.attribution) && b.attribution !== 'tracked' ? b.attribution : 'operator_attributed') : (ATTRIBUTION.includes(b.attribution) && b.attribution !== 'tracked' ? b.attribution : 'unknown'));
      if ('channel' in b) set('channel', clean(b.channel, 40) || null);
    }
    if (!sets.length) throw new HttpError(400, 'Nothing to update.');
    set('updated_at', now());
    vals.push(r.id);
    await env.DB.prepare(`UPDATE enquiries SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    if ('nextAction' in b || 'nextActionDue' in b) await logEvent(env, r.id, 'followup', `Next: ${clean(b.nextAction, 200) || r.next_action || ''} by ${dateOnly(b.nextActionDue) || r.next_action_due || '—'}`, who());
    return json(out(await getOne(env, r.id)));
  }

  // Move stage, asking only for what that stage needs.
  if (method === 'POST' && (m = path.match(/^\/api\/enquiries\/([^/]+)\/stage$/))) {
    const r = await getOne(env, m[1]);
    const b = await request.json<any>();
    const to = b.stage;
    if (!STAGES.includes(to)) throw new HttpError(400, 'Unknown stage.');
    if (to === r.stage) return json(out(r));
    const sets: string[] = ['stage = ?', 'updated_at = ?'];
    const vals: any[] = [to, now()];
    const add = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    let note = '';
    if (to === 'quoted' || to === 'tentative') {
      const amount = num(b.quoteAmount ?? r.quote_amount);
      if (!amount || amount <= 0) throw new HttpError(400, 'Enter the quoted amount.');
      add('quote_amount', amount);
      add('quote_nights', num(b.quoteNights ?? r.quote_nights));
      add('quote_rooms', num(b.quoteRooms ?? r.quote_rooms));
      add('quote_inclusions', clean(b.quoteInclusions ?? r.quote_inclusions, 500) || null);
      add('quote_valid_until', dateOnly(b.quoteValidUntil ?? r.quote_valid_until));
      add('est_contribution', num(b.estContribution ?? r.est_contribution));
      add('quote_sent_at', r.quote_sent_at || now());
      note = `Quote ₹${amount.toLocaleString('en-IN')}`;
    }
    if (to === 'booked') {
      const value = num(b.bookedValue ?? r.quote_amount);
      const nights = num(b.roomNights) ?? (num(r.quote_nights) && num(r.quote_rooms) ? Number(r.quote_nights) * Number(r.quote_rooms) : null);
      if (!value || value <= 0) throw new HttpError(400, 'Enter the booked value.');
      if (!nights || nights <= 0) throw new HttpError(400, 'Enter room nights (rooms × nights).');
      add('booked_value', value); add('room_nights', nights); add('booked_at', now());
      if (b.estContribution !== undefined) add('est_contribution', num(b.estContribution));
      add('next_action', 'Pre-arrival note'); add('next_action_due', r.check_in ? r.check_in : null);
      note = `Booked ₹${value.toLocaleString('en-IN')} · ${nights} room nights`;
    }
    if (to === 'lost' || to === 'cancelled') {
      if (!LOSS_REASONS.includes(b.lostReason)) throw new HttpError(400, 'Choose why it was lost.');
      add('lost_reason', b.lostReason); add('lost_note', clean(b.lostNote, 500) || null); add('next_action', null); add('next_action_due', null);
      note = `Reason: ${b.lostReason}${b.lostNote ? ` — ${clean(b.lostNote, 200)}` : ''}`;
    }
    if (to === 'stayed') { add('next_action', 'Ask for a review'); add('next_action_due', now().slice(0, 10)); }
    if (to === 'nurture') { add('next_action', clean(b.nextAction, 200) || 'Check back'); add('next_action_due', dateOnly(b.nextActionDue)); }
    if (r.stage === 'new' && !r.first_contacted_at) add('first_contacted_at', now());
    if (['contacted', 'qualified'].includes(to) && b.nextActionDue) { add('next_action', clean(b.nextAction, 200) || 'Follow up'); add('next_action_due', dateOnly(b.nextActionDue)); }
    vals.push(r.id);
    await env.DB.prepare(`UPDATE enquiries SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    await logEvent(env, r.id, 'stage', note, who(), r.stage, to);
    return json(out(await getOne(env, r.id)));
  }

  if (method === 'POST' && (m = path.match(/^\/api\/enquiries\/([^/]+)\/notes$/))) {
    const r = await getOne(env, m[1]);
    const text = clean((await request.json<any>()).text, 2000);
    if (!text) throw new HttpError(400, 'Write a note.');
    await logEvent(env, r.id, 'note', text, who());
    await env.DB.prepare('UPDATE enquiries SET updated_at = ? WHERE id = ?').bind(now(), r.id).run();
    return json({ ok: true });
  }

  // Right to erasure: remove personal data, keep anonymous economics for learning (FR-CRM-010).
  if (method === 'POST' && (m = path.match(/^\/api\/enquiries\/([^/]+)\/forget$/))) {
    requireOwner(request, env);
    const r = await getOne(env, m[1]);
    await env.DB.prepare(
      `UPDATE enquiries SET name = NULL, phone = NULL, email = NULL, first_message = NULL, budget_note = NULL, interests = NULL,
         lost_note = NULL, consent_marketing = 0, pii_deleted_at = ?, updated_at = ? WHERE id = ?`
    ).bind(now(), now(), r.id).run();
    await env.DB.prepare(`UPDATE enquiry_events SET text = '[removed]' WHERE enquiry_id = ? AND kind = 'note'`).bind(r.id).run();
    await logEvent(env, r.id, 'privacy', 'Personal data deleted on request.', who());
    return json(out(await getOne(env, r.id)));
  }

  // Campaign funnel: what the content actually produced (§10.2 content funnel).
  if (method === 'GET' && (m = path.match(/^\/api\/campaigns\/([^/]+)\/funnel$/))) {
    return json(await funnel(env, m[1]));
  }

  // Close the loop: CRM truth becomes an IMI Outcome record. Learning stays human.
  if (method === 'POST' && (m = path.match(/^\/api\/campaigns\/([^/]+)\/outcome$/))) {
    requireOwner(request, env);
    const b = await request.json<any>();
    const learning = clean(b.learning, 2000);
    if (!learning) throw new HttpError(400, 'Write what you learned. IMI records the numbers; the lesson is yours.');
    const f = await funnel(env, m[1]);
    const c = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(m[1]).first<any>();
    const interim = f.window.end ? now().slice(0, 10) < f.window.end : true;
    const t = f.totals;
    const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
    const actual = `${interim ? `Interim (window ends ${f.window.end || 'after first post'}). ` : ''}${t.enquiries} enquiries (${t.tracked} tracked), ${t.qualified} qualified, ${t.quoted} quoted, ${t.booked} booked, ${t.roomNights} room nights, ${inr(t.bookedValue)} booked value, ${inr(t.contribution)} estimated contribution. ${t.lost} lost${f.topLossReason ? ` (most often: ${f.topLossReason})` : ''}.`;
    const level = t.enquiries === 0 ? 'Unknown' : t.tracked / t.enquiries >= 0.7 && t.enquiries >= 3 ? 'High' : t.tracked > 0 ? 'Medium' : 'Low';
    const reason = t.enquiries === 0
      ? 'No enquiries were linked to this campaign.'
      : `${t.tracked} of ${t.enquiries} enquiries arrived through IMI tracked links or ref codes; the rest were self-reported or operator-attributed.`;
    const id = `out-${Date.now()}`;
    const last = await env.DB.prepare(`SELECT code FROM outcome_items ORDER BY CAST(substr(code, 5) AS INTEGER) DESC LIMIT 1`).first<any>();
    const code = `OUT-${String((last ? Number(String(last.code).slice(4)) || 0 : 0) + 1).padStart(4, '0')}`;
    await env.DB.prepare(
      `INSERT INTO outcome_items (id, code, domain, decision_code, action_taken, actual_outcome, date_evaluated, evaluator, retrospective,
         quantitative_results_json, qualitative_results_json, attribution_confidence_level, attribution_confidence_reason,
         unexpected_effects_json, resulting_learning_json)
       VALUES (?, ?, 'iddav-marketing-intelligence', ?, ?, ?, ?, ?, 'decision_time', ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, code, c.decision_code || c.code,
      `Campaign ${c.code} "${c.name}" (${f.published} publications across ${Object.keys(f.byChannel).length} channels).`,
      actual, now().slice(0, 10), who(),
      JSON.stringify([{ metric: c.primary_metric, expected: c.expected_outcome, actual: String(metricValue(c.primary_metric, t)), variance: '' }]),
      JSON.stringify(clean(b.qualitative, 2000) ? [clean(b.qualitative, 2000)] : []),
      level, reason, JSON.stringify(clean(b.unexpected, 1000) ? [clean(b.unexpected, 1000)] : []),
      JSON.stringify({ summary: learning, learningStrength: 'provisional' })
    ).run();
    return json({ code, interim });
  }

  return null;
}

function metricValue(metric: string, t: any): string | number {
  switch (metric) {
    case 'qualified_inquiries': return t.qualified;
    case 'bookings': return t.booked;
    case 'room_nights': return t.roomNights;
    case 'contribution': return `₹${Math.round(t.contribution).toLocaleString('en-IN')}`;
    default: return 'Not measured in CRM (record manually)';
  }
}

async function funnel(env: Env, campaignId: string) {
  const c = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId).first<any>();
  if (!c) throw new HttpError(404, 'Campaign not found.');
  const { results } = await env.DB.prepare('SELECT * FROM enquiries WHERE campaign_id = ?').bind(campaignId).all<any>();
  const rows = results || [];
  const first = await env.DB.prepare(
    `SELECT MIN(p.published_at) AS start, COUNT(*) AS n FROM publications p JOIN contents k ON k.id = p.content_id
     WHERE k.campaign_id = ? AND p.status = 'published'`
  ).bind(campaignId).first<any>();
  const start = first?.start ? String(first.start).slice(0, 10) : null;
  const end = start ? new Date(Date.parse(`${start}T00:00:00Z`) + c.outcome_window_days * 86400_000).toISOString().slice(0, 10) : null;

  // One copy of the truth: when the CRM is connected, the campaign's results come from it, not from this table.
  if (crmMode(env)) {
    const crm = crmTotals(await fetchCrmCampaign(env, c.code, start ? `${start}T00:00:00Z` : null), ABBR_TO_CHANNEL);
    return {
      campaign: { id: c.id, code: c.code, expectedOutcome: c.expected_outcome, primaryMetric: c.primary_metric, windowDays: c.outcome_window_days },
      window: { start, end, closed: end ? now().slice(0, 10) >= end : false },
      published: first?.n || 0, totals: crm.totals, byChannel: crm.byChannel, topLossReason: crm.topLossReason, source: 'crm' as const,
    };
  }

  const reached = (r: any, s: string[]) => s.includes(r.stage) || (s.includes('quoted') && r.quote_amount) || (s.includes('booked') && r.booked_value);
  const won = rows.filter((r) => ['booked', 'stayed'].includes(r.stage));
  const lost = rows.filter((r) => ['lost', 'cancelled'].includes(r.stage));
  const reasons: Record<string, number> = {};
  for (const r of lost) if (r.lost_reason) reasons[r.lost_reason] = (reasons[r.lost_reason] || 0) + 1;
  const topLossReason = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const responseHours = rows.filter((r) => r.first_contacted_at)
    .map((r) => (Date.parse(r.first_contacted_at.replace(' ', 'T') + 'Z') - Date.parse(r.created_at.replace(' ', 'T') + 'Z')) / 3600_000)
    .sort((a, b) => a - b);
  const byChannel: Record<string, { enquiries: number; booked: number; bookedValue: number }> = {};
  for (const r of rows) {
    const k = r.channel || 'not recorded';
    byChannel[k] ||= { enquiries: 0, booked: 0, bookedValue: 0 };
    byChannel[k].enquiries++;
    if (['booked', 'stayed'].includes(r.stage)) { byChannel[k].booked++; byChannel[k].bookedValue += Number(r.booked_value) || 0; }
  }
  return {
    campaign: { id: c.id, code: c.code, expectedOutcome: c.expected_outcome, primaryMetric: c.primary_metric, windowDays: c.outcome_window_days },
    window: { start, end, closed: end ? now().slice(0, 10) >= end : false },
    published: first?.n || 0,
    totals: {
      enquiries: rows.length,
      tracked: rows.filter((r) => r.attribution === 'tracked').length,
      qualified: rows.filter((r) => reached(r, ['qualified', 'quoted', 'tentative', 'booked', 'stayed'])).length,
      quoted: rows.filter((r) => reached(r, ['quoted', 'tentative', 'booked', 'stayed'])).length,
      booked: won.length,
      lost: lost.length,
      roomNights: won.reduce((s, r) => s + (Number(r.room_nights) || 0), 0),
      bookedValue: won.reduce((s, r) => s + (Number(r.booked_value) || 0), 0),
      contribution: won.reduce((s, r) => s + (Number(r.est_contribution) || 0), 0),
      contributionKnown: won.length > 0 && won.every((r) => r.est_contribution !== null),
      medianFirstReplyHours: responseHours.length ? Math.round(responseHours[Math.floor(responseHours.length / 2)] * 10) / 10 : null,
    },
    byChannel,
    topLossReason,
    source: 'local' as const,
  };
}
