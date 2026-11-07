// Content Studio, built to IMI Master Requirements v2:
//  - Campaign declares objective, success metric, audience, CTA, destination
//    and expected outcome BEFORE content exists (FR-COM-005/006, CIL-FR-004/033).
//  - Copy is grounded only in approved decisions/records + owner-stated facts,
//    with cited evidence IDs (TFR-AI-004, TFR-AI-002).
//  - Original photos are the default background; AI backgrounds are landscape
//    atmosphere only and carry a disclosure everywhere (PR-05/06, FR-BRD-005/007).
//  - One publication record and one adapted caption per channel (FR-BRD-004, CIL-FR-002).
//  - Tracked link per publication (FR-COM-006, FR-CRM-002).
//  - Owner approval is recorded against a hash of the exact content; any edit
//    voids it (Approval class B / TFR-AI-007). Live posting needs approval + PIN.
//  - Every test and publish attempt is appended to an audit log (NFR-006).

import type { Env } from './env';
import { json, HttpError, now, errMsg, actor, sha256Hex, CORS_HEADERS } from './http';
import { requireOwner } from './policy';
import { generateCopy, generateAtmosphere, generateCreativeBrief, type CopyProvider, type EvidenceItem } from './ai';
import { publishTo, CHANNELS, COPY_ONLY, VIDEO_CAPABLE, type Channel } from './publishers';
import { getConn, CHANNEL_TO_CONNECTION } from './connections';

export const OBJECTIVES = ['awareness', 'qualified_reach', 'inquiry', 'booking', 'weekday_fill', 'stay_extension', 'referral', 'learning_engagement'];
export const METRICS = ['qualified_inquiries', 'bookings', 'room_nights', 'contribution', 'saves_and_shares', 'link_clicks', 'profile_visits', 'learning_completions'];
export const CTA_TYPES = ['whatsapp', 'call', 'booking_form', 'website', 'article', 'direct_response'];
export const SEGMENTS = ['families', 'couples', 'photographers', 'serious_wildlife_travellers', 'birders', 'learners', 'small_groups', 'corporate_retreats', 'warm_personal_network'];
const TEMPLATES = ['bottom', 'left', 'full_bleed', 'dark'];
const LINK_CHANNELS = new Set(['facebook', 'threads', 'linkedin', 'telegram', 'youtube', 'whatsapp_status']);
const NO_HASHTAG_CHANNELS = new Set(['google_business', 'whatsapp', 'whatsapp_status', 'website', 'google_ads']);
const CH_ABBR: Record<string, string> = {
  instagram: 'IG', facebook: 'FB', threads: 'TH', linkedin: 'LI', google_business: 'GB', youtube: 'YT', telegram: 'TG', whatsapp: 'WA',
  whatsapp_status: 'ST', website: 'WS', google_ads: 'GA',
};

// Outside creative tools: open with a link, sign in with your own account there,
// then bring the finished poster or video back into IMI.
export const CREATIVE_TOOLS = [
  { id: 'gemini', name: 'Google Gemini', url: 'https://gemini.google.com', makes: ['video', 'image'], note: 'Quickest way to a short AI video with a Google account.' },
  { id: 'flow', name: 'Google Flow (Veo)', url: 'https://labs.google/flow', makes: ['video'], note: 'More control; choose Veo by name here.' },
  { id: 'runway', name: 'Runway', url: 'https://app.runwayml.com', makes: ['video', 'image'], note: 'Short cinematic clips and edits.' },
  { id: 'firefly', name: 'Adobe Firefly', url: 'https://firefly.adobe.com', makes: ['image', 'video'], note: 'Commercially-safe image generation.' },
  { id: 'canva', name: 'Canva', url: 'https://www.canva.com', makes: ['design', 'video'], note: 'Finish a poster or reel by hand.' },
  { id: 'capcut', name: 'CapCut', url: 'https://www.capcut.com', makes: ['video'], note: 'Edit your own Sri Antra clips into a reel.' },
  { id: 'chatgpt_images', name: 'ChatGPT', url: 'https://chatgpt.com', makes: ['image'], note: 'Images in your ChatGPT account.' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai', makes: ['design'], note: 'Design drafts and layouts.' },
];
export const AI_DISCLOSURE = 'Background image: AI-generated, not a photograph of Sri Antra.';
const toolName = (id: string) => CREATIVE_TOOLS.find((t) => t.id === id)?.name || id;

function disclosure(content: any): string | null {
  if (content.ai_media_tool) {
    return `Made with AI (${toolName(content.ai_media_tool)}). Not real footage or a photograph of Sri Antra.`;
  }
  return content.background_authenticity === 'ai_generated' ? AI_DISCLOSURE : null;
}

// ---------------------------------------------------------------- Helpers

async function nextCode(env: Env, name: string, prefix: string): Promise<string> {
  const row = await env.DB.prepare(
    `INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`
  ).bind(name).first<{ value: number }>();
  return `${prefix}-${String(row!.value).padStart(4, '0')}`;
}

const parse = (v: string | null | undefined, fallback: any = undefined) => {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};

function wordCount(...parts: (string | null | undefined)[]) {
  return parts.filter(Boolean).join(' ').trim().split(/\s+/).filter(Boolean).length;
}

function trackedUrl(campaign: any, content: any, channel: string): string {
  const ref = `${campaign.code}-${content.series_number}-${CH_ABBR[channel] || channel}`;
  try {
    const u = new URL(campaign.destination_url);
    if (/(^|\.)wa\.me$|api\.whatsapp\.com$/.test(u.hostname)) {
      // WhatsApp links ignore UTMs; a pre-filled reference makes the enquiry self-identify its source.
      u.searchParams.set('text', `Hi Iddav WildStay, I'd like to know more. (ref ${ref})`);
      return u.toString();
    }
    if (u.protocol === 'tel:') return u.toString();
    u.searchParams.set('utm_source', channel);
    u.searchParams.set('utm_medium', channel === 'whatsapp' || channel === 'telegram' ? 'messaging' : 'social');
    u.searchParams.set('utm_campaign', campaign.code.toLowerCase());
    u.searchParams.set('utm_content', ref.toLowerCase());
    return u.toString();
  } catch {
    return campaign.destination_url;
  }
}

export function finalText(pub: any, content: any): string {
  const extra = parse(pub.extra_json, {});
  if (pub.channel === 'google_ads') {
    return [
      'HEADLINES (max 30 characters each)', ...(extra.headlines || []).map((h: string, i: number) => `${i + 1}. ${h}`), '',
      'DESCRIPTIONS (max 90 characters each)', ...(extra.descriptions || []).map((d: string, i: number) => `${i + 1}. ${d}`), '',
      `FINAL URL: ${pub.tracked_url}`,
    ].join('\n');
  }
  if (pub.channel === 'website') {
    const d = disclosure(content);
    return [pub.title ? `# ${pub.title}` : '', extra.metaDescription ? `Meta description: ${extra.metaDescription}` : '', pub.caption.trim(), d || '']
      .filter(Boolean).join('\n\n');
  }
  const parts = [pub.caption.trim()];
  if (LINK_CHANNELS.has(pub.channel) || pub.channel === 'whatsapp') parts.push(pub.tracked_url);
  const d = disclosure(content);
  if (d) parts.push(d);
  const tags: string[] = parse(pub.hashtags_json, []);
  if (tags.length && !NO_HASHTAG_CHANNELS.has(pub.channel)) parts.push(tags.join(' '));
  return parts.filter(Boolean).join('\n\n');
}

async function loadContent(env: Env, id: string) {
  const content = await env.DB.prepare('SELECT * FROM contents WHERE id = ?').bind(id).first<any>();
  if (!content) throw new HttpError(404, 'Content not found.');
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(content.campaign_id).first<any>();
  const { results } = await env.DB.prepare('SELECT * FROM publications WHERE content_id = ? ORDER BY channel').bind(id).all<any>();
  return { content, campaign, pubs: results || [] };
}

async function contentHash(content: any, pubs: any[]): Promise<string> {
  return sha256Hex(JSON.stringify({
    eyebrow: content.eyebrow, headline: content.headline, poster: content.poster_asset_id, video: content.video_asset_id,
    background: content.background_asset_id, mode: content.media_mode, tool: content.ai_media_tool,
    pubs: pubs.map((p) => ({ c: p.channel, t: finalText(p, content), title: p.title || '', x: p.extra_json || '' })).sort((a, b) => a.c.localeCompare(b.c)),
  }));
}

async function currentApproval(env: Env, content: any, pubs: any[]) {
  const a = await env.DB.prepare('SELECT * FROM approvals WHERE content_id = ? AND revoked_at IS NULL ORDER BY approved_at DESC LIMIT 1')
    .bind(content.id).first<any>();
  if (!a) return null;
  const valid = a.content_hash === (await contentHash(content, pubs));
  return { approvalClass: a.approval_class, approvedBy: a.approved_by, approvedAt: a.approved_at, note: a.note || '', valid };
}

async function invalidate(env: Env, contentId: string, reason: string) {
  await env.DB.prepare(`UPDATE approvals SET revoked_at = ?, revoked_reason = ? WHERE content_id = ? AND revoked_at IS NULL`)
    .bind(now(), reason, contentId).run();
}

function campaignOut(r: any) {
  return {
    id: r.id, code: r.code, name: r.name, objective: r.objective, primaryMetric: r.primary_metric,
    audience: parse(r.audience_json, []), ctaType: r.cta_type, destinationUrl: r.destination_url,
    ownerFacts: r.owner_facts || '', decisionCode: r.decision_code || undefined, expectedOutcome: r.expected_outcome,
    outcomeWindowDays: r.outcome_window_days, seriesLabel: r.series_label || '', status: r.status,
    createdBy: r.created_by, createdAt: r.created_at,
  };
}

async function contentOut(env: Env, id: string) {
  const { content: c, campaign, pubs } = await loadContent(env, id);
  const assetIds = [c.background_asset_id, c.poster_asset_id, c.video_asset_id].filter(Boolean);
  const assets: Record<string, any> = {};
  for (const aid of assetIds) {
    const a = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(aid).first<any>();
    if (a) assets[aid] = { id: a.id, key: a.r2_key, kind: a.kind, authenticity: a.authenticity, credit: a.credit || '', sizeBytes: a.size_bytes };
  }
  return {
    id: c.id, campaignId: c.campaign_id, campaignCode: campaign.code, seriesNumber: c.series_number, template: c.template,
    eyebrow: c.eyebrow || '', headline: c.headline, wordCount: wordCount(c.eyebrow, c.headline),
    imagePrompt: c.image_prompt || '', backgroundAuthenticity: c.background_authenticity,
    background: c.background_asset_id ? assets[c.background_asset_id] : null,
    poster: c.poster_asset_id ? assets[c.poster_asset_id] : null,
    video: c.video_asset_id ? assets[c.video_asset_id] : null,
    copyProvider: c.copy_provider, copyModel: c.copy_model, evidenceIdsUsed: parse(c.evidence_ids_json, []),
    insufficientEvidence: c.insufficient_evidence === 1, aiNotes: c.ai_notes || '',
    mediaMode: c.media_mode || 'poster', aiMediaTool: c.ai_media_tool || null, requiresClassA: c.requires_class_a === 1,
    posterSource: c.poster_source || 'composed',
    status: c.status, createdAt: c.created_at, updatedAt: c.updated_at,
    approval: await currentApproval(env, c, pubs),
    publications: pubs.map((p) => ({
      id: p.id, channel: p.channel, caption: p.caption, hashtags: parse(p.hashtags_json, []), title: p.title || '',
      trackedUrl: p.tracked_url, finalText: finalText(p, c), status: p.status, method: p.method || null,
      extra: parse(p.extra_json, {}), copyOnly: COPY_ONLY.has(p.channel), canPostVideo: VIDEO_CAPABLE.has(p.channel),
      externalId: p.external_id || null, permalink: p.permalink || null, publishedAt: p.published_at || null,
      lastResult: parse(p.last_result_json),
    })),
  };
}

async function gatherEvidence(env: Env, campaign: any): Promise<EvidenceItem[]> {
  const ev: EvidenceItem[] = [];
  if (campaign.decision_code) {
    const d = await env.DB.prepare(`SELECT * FROM decision_items WHERE code = ? AND approval_status = 'approved'`).bind(campaign.decision_code).first<any>();
    if (d) {
      ev.push({ id: d.code, kind: 'approved decision', text: `${d.title}. Problem: ${d.problem_statement}. Chosen option: ${d.selected_option}. Rationale: ${d.rationale}` });
      const r = await env.DB.prepare('SELECT * FROM intelligence_records WHERE code = ?').bind(d.associated_record_code).first<any>();
      if (r) {
        const obs = parse(r.observation_json, {});
        const obsText = typeof obs === 'string' ? obs : Object.values(obs).filter((v) => typeof v === 'string').join(' ');
        ev.push({ id: r.code, kind: `intelligence record, verification: ${r.verification_status || 'unstated'}`, text: `${r.title}. ${obsText}`.slice(0, 2500) });
      }
    }
  }
  if (campaign.owner_facts?.trim()) {
    ev.push({ id: `${campaign.code}-FACTS`, kind: 'owner-stated facts (Rama)', text: campaign.owner_facts.trim() });
  }
  return ev;
}

async function writeChannel(env: Env, providerIn: unknown, campaign: any, content: any, channel: string, instruction: string) {
  const provider: CopyProvider = providerIn === 'chatgpt' ? 'chatgpt' : 'claude';
  const evidence = await gatherEvidence(env, campaign);
  const context = `The poster already exists with eyebrow "${content.eyebrow || ''}" and headline "${content.headline}". Keep the same single idea; return the same eyebrow and headline. Write ONLY the ${channel} copy well.${instruction ? ` Owner's instruction for this rewrite: ${instruction}` : ''}`;
  const copy = await generateCopy(env, {
    provider, campaign, evidence, channels: [channel], template: content.template,
    backgroundIsOriginal: content.background_authenticity !== 'ai_generated', context,
  }, content.id);
  return copy.channels[channel];
}

async function putAsset(env: Env, opts: {
  body: ArrayBuffer | ReadableStream; kind: 'image' | 'video' | 'poster'; contentType: string; authenticity: string;
  credit?: string; rights?: string; filename?: string; aiCallId?: string; size?: number;
}) {
  const id = crypto.randomUUID();
  const ext = opts.contentType.split('/')[1]?.replace('jpeg', 'jpg').replace('quicktime', 'mov') || 'bin';
  const key = `${opts.kind}s/${id}.${ext}`;
  const sha = opts.body instanceof ArrayBuffer ? await sha256Hex(opts.body) : null;
  const obj = await env.POSTERS.put(key, opts.body, { httpMetadata: { contentType: opts.contentType } });
  await env.DB.prepare(
    `INSERT INTO assets (id, r2_key, kind, content_type, authenticity, credit, rights_note, original_filename, sha256, r2_etag, size_bytes, ai_call_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, key, opts.kind, opts.contentType, opts.authenticity, opts.credit ?? null, opts.rights ?? null, opts.filename ?? null,
    sha, obj?.etag ?? null, obj?.size ?? opts.size ?? null, opts.aiCallId ?? null, now()).run();
  return { id, key };
}

async function audit(env: Env, e: { contentId: string; publicationId?: string; channel?: string; action: string; ok: boolean; message: string; actor: string; detail?: unknown }) {
  await env.DB.prepare(
    `INSERT INTO publication_events (id, content_id, publication_id, channel, action, ok, message, actor, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), e.contentId, e.publicationId ?? null, e.channel ?? null, e.action, e.ok ? 1 : 0, e.message, e.actor,
    e.detail ? JSON.stringify(e.detail) : null, now()).run();
}

async function refreshStatus(env: Env, contentId: string) {
  const c = await env.DB.prepare('SELECT status, poster_asset_id FROM contents WHERE id = ?').bind(contentId).first<any>();
  const after = await env.DB.prepare('SELECT status FROM publications WHERE content_id = ?').bind(contentId).all<any>();
  const st = (after.results || []).map((x) => x.status);
  const overall = st.length && st.every((s) => s === 'published') ? 'published'
    : st.some((s) => s === 'published') ? 'partially_published'
    : c?.poster_asset_id ? 'ready' : 'draft';
  await env.DB.prepare('UPDATE contents SET status = ?, updated_at = ? WHERE id = ?').bind(overall, now(), contentId).run();
}

// ---------------------------------------------------------------- Media

export async function serveMedia(env: Env, key: string, request?: Request): Promise<Response> {
  if (!key || key.includes('..')) return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  // Range support lets video players and Meta's fetcher stream videos.
  const range = request?.headers.get('Range') ? request.headers : undefined;
  const obj = await env.POSTERS.get(key, range ? { range } : undefined);
  if (!obj) return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  const headers: Record<string, string> = {
    'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes', ...CORS_HEADERS,
  };
  const r = (obj as R2ObjectBody).range as { offset?: number; length?: number } | undefined;
  if (range && r && r.offset !== undefined && r.length !== undefined) {
    headers['Content-Range'] = `bytes ${r.offset}-${r.offset + r.length - 1}/${obj.size}`;
    headers['Content-Length'] = String(r.length);
    return new Response((obj as R2ObjectBody).body, { status: 206, headers });
  }
  headers['Content-Length'] = String(obj.size);
  return new Response((obj as R2ObjectBody).body, { headers });
}

// ---------------------------------------------------------------- Routes

export async function handleStudioRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;
  let m: RegExpMatchArray | null;

  // ---- Form options + which channels are connected
  if (method === 'GET' && path === '/api/studio/options') {
    const { results } = await env.DB.prepare(
      `SELECT code, title FROM decision_items WHERE approval_status = 'approved' ORDER BY inserted_at DESC LIMIT 100`
    ).all<any>();
    const conns = await env.DB.prepare('SELECT platform, last_ok FROM connections').all<any>();
    const connected = new Set((conns.results || []).map((r) => r.platform));
    return json({
      objectives: OBJECTIVES, metrics: METRICS, ctaTypes: CTA_TYPES, segments: SEGMENTS, templates: TEMPLATES,
      channels: CHANNELS.map((c) => ({
        id: c, connection: CHANNEL_TO_CONNECTION[c] || null, copyOnly: COPY_ONLY.has(c),
        connected: COPY_ONLY.has(c) ? true : connected.has(CHANNEL_TO_CONNECTION[c]),
      })),
      creativeTools: CREATIVE_TOOLS,
      aiProviders: { claude: connected.has('claude') || Boolean(env.ANTHROPIC_API_KEY), chatgpt: connected.has('chatgpt') || Boolean(env.OPENAI_API_KEY) },
      approvedDecisions: results || [],
      ownerPinSet: Boolean(env.OWNER_PIN),
      aiDisclosure: AI_DISCLOSURE,
    });
  }

  // ---- Campaigns
  if (method === 'GET' && path === '/api/campaigns') {
    const { results } = await env.DB.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
    return json((results || []).map(campaignOut));
  }

  if (method === 'POST' && path === '/api/campaigns') {
    const b = await request.json<any>();
    const need = (v: unknown, label: string) => { if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${label} is required.`); };
    need(b.name, 'Name'); need(b.expectedOutcome, 'Expected outcome'); need(b.destinationUrl, 'Destination link');
    if (!OBJECTIVES.includes(b.objective)) throw new HttpError(400, 'Choose one primary objective.');
    if (!METRICS.includes(b.primaryMetric)) throw new HttpError(400, 'Choose the primary success metric.');
    if (!CTA_TYPES.includes(b.ctaType)) throw new HttpError(400, 'Choose a call to action.');
    try { new URL(b.destinationUrl); } catch { throw new HttpError(400, 'Destination link must be a full URL (https://…, https://wa.me/…, or tel:…).'); }
    if (!b.decisionCode && !b.ownerFacts?.trim()) throw new HttpError(400, 'Link an approved decision or write the facts this campaign may use.');
    const audience = (Array.isArray(b.audience) ? b.audience : []).filter((s: string) => SEGMENTS.includes(s));
    const id = crypto.randomUUID();
    const code = await nextCode(env, 'campaign', 'CMP');
    await env.DB.prepare(
      `INSERT INTO campaigns (id, code, name, objective, primary_metric, audience_json, cta_type, destination_url, owner_facts,
         decision_code, expected_outcome, outcome_window_days, series_label, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(id, code, b.name.trim(), b.objective, b.primaryMetric, JSON.stringify(audience), b.ctaType, b.destinationUrl.trim(),
      b.ownerFacts?.trim() || null, b.decisionCode || null, b.expectedOutcome.trim(), Math.max(1, Math.min(180, Number(b.outcomeWindowDays) || 14)),
      b.seriesLabel?.trim() || null, actor(request, env.OWNER_PIN), now()).run();
    return json(campaignOut(await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first()), 201);
  }

  if (method === 'GET' && (m = path.match(/^\/api\/campaigns\/([^/]+)\/contents$/))) {
    const { results } = await env.DB.prepare('SELECT id FROM contents WHERE campaign_id = ? ORDER BY series_number DESC').bind(m[1]).all<any>();
    return json(await Promise.all((results || []).map((r) => contentOut(env, r.id))));
  }

  // ---- Upload an original photo (or a video for YouTube)
  if (method === 'POST' && path === '/api/assets') {
    const ct = request.headers.get('Content-Type') || '';
    const kind = ct.startsWith('video/') ? 'video' : ct.startsWith('image/') ? 'image' : null;
    if (!kind) throw new HttpError(400, 'Upload a JPEG/PNG/WebP photo or an MP4/MOV video.');
    const size = Number(request.headers.get('Content-Length') || 0);
    if (kind === 'image' && size > 15_000_000) throw new HttpError(400, 'Photos must be under 15 MB.');
    if (kind === 'video' && size > 95_000_000) throw new HttpError(400, 'Videos must be under 95 MB here. Upload longer videos in YouTube Studio and record the link.');
    const authenticity = url.searchParams.get('authenticity') || 'original';
    if (!['original', 'documentary_edit'].includes(authenticity)) throw new HttpError(400, 'Uploads must be original or documentary edits.');
    if (url.searchParams.get('rightsConfirmed') !== 'true') throw new HttpError(400, 'Confirm Iddav owns or has rights to this file.');
    const a = await putAsset(env, {
      body: kind === 'image' ? await request.arrayBuffer() : request.body!, kind, contentType: ct, authenticity,
      credit: url.searchParams.get('credit') || undefined, rights: 'Owner confirmed rights at upload', filename: url.searchParams.get('filename') || undefined, size,
    });
    return json({ id: a.id, key: a.key, kind, authenticity }, 201);
  }

  // ---- Create a content draft (copy + background) for a campaign
  if (method === 'POST' && (m = path.match(/^\/api\/campaigns\/([^/]+)\/contents$/))) {
    const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(m[1]).first<any>();
    if (!campaign) throw new HttpError(404, 'Campaign not found.');
    const b = await request.json<any>();
    const provider: CopyProvider = b.provider === 'claude' ? 'claude' : 'chatgpt';
    const channels: string[] = (Array.isArray(b.channels) ? b.channels : []).filter((c: string) => (CHANNELS as string[]).includes(c));
    if (!channels.length) throw new HttpError(400, 'Choose at least one channel.');
    const template = TEMPLATES.includes(b.template) ? b.template : 'bottom';
    let bgAsset: any = null;
    if (b.backgroundAssetId) {
      bgAsset = await env.DB.prepare(`SELECT * FROM assets WHERE id = ? AND kind = 'image'`).bind(b.backgroundAssetId).first<any>();
      if (!bgAsset) throw new HttpError(400, 'That photo was not found. Upload it again.');
    } else if (!b.aiBackground) {
      throw new HttpError(400, 'Upload an original photo, or choose an AI atmosphere background.');
    }

    const id = crypto.randomUUID();
    const evidence = await gatherEvidence(env, campaign);
    const copy = await generateCopy(env, { provider, campaign, evidence, channels, template, backgroundIsOriginal: Boolean(bgAsset) }, id);

    let authenticity = bgAsset?.authenticity || 'ai_generated';
    let imagePrompt = copy.imagePrompt;
    if (!bgAsset) {
      const img = await generateAtmosphere(env, copy.imagePrompt, id);
      bgAsset = await putAsset(env, { body: img.bytes, kind: 'image', contentType: 'image/png', authenticity: 'ai_generated', aiCallId: img.aiCallId, rights: 'AI-generated for Iddav' });
      authenticity = 'ai_generated';
    } else {
      imagePrompt = '';
    }

    const seq = await env.DB.prepare('SELECT COALESCE(MAX(series_number), 0) + 1 AS n FROM contents WHERE campaign_id = ?').bind(campaign.id).first<{ n: number }>();
    const ts = now();
    const content = {
      id, campaign_id: campaign.id, series_number: seq?.n ?? 1, template, eyebrow: copy.eyebrow, headline: copy.headline,
      image_prompt: imagePrompt, background_asset_id: bgAsset.id, background_authenticity: authenticity,
    };
    await env.DB.prepare(
      `INSERT INTO contents (id, campaign_id, series_number, template, eyebrow, headline, image_prompt, background_asset_id,
         background_authenticity, copy_provider, copy_model, copy_ai_call_id, evidence_ids_json, insufficient_evidence, ai_notes,
         status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
    ).bind(id, campaign.id, content.series_number, template, copy.eyebrow, copy.headline, imagePrompt, bgAsset.id, authenticity,
      copy.provider, copy.model, copy.aiCallId, JSON.stringify(copy.evidenceIdsUsed), copy.insufficientEvidence ? 1 : 0, copy.notes,
      actor(request, env.OWNER_PIN), ts, ts).run();
    for (const ch of channels) {
      const v = copy.channels[ch];
      await env.DB.prepare(
        `INSERT INTO publications (id, content_id, channel, caption, hashtags_json, title, extra_json, tracked_url, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
      ).bind(crypto.randomUUID(), id, ch, v.caption, JSON.stringify(v.hashtags), v.title || null, v.extra ? JSON.stringify(v.extra) : null,
        trackedUrl(campaign, content, ch), ts, ts).run();
    }
    return json(await contentOut(env, id), 201);
  }

  // ---- Swap background: an uploaded original, or a new AI atmosphere
  if (method === 'POST' && (m = path.match(/^\/api\/contents\/([^/]+)\/background$/))) {
    const { content } = await loadContent(env, m[1]);
    const b = await request.json<any>();
    let assetId: string;
    let authenticity: string;
    let prompt = content.image_prompt || '';
    if (b.assetId) {
      const a = await env.DB.prepare(`SELECT * FROM assets WHERE id = ? AND kind = 'image'`).bind(b.assetId).first<any>();
      if (!a) throw new HttpError(400, 'Photo not found.');
      assetId = a.id; authenticity = a.authenticity; prompt = '';
    } else {
      prompt = (b.imagePrompt || prompt || 'Dawn mist over dry deciduous forest in central India, soft golden light').trim();
      const img = await generateAtmosphere(env, prompt, content.id);
      assetId = (await putAsset(env, { body: img.bytes, kind: 'image', contentType: 'image/png', authenticity: 'ai_generated', aiCallId: img.aiCallId, rights: 'AI-generated for Iddav' })).id;
      authenticity = 'ai_generated';
    }
    await env.DB.prepare(
      `UPDATE contents SET background_asset_id = ?, background_authenticity = ?, image_prompt = ?, poster_asset_id = NULL, status = 'draft', updated_at = ? WHERE id = ?`
    ).bind(assetId, authenticity, prompt, now(), content.id).run();
    await invalidate(env, content.id, 'Background changed');
    return json(await contentOut(env, content.id));
  }

  // ---- Edit poster text / template
  if (method === 'PATCH' && (m = path.match(/^\/api\/contents\/([^/]+)$/))) {
    const { content, pubs } = await loadContent(env, m[1]);
    if (pubs.some((p) => p.status === 'published')) throw new HttpError(409, 'Already published somewhere; create a new version instead.');
    const b = await request.json<any>();
    const eyebrow = typeof b.eyebrow === 'string' ? b.eyebrow : content.eyebrow;
    const headline = typeof b.headline === 'string' ? b.headline : content.headline;
    const template = TEMPLATES.includes(b.template) ? b.template : content.template;
    await env.DB.prepare(`UPDATE contents SET eyebrow = ?, headline = ?, template = ?, poster_asset_id = NULL, poster_source = 'composed', status = 'draft', updated_at = ? WHERE id = ?`)
      .bind(eyebrow, headline, template, now(), content.id).run();
    await invalidate(env, content.id, 'Poster text changed');
    return json(await contentOut(env, content.id));
  }

  // ---- Edit one channel's caption
  if (method === 'PATCH' && (m = path.match(/^\/api\/publications\/([^/]+)$/))) {
    const p = await env.DB.prepare('SELECT * FROM publications WHERE id = ?').bind(m[1]).first<any>();
    if (!p) throw new HttpError(404, 'Publication not found.');
    if (p.status === 'published') throw new HttpError(409, 'Already published.');
    const b = await request.json<any>();
    const caption = typeof b.caption === 'string' ? b.caption.replace(/https?:\/\/\S+/g, '').trim() : p.caption;
    const hashtags = Array.isArray(b.hashtags) ? b.hashtags.map((h: string) => (h.startsWith('#') ? h : `#${h}`)) : parse(p.hashtags_json, []);
    const title = typeof b.title === 'string' ? b.title.slice(0, 100) : p.title;
    const extra = parse(p.extra_json, {});
    if (Array.isArray(b.headlines)) {
      const long = b.headlines.filter((h: string) => h.length > 30);
      if (long.length) throw new HttpError(400, `Google Ads headlines must be 30 characters or fewer: "${long[0]}"`);
      extra.headlines = b.headlines.map((h: string) => h.trim()).filter(Boolean).slice(0, 15);
    }
    if (Array.isArray(b.descriptions)) {
      const long = b.descriptions.filter((d: string) => d.length > 90);
      if (long.length) throw new HttpError(400, `Google Ads descriptions must be 90 characters or fewer: "${long[0]}"`);
      extra.descriptions = b.descriptions.map((d: string) => d.trim()).filter(Boolean).slice(0, 4);
    }
    if (typeof b.metaDescription === 'string') extra.metaDescription = b.metaDescription.slice(0, 155);
    await env.DB.prepare('UPDATE publications SET caption = ?, hashtags_json = ?, title = ?, extra_json = ?, updated_at = ? WHERE id = ?')
      .bind(caption, JSON.stringify(hashtags), title, Object.keys(extra).length ? JSON.stringify(extra) : null, now(), p.id).run();
    await invalidate(env, p.content_id, `${p.channel} caption changed`);
    return json(await contentOut(env, p.content_id));
  }

  // ---- Save the composed poster (JPEG from the browser)
  if (method === 'PUT' && (m = path.match(/^\/api\/contents\/([^/]+)\/poster$/))) {
    const { content } = await loadContent(env, m[1]);
    const words = wordCount(content.eyebrow, content.headline);
    if (words > 12) throw new HttpError(400, `Poster has ${words} words; the limit is 12.`);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 1000 || bytes.byteLength > 8_000_000) throw new HttpError(400, 'Poster must be a JPEG under 8 MB.');
    const authenticity = content.background_authenticity === 'ai_generated' ? 'mixed' : 'documentary_edit';
    const a = await putAsset(env, { body: bytes, kind: 'poster', contentType: 'image/jpeg', authenticity, rights: 'Iddav composed poster' });
    await env.DB.prepare(`UPDATE contents SET poster_asset_id = ?, poster_source = 'composed', status = 'ready', updated_at = ? WHERE id = ?`).bind(a.id, now(), content.id).run();
    await invalidate(env, content.id, 'Poster re-saved');
    return json(await contentOut(env, content.id));
  }

  // ---- Attach an uploaded video (needed for YouTube)
  if (method === 'POST' && (m = path.match(/^\/api\/contents\/([^/]+)\/video$/))) {
    const { content } = await loadContent(env, m[1]);
    const b = await request.json<any>();
    const a = await env.DB.prepare(`SELECT * FROM assets WHERE id = ? AND kind = 'video'`).bind(b.assetId).first<any>();
    if (!a) throw new HttpError(400, 'Video not found.');
    await env.DB.prepare('UPDATE contents SET video_asset_id = ?, updated_at = ? WHERE id = ?').bind(a.id, now(), content.id).run();
    await invalidate(env, content.id, 'Video changed');
    return json(await contentOut(env, content.id));
  }

  // ---- Owner approval (recorded against the exact content)
  if (method === 'POST' && (m = path.match(/^\/api\/contents\/([^/]+)\/approve$/))) {
    requireOwner(request, env);
    const { content, pubs } = await loadContent(env, m[1]);
    if (!content.poster_asset_id) throw new HttpError(400, 'Save the poster before approving.');
    const b = await request.json<any>().catch(() => ({}));
    if (content.insufficient_evidence === 1 && !b.acknowledgeThinEvidence) {
      throw new HttpError(400, 'The draft was written with thin evidence. Tick the acknowledgement to approve anyway.');
    }
    const approvalClass = b.approvalClass === 'A' ? 'A' : 'B';
    if (content.requires_class_a === 1 && approvalClass !== 'A') {
      throw new HttpError(400, 'This content includes AI media showing animals, so it needs Class A approval with a domain review note.');
    }
    if (approvalClass === 'A' && !b.domainReviewNote?.trim()) {
      throw new HttpError(400, 'Class A content needs a note on the domain review (who checked the wildlife interpretation).');
    }
    await invalidate(env, content.id, 'Superseded by new approval');
    await env.DB.prepare(
      `INSERT INTO approvals (id, content_id, approval_class, approved_by, note, domain_review_note, content_hash, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), content.id, approvalClass, actor(request, env.OWNER_PIN), b.note?.trim() || null, b.domainReviewNote?.trim() || null,
      await contentHash(content, pubs), now()).run();
    await audit(env, { contentId: content.id, action: 'approved', ok: true, message: `Class ${approvalClass} approval`, actor: actor(request, env.OWNER_PIN) });
    return json(await contentOut(env, content.id));
  }

  // ---- Test or publish selected channels
  if (method === 'POST' && (m = path.match(/^\/api\/contents\/([^/]+)\/publish$/))) {
    const b = await request.json<any>().catch(() => ({}));
    const dryRun = b.dryRun !== false;
    if (!dryRun) requireOwner(request, env); // Gate 1: permission before any lookup
    const { content, pubs } = await loadContent(env, m[1]);
    if (!content.poster_asset_id) throw new HttpError(400, 'Save the poster first.');
    if (!dryRun) {
      const ap = await currentApproval(env, content, pubs);
      if (!ap) throw new HttpError(403, 'Approve this content before publishing.');
      if (!ap.valid) throw new HttpError(403, 'The content changed after approval. Approve it again.');
    }
    const want = new Set<string>(Array.isArray(b.channels) ? b.channels : []);
    const targets = pubs.filter((p) => want.has(p.channel));
    if (!targets.length) throw new HttpError(400, 'Choose at least one channel.');
    const poster = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(content.poster_asset_id).first<any>();
    const video = content.video_asset_id ? await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(content.video_asset_id).first<any>() : null;
    const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(content.campaign_id).first<any>();
    const who = actor(request, env.OWNER_PIN);

    const results: any[] = [];
    for (const p of targets) {
      if (COPY_ONLY.has(p.channel)) {
        results.push({ channel: p.channel, ok: false, dryRun, message: 'Copy-only channel: copy it, post it yourself, then record the link.' });
        continue;
      }
      if (!dryRun && p.status === 'published') {
        results.push({ channel: p.channel, ok: false, dryRun, message: 'Already published; skipped to avoid a duplicate.' });
        continue;
      }
      let r;
      try {
        r = await publishTo(env, p.channel as Channel, {
          dryRun, imageUrl: `${url.origin}/media/${poster.r2_key}`, imageKey: poster.r2_key, videoKey: video?.r2_key,
          videoUrl: video ? `${url.origin}/media/${video.r2_key}` : undefined,
          postVideo: Boolean(video) && content.media_mode === 'video' && VIDEO_CAPABLE.has(p.channel as Channel),
          caption: finalText(p, content), link: p.tracked_url, title: p.title || content.headline, ctaType: campaign.cta_type,
        });
      } catch (e) {
        r = { ok: false, dryRun, message: errMsg(e) };
      }
      const newStatus = dryRun ? (r.ok ? 'tested' : p.status === 'published' ? 'published' : 'draft') : r.ok ? 'published' : 'failed';
      await env.DB.prepare(
        `UPDATE publications SET status = ?, method = CASE WHEN ? THEN 'api' ELSE method END, external_id = COALESCE(?, external_id),
           permalink = COALESCE(?, permalink), published_at = CASE WHEN ? THEN ? ELSE published_at END, last_result_json = ?, updated_at = ?
         WHERE id = ?`
      ).bind(newStatus, !dryRun && r.ok ? 1 : 0, !dryRun ? (r as any).externalId ?? null : null, !dryRun ? (r as any).permalink ?? null : null,
        !dryRun && r.ok ? 1 : 0, now(), JSON.stringify({ ...r, at: now() }), now(), p.id).run();
      await audit(env, { contentId: content.id, publicationId: p.id, channel: p.channel, action: dryRun ? 'test' : 'publish', ok: r.ok, message: r.message, actor: who, detail: r });
      results.push({ channel: p.channel, ...r });
    }
    await refreshStatus(env, content.id);
    return json({ results, content: await contentOut(env, content.id) });
  }

  // ---- Manual fallback: you posted it yourself, record where (TFR-REU-008)
  if (method === 'POST' && (m = path.match(/^\/api\/publications\/([^/]+)\/manual$/))) {
    requireOwner(request, env);
    const p = await env.DB.prepare('SELECT * FROM publications WHERE id = ?').bind(m[1]).first<any>();
    if (!p) throw new HttpError(404, 'Publication not found.');
    const b = await request.json<any>();
    const link = typeof b.permalink === 'string' ? b.permalink.trim() : '';
    if (!/^https?:\/\//.test(link) && !['whatsapp', 'whatsapp_status', 'google_ads'].includes(p.channel)) throw new HttpError(400, 'Paste the link to the live post.');
    const at = typeof b.publishedAt === 'string' && b.publishedAt ? b.publishedAt.replace('T', ' ').slice(0, 19) : now();
    await env.DB.prepare(`UPDATE publications SET status = 'published', method = 'manual', permalink = ?, published_at = ?, updated_at = ? WHERE id = ?`)
      .bind(link || null, at, now(), p.id).run();
    await refreshStatus(env, p.content_id);
    await audit(env, { contentId: p.content_id, publicationId: p.id, channel: p.channel, action: 'manual_record', ok: true, message: `Recorded manual post ${link}`, actor: actor(request, env.OWNER_PIN) });
    return json(await contentOut(env, p.content_id));
  }

  // ---- Rewrite one channel's copy with Claude or ChatGPT (optionally with an instruction)
  if (method === 'POST' && (m = path.match(/^\/api\/publications\/([^/]+)\/rewrite$/))) {
    const p = await env.DB.prepare('SELECT * FROM publications WHERE id = ?').bind(m[1]).first<any>();
    if (!p) throw new HttpError(404, 'Publication not found.');
    if (p.status === 'published') throw new HttpError(409, 'Already published.');
    const b = await request.json<any>().catch(() => ({}));
    const { content, campaign } = await loadContent(env, p.content_id);
    const draft = await writeChannel(env, b.provider, campaign, content, p.channel, String(b.instruction || '').slice(0, 400));
    await env.DB.prepare('UPDATE publications SET caption = ?, hashtags_json = ?, title = ?, extra_json = ?, status = ?, updated_at = ? WHERE id = ?')
      .bind(draft.caption, JSON.stringify(draft.hashtags), draft.title || p.title, draft.extra ? JSON.stringify(draft.extra) : p.extra_json,
        p.status === 'tested' ? 'draft' : p.status, now(), p.id).run();
    await invalidate(env, p.content_id, `${p.channel} rewritten by AI`);
    return json(await contentOut(env, p.content_id));
  }

  // ---- Add another channel to existing content
  if (method === 'POST' && (m = path.match(/^\/api\/contents\/([^/]+)\/channels$/))) {
    const { content, campaign, pubs } = await loadContent(env, m[1]);
    const b = await request.json<any>();
    const ch = String(b.channel || '');
    if (!(CHANNELS as string[]).includes(ch)) throw new HttpError(400, 'Unknown channel.');
    if (pubs.some((p) => p.channel === ch)) throw new HttpError(409, `${ch} is already part of this content.`);
    const draft = await writeChannel(env, b.provider, campaign, content, ch, '');
    await env.DB.prepare(
      `INSERT INTO publications (id, content_id, channel, caption, hashtags_json, title, extra_json, tracked_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).bind(crypto.randomUUID(), content.id, ch, draft.caption, JSON.stringify(draft.hashtags), draft.title || null,
      draft.extra ? JSON.stringify(draft.extra) : null, trackedUrl(campaign, content, ch), now(), now()).run();
    await invalidate(env, content.id, `${ch} added`);
    await refreshStatus(env, content.id);
    return json(await contentOut(env, content.id));
  }

  // ---- Write a ready-to-paste prompt for an outside tool (Gemini, Flow, Runway, Canva…)
  if (method === 'POST' && (m = path.match(/^\/api\/contents\/([^/]+)\/creative-brief$/))) {
    const { content, campaign } = await loadContent(env, m[1]);
    const b = await request.json<any>();
    const tool = CREATIVE_TOOLS.find((t) => t.id === b.tool);
    if (!tool) throw new HttpError(400, 'Choose a tool.');
    const kind = ['video', 'image', 'design'].includes(b.kind) ? b.kind : tool.makes[0];
    const provider: CopyProvider = b.provider === 'chatgpt' ? 'chatgpt' : 'claude';
    const brief = await generateCreativeBrief(env, { provider, tool: tool.id, kind, content, campaign, evidence: await gatherEvidence(env, campaign) });
    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO creative_briefs (id, content_id, tool, kind, provider, model, prompt, ai_call_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, content.id, tool.id, kind, provider, brief.model, brief.prompt, brief.aiCallId, actor(request, env.OWNER_PIN), now()).run();
    return json({ id, tool: tool.id, toolName: tool.name, url: tool.url, kind, prompt: brief.prompt });
  }

  // ---- Bring a finished poster or video back from an outside tool
  if (method === 'POST' && (m = path.match(/^\/api\/contents\/([^/]+)\/import$/))) {
    const { content, pubs } = await loadContent(env, m[1]);
    if (pubs.some((p) => p.status === 'published')) throw new HttpError(409, 'Already published somewhere; create a new version instead.');
    const tool = url.searchParams.get('tool') || 'other';
    const use = url.searchParams.get('use'); // video | poster | background
    const madeWithAi = url.searchParams.get('ai') !== 'false';
    const showsAnimals = url.searchParams.get('showsAnimals') === 'true';
    const ct = request.headers.get('Content-Type') || '';
    const size = Number(request.headers.get('Content-Length') || 0);
    if (use === 'video' && !ct.startsWith('video/')) throw new HttpError(400, 'Choose a video file (MP4 or MOV).');
    if (use !== 'video' && !ct.startsWith('image/')) throw new HttpError(400, 'Choose an image file (JPEG or PNG).');
    if (use === 'video' && size > 95_000_000) throw new HttpError(400, 'Videos must be under 95 MB here.');
    if (use !== 'video' && size > 15_000_000) throw new HttpError(400, 'Images must be under 15 MB.');
    if (use === 'poster' && !/jpe?g/.test(ct)) throw new HttpError(400, 'Finished posters must be JPEG (Instagram requires it).');
    const briefId = url.searchParams.get('briefId');
    const a = await putAsset(env, {
      body: use === 'video' ? request.body! : await request.arrayBuffer(),
      kind: use === 'video' ? 'video' : use === 'poster' ? 'poster' : 'image', contentType: ct,
      authenticity: madeWithAi ? 'ai_generated' : 'original', credit: madeWithAi ? toolName(tool) : url.searchParams.get('credit') || undefined,
      rights: madeWithAi ? `Generated in ${toolName(tool)} under Iddav's account${briefId ? ` (brief ${briefId})` : ''}` : 'Owner confirmed rights at upload',
      filename: url.searchParams.get('filename') || undefined, size,
    });
    const sets: string[] = [];
    const vals: any[] = [];
    if (use === 'video') { sets.push('video_asset_id = ?', `media_mode = 'video'`); vals.push(a.id); }
    else if (use === 'poster') { sets.push('poster_asset_id = ?', `poster_source = 'imported'`, `status = 'ready'`); vals.push(a.id); }
    else { sets.push('background_asset_id = ?', 'background_authenticity = ?', 'poster_asset_id = NULL', `status = 'draft'`); vals.push(a.id, madeWithAi ? 'ai_generated' : 'original'); }
    if (madeWithAi) { sets.push('ai_media_tool = ?'); vals.push(tool); }
    if (showsAnimals && madeWithAi) sets.push('requires_class_a = 1');
    sets.push('updated_at = ?'); vals.push(now(), content.id);
    await env.DB.prepare(`UPDATE contents SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    await invalidate(env, content.id, `Imported ${use} from ${toolName(tool)}`);
    await audit(env, { contentId: content.id, action: 'import', ok: true, message: `Imported ${use} from ${toolName(tool)}${madeWithAi ? ' (AI)' : ''}`, actor: actor(request, env.OWNER_PIN) });
    return json(await contentOut(env, content.id));
  }

  // ---- Choose whether video-capable channels post the poster or the video
  if (method === 'POST' && (m = path.match(/^\/api\/contents\/([^/]+)\/media-mode$/))) {
    const { content } = await loadContent(env, m[1]);
    const b = await request.json<any>();
    const mode = b.mode === 'video' ? 'video' : 'poster';
    if (mode === 'video' && !content.video_asset_id) throw new HttpError(400, 'Attach a video first.');
    await env.DB.prepare('UPDATE contents SET media_mode = ?, updated_at = ? WHERE id = ?').bind(mode, now(), content.id).run();
    await invalidate(env, content.id, `Media mode set to ${mode}`);
    return json(await contentOut(env, content.id));
  }

  // ---- Audit trail for one content item
  if (method === 'GET' && (m = path.match(/^\/api\/contents\/([^/]+)\/events$/))) {
    const { results } = await env.DB.prepare('SELECT * FROM publication_events WHERE content_id = ? ORDER BY created_at DESC LIMIT 200').bind(m[1]).all();
    return json(results || []);
  }

  // ---- AI usage this month (cost visibility)
  if (method === 'GET' && path === '/api/ai/usage') {
    const month = now().slice(0, 7);
    const { results } = await env.DB.prepare(
      `SELECT kind, provider, model, status, COUNT(*) AS calls, SUM(COALESCE(input_tokens,0)) AS input_tokens,
              SUM(COALESCE(output_tokens,0)) AS output_tokens, SUM(COALESCE(images,0)) AS images
       FROM ai_calls WHERE substr(created_at,1,7) = ? GROUP BY kind, provider, model, status`
    ).bind(month).all();
    return json({ month, caps: { text: Number(env.AI_MONTHLY_TEXT_CAP || 600), image: Number(env.AI_MONTHLY_IMAGE_CAP || 60) }, rows: results || [] });
  }

  return null;
}

export { getConn };
