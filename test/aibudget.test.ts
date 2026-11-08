// IMI ONE round 5: AI spending controls in front of every AI call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/index.ts';
import { makeD1 } from './helpers/d1.ts';
import { aiGate, costInr, DEFAULT_PRICES } from '../src/aibudget.ts';

const OWNER = 'rama@iddav.com', CREATOR = 'writer@iddav.com', AD_OWNER = 'owner@antardrishti.com';
function world() {
  const DB = makeD1();
  const run = (sql: string, ...a: unknown[]) => DB.raw.prepare(sql).run(...(a as any[]));
  run("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')");
  const m = (id: string, ws: string, email: string, role: string) => run("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, 'tnt-rama', ?, ?, ?, 'seed', '2026-11-01')", id, ws, email, role);
  m('m1', 'ws-iddav', OWNER, 'owner'); m('m2', 'ws-iddav', CREATOR, 'creator'); m('m3', 'ws-antardrishti', AD_OWNER, 'owner');
  return { DB, OWNER_EMAILS: OWNER, ANTHROPIC_API_KEY: 'test-key', POSTERS: { put: async () => {}, get: async () => null }, ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined } as any;
}
const call = async (env: any, who: string, method: string, path: string, body?: unknown) => {
  const r = await createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) as any };
};
const spend = (env: any, ws: string, provider: string, inr: number, user: string | null = null) => env.DB.raw.prepare(
  "INSERT INTO ai_calls (id, kind, task, provider, model, prompt_version, params_json, latency_ms, status, created_at, workspace_id, user_email, cost_inr) VALUES (?, 'text', 't', ?, 'm', 'v', '{}', 0, 'ok', datetime('now'), ?, ?, ?)")
  .run(crypto.randomUUID(), provider, ws, user, inr);
const W = '/v1/workspaces/ws-iddav';

test('AI is off until an owner sets a budget; the old assist route then refuses without calling any AI', async () => {
  const env = world();
  await assert.rejects(aiGate(env, { workspace: 'ws-iddav', provider: 'anthropic', kind: 'text' }), /switched off/);
  const realFetch = globalThis.fetch; let called = false;
  globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  try {
    const r = await call(env, OWNER, 'POST', '/api/ai/assist', { text: 'Polish this field note', provider: 'claude' });
    assert.equal(r.status, 403);
    assert.equal(called, false, 'nothing was sent to the AI');
  } finally { globalThis.fetch = realFetch; }
});

test('only owners set the budget; AI cannot be switched on with a zero budget', async () => {
  const env = world();
  assert.equal((await call(env, CREATOR, 'POST', `${W}/ai-budget`, { monthlyCapInr: 500, enabled: true })).status, 403);
  assert.equal((await call(env, OWNER, 'POST', `${W}/ai-budget`, { enabled: true })).status, 400);
  const ok = await call(env, OWNER, 'POST', `${W}/ai-budget`, { monthlyCapInr: 100, enabled: true, dailyCallsPerPerson: 2, providerCaps: { openai: 10 } });
  assert.deepEqual([ok.status, ok.data.enabled, ok.data.monthlyCapInr, ok.data.providerCaps.openai, ok.data.updatedBy], [200, true, 100, 10, OWNER]);
  assert.equal((await call(env, AD_OWNER, 'GET', `${W}/ai-budget`)).status, 404, 'another brand cannot see it');
  assert.equal((await call(env, AD_OWNER, 'GET', '/v1/workspaces/ws-antardrishti/ai-budget')).data.enabled, false, 'each brand has its own budget, off by default');
});

test('the monthly cap, the provider cap and the daily per-person limit each stop calls', async () => {
  const env = world();
  await call(env, OWNER, 'POST', `${W}/ai-budget`, { monthlyCapInr: 100, enabled: true, dailyCallsPerPerson: 2, providerCaps: { openai: 10 } });
  assert.ok((await aiGate(env, { workspace: 'ws-iddav', provider: 'anthropic', kind: 'text' })).estimateInr > 0);
  spend(env, 'ws-iddav', 'openai', 9.9);
  await assert.rejects(aiGate(env, { workspace: 'ws-iddav', provider: 'openai', kind: 'image' }), /openai budget/);
  spend(env, 'ws-iddav', 'anthropic', 2, CREATOR); spend(env, 'ws-iddav', 'anthropic', 2, CREATOR);
  await assert.rejects(aiGate(env, { workspace: 'ws-iddav', provider: 'anthropic', kind: 'text', user: CREATOR }), /today's 2 AI requests/);
  await aiGate(env, { workspace: 'ws-iddav', provider: 'anthropic', kind: 'text', user: OWNER });
  spend(env, 'ws-iddav', 'anthropic', 85);
  await assert.rejects(aiGate(env, { workspace: 'ws-iddav', provider: 'anthropic', kind: 'text' }), /budget \(Rs 100\) would be passed/);
  assert.ok((await aiGate(env, { workspace: 'ws-antardrishti', provider: 'anthropic', kind: 'text' }).catch((e) => e)).message.includes('switched off'), 'brands do not share budgets');
});

test('Today warns when spending reaches the warning level; the kill switch stops everything', async () => {
  const env = world();
  await call(env, OWNER, 'POST', `${W}/ai-budget`, { monthlyCapInr: 100, enabled: true, alertPct: 80 });
  spend(env, 'ws-iddav', 'anthropic', 81);
  const t = (await call(env, OWNER, 'GET', `${W}/today`)).data;
  assert.equal(t.needsYou[0].kind, 'ai_budget');
  await call(env, OWNER, 'POST', `${W}/ai-budget`, { enabled: false });
  await assert.rejects(aiGate(env, { workspace: 'ws-iddav', provider: 'anthropic', kind: 'text' }), /switched off/);
});

test('cost estimates come from token and image counts with the price table', () => {
  assert.equal(costInr(DEFAULT_PRICES, 'anthropic', { inputTokens: 2500, outputTokens: 1200 }), 2.17);
  assert.equal(costInr(DEFAULT_PRICES, 'openai', { images: 2 }), 30);
});
