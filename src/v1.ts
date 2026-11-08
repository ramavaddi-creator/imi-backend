// IMI ONE API, version 1 (milestone 1). Every route is workspace-scoped and
// checked on the server: identity from Cloudflare Access (policy.ts), membership
// and role from the memberships table (tenancy.ts).
//
//   GET /v1/me                        who you are and your role in each brand
//   GET /v1/workspaces                the brands you belong to
//   GET /v1/workspaces/:id/today      one brand's Today, every figure labelled with its source
//
// The response shapes match the IMI ONE web app's contract (imi-one-web src/contract.ts).

import type { Env } from './env';
import { HttpError, json } from './http';
import { verifiedEmail } from './policy';
import { membershipsOf, requireWorkspace, type Membership } from './tenancy';
import { crmMode } from './crm_bridge';
import { contentHash } from './studio';

const GOALS: Record<string, { label: string; phrase: string }> = {
  qualified_enquiries: { label: 'Enquiries from posts', phrase: '{n} people enquired from your posts' },
  sales: { label: 'Sales from posts', phrase: '{n} sales came from your posts' },
  sign_ups: { label: 'Sign-ups from posts', phrase: '{n} people signed up after seeing a post' },
  screener_completions: { label: 'Research volunteers', phrase: '{n} research volunteers completed the screener' },
  followers: { label: 'New followers', phrase: '{n} new followers' },
};

// Staging unless this deployment explicitly says production. Mislabelling
// production as staging is visible and harmless; the reverse would not be.
const environment = (env: Env): 'staging' | 'production' => (env.DATA_ENVIRONMENT === 'production' ? 'production' : 'staging');

const toWorkspace = (m: Membership) => ({
  id: m.workspace_id, tenantId: m.tenant_id, name: m.name, kind: m.kind, description: m.description,
  goal: { key: m.goal_key, ...(GOALS[m.goal_key] ?? GOALS.qualified_enquiries), period: 'this week' },
  maxHeadlineWords: m.max_headline_words,
});

export async function handleV1(request: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith('/v1/')) return null;
  if (request.method !== 'GET') return json({ error: 'not found' }, 404);
  try {
    if (path === '/v1/me') {
      const email = verifiedEmail(request);
      if (!email) throw new HttpError(401, 'Sign in through Cloudflare Access first.');
      const ms = await membershipsOf(env, email);
      return json({
        email, name: email.split('@')[0],
        tenantId: ms[0]?.tenant_id ?? null,
        roles: Object.fromEntries(ms.map((m) => [m.workspace_id, m.role])),
        environment: environment(env),
      });
    }
    if (path === '/v1/workspaces') {
      const email = verifiedEmail(request);
      if (!email) throw new HttpError(401, 'Sign in through Cloudflare Access first.');
      return json((await membershipsOf(env, email)).map(toWorkspace));
    }
    const m = path.match(/^\/v1\/workspaces\/([^/]+)\/today$/);
    if (m) {
      const { membership } = await requireWorkspace(request, env, decodeURIComponent(m[1]), 'today.read');
      return json(await today(env, membership));
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    throw e;
  }
}

async function today(env: Env, ws: Membership) {
  const id = ws.workspace_id;
  const needsYou: unknown[] = [];

  // Posts ready to go whose current version has no valid approval.
  const { results: ready } = await env.DB.prepare(
    `SELECT c.* FROM contents c JOIN campaigns k ON k.id = c.campaign_id
     WHERE k.workspace_id = ? AND c.status = 'ready' ORDER BY c.updated_at LIMIT 10`).bind(id).all<any>();
  for (const c of ready ?? []) {
    const pubs = (await env.DB.prepare('SELECT * FROM publications WHERE content_id = ?').bind(c.id).all<any>()).results ?? [];
    const hash = await contentHash(c, pubs);
    const ok = await env.DB.prepare('SELECT 1 FROM approvals WHERE content_id = ? AND revoked_at IS NULL AND content_hash = ? LIMIT 1').bind(c.id, hash).first();
    if (!ok) needsYou.push({ id: `content-${c.id}`, kind: 'approve_post', subject: c.headline, title: `Approve "${c.headline}"`,
      why: 'It will not go out until you approve it.', action: { label: 'Review post', screen: 'create', ref: c.id } });
  }
  // Decisions waiting for approval.
  const { results: decisions } = await env.DB.prepare(
    "SELECT id, code, title FROM decision_items WHERE workspace_id = ? AND approval_status = 'pending' ORDER BY rowid LIMIT 3").bind(id).all<any>();
  for (const d of decisions ?? []) {
    needsYou.push({ id: `decision-${d.id}`, kind: 'review_decision', subject: d.title, title: d.title,
      why: 'Waiting for approval', action: { label: 'Review decision', screen: 'intelligence', ref: d.id } });
  }

  const published = await env.DB.prepare(
    `SELECT 1 FROM publications p JOIN contents c ON c.id = p.content_id JOIN campaigns k ON k.id = c.campaign_id
     WHERE k.workspace_id = ? AND p.status = 'published' LIMIT 1`).bind(id).first();

  return {
    workspaceId: id, isSample: false, environment: environment(env),
    goal: await goal(env, ws),
    needsYou: needsYou.slice(0, 3),
    upcoming: [],
    notes: ['Scheduling is not built yet. Approved posts are published from Content Studio.'],
    setup: [{ id: 's3', label: 'Make your first post', done: !!published, screen: 'create' }],
    security: [],
  };
}

// This week's goal number, from the CRM, counting only this workspace's campaigns.
async function goal(env: Env, ws: Membership) {
  const source = ws.goal_key === 'qualified_enquiries' ? 'Iddav CRM' : 'CRM';
  if (ws.goal_key !== 'qualified_enquiries') {
    return { value: null, previous: null, trust: { kind: 'unavailable', source: ws.name, detail: 'This goal is not connected to a data source yet.' } };
  }
  if (!crmMode(env)) {
    return { value: null, previous: null, trust: { kind: 'unavailable', source, detail: 'The CRM is not connected in this environment.' } };
  }
  const { results } = await env.DB.prepare('SELECT code FROM campaigns WHERE workspace_id = ?').bind(ws.workspace_id).all<{ code: string }>();
  const codes = new Set((results ?? []).map((r) => r.code.toUpperCase()));
  const day = 86400000, now = Date.now();
  const sum = async (since: number) => {
    const url = new URL('/integrations/imi/outcomes', env.CRM_URL);
    url.searchParams.set('since', new Date(since).toISOString());
    const res = await fetch(url.toString(), { headers: { 'x-imi-feed-key': env.CRM_SERVICE_KEY! }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new HttpError(502, `The CRM answered ${res.status}.`);
    const body = (await res.json().catch(() => null)) as { imi_campaigns?: { code: string; enquiries: number }[] } | null;
    if (!body || !Array.isArray(body.imi_campaigns)) throw new HttpError(502, 'The CRM answered in a form IMI does not recognise.');
    return body.imi_campaigns.filter((c) => codes.has(String(c.code).toUpperCase())).reduce((s, c) => s + (Number(c.enquiries) || 0), 0);
  };
  try {
    const last7 = await sum(now - 7 * day), last14 = await sum(now - 14 * day);
    return { value: last7, previous: last14 - last7, trust: { kind: 'measured', source, detail: "Enquiries carrying this brand's campaign links, last 7 days" } };
  } catch {
    return { value: null, previous: null, trust: { kind: 'unavailable', source, detail: 'The CRM could not be reached. Try again in a minute.' } };
  }
}
