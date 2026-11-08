// IMI ONE round 5: AI spending controls. Every AI call, old or new, passes aiGate()
// first and aiRecord() after. AI is off for a brand until an owner sets a budget.
// Costs are ESTIMATES from token and image counts (the provider's bill is the truth);
// the owner can correct the price table per brand.

import type { Env } from './env';
import { HttpError } from './http';

export type AiProviderKey = 'anthropic' | 'openai';
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// Default estimates in rupees: per 1M input tokens, per 1M output tokens, per image.
// Set from public list prices at about Rs 85 per US dollar; owners should check their provider's current prices.
export const DEFAULT_PRICES: Record<AiProviderKey, { in: number; out: number; image: number }> = {
  anthropic: { in: 255, out: 1275, image: 0 },
  openai: { in: 13, out: 51, image: 15 },
};
// What a call is assumed to cost before it runs (to stop a call that would pass the cap).
const TYPICAL = { text: { in: 2500, out: 1200 }, image: 1 };

// The legacy /api routes (old Content Studio) are single-brand: they belong to Iddav.
export const legacyWorkspace = (env: Env) => env.LEGACY_WORKSPACE || 'ws-iddav';

export async function getBudget(env: Env, ws: string) {
  const b = await env.DB.prepare('SELECT * FROM ai_budgets WHERE workspace_id = ?').bind(ws).first<any>();
  const prices = { ...DEFAULT_PRICES, ...(b ? JSON.parse(b.prices_json || '{}') : {}) } as typeof DEFAULT_PRICES;
  return {
    enabled: !!b?.ai_enabled, monthlyCapInr: b?.monthly_cap_inr ?? 0, dailyCallsPerPerson: b?.daily_calls_per_person ?? 20,
    providerCaps: (b ? JSON.parse(b.provider_caps_json || '{}') : {}) as Partial<Record<AiProviderKey, number>>,
    prices, alertPct: b?.alert_pct ?? 80, updatedBy: b?.updated_by ?? null, updatedAt: b?.updated_at ?? null,
  };
}

export const costInr = (prices: typeof DEFAULT_PRICES, p: AiProviderKey, u: { inputTokens?: number | null; outputTokens?: number | null; images?: number | null }) =>
  Math.round((((u.inputTokens ?? 0) * prices[p].in + (u.outputTokens ?? 0) * prices[p].out) / 1e6 + (u.images ?? 0) * prices[p].image) * 100) / 100;

async function spent(env: Env, ws: string, provider?: AiProviderKey) {
  const month = now().slice(0, 7);
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(cost_inr), 0) AS s FROM ai_calls WHERE workspace_id = ? AND substr(created_at, 1, 7) = ? ${provider ? 'AND provider = ?' : ''}`)
    .bind(...(provider ? [ws, month, provider] : [ws, month])).first<{ s: number }>();
  return r?.s ?? 0;
}

// Throws (and nothing is sent to the AI) when any rule would be broken.
export async function aiGate(env: Env, a: { workspace: string; provider: AiProviderKey; kind: 'text' | 'image'; user?: string | null }) {
  const b = await getBudget(env, a.workspace);
  if (!b.enabled) throw new HttpError(403, 'AI is switched off for this brand. An owner can set a budget and switch it on in Brand settings, AI budget.');
  const estimate = a.kind === 'image' ? costInr(b.prices, a.provider, { images: TYPICAL.image }) : costInr(b.prices, a.provider, { inputTokens: TYPICAL.text.in, outputTokens: TYPICAL.text.out });
  const month = await spent(env, a.workspace);
  if (month + estimate > b.monthlyCapInr) throw new HttpError(429, `This month's AI budget (Rs ${b.monthlyCapInr}) would be passed. An owner can raise it in Brand settings.`);
  const pcap = b.providerCaps[a.provider];
  if (pcap !== undefined && (await spent(env, a.workspace, a.provider)) + estimate > pcap) throw new HttpError(429, `The ${a.provider} budget for this month (Rs ${pcap}) would be passed.`);
  if (a.user) {
    const day = now().slice(0, 10);
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE workspace_id = ? AND user_email = ? AND substr(created_at, 1, 10) = ?').bind(a.workspace, a.user, day).first<{ n: number }>())?.n ?? 0;
    if (n >= b.dailyCallsPerPerson) throw new HttpError(429, `You have used today's ${b.dailyCallsPerPerson} AI requests for this brand.`);
  }
  return { estimateInr: estimate };
}

export async function setBudget(env: Env, ws: string, who: string, body: any) {
  const cur = await getBudget(env, ws);
  const int = (v: unknown, lo: number, hi: number, name: string, fallback: number) => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${name}: a whole number from ${lo} to ${hi}.`);
    return n;
  };
  const cap = int(body?.monthlyCapInr, 0, 10_000_000, 'Monthly budget', cur.monthlyCapInr);
  const daily = int(body?.dailyCallsPerPerson, 1, 1000, 'Daily requests per person', cur.dailyCallsPerPerson);
  const alert = int(body?.alertPct, 10, 100, 'Warning level', cur.alertPct);
  const caps: Partial<Record<AiProviderKey, number>> = { ...cur.providerCaps };
  for (const p of ['anthropic', 'openai'] as AiProviderKey[]) {
    if (body?.providerCaps && p in body.providerCaps) {
      const v = body.providerCaps[p];
      if (v === null || v === '') delete caps[p]; else caps[p] = int(v, 0, 10_000_000, `${p} budget`, 0);
    }
  }
  const enabled = body?.enabled === undefined ? cur.enabled : !!body.enabled;
  if (enabled && cap <= 0) throw new HttpError(400, 'Set a monthly budget above zero before switching AI on.');
  await env.DB.prepare(`INSERT INTO ai_budgets (workspace_id, ai_enabled, monthly_cap_inr, daily_calls_per_person, provider_caps_json, alert_pct, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET ai_enabled = excluded.ai_enabled, monthly_cap_inr = excluded.monthly_cap_inr,
      daily_calls_per_person = excluded.daily_calls_per_person, provider_caps_json = excluded.provider_caps_json, alert_pct = excluded.alert_pct,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(ws, enabled ? 1 : 0, cap, daily, JSON.stringify(caps), alert, who, now()).run();
  return usage(env, ws);
}

export async function usage(env: Env, ws: string) {
  const b = await getBudget(env, ws);
  const month = now().slice(0, 7);
  const { results: byProvider } = await env.DB.prepare(`SELECT provider, COUNT(*) AS calls, COALESCE(SUM(cost_inr), 0) AS inr FROM ai_calls WHERE workspace_id = ? AND substr(created_at, 1, 7) = ? GROUP BY provider`).bind(ws, month).all<any>();
  const { results: recent } = await env.DB.prepare(`SELECT created_at, provider, model, kind, task, status, user_email, input_tokens, output_tokens, images, cost_inr FROM ai_calls WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 25`).bind(ws).all<any>();
  const total = (byProvider ?? []).reduce((s: number, r: any) => s + r.inr, 0);
  return { ...b, month, spentInr: Math.round(total * 100) / 100, byProvider: byProvider ?? [], recent: recent ?? [],
    warning: b.monthlyCapInr > 0 && total >= (b.monthlyCapInr * b.alertPct) / 100, estimateNote: 'Estimated from token and image counts; your provider\u2019s bill is the source of truth.' };
}

// For calls that do not report token counts: log the gate's estimate as the cost.
export async function aiRecordEstimate(env: Env, a: { workspace: string; provider: AiProviderKey; kind: 'text' | 'image'; task: string; estimateInr: number; user?: string | null; ok: boolean }) {
  await env.DB.prepare(`INSERT INTO ai_calls (id, kind, task, provider, model, prompt_version, params_json, latency_ms, status, created_at, workspace_id, user_email, cost_inr)
    VALUES (?, ?, ?, ?, 'unknown', 'assist', '{}', 0, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), a.kind, a.task, a.provider, a.ok ? 'ok' : 'error', now(), a.workspace, a.user ?? null, a.ok ? a.estimateInr : 0).run();
}
