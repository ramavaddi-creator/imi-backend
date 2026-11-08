// Provider-neutral AI adapter (TFR-AI-001). Copy can come from Claude or
// ChatGPT; images come from OpenAI. Every call is logged with task, prompt
// version, model, parameters, tokens, latency and outcome (TFR-AI-003,
// CIL-NFR-007) and is subject to a monthly cap (NFR-014, CILA-AT-23).

import { aiGate, costInr, getBudget, legacyWorkspace, type AiProviderKey } from './aibudget';
import type { Env } from './env';
import { getConn } from './connections';
import { now, errMsg, HttpError } from './http';

export type CopyProvider = 'claude' | 'chatgpt';

export const COPY_PROMPT_VERSION = 'imi-copy-1.0 (2026-11-05)';
export const IMAGE_PROMPT_VERSION = 'imi-atmosphere-1.0 (2026-11-05)';

const providerKey = (p: string): AiProviderKey => (/claude|anthropic/i.test(p) ? 'anthropic' : 'openai');

async function apiKey(env: Env, provider: CopyProvider): Promise<string> {
  const c = await getConn(env, provider).catch(() => null);
  const k = c?.secrets.apiKey || (provider === 'claude' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  if (!k) throw new HttpError(400, `${provider === 'claude' ? 'Claude' : 'ChatGPT'} is not connected. Open Connections.`);
  return k;
}

async function enforceCap(env: Env, kind: 'text' | 'image', provider: AiProviderKey = kind === 'image' ? 'openai' : 'anthropic') {
  await aiGate(env, { workspace: legacyWorkspace(env), provider, kind });
  const cap = Number(kind === 'image' ? env.AI_MONTHLY_IMAGE_CAP || 60 : env.AI_MONTHLY_TEXT_CAP || 600);
  const month = now().slice(0, 7);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ai_calls WHERE kind = ? AND substr(created_at, 1, 7) = ? AND status = 'ok'`
  ).bind(kind, month).first<{ n: number }>();
  if ((row?.n ?? 0) >= cap) {
    throw new HttpError(429, `Monthly AI ${kind} limit reached (${cap}). Raise AI_MONTHLY_${kind.toUpperCase()}_CAP if this is intended.`);
  }
}

async function logCall(env: Env, rec: {
  kind: 'text' | 'image'; task: string; provider: string; model: string; promptVersion: string;
  params: unknown; inputTokens?: number; outputTokens?: number; images?: number; latencyMs: number;
  status: 'ok' | 'error'; error?: string; entityType?: string; entityId?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO ai_calls (id, kind, task, provider, model, prompt_version, params_json, input_tokens, output_tokens, images,
       latency_ms, status, error, entity_type, entity_id, created_at, workspace_id, cost_inr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, rec.kind, rec.task, rec.provider, rec.model, rec.promptVersion, JSON.stringify(rec.params ?? {}),
    rec.inputTokens ?? null, rec.outputTokens ?? null, rec.images ?? null, rec.latencyMs, rec.status,
    rec.error ?? null, rec.entityType ?? null, rec.entityId ?? null, now(), legacyWorkspace(env),
    costInr((await getBudget(env, legacyWorkspace(env))).prices, providerKey(rec.provider), rec)
  ).run();
  return id;
}

// ---------------------------------------------------------------- Copy

export interface EvidenceItem { id: string; kind: string; text: string }

export interface CopyRequest {
  provider: CopyProvider;
  campaign: any;
  evidence: EvidenceItem[];
  channels: string[];
  template: string;
  backgroundIsOriginal: boolean;
  context?: string; // e.g. keep the existing poster headline; rewrite instruction
}

export interface ChannelCopy {
  caption: string;
  hashtags: string[];
  title?: string;
  extra?: { headlines?: string[]; descriptions?: string[]; metaDescription?: string };
}

export interface CopyResult {
  eyebrow: string;
  headline: string;
  imagePrompt: string;
  channels: Record<string, ChannelCopy>;
  evidenceIdsUsed: string[];
  insufficientEvidence: boolean;
  notes: string;
  aiCallId: string;
  provider: CopyProvider;
  model: string;
}

const CHANNEL_GUIDE: Record<string, string> = {
  instagram: '60–150 words, warm and observant; links are not clickable here, so point to "WhatsApp us" or "link in bio"; 5–10 hashtags.',
  facebook: '60–150 words; a link will be appended automatically; 2–4 hashtags.',
  threads: 'Under 450 characters, conversational, 0–2 hashtags; a link is appended automatically.',
  linkedin: '80–200 words, thoughtful and professional, the lesson or insight first; at most 3 hashtags; a link is appended automatically.',
  google_business: 'Under 900 characters, practical for someone planning a stay; NO hashtags, NO phone numbers, NO URLs (Google rejects them); a button carries the link.',
  youtube: 'Provide "title" (under 90 characters) and a caption used as the description, 80–200 words; 3–5 hashtags.',
  telegram: 'Under 800 characters, one short paragraph plus one line; 0–3 hashtags; a link is appended automatically.',
  whatsapp: 'Under 500 characters, one plain paragraph, personal tone, no hashtags, no emojis beyond one.',
  whatsapp_status: 'A WhatsApp Status caption: under 300 characters, warm and personal, one line plus one short question or invitation; no hashtags; a link is appended automatically.',
  website: 'An iddavwildstay.com field note: "title" (under 70 characters), "caption" is the article body of 300–600 words in short paragraphs with plain subheadings, and "metaDescription" (under 155 characters). No hashtags. End with one gentle line inviting a stay.',
  google_ads: 'A Google responsive search ad: "headlines" = 8–15 headlines each UNDER 30 characters, "descriptions" = 4 descriptions each UNDER 90 characters, and "caption" = one sentence summarising the ad idea. No exclamation marks, no superlatives like best/#1, no guaranteed sightings.',
};

export const COPY_PROMPT_VERSION_NOTE = 'channels: +whatsapp_status, +website, +google_ads';

function buildPrompt(r: CopyRequest) {
  const c = r.campaign;
  const evidence = r.evidence.length
    ? r.evidence.map((e) => `[${e.id}] (${e.kind}) ${e.text}`).join('\n')
    : '(none)';
  const system = `You draft social content for Iddav WildStay, an eco-lodge (Sri Antra) in the buffer zone of Tadoba Andhari Tiger Reserve, Maharashtra, India.
Brand doctrine: evidence-led, restrained, never boastful. "Stay Close. Stay Wild." Coexistence over control; silence over stimulation. Mood: National Geographic + Leica + Aman.

FACTS RULE (non-negotiable): You may state as fact ONLY what appears in the EVIDENCE list. Cite every evidence ID you rely on in "evidenceIdsUsed". If the evidence is too thin to say something useful, set "insufficientEvidence": true and write a restrained invitation rather than inventing anything. Never invent sightings, numbers, prices, offers, awards, dates or quotes.
WILDLIFE RULE: never promise or imply sightings, never reveal animal locations or timings, never encourage crowding, baiting or pursuit. Never imply Core-zone safari access is included.
PEOPLE RULE: never claim "27 years in the forest" (the founder has 5 years of forest experience at Sri Antra). Do not mention any former team member.
POSTER RULES: "eyebrow" (2–3 words) + "headline" together must be AT MOST 12 words. The headline's first 3 words must create tension, a question or a jolt — never a flat statement. One idea only. It must open a curiosity gap.
CAPTION RULES: each caption pays off the curiosity gap and contains exactly one save or share prompt. Write a DIFFERENT caption for each channel following its guide. Do not include any URL.
IMAGE: "imagePrompt" describes a background of landscape, light, weather, texture or forest atmosphere ONLY — no animals, birds, people, vehicles or buildings — because AI images must never pass as real wildlife or a real Sri Antra scene.
Return ONLY a JSON object: {"eyebrow": string, "headline": string, "imagePrompt": string, "channels": {"<channel>": {"caption": string, "hashtags": string[], "title"?: string, "headlines"?: string[], "descriptions"?: string[], "metaDescription"?: string}}, "evidenceIdsUsed": string[], "insufficientEvidence": boolean, "notes": string}`;
  const user = `CAMPAIGN: ${c.name}
Objective: ${c.objective} · Primary success metric: ${c.primary_metric}
Audience segments: ${JSON.parse(c.audience_json || '[]').join(', ') || 'not specified'}
Call to action: ${c.cta_type}
Expected outcome (declared before publishing): ${c.expected_outcome}

EVIDENCE:
${evidence}

CHANNELS (write one caption for each):
${r.channels.map((ch) => `- ${ch}: ${CHANNEL_GUIDE[ch] || 'concise'}`).join('\n')}

Poster layout: ${r.template}. Background will be ${r.backgroundIsOriginal ? 'an original Sri Antra photograph chosen by the owner' : 'an AI-generated atmosphere image (it will be labelled as AI)'}.${r.context ? `\n\nADDITIONAL CONTEXT:\n${r.context}` : ''}`;
  return { system, user };
}

function parseJsonLoose(text: string): any {
  const cleaned = text.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export { logCall as recordAiCall };
export async function generateCopy(env: Env, r: CopyRequest, entityId: string): Promise<CopyResult> {
  await enforceCap(env, 'text', providerKey(r.provider));
  const key = await apiKey(env, r.provider);
  const { system, user } = buildPrompt(r);
  const model = r.provider === 'claude' ? env.ANTHROPIC_MODEL || 'claude-sonnet-5-5' : env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';
  const params = { max_tokens: 3000, channels: r.channels, evidenceIds: r.evidence.map((e) => e.id) };
  const t0 = Date.now();
  let text = '';
  let inTok: number | undefined;
  let outTok: number | undefined;
  try {
    if (r.provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 3000, system, messages: [{ role: 'user', content: user }] }),
      });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error?.message || `Claude error ${res.status}`);
      text = (d.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      inTok = d.usage?.input_tokens; outTok = d.usage?.output_tokens;
    } else {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error?.message || `ChatGPT error ${res.status}`);
      text = d.choices?.[0]?.message?.content || '';
      inTok = d.usage?.prompt_tokens; outTok = d.usage?.completion_tokens;
    }

    // Schema validation (TFR-AI-002): reject drafts that cite evidence we never gave.
    const p = parseJsonLoose(text);
    if (!p.headline || typeof p.headline !== 'string') throw new Error('Draft had no headline.');
    const allowed = new Set(r.evidence.map((e) => e.id));
    const used: string[] = Array.isArray(p.evidenceIdsUsed) ? p.evidenceIdsUsed.map(String) : [];
    const invented = used.filter((id) => !allowed.has(id));
    if (invented.length) throw new Error(`Draft cited evidence that does not exist (${invented.join(', ')}).`);
    const channels: CopyResult['channels'] = {};
    for (const ch of r.channels) {
      const v = p.channels?.[ch];
      if (!v?.caption) throw new Error(`Draft is missing the ${ch} caption.`);
      const extra: ChannelCopy['extra'] = {};
      if (ch === 'google_ads') {
        extra.headlines = (Array.isArray(v.headlines) ? v.headlines : []).map((h: string) => String(h).trim()).filter((h: string) => h && h.length <= 30).slice(0, 15);
        extra.descriptions = (Array.isArray(v.descriptions) ? v.descriptions : []).map((d: string) => String(d).trim()).filter((d: string) => d && d.length <= 90).slice(0, 4);
        if ((extra.headlines?.length ?? 0) < 3 || (extra.descriptions?.length ?? 0) < 2) throw new Error('Google Ads draft did not meet the character limits. Try again.');
      }
      if (ch === 'website' && v.metaDescription) extra.metaDescription = String(v.metaDescription).slice(0, 155);
      channels[ch] = {
        caption: String(v.caption).replace(/https?:\/\/\S+/g, '').trim(),
        hashtags: ['website', 'google_ads', 'whatsapp_status', 'google_business', 'whatsapp'].includes(ch) ? []
          : Array.isArray(v.hashtags) ? v.hashtags.map((h: string) => (String(h).startsWith('#') ? h : `#${h}`).replace(/\s+/g, '')) : [],
        ...(v.title ? { title: String(v.title).slice(0, ch === 'website' ? 90 : 100) } : {}),
        ...(Object.keys(extra).length ? { extra } : {}),
      };
    }
    const aiCallId = await logCall(env, {
      kind: 'text', task: 'campaign_copy', provider: r.provider, model, promptVersion: COPY_PROMPT_VERSION, params,
      inputTokens: inTok, outputTokens: outTok, latencyMs: Date.now() - t0, status: 'ok', entityType: 'content', entityId,
    });
    return {
      eyebrow: String(p.eyebrow || ''), headline: p.headline, imagePrompt: String(p.imagePrompt || ''),
      channels, evidenceIdsUsed: used, insufficientEvidence: Boolean(p.insufficientEvidence) || r.evidence.length === 0,
      notes: String(p.notes || ''), aiCallId, provider: r.provider, model,
    };
  } catch (e) {
    await logCall(env, {
      kind: 'text', task: 'campaign_copy', provider: r.provider, model, promptVersion: COPY_PROMPT_VERSION, params,
      inputTokens: inTok, outputTokens: outTok, latencyMs: Date.now() - t0, status: 'error', error: errMsg(e), entityType: 'content', entityId,
    });
    throw new HttpError(502, errMsg(e));
  }
}

// ---------------------------------------------------------------- Images

export async function generateAtmosphere(env: Env, prompt: string, entityId: string): Promise<{ bytes: ArrayBuffer; model: string; aiCallId: string }> {
  await enforceCap(env, 'image');
  const key = await apiKey(env, 'chatgpt');
  const model = env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const full = `${prompt}

Photorealistic landscape and atmosphere only: light, weather, foliage, water, earth, sky, texture. Natural light, Leica tonality, deep shadows, restrained colour, editorial and premium.
Strictly NO animals, birds, insects, people, vehicles, buildings, text, letters, logos, watermarks or frames.`;
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, prompt: full, size: '1024x1536', n: 1 }),
    });
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error?.message || `Image generation error ${res.status}`);
    const item = d.data?.[0];
    let bytes: ArrayBuffer;
    if (item?.b64_json) {
      const bin = atob(item.b64_json);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      bytes = arr.buffer;
    } else if (item?.url) {
      bytes = await (await fetch(item.url)).arrayBuffer();
    } else {
      throw new Error('Image generation returned no image.');
    }
    const aiCallId = await logCall(env, {
      kind: 'image', task: 'poster_background', provider: 'chatgpt', model, promptVersion: IMAGE_PROMPT_VERSION,
      params: { size: '1024x1536', prompt }, inputTokens: d.usage?.input_tokens, outputTokens: d.usage?.output_tokens,
      images: 1, latencyMs: Date.now() - t0, status: 'ok', entityType: 'content', entityId,
    });
    return { bytes, model, aiCallId };
  } catch (e) {
    await logCall(env, {
      kind: 'image', task: 'poster_background', provider: 'chatgpt', model, promptVersion: IMAGE_PROMPT_VERSION,
      params: { size: '1024x1536', prompt }, latencyMs: Date.now() - t0, status: 'error', error: errMsg(e), entityType: 'content', entityId,
    });
    throw new HttpError(502, errMsg(e));
  }
}


// ---------------------------------------------------------------- Creative briefs for outside tools

export const BRIEF_PROMPT_VERSION = 'imi-brief-1.0 (2026-11-05)';

const TOOL_STYLE: Record<string, string> = {
  gemini: 'Gemini app video: one paragraph describing the scene, camera movement, light, sound and mood; about 8 seconds; vertical 9:16.',
  flow: 'Google Flow (Veo): a shot list of 1–3 shots, each with subject, camera move, lens feel, lighting, ambient sound, and duration (total 8–16 seconds); vertical 9:16.',
  runway: 'Runway video: a concise prompt under 80 words: subject, camera motion, lighting, style; 5–10 seconds; vertical 9:16.',
  firefly: 'Adobe Firefly image: a single prompt under 60 words plus suggested style settings; portrait 4:5.',
  canva: 'Canva design brief: exact poster text (eyebrow, headline), layout from the template, colours #080F08 background, #C9A84C gold only for eyebrow and divider, #F0E8CC cream, white headline in Cormorant Garamond, labels in Montserrat; 1080×1350.',
  capcut: 'CapCut edit plan for a 15–30 second vertical reel from Iddav’s own clips: shot order, on-screen text (max 12 words total), pacing, natural sound, ending card.',
  chatgpt_images: 'ChatGPT image: a single prompt for a portrait 4:5 image.',
  claude: 'Claude design brief: describe the poster layout, exact text and brand colours so Claude can draft a design.',
  other: 'A clear, tool-neutral prompt.',
};

export async function generateCreativeBrief(env: Env, r: {
  provider: CopyProvider; tool: string; kind: 'video' | 'image' | 'design'; content: any; campaign: any; evidence: EvidenceItem[];
}): Promise<{ prompt: string; aiCallId: string; model: string }> {
  await enforceCap(env, 'text', providerKey(r.provider));
  const key = await apiKey(env, r.provider);
  const model = r.provider === 'claude' ? env.ANTHROPIC_MODEL || 'claude-sonnet-5-5' : env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';
  const system = `You write production prompts for outside creative tools for Iddav WildStay (Sri Antra eco-lodge, Tadoba buffer zone, India). Mood: National Geographic + Leica + Aman; quiet, observant, premium.
RULES: AI-made media must never pass as real wildlife footage or a real Sri Antra moment. Prefer landscape, weather, light, water, forest texture, human hands, food, architecture details. If an animal appears it must be distant, natural, undisturbed and generic, never a named individual, never staged, never baited, never crowded by vehicles. No text inside generated video unless the tool brief is Canva/CapCut. No logos. Never imply guaranteed sightings.
Use only the facts provided. Output ONLY the prompt text for the tool, no preamble.`;
  const user = `TOOL: ${r.tool} — ${TOOL_STYLE[r.tool] || TOOL_STYLE.other}
KIND: ${r.kind}
CAMPAIGN: ${r.campaign.name} — objective ${r.campaign.objective}; audience ${JSON.parse(r.campaign.audience_json || '[]').join(', ') || 'general'}
POSTER: eyebrow "${r.content.eyebrow || ''}", headline "${r.content.headline}", template ${r.content.template}
FACTS:
${r.evidence.map((e) => `[${e.id}] ${e.text}`).join('\n') || '(none)'}`;
  const t0 = Date.now();
  let text = '';
  let inTok: number | undefined; let outTok: number | undefined;
  try {
    if (r.provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 900, system, messages: [{ role: 'user', content: user }] }),
      });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error?.message || `Claude error ${res.status}`);
      text = (d.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      inTok = d.usage?.input_tokens; outTok = d.usage?.output_tokens;
    } else {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error?.message || `ChatGPT error ${res.status}`);
      text = d.choices?.[0]?.message?.content || '';
      inTok = d.usage?.prompt_tokens; outTok = d.usage?.completion_tokens;
    }
    if (!text.trim()) throw new Error('The writer returned an empty prompt.');
    const aiCallId = await logCall(env, {
      kind: 'text', task: `creative_brief:${r.tool}`, provider: r.provider, model, promptVersion: BRIEF_PROMPT_VERSION,
      params: { tool: r.tool, kind: r.kind }, inputTokens: inTok, outputTokens: outTok, latencyMs: Date.now() - t0, status: 'ok',
      entityType: 'content', entityId: r.content.id,
    });
    return { prompt: text.trim(), aiCallId, model };
  } catch (e) {
    await logCall(env, {
      kind: 'text', task: `creative_brief:${r.tool}`, provider: r.provider, model, promptVersion: BRIEF_PROMPT_VERSION,
      params: { tool: r.tool, kind: r.kind }, latencyMs: Date.now() - t0, status: 'error', error: errMsg(e), entityType: 'content', entityId: r.content.id,
    });
    throw new HttpError(502, errMsg(e));
  }
}
