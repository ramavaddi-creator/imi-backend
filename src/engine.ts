// IMI ONE round 11: Build 4, the Content Engine (design section 5).
//
//   idea (record | voice note | typed idea) -> content pack -> one prompt (idea map + every chosen format)
//   -> Route A: Send to AI (copy, paste back)   or   Route B: direct AI call through the budget gate
//   -> one draft per format, each tied to the pack, the Brand Kit version and the template version
//   -> checks (Brand Facts wrong forms block; word limits and hashtags warn) -> owner approval
//   -> week plan from the Brand Kit's cadence (suggested, never forced) -> results by the brand's goal.
//
// Brand Kits and templates are immutable versions. An owner idea is labelled "owner idea, not evidence".

import type { Env } from './env';
import { HttpError, now } from './http';
import type { Membership } from './tenancy';
import { listFacts } from './admin';
import { redact } from './create';
import { linkChecks, packLinkLines } from './links';
import { aiGate, getBudget, costInr, usage } from './aibudget';
import { io, redact as redactSecrets } from './search';

const iso = () => new Date().toISOString();
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
export const PACK_PROMPT_VERSION = 'imi-pack-1.1 (2026-11-20, links)';

// ---------------------------------------------------------------- Brand Kit

export interface Kit {
  description: string; audiences: string[]; voice: string;
  visual: { colours: { name: string; hex: string }[]; fonts: string[]; imageRules: string[] };
  formats: string[]; maxPosterWords: number | null; maxHeadlineWords: number | null; hookRule: boolean;
  cadence: { maxGapDays: number | null; rotation: 'no_three_same' | null; preferredTime: string | null };
  goal: string; compliance: string[]; neverSend: string[];
}

const strList = (v: unknown, max: number, len: number) => (Array.isArray(v) ? v : []).map((x) => clip(x, len)).filter(Boolean).slice(0, max);
const intOrNull = (v: unknown, lo: number, hi: number, name: string) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${name}: a whole number from ${lo} to ${hi}, or empty.`);
  return n;
};

export async function templates(env: Env) {
  const { results } = await env.DB.prepare(`SELECT t.* FROM format_template_versions t WHERE t.version = (SELECT MAX(version) FROM format_template_versions x WHERE x.template_key = t.template_key) ORDER BY t.template_key`).all<any>();
  return (results ?? []).map((t) => ({ id: t.id, key: t.template_key, version: t.version, name: t.name, channel: t.channel, rules: JSON.parse(t.rules_json), instructions: t.prompt_template }));
}

export function validateKit(body: any, knownFormats: string[]): Kit {
  const k = body?.kit ?? body ?? {};
  const formats = strList(k.formats, 12, 40).filter((f) => knownFormats.includes(f));
  if (!formats.length) throw new HttpError(400, 'Choose at least one format.');
  const colours = (Array.isArray(k.visual?.colours) ? k.visual.colours : []).slice(0, 8).map((c: any) => {
    const hex = clip(c?.hex, 7);
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new HttpError(400, 'Colours are hex codes such as #080F08.');
    return { name: clip(c?.name, 30) || hex, hex: hex.toUpperCase() };
  });
  const time = clip(k.cadence?.preferredTime, 5);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'Preferred time as HH:MM, for example 18:30.');
  const rotation = k.cadence?.rotation === 'no_three_same' ? 'no_three_same' : null;
  return {
    description: clip(k.description, 600), audiences: strList(k.audiences, 8, 200), voice: clip(k.voice, 400),
    visual: { colours, fonts: strList(k.visual?.fonts, 4, 60), imageRules: strList(k.visual?.imageRules, 8, 200) },
    formats, maxPosterWords: intOrNull(k.maxPosterWords, 3, 40, 'Poster word limit'), maxHeadlineWords: intOrNull(k.maxHeadlineWords, 3, 40, 'Headline word limit'),
    hookRule: !!k.hookRule,
    cadence: { maxGapDays: intOrNull(k.cadence?.maxGapDays, 1, 30, 'Longest gap between posts'), rotation, preferredTime: time || null },
    goal: clip(k.goal, 120), compliance: strList(k.compliance, 12, 300), neverSend: strList(k.neverSend, 12, 200),
  };
}

async function kitVersion(env: Env, ws: string, versionId?: string) {
  const row = versionId
    ? await env.DB.prepare('SELECT * FROM brand_kit_versions WHERE id = ? AND workspace_id = ?').bind(versionId, ws).first<any>()
    : await env.DB.prepare('SELECT v.* FROM brand_kits k JOIN brand_kit_versions v ON v.id = k.current_version_id WHERE k.workspace_id = ?').bind(ws).first<any>();
  return row ? { id: row.id as string, version: row.version as number, kit: JSON.parse(row.kit_json) as Kit, note: row.note, createdBy: row.created_by, createdAt: row.created_at } : null;
}

export async function getKit(env: Env, ws: string) {
  const current = await kitVersion(env, ws);
  const { results } = await env.DB.prepare('SELECT id, version, note, created_by, created_at FROM brand_kit_versions WHERE workspace_id = ? ORDER BY version DESC LIMIT 50').bind(ws).all<any>();
  return { current, history: results ?? [], templates: await templates(env) };
}

// A change is a new version; nothing is edited in place.
export async function saveKit(env: Env, ws: string, who: string, body: any) {
  const tpl = await templates(env);
  const kit = validateKit(body, tpl.map((t) => t.key));
  const last = await env.DB.prepare('SELECT MAX(version) AS v FROM brand_kit_versions WHERE workspace_id = ?').bind(ws).first<{ v: number | null }>();
  const id = crypto.randomUUID(), version = (last?.v ?? 0) + 1;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO brand_kit_versions (id, workspace_id, version, kit_json, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, ws, version, JSON.stringify(kit), clip(body?.note, 200) || null, who, iso()),
    env.DB.prepare('INSERT INTO brand_kits (workspace_id, current_version_id) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET current_version_id = excluded.current_version_id').bind(ws, id),
  ]);
  return getKit(env, ws);
}

// ---------------------------------------------------------------- checks (design 5.8: listed wrong forms and limits only)

export interface Check { level: 'block' | 'warn'; code: string; message: string }
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export async function checkText(env: Env, ws: string, d: { headline: string; caption: string }, kit: Kit | null, rules: any | null): Promise<Check[]> {
  const out: Check[] = [];
  const text = `${d.headline}\n${d.caption}`.toLowerCase();
  for (const f of await listFacts(env, ws)) for (const w of f.wrongForms) {
    if (w && text.includes(w.toLowerCase())) out.push({ level: 'block', code: 'wrong_form', message: `"${w}" contradicts an approved Brand Fact: ${f.statement}` });
  }
  const limit = rules?.usePosterLimit ? kit?.maxPosterWords : rules?.useKitHeadlineLimit ? kit?.maxHeadlineWords : null;
  if (limit && words(d.headline) > limit) out.push({ level: 'warn', code: 'word_limit', message: `The headline has ${words(d.headline)} words; this brand's limit for this format is ${limit}.` });
  const tags = (d.caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (rules && typeof rules.maxHashtags === 'number' && tags > rules.maxHashtags) out.push({ level: 'warn', code: 'hashtags', message: `${tags} hashtags; this format allows ${rules.maxHashtags}.` });
  if (rules?.maxChars && d.caption.length > rules.maxChars) out.push({ level: 'warn', code: 'length', message: `The caption is ${d.caption.length} characters; the limit is ${rules.maxChars}.` });
  out.push(...(await linkChecks(env, ws, `${d.headline}\n${d.caption}`)));
  return out;
}

// Used by approval for every draft: a listed wrong form blocks approval until the text is fixed.
export async function draftChecks(env: Env, ws: string, d: any) {
  const kv = d.brand_kit_version_id ? await kitVersion(env, ws, d.brand_kit_version_id) : null;
  const t = d.format_template_version_id ? await env.DB.prepare('SELECT rules_json FROM format_template_versions WHERE id = ?').bind(d.format_template_version_id).first<any>() : null;
  return checkText(env, ws, { headline: d.headline, caption: d.caption }, kv?.kit ?? null, t ? JSON.parse(t.rules_json) : null);
}

// ---------------------------------------------------------------- packs

async function getPackRow(env: Env, ws: string, id: string) {
  const p = await env.DB.prepare('SELECT * FROM content_packs WHERE id = ? AND workspace_id = ?').bind(id, ws).first<any>();
  if (!p) throw new HttpError(404, 'Pack not found');
  return p;
}

export async function createPack(env: Env, m: Membership, who: string, body: any) {
  const ws = m.workspace_id;
  const kv = await kitVersion(env, ws);
  if (!kv) throw new HttpError(409, 'Set up this brand\'s Brand Kit first (Brand settings, Brand Kit).');
  const kind = String(body?.input?.kind ?? '');
  if (!['record', 'voice_note', 'typed_idea'].includes(kind)) throw new HttpError(400, 'Start from a record, a voice note or a typed idea.');
  let recordId: string | null = null, text = '';
  if (kind === 'record') {
    if (m.kind === 'research') throw new HttpError(403, 'Research records are never sent to an AI for this brand. Type the idea instead.');
    const r = await env.DB.prepare('SELECT id, title, observation_json FROM intelligence_records WHERE id = ? AND workspace_id = ?').bind(String(body?.input?.recordId ?? ''), ws).first<any>();
    if (!r) throw new HttpError(404, 'Record not found');
    let o: any = {}; try { o = JSON.parse(r.observation_json || '{}'); } catch { /* */ }
    recordId = r.id;
    text = [r.title, o.rawStatement && o.rawStatement !== r.title ? o.rawStatement : '', o.source ? `Source: ${o.source}` : ''].filter(Boolean).join('\n');
  } else {
    text = clip(body?.input?.text, 2000);
    if (text.length < 10) throw new HttpError(400, 'Describe the idea in at least a sentence.');
  }
  const tpl = await templates(env);
  const wanted = strList(body?.formats, 8, 40);
  const chosen = (wanted.length ? wanted : kv.kit.formats).filter((k) => kv.kit.formats.includes(k));
  const picked = tpl.filter((t) => chosen.includes(t.key));
  if (!picked.length) throw new HttpError(400, 'Choose at least one of this brand\'s formats.');
  const provenance = kind === 'record'
    ? { kind, by: who, at: iso(), label: 'From an evidence record' }
    : { kind, by: who, at: iso(), label: 'Owner idea, not evidence', ...(kind === 'voice_note' ? { transcribed: 'in the browser, by the person who recorded it' } : {}) };
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO content_packs (id, workspace_id, source_record_id, input_kind, input_text, input_provenance_json, brand_kit_version_id, templates_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, ws, recordId, kind, text, JSON.stringify(provenance), kv.id,
    JSON.stringify(picked.map((t) => ({ key: t.key, id: t.id, version: t.version }))), who, iso(), iso()).run();
  return getPack(env, ws, id);
}

export async function listPacks(env: Env, ws: string) {
  const { results } = await env.DB.prepare(`SELECT p.id, p.input_kind, substr(p.input_text, 1, 140) AS input_text, p.status, p.route, p.created_by, p.created_at, v.version AS kit_version,
    (SELECT COUNT(*) FROM drafts d WHERE d.pack_id = p.id) AS drafts FROM content_packs p JOIN brand_kit_versions v ON v.id = p.brand_kit_version_id
    WHERE p.workspace_id = ? ORDER BY p.created_at DESC LIMIT 50`).bind(ws).all<any>();
  return results ?? [];
}

export async function getPack(env: Env, ws: string, id: string) {
  const p = await getPackRow(env, ws, id);
  const kv = await kitVersion(env, ws, p.brand_kit_version_id);
  const { results } = await env.DB.prepare(`SELECT d.id, d.headline, d.caption, d.format, d.status, d.version, d.scheduled_for, d.scheduled_channel, d.approved_by, d.approved_at,
    d.format_template_version_id, d.brand_kit_version_id, d.approved_kit_version_id, d.approved_template_version_id, d.pack_media_id, d.media_type, d.ai_generated_media, t.template_key, t.version AS template_version, t.channel
    FROM drafts d LEFT JOIN format_template_versions t ON t.id = d.format_template_version_id WHERE d.pack_id = ? AND d.workspace_id = ? ORDER BY t.template_key`).bind(id, ws).all<any>();
  const drafts: any[] = [];
  for (const d of results ?? []) drafts.push({ ...d, checks: await draftChecks(env, ws, d) });
  return {
    id: p.id, inputKind: p.input_kind, inputText: p.input_text, provenance: JSON.parse(p.input_provenance_json), sourceRecordId: p.source_record_id,
    kit: kv ? { id: kv.id, version: kv.version } : null, templates: JSON.parse(p.templates_json), ideaMap: p.idea_map_json ? JSON.parse(p.idea_map_json) : null,
    status: p.status, route: p.route, estCostInr: p.est_cost_inr, createdBy: p.created_by, createdAt: p.created_at, drafts,
    media: await listPackMedia(env, ws, p.id), mediaLimits: MEDIA_LIMIT_NOTE,
  };
}

// One prompt: the idea map plus every chosen format, with the brand's rules and facts.
async function buildPackPrompt(env: Env, m: Membership, p: any) {
  const kv = (await kitVersion(env, m.workspace_id, p.brand_kit_version_id))!;
  const k = kv.kit;
  const tplRows = JSON.parse(p.templates_json) as { key: string; id: string }[];
  const tpls: any[] = [];
  for (const t of tplRows) {
    const r = await env.DB.prepare('SELECT * FROM format_template_versions WHERE id = ?').bind(t.id).first<any>();
    if (r) tpls.push(r);
  }
  const facts = await listFacts(env, m.workspace_id);
  const prov = JSON.parse(p.input_provenance_json);
  const lines = [
    `You are a content team for ${m.name}. ${k.description}`.trim(),
    k.audiences.length ? `Audiences: ${k.audiences.join('; ')}.` : '',
    k.voice ? `Voice: ${k.voice}` : '',
    k.goal ? `What success means: ${k.goal}. Write for that, not for likes.` : '',
    '',
    p.input_kind === 'record' ? 'THE FINDING (treat as the only source of facts):' : `THE IDEA (${prov.label}; do not present it as research or evidence):`,
    p.input_text,
    '',
    'BRAND RULES:',
    k.hookRule ? '- Open every headline with tension, a question or a surprise in the first three words; never a flat statement.' : '',
    k.maxHeadlineWords ? `- Headlines: at most ${k.maxHeadlineWords} words.` : '',
    k.maxPosterWords ? `- Text on a poster or image: at most ${k.maxPosterWords} words, one idea.` : '',
    ...k.compliance.map((c) => `- ${c}`),
    ...k.visual.imageRules.map((c) => `- ${c}`),
    '- Use only facts stated above or in the Brand Facts. Mark anything else [suggestion].',
    ...(facts.length ? ['', 'BRAND FACTS (state them exactly; never use the wrong forms):', ...facts.map((f) => `- ${f.statement}${f.wrongForms.length ? ` Never write: ${f.wrongForms.map((w) => `"${w}"`).join(', ')}.` : ''}`)] : []),
    ...(await mediaLines(env, p.id)),
    '@@LINKS@@',
    '',
    'FIRST, AN IDEA MAP:',
    'IDEA MAP',
    'HOOK: <the tension or question>',
    'STORY: <the moment or story, in one or two sentences>',
    'PROOF: <the fact that makes it true, from the facts above>',
    'AUDIENCE: <who this is for>',
    '',
    'THEN ONE SECTION PER FORMAT, EXACTLY IN THIS FORM:',
    ...tpls.flatMap((t) => [`=== ${t.template_key} ===`, `(${t.name}) ${t.prompt_template}`, 'HEADLINE: <one line>', '<the rest of this format>', '']),
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  // The brand's own links go in after redaction, which would otherwise remove its WhatsApp number and email.
  const [head, tail] = lines.join('\n').split('@@LINKS@@');
  const a = redact(head), b = redact(tail);
  const linkBlock = (await packLinkLines(env, m.workspace_id, tplRows.map((t) => t.key))).join('\n');
  return { text: `${a.text.replace(/\n+$/, '')}\n${linkBlock}\n${b.text.replace(/^\n+/, '\n')}`, count: a.count + b.count };
}

export async function packPrompt(env: Env, m: Membership, id: string, who: string, body: any) {
  const p = await getPackRow(env, m.workspace_id, id);
  const prov = await env.DB.prepare('SELECT name, url FROM ai_providers WHERE id = ? AND workspace_id = ? AND enabled = 1').bind(String(body?.providerId ?? ''), m.workspace_id).first<any>();
  if (!prov) throw new HttpError(400, 'Choose an AI service from the list.');
  const { text, count } = await buildPackPrompt(env, m, p);
  await env.DB.prepare('INSERT INTO pack_handoffs (id, workspace_id, pack_id, provider, route, redactions, prompt_chars, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), m.workspace_id, id, prov.name, 'send_to_ai', count, text.length, who, iso()).run();
  return { prompt: text, redactions: count, provider: prov.name, url: prov.url, note: 'Your AI service may have its own costs; they are outside IMI ONE\'s budget.' };
}

// Parses "IDEA MAP ... === key === HEADLINE: ... rest". Only the pack's own formats are accepted.
export function parsePackReply(text: string, keys: string[]) {
  const map: Record<string, string> = {};
  const head = text.split(/^===/m)[0];
  for (const f of ['HOOK', 'STORY', 'PROOF', 'AUDIENCE']) {
    const mm = head.match(new RegExp(`^\\s*${f}:\\s*(.+)$`, 'mi'));
    if (mm) map[f.toLowerCase()] = mm[1].trim().slice(0, 400);
  }
  const sections: { key: string; headline: string; caption: string }[] = [];
  const re = /^===\s*([a-z_]+)\s*===\s*$/gm;
  const marks = [...text.matchAll(re)];
  marks.forEach((mk, i) => {
    const key = mk[1];
    if (!keys.includes(key) || sections.some((s) => s.key === key)) return;
    const body = text.slice((mk.index ?? 0) + mk[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined).replace(/^\s*\([^)]*\)[^\n]*\n/, '').trim();
    const h = body.match(/^\s*HEADLINE:\s*(.+)$/mi);
    if (!h) return;
    const rest = body.replace(h[0], '').trim();
    sections.push({ key, headline: h[1].trim().slice(0, 200), caption: rest.slice(0, 2200) });
  });
  return { ideaMap: Object.keys(map).length ? map : null, sections };
}

async function saveDrafts(env: Env, ws: string, who: string, p: any, parsed: ReturnType<typeof parsePackReply>, source: string, route: 'send_to_ai' | 'direct_ai') {
  if (p.status === 'drafted') throw new HttpError(409, 'This pack already has drafts. Start a new pack for another version.');
  if (!parsed.sections.length) throw new HttpError(400, 'No format sections were found. The reply must contain lines like "=== caption ===" followed by "HEADLINE: ...".');
  const tplRows = JSON.parse(p.templates_json) as { key: string; id: string }[];
  const at = now();
  const stmts = parsed.sections.filter((s) => s.caption.length >= 2).map((s) => {
    const t = tplRows.find((x) => x.key === s.key)!;
    return env.DB.prepare(`INSERT INTO drafts (id, workspace_id, record_id, headline, caption, format, source, created_by, created_at, updated_at, pack_id, format_template_version_id, brand_kit_version_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), ws, p.source_record_id, s.headline, s.caption, s.key.replace(/_/g, ' '), source, who, at, at, p.id, t.id, p.brand_kit_version_id);
  });
  if (!stmts.length) throw new HttpError(400, 'Every section needs a headline and some text under it.');
  stmts.push(env.DB.prepare("UPDATE content_packs SET status = 'drafted', route = ?, idea_map_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'new'")
    .bind(route, parsed.ideaMap ? JSON.stringify(parsed.ideaMap) : null, iso(), p.id, ws));
  await env.DB.batch(stmts);
  return getPack(env, ws, p.id);
}

// Route A: bring the AI's reply back.
export async function bringBack(env: Env, ws: string, id: string, who: string, body: any) {
  const p = await getPackRow(env, ws, id);
  const text = clip(body?.pasted, 20000);
  let source = 'Send to AI';
  if (body?.providerId) {
    const pr = await env.DB.prepare('SELECT name FROM ai_providers WHERE id = ? AND workspace_id = ?').bind(String(body.providerId), ws).first<any>();
    if (pr) source = pr.name;
  }
  return saveDrafts(env, ws, who, p, parsePackReply(text, (JSON.parse(p.templates_json) as any[]).map((t) => t.key)), source, 'send_to_ai');
}

// Route B: estimate first, then a direct call only through the budget gate.
export async function estimate(env: Env, m: Membership, id: string) {
  const p = await getPackRow(env, m.workspace_id, id);
  const { text } = await buildPackPrompt(env, m, p);
  const formats = (JSON.parse(p.templates_json) as any[]).length;
  const tokensIn = Math.ceil(text.length / 4), tokensOut = 250 + 600 * formats;
  const b = await getBudget(env, m.workspace_id);
  const inr = costInr(b.prices, 'anthropic', { inputTokens: tokensIn, outputTokens: tokensOut });
  const u = await usage(env, m.workspace_id);
  return { provider: 'anthropic', inputTokens: tokensIn, outputTokens: tokensOut, estimateInr: inr, aiEnabled: b.enabled, spentInr: u.spentInr, monthlyCapInr: b.monthlyCapInr,
    fits: b.enabled && u.spentInr + inr <= b.monthlyCapInr, keyConfigured: !!env.ANTHROPIC_API_KEY, note: 'An estimate from the prompt length; the provider\'s bill is the source of truth.' };
}

export async function generate(env: Env, m: Membership, id: string, who: string) {
  const ws = m.workspace_id;
  const p = await getPackRow(env, ws, id);
  if (p.status === 'drafted') throw new HttpError(409, 'This pack already has drafts.');
  // The gate runs before anything else: with AI off or a limit reached, nothing is sent anywhere.
  await aiGate(env, { workspace: ws, provider: 'anthropic', kind: 'text', user: who });
  const est = await estimate(env, m, id);
  if (!est.fits) throw new HttpError(429, `This pack is estimated at Rs ${est.estimateInr}; it would pass this month's AI budget (Rs ${est.monthlyCapInr}).`);
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(409, 'No AI key is set on this server. Use "Send to AI" instead.');
  const { text } = await buildPackPrompt(env, m, p);
  const model = env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const t0 = Date.now();
  let status: 'ok' | 'error' = 'ok', error: string | null = null, reply = '', usageIn: number | null = null, usageOut: number | null = null;
  try {
    const res = await io.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: Math.min(8000, est.outputTokens + 1000), messages: [{ role: 'user', content: text }] }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`The AI service answered ${res.status}: ${j?.error?.message ?? ''}`);
    reply = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    usageIn = j.usage?.input_tokens ?? null; usageOut = j.usage?.output_tokens ?? null;
  } catch (e) { status = 'error'; error = redactSecrets(e instanceof Error ? e.message : String(e)); }
  const b = await getBudget(env, ws);
  await env.DB.prepare(`INSERT INTO ai_calls (id, kind, task, provider, model, prompt_version, params_json, input_tokens, output_tokens, images, latency_ms, status, error, entity_type, entity_id, created_at, workspace_id, user_email, cost_inr)
    VALUES (?, 'text', 'content_pack', 'anthropic', ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'content_pack', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), model, PACK_PROMPT_VERSION, JSON.stringify({ formats: est.outputTokens }), usageIn, usageOut, Date.now() - t0, status, error, id, now(), ws, who,
      status === 'ok' ? costInr(b.prices, 'anthropic', { inputTokens: usageIn ?? est.inputTokens, outputTokens: usageOut ?? est.outputTokens }) : 0).run();
  await env.DB.prepare("UPDATE content_packs SET est_cost_inr = ? WHERE id = ?").bind(est.estimateInr, id).run();
  if (status === 'error') throw new HttpError(502, error ?? 'The AI service failed.');
  await env.DB.prepare('INSERT INTO pack_handoffs (id, workspace_id, pack_id, provider, route, redactions, prompt_chars, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), ws, id, 'Claude (direct)', 'direct_ai', 0, text.length, who, iso()).run();
  return saveDrafts(env, ws, who, p, parsePackReply(reply, (JSON.parse(p.templates_json) as any[]).map((t) => t.key)), 'Claude (direct, budget-checked)', 'direct_ai');
}

// ---------------------------------------------------------------- week plan (suggests; never forces filler posts)

export async function plan(env: Env, ws: string, id: string, body: any, canSchedule: boolean) {
  const p = await getPack(env, ws, id);
  const kv = await kitVersion(env, ws, p.kit!.id);
  const cad = kv!.kit.cadence;
  const items = p.drafts.map((d: any) => ({ draftId: d.id, format: d.template_key, channel: d.channel, approved: d.status === 'approved', suggestedFor: null as string | null }));
  if (!cad.maxGapDays) return { cadence: cad, items, note: 'No posting rhythm is set for this brand, so IMI ONE suggests no dates. Choose them yourself.' };
  // Order so the same format is never used three times in a row when rotation is on, then space by the gap.
  const order: typeof items = [];
  const pool = [...items];
  while (pool.length) {
    let i = 0;
    if (cad.rotation === 'no_three_same' && order.length >= 2 && order.at(-1)!.format === order.at(-2)!.format) {
      const j = pool.findIndex((x) => x.format !== order.at(-1)!.format);
      if (j >= 0) i = j;
    }
    order.push(pool.splice(i, 1)[0]);
  }
  const { results: last } = await env.DB.prepare(`SELECT MAX(COALESCE(scheduled_for, posted_at)) AS t FROM drafts WHERE workspace_id = ? AND (status = 'posted' OR scheduled_for IS NOT NULL) AND (pack_id IS NULL OR pack_id != ?)`).bind(ws, id).all<any>();
  const lastT = last?.[0]?.t ? Date.parse(String(last[0].t).replace(' ', 'T') + (String(last[0].t).endsWith('Z') ? '' : 'Z')) : NaN;
  const [hh, mm] = (cad.preferredTime ?? '18:30').split(':').map(Number);
  // IST wall-clock time stored as UTC.
  const startDay = new Date(Math.max(Date.now() + 86400_000, Number.isFinite(lastT) ? lastT + 86400_000 : 0));
  let t = Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate(), hh, mm) - 330 * 60_000;
  const gapDays = Math.max(1, Math.min(cad.maxGapDays, Math.ceil(7 / Math.max(1, order.length))));
  for (const it of order) { it.suggestedFor = new Date(t).toISOString(); t += gapDays * 86400_000; }
  if (body?.apply) {
    if (!canSchedule) throw new HttpError(403, 'Only an owner can schedule posts.');
    let scheduled = 0;
    for (const it of order) {
      if (!it.approved) continue;
      const r = await env.DB.prepare("UPDATE drafts SET scheduled_for = ?, scheduled_channel = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'approved'")
        .bind(it.suggestedFor, it.channel ?? 'Instagram', now(), it.draftId, ws).run();
      scheduled += (r as any).meta?.changes ?? 0;
    }
    return { cadence: cad, items: order, scheduled, note: `${scheduled} approved drafts scheduled. Drafts not yet approved were left unscheduled.` };
  }
  return { cadence: cad, items: order, note: `Suggested: one post every ${gapDays} day(s) at ${cad.preferredTime ?? '18:30'} IST, within this brand's longest gap of ${cad.maxGapDays} day(s). Only approved drafts can be scheduled.` };
}

// ---------------------------------------------------------------- round 11.1: photos and videos on a pack

const PACK_MEDIA: Record<string, { ext: string; kind: 'image' | 'video'; max: number }> = {
  'image/jpeg': { ext: 'jpg', kind: 'image', max: 20 * 1024 * 1024 },
  'image/png': { ext: 'png', kind: 'image', max: 20 * 1024 * 1024 },
  'image/webp': { ext: 'webp', kind: 'image', max: 20 * 1024 * 1024 },
  'video/mp4': { ext: 'mp4', kind: 'video', max: 95 * 1024 * 1024 },
  'video/quicktime': { ext: 'mov', kind: 'video', max: 95 * 1024 * 1024 },
  'video/webm': { ext: 'webm', kind: 'video', max: 95 * 1024 * 1024 },
};
export const MEDIA_LIMIT_NOTE = 'Photos up to 20 MB (JPEG, PNG, WebP); videos up to 95 MB (MP4, MOV, WebM).';

// The file streams straight to private storage; the declared size is checked first (Cloudflare's own
// limit for one upload is 100 MB). The person must say whether it is real or AI-made.
export async function addPackMedia(env: Env, ws: string, id: string, who: string, request: Request) {
  const p = await getPackRow(env, ws, id);
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const spec = PACK_MEDIA[type];
  if (!spec) throw new HttpError(415, `This file type is not accepted. ${MEDIA_LIMIT_NOTE}`);
  const u = new URL(request.url);
  const origin = u.searchParams.get('origin');
  if (origin !== 'real' && origin !== 'ai_made') throw new HttpError(400, 'Say whether this is a real photo or video, or AI-made.');
  const bytes = Number(request.headers.get('content-length'));
  if (!Number.isFinite(bytes) || bytes < 100) throw new HttpError(411, 'The file size was not sent. Try again.');
  if (bytes > spec.max) throw new HttpError(413, `Too large. ${MEDIA_LIMIT_NOTE}`);
  const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM pack_media WHERE pack_id = ? AND removed_at IS NULL').bind(p.id).first<{ n: number }>())?.n ?? 0;
  if (count >= 20) throw new HttpError(409, 'A pack holds up to 20 photos and videos.');
  const mediaId = crypto.randomUUID();
  const key = `packs/${ws}/${p.id}/${mediaId}.${spec.ext}`;
  await env.POSTERS.put(key, request.body ?? (await request.arrayBuffer()), { httpMetadata: { contentType: type } });
  const name = clip(u.searchParams.get('name'), 120) || null;
  await env.DB.prepare(`INSERT INTO pack_media (id, workspace_id, pack_id, r2_key, media_type, kind, origin, bytes, file_name, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(mediaId, ws, p.id, key, type, spec.kind, origin, bytes, name, who, iso()).run();
  return listPackMedia(env, ws, p.id);
}

export async function listPackMedia(env: Env, ws: string, packId: string) {
  const { results } = await env.DB.prepare(`SELECT id, media_type, kind, origin, bytes, file_name, uploaded_by, uploaded_at,
    (SELECT COUNT(*) FROM drafts d WHERE d.pack_media_id = m.id) AS used_by FROM pack_media m WHERE pack_id = ? AND workspace_id = ? AND removed_at IS NULL ORDER BY uploaded_at`).bind(packId, ws).all<any>();
  return (results ?? []).map((m) => ({ ...m, label: m.origin === 'ai_made' ? 'AI-made, not a photograph' : m.kind === 'video' ? 'Real video' : 'Real photo' }));
}

export async function getPackMedia(env: Env, ws: string, packId: string, mediaId: string) {
  const m = await env.DB.prepare('SELECT r2_key, media_type FROM pack_media WHERE id = ? AND pack_id = ? AND workspace_id = ? AND removed_at IS NULL').bind(mediaId, packId, ws).first<any>();
  if (!m) throw new HttpError(404, 'File not found');
  const obj = await env.POSTERS.get(m.r2_key);
  if (!obj) throw new HttpError(404, 'File not found');
  return new Response(obj.body, { headers: { 'Content-Type': m.media_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

// A file a draft already uses stays (the approval covers it); otherwise it is removed from storage.
export async function removePackMedia(env: Env, ws: string, packId: string, mediaId: string) {
  const m = await env.DB.prepare('SELECT r2_key FROM pack_media WHERE id = ? AND pack_id = ? AND workspace_id = ? AND removed_at IS NULL').bind(mediaId, packId, ws).first<any>();
  if (!m) throw new HttpError(404, 'File not found');
  if (await env.DB.prepare('SELECT 1 FROM drafts WHERE pack_media_id = ? LIMIT 1').bind(mediaId).first()) throw new HttpError(409, 'A draft uses this file. Choose another file for that draft first.');
  await env.POSTERS.delete(m.r2_key);
  await env.DB.prepare('UPDATE pack_media SET removed_at = ? WHERE id = ?').bind(iso(), mediaId).run();
  return listPackMedia(env, ws, packId);
}

// Gives a draft one of its pack's files. Like any media change, it makes a new version and clears approval.
export async function useMediaOnDraft(env: Env, ws: string, draftId: string, body: any) {
  const d = await env.DB.prepare('SELECT * FROM drafts WHERE id = ? AND workspace_id = ?').bind(draftId, ws).first<any>();
  if (!d) throw new HttpError(404, 'Draft not found');
  if (d.status === 'posted') throw new HttpError(409, 'This draft has been posted.');
  if (!d.pack_id) throw new HttpError(409, 'Only drafts from a content pack can use pack files. Upload an image on the draft instead.');
  const m = await env.DB.prepare('SELECT * FROM pack_media WHERE id = ? AND pack_id = ? AND workspace_id = ? AND removed_at IS NULL').bind(String(body?.mediaId ?? ''), d.pack_id, ws).first<any>();
  if (!m) throw new HttpError(404, 'File not found in this pack');
  await env.DB.prepare(`UPDATE drafts SET media_key = ?, media_type = ?, ai_generated_media = ?, pack_media_id = ?, version = version + 1, status = 'draft', approved_by = NULL, approved_at = NULL,
      approved_version = NULL, approved_kit_version_id = NULL, approved_template_version_id = NULL, scheduled_for = NULL, scheduled_channel = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .bind(m.r2_key, m.media_type, m.origin === 'ai_made' ? 1 : 0, m.id, now(), draftId, ws).run();
  return { id: draftId, mediaId: m.id, mediaType: m.media_type, aiGenerated: m.origin === 'ai_made', version: d.version + 1, status: 'draft' };
}

// What the AI is told about the pack's files (it cannot see them through copy and paste).
async function mediaLines(env: Env, packId: string) {
  const { results } = await env.DB.prepare("SELECT kind, origin, file_name FROM pack_media WHERE pack_id = ? AND removed_at IS NULL").bind(packId).all<any>();
  if (!results?.length) return [];
  const photos = results.filter((r) => r.kind === 'image' && r.origin === 'real').length, videos = results.filter((r) => r.kind === 'video' && r.origin === 'real').length;
  const ai = results.filter((r) => r.origin === 'ai_made').length;
  return ['', 'FILES THE OWNER HAS FOR THIS PACK:',
    `- ${photos} real photo(s), ${videos} real video(s)${ai ? `, ${ai} AI-made image(s) or video(s)` : ''}.`,
    '- Write the formats to use them (a reel for a video, a carousel for several photos).',
    '- Never describe details you cannot see; if a photo is attached to this message, describe only what is in it.',
    ...(ai ? ['- Any AI-made file must be labelled "AI-made" in the caption and never presented as a real photograph.'] : [])];
}
