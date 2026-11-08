// IMI ONE round 2: Send to AI -> Bring back from AI -> draft -> approval -> Mark as posted.
// Brand-scoped like everything in /v1. Identity always from the verified sign-in.

import type { Env } from './env';
import { HttpError } from './http';
import type { Membership } from './tenancy';
import { allocCode } from './intel';
import { factLines } from './admin';

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const httpsUrl = (s: unknown) => { const v = clip(s, 500); try { return new URL(v).protocol === 'https:' ? v : ''; } catch { return ''; } };

// ------------------------------------------------------------------ providers

const DEFAULT_PROVIDERS = [
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Claude', url: 'https://claude.ai/new' },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
];

export async function listProviders(env: Env, ws: string, who: string) {
  let { results } = await env.DB.prepare('SELECT id, name, url, kind, enabled FROM ai_providers WHERE workspace_id = ? ORDER BY created_at, name').bind(ws).all<any>();
  if (!results?.length) {
    await env.DB.batch(DEFAULT_PROVIDERS.map((p) => env.DB.prepare('INSERT OR IGNORE INTO ai_providers (id, workspace_id, name, url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), ws, p.name, p.url, `default (first opened by ${who})`, now())));
    ({ results } = await env.DB.prepare('SELECT id, name, url, kind, enabled FROM ai_providers WHERE workspace_id = ? ORDER BY created_at, name').bind(ws).all<any>());
  }
  return (results ?? []).map((p) => ({ ...p, enabled: !!p.enabled }));
}

export async function addProvider(env: Env, ws: string, who: string, body: any) {
  const name = clip(body?.name, 40), url = httpsUrl(body?.url);
  if (name.length < 2) throw new HttpError(400, 'Give the AI service a name.');
  if (!url) throw new HttpError(400, 'Use the service\u2019s https:// address.');
  try {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO ai_providers (id, workspace_id, name, url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, ws, name, url, who, now()).run();
    return { id, name, url, kind: 'website', enabled: true };
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new HttpError(409, 'That name is already in the list.');
    throw e;
  }
}

// ------------------------------------------------------------------ Send to AI (full context, redacted, logged)

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?\d[\d\s-]{8,}\d)/g;
export function redact(text: string) {
  let n = 0;
  const out = text.replace(EMAIL, () => { n++; return '[email removed]'; }).replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 10 ? (n++, '[phone removed]') : m));
  return { text: out, count: n };
}

const LABEL: Record<string, string> = { create_content: 'Create a post or campaign', take_action: 'Take a business action', monitor: 'Monitor developments', archive: 'Archive / no action' };

export async function preparePrompt(env: Env, ws: Membership, recordId: string, who: string, body: any) {
  if (ws.kind === 'research') throw new HttpError(403, 'Sending research records to outside AI services is off for this brand until a privacy-reviewed workflow exists.');
  const rec = await env.DB.prepare('SELECT * FROM intelligence_records WHERE id = ? AND workspace_id = ?').bind(recordId, ws.workspace_id).first<any>();
  if (!rec) throw new HttpError(404, 'Record not found');
  const prov = await env.DB.prepare('SELECT name, url FROM ai_providers WHERE id = ? AND workspace_id = ? AND enabled = 1').bind(String(body?.providerId ?? ''), ws.workspace_id).first<any>();
  if (!prov) throw new HttpError(400, 'Choose an AI service from the list.');
  const dec = await env.DB.prepare('SELECT selected_option, rationale FROM decision_items WHERE record_id = ? AND workspace_id = ? AND superseded_by IS NULL').bind(rec.id, ws.workspace_id).first<any>();
  let o: any = {}; try { o = JSON.parse(rec.observation_json || '{}'); } catch { /* keep empty */ }
  const fmt = clip(body?.format, 40) || 'single image post', audience = clip(body?.audience, 200), tone = clip(body?.tone, 120), extra = clip(body?.instructions, 1000);
  const lines = [
    `You are helping ${ws.name} write marketing content. ${clip(ws.description, 400)}`.trim(),
    '',
    'THE FINDING (from IMI ONE; treat as the only source of facts):',
    `Title: ${rec.title}`,
    o.rawStatement && o.rawStatement !== rec.title ? `Statement: ${o.rawStatement}` : '',
    o.source ? `Source: ${o.source}${o.sourceReference ? ` (${o.sourceReference})` : ''}` : '',
    o.publishedAt ? `Published: ${o.publishedAt}` : '',
    o.evidenceClass ? `Evidence type: ${String(o.evidenceClass).replace('_', ' ')}` : '',
    `Verification: ${rec.verification_status || 'unverified'}`,
    dec ? `Our decision: ${LABEL[dec.selected_option] ?? dec.selected_option}. Reason: ${dec.rationale}` : '',
    '',
    'WHAT TO MAKE:',
    `Format: ${fmt}.`,
    audience ? `Audience: ${audience}.` : '',
    tone ? `Tone: ${tone}.` : '',
    ws.max_headline_words ? `Headline: at most ${ws.max_headline_words} words. Open with tension, a question or a surprise in the first three words.` : '',
    extra ? `Also: ${extra}` : '',
    ...(await factLines(env, ws.workspace_id)),
    '',
    'RULES:',
    '- Use only facts stated above. If you add anything else, mark it [suggestion].',
    '- Do not present an AI-generated image as a real photograph of wildlife, people or places.',
    '- Do not claim certainty the evidence does not support.',
    '',
    'REPLY IN EXACTLY THIS FORM so it can be brought back into IMI ONE:',
    'HEADLINE: <one line>',
    'CAPTION: <the caption>',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  const { text, count } = redact(lines.join('\n'));
  const dataClass = o.source ? 'public source' : 'internal note';
  await env.DB.prepare('INSERT INTO ai_handoffs (id, workspace_id, record_id, provider, data_class, redactions, prompt_chars, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), ws.workspace_id, rec.id, prov.name, dataClass, count, text.length, who, now()).run();
  return { prompt: text, redactions: count, provider: prov.name, url: prov.url, dataClass };
}

// ------------------------------------------------------------------ Bring back from AI -> draft

// Accepts "HEADLINE: ... CAPTION: ..." pasted straight from the AI, or separate fields.
export function parseReply(text: string) {
  const h = text.match(/HEADLINE:\s*(.+)/i), c = text.match(/CAPTION:\s*([\s\S]+)/i);
  return h && c ? { headline: h[1].trim(), caption: c[1].trim() } : null;
}

export async function createDraft(env: Env, ws: string, who: string, body: any) {
  let headline = clip(body?.headline, 200), caption = clip(body?.caption, 2200);
  const pasted = clip(body?.pasted, 6000);
  if (pasted) { const p = parseReply(pasted); if (p) { headline = clip(p.headline, 200); caption = clip(p.caption, 2200); } else if (!caption) caption = pasted.slice(0, 2200); }
  if (headline.length < 2 || caption.length < 2) throw new HttpError(400, 'A draft needs a headline and a caption.');
  let recordId: string | null = null;
  if (body?.recordId) {
    const r = await env.DB.prepare('SELECT id FROM intelligence_records WHERE id = ? AND workspace_id = ?').bind(String(body.recordId), ws).first<any>();
    if (!r) throw new HttpError(404, 'Record not found');
    recordId = r.id;
  }
  let source = 'Written here';
  if (body?.providerId) {
    const p = await env.DB.prepare('SELECT name FROM ai_providers WHERE id = ? AND workspace_id = ?').bind(String(body.providerId), ws).first<any>();
    if (!p) throw new HttpError(400, 'Unknown AI service.');
    source = p.name;
  }
  const id = crypto.randomUUID(), at = now();
  await env.DB.prepare(`INSERT INTO drafts (id, workspace_id, record_id, headline, caption, format, source, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, ws, recordId, headline, caption, clip(body?.format, 40) || 'single image', source, who, at, at).run();
  return { id, headline, caption, source };
}

export async function listDrafts(env: Env, ws: string, recordId: string | null) {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.record_id, r.code AS record_code, d.headline, d.caption, d.format, d.source, d.media_type, d.ai_generated_media, d.version, d.status,
       d.created_by, d.created_at, d.updated_at, d.approved_by, d.approved_at, d.posted_url, d.posted_channel, d.posted_at, (d.media_key IS NOT NULL) AS has_media,
       d.scheduled_for, d.scheduled_channel, (SELECT o.code FROM outcome_items o WHERE o.draft_id = d.id) AS outcome_code
     FROM drafts d LEFT JOIN intelligence_records r ON r.id = d.record_id
     WHERE d.workspace_id = ? ${recordId ? 'AND d.record_id = ?' : ''} ORDER BY d.updated_at DESC LIMIT 100`).bind(...(recordId ? [ws, recordId] : [ws])).all<any>();
  return (results ?? []).map((d) => ({ ...d, ai_generated_media: !!d.ai_generated_media, has_media: !!d.has_media }));
}

const getDraft = async (env: Env, ws: string, id: string) => {
  const d = await env.DB.prepare('SELECT * FROM drafts WHERE id = ? AND workspace_id = ?').bind(id, ws).first<any>();
  if (!d) throw new HttpError(404, 'Draft not found');
  return d;
};

// Editing makes a new version and clears approval (the approved text is never silently changed).
export async function editDraft(env: Env, ws: string, id: string, body: any) {
  const d = await getDraft(env, ws, id);
  if (d.status === 'posted') throw new HttpError(409, 'This draft has been posted; make a new draft instead.');
  const headline = clip(body?.headline, 200) || d.headline, caption = clip(body?.caption, 2200) || d.caption;
  await env.DB.prepare(`UPDATE drafts SET headline = ?, caption = ?, version = version + 1, status = 'draft', approved_by = NULL, approved_at = NULL, approved_version = NULL, scheduled_for = NULL, scheduled_channel = NULL, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND version = ?`).bind(headline, caption, now(), id, ws, d.version).run();
  return { id, version: d.version + 1, status: 'draft' };
}

export async function approveDraft(env: Env, ws: string, id: string, who: string, body: any) {
  const d = await getDraft(env, ws, id);
  const v = Number(body?.version);
  if (v !== d.version) throw new HttpError(409, 'The draft changed since you opened it. Review the new version.');
  if (d.status !== 'draft') return { id, status: d.status, version: d.version };
  const r = await env.DB.prepare("UPDATE drafts SET status = 'approved', approved_by = ?, approved_at = ?, approved_version = version WHERE id = ? AND workspace_id = ? AND status = 'draft' AND version = ?")
    .bind(who, now(), id, ws, v).run();
  if (!(r as any).meta?.changes) throw new HttpError(409, 'The draft changed since you opened it.');
  return { id, status: 'approved', version: v, approvedBy: who };
}

export async function markPosted(env: Env, ws: string, id: string, who: string, body: any) {
  const d = await getDraft(env, ws, id);
  if (d.status === 'posted') return { id, status: 'posted', url: d.posted_url };
  if (d.status !== 'approved') throw new HttpError(409, 'Approve the draft before marking it as posted.');
  const url = httpsUrl(body?.url);
  if (!url) throw new HttpError(400, 'Paste the link to the live post (https://...).');
  const channel = clip(body?.channel, 40) || 'unspecified';
  await env.DB.prepare("UPDATE drafts SET status = 'posted', posted_url = ?, posted_channel = ?, posted_by = ?, posted_at = ? WHERE id = ? AND workspace_id = ? AND status = 'approved'")
    .bind(url, channel, who, now(), id, ws).run();
  return { id, status: 'posted', url };
}

// ------------------------------------------------------------------ media brought back (private)

const MEDIA: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export async function putMedia(env: Env, ws: string, id: string, request: Request) {
  const d = await getDraft(env, ws, id);
  if (d.status === 'posted') throw new HttpError(409, 'This draft has been posted.');
  const type = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!MEDIA[type]) throw new HttpError(415, 'Use a PNG, JPEG or WebP image.');
  const buf = await request.arrayBuffer();
  if (buf.byteLength < 100 || buf.byteLength > 10 * 1024 * 1024) throw new HttpError(413, 'The image must be under 10 MB.');
  const aiMade = new URL(request.url).searchParams.get('ai') === '1';
  const key = `drafts/${ws}/${id}/${crypto.randomUUID()}.${MEDIA[type]}`;
  await env.POSTERS.put(key, buf, { httpMetadata: { contentType: type } });
  await env.DB.prepare(`UPDATE drafts SET media_key = ?, media_type = ?, ai_generated_media = ?, version = version + 1, status = 'draft', approved_by = NULL, approved_at = NULL,
      approved_version = NULL, scheduled_for = NULL, scheduled_channel = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`).bind(key, type, aiMade ? 1 : 0, now(), id, ws).run();
  return { id, mediaType: type, aiGenerated: aiMade };
}

export async function getMedia(env: Env, ws: string, id: string) {
  const d = await getDraft(env, ws, id);
  if (!d.media_key) throw new HttpError(404, 'No image');
  const obj = await env.POSTERS.get(d.media_key);
  if (!obj) throw new HttpError(404, 'No image');
  return new Response(obj.body, { headers: { 'Content-Type': d.media_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

// ------------------------------------------------------------------ round 3: schedule, calendar, outcomes

export const CHANNELS = ['Instagram', 'Facebook', 'LinkedIn', 'Threads', 'WhatsApp Status', 'Website'];

// Only an approved draft can be scheduled. Without direct publishing, the owner posts it
// and IMI ONE reminds them when it is due. {when: null} removes it from the calendar.
export async function scheduleDraft(env: Env, ws: string, id: string, body: any) {
  const d = await getDraft(env, ws, id);
  if (body?.when === null) {
    await env.DB.prepare('UPDATE drafts SET scheduled_for = NULL, scheduled_channel = NULL WHERE id = ? AND workspace_id = ?').bind(id, ws).run();
    return { id, scheduledFor: null };
  }
  if (d.status !== 'approved') throw new HttpError(409, 'Approve the draft before scheduling it.');
  // Moving on the calendar: a new date only, keeping the scheduled time of day and channel.
  if (typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) && d.scheduled_for) {
    body = { when: `${body.date}T${String(d.scheduled_for).slice(11)}`, channel: d.scheduled_channel };
  }
  const when = new Date(String(body?.when ?? ''));
  if (Number.isNaN(when.getTime())) throw new HttpError(400, 'Choose a date and time.');
  if (when.getTime() < Date.now() - 60_000) throw new HttpError(400, 'Choose a time in the future.');
  if (when.getTime() > Date.now() + 366 * 86400_000) throw new HttpError(400, 'Choose a time within the next year.');
  const channel = CHANNELS.includes(body?.channel) ? body.channel : null;
  if (!channel) throw new HttpError(400, 'Choose where it will be posted.');
  const iso = when.toISOString();
  await env.DB.prepare("UPDATE drafts SET scheduled_for = ?, scheduled_channel = ? WHERE id = ? AND workspace_id = ? AND status = 'approved'").bind(iso, channel, id, ws).run();
  return { id, scheduledFor: iso, channel };
}

const channelId = (c: string | null) => (c ? c.toLowerCase().replace(/\s.*$/, '') : 'website');

// Calendar for one month (YYYY-MM): scheduled drafts and posted ones, in the calendar's own shape.
export async function calendar(env: Env, ws: string, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Month as YYYY-MM.');
  const { results } = await env.DB.prepare(
    `SELECT id, headline, status, scheduled_for, scheduled_channel, posted_at, posted_channel FROM drafts
     WHERE workspace_id = ? AND ((status = 'approved' AND substr(scheduled_for, 1, 7) = ?) OR (status = 'posted' AND substr(COALESCE(scheduled_for, posted_at), 1, 7) = ?))
     ORDER BY COALESCE(scheduled_for, posted_at)`).bind(ws, month, month).all<any>();
  return {
    posts: (results ?? []).map((d) => ({
      id: d.id, title: d.headline,
      channels: [channelId(d.status === 'posted' ? d.posted_channel : d.scheduled_channel)],
      when: d.scheduled_for ?? new Date(String(d.posted_at).replace(' ', 'T') + 'Z').toISOString(),
      state: d.status === 'posted' ? 'published' : 'manual',
      stateNote: d.status === 'posted' ? 'Posted' : 'You post this; IMI ONE reminds you.',
    })),
    blocks: [],
  };
}

// Results of a posted draft become an outcome, linked to the record's current decision.
export async function recordOutcome(env: Env, ws: { id: string; domain: string }, draftId: string, who: string, body: any) {
  const d = await getDraft(env, ws.id, draftId);
  if (d.status !== 'posted') throw new HttpError(409, 'Results are recorded after the post is live.');
  const summary = clip(body?.summary, 1000);
  if (summary.length < 3) throw new HttpError(400, 'Say what happened, in a sentence.');
  const conf = ['low', 'medium', 'high'].includes(body?.confidence) ? body.confidence : null;
  if (!conf) throw new HttpError(400, 'Say how sure you are that the post caused this.');
  const reason = clip(body?.reason, 500);
  if (reason.length < 3) throw new HttpError(400, 'Say why you are that sure.');
  const metrics: Record<string, number> = {};
  for (const k of ['reach', 'engagements', 'enquiries', 'bookings']) {
    if (body?.[k] === undefined || body?.[k] === null || body?.[k] === '') continue;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 0 || n > 1e9) throw new HttpError(400, `${k} must be a whole number.`);
    metrics[k] = n;
  }
  const dec = d.record_id ? await env.DB.prepare('SELECT code FROM decision_items WHERE record_id = ? AND workspace_id = ? AND superseded_by IS NULL').bind(d.record_id, ws.id).first<any>() : null;
  const id = crypto.randomUUID(), code = await allocCode(env, 'OUT');
  try {
    await env.DB.prepare(`INSERT INTO outcome_items (id, code, domain, decision_code, action_taken, actual_outcome, date_evaluated, evaluator, retrospective,
        quantitative_results_json, attribution_confidence_level, attribution_confidence_reason, resulting_learning_json, workspace_id, draft_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?, '[]', ?, ?)`)
      .bind(id, code, ws.domain, dec?.code ?? 'none', `Posted "${clip(d.headline, 150)}" on ${d.posted_channel}`, summary, now().slice(0, 10), who,
        JSON.stringify({ ...metrics, source: 'entered by hand' }), conf, reason, ws.id, d.id).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new HttpError(409, 'Results for this post are already recorded.');
    throw e;
  }
  return { id, code, decisionCode: dec?.code ?? null };
}
