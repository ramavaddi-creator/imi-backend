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
import * as links from './links';
import * as partners from './partners';
import { membershipsOf, requireWorkspace, type Membership } from './tenancy';
import { crmFetch, crmMode } from './crm_bridge';
import { can } from './tenancy';
import { legacyWorkspace } from './aibudget';
import { usage as aiUsage, setBudget as setAiBudget } from './aibudget';
import { listMembers, addMember, changeRole, revokeMember, listFacts, addFact, retireFact, updateProfile, getProfile, toggleProvider, activity } from './admin';
import { listProviders, addProvider, preparePrompt, createDraft, listDrafts, editDraft, approveDraft, markPosted, putMedia, getMedia, scheduleDraft, calendar, recordOutcome } from './create';
import { parseConnector, listConnections, updateConnection, oauthStart, runSync, disconnect, listRuns, addManual, listManual, funnel, rotateKeys, needsAttention, listTopics, saveTopic, retireTopic } from './search';
import { isOwner } from './policy';
import * as ig from './instagram';
import * as engine from './engine';
import * as season from './season';
import { feeds, parseProfile, listInbox, captureInbox, setInboxStatus, promoteInbox, listRecords, decisionHistory, decideOnRecord, listOutcomes } from './intel';

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
  try {
    const admin = await handleAdmin(request, env, path);
    if (admin) return admin;
    const eng0 = await handleEngine(request, env, path);
    if (eng0) return eng0;
    const sea = await handleSeason(request, env, path);
    if (sea) return sea;
    const lk = await handleLinks(request, env, path);
    if (lk) return lk;
    const pt = await handlePartners(request, env, path);
    if (pt) return pt;
    const created = await handleCreate(request, env, path);
    if (created) return created;
    const intel = await handleIntel(request, env, path);
    if (intel) return intel;
    const search = await handleSearch(request, env, path);
    if (search) return search;
    const social = await handleSocial(request, env, path);
    if (social) return social;
    if (request.method !== 'GET') return json({ error: 'not found' }, 404);
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
    const crmView = path.match(/^\/v1\/workspaces\/([^/]+)\/crm\/pipeline$/);
    if (crmView) {
      const ws = decodeURIComponent(crmView[1]);
      const { membership } = await requireWorkspace(request, env, ws, 'results.read');
      return json(await crmPipeline(env, ws, membership.role));
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

  // Posts to approve come from Drafts only: that is the screen "Review post" opens.
  // (The older poster-studio table, contents, has no screen in IMI ONE, so a task
  // from it led to an empty Drafts page. It is no longer listed here.)
  // Drafts waiting for the owner's approval (round 2).
  const { results: drafts } = await env.DB.prepare(
    "SELECT id, headline FROM drafts WHERE workspace_id = ? AND status = 'draft' ORDER BY updated_at DESC LIMIT 3").bind(id).all<any>();
  for (const d of drafts ?? []) {
    needsYou.push({ id: `draft-${d.id}`, kind: 'approve_post', subject: d.headline, title: `Approve "${d.headline}"`,
      why: 'It will not go out until you approve it.', action: { label: 'Review post', screen: 'create', ref: d.id } });
  }
  // Scheduled posts that are due: the owner posts them by hand, then marks them as posted.
  const { results: due } = await env.DB.prepare(
    "SELECT id, headline FROM drafts WHERE workspace_id = ? AND status = 'approved' AND scheduled_for IS NOT NULL AND scheduled_for <= ? ORDER BY scheduled_for LIMIT 3")
    .bind(id, new Date().toISOString()).all<any>();
  for (const d of due ?? []) {
    needsYou.push({ id: `due-${d.id}`, kind: 'approve_post', subject: d.headline, title: d.headline,
      why: 'It was scheduled for now. Post it, then mark it as posted.', action: { label: 'Post it now', screen: 'create', ref: d.id } });
  }
  // A week after posting: ask for results, so the outcome is linked to the post and its decision.
  const { results: ripe } = await env.DB.prepare(
    `SELECT d.id, d.headline FROM drafts d WHERE d.workspace_id = ? AND d.status = 'posted' AND d.posted_at <= datetime('now', '-7 days')
       AND NOT EXISTS (SELECT 1 FROM outcome_items o WHERE o.draft_id = d.id) ORDER BY d.posted_at LIMIT 3`).bind(id).all<any>();
  for (const d of ripe ?? []) {
    needsYou.push({ id: `results-${d.id}`, kind: 'review_learning', subject: d.headline, title: d.headline,
      why: 'Results are in? Record what happened, so IMI ONE can learn.', action: { label: 'Record results', screen: 'create', ref: d.id } });
  }
  // A Google measurement connection that stopped working (round 9).
  needsYou.unshift(...(await needsAttention(env, id)), ...(await ig.needsAttention(env, id)));
  // AI spending near or over this month's budget (round 5).
  const ai = await aiUsage(env, id);
  if (ai.warning) {
    needsYou.unshift({ id: 'ai-budget', kind: 'ai_budget', subject: `${ai.spentInr} / ${ai.monthlyCapInr}`, title: 'AI spending is close to this month\'s budget',
      why: 'New AI requests stop when the budget is reached.', action: { label: 'Review the AI budget', screen: 'admin', ref: 'ai' } });
  }
  // Round 12: season and demand dates coming up (30/14/7-day reminders).
  needsYou.push(...(await season.seasonReminders(env, id)));
  needsYou.push(...(await partners.outreachReminder(env, id)));
  // Records waiting for a decision (decisions are made on the record itself).
  const { results: open } = await env.DB.prepare(
    "SELECT id, code, title FROM intelligence_records WHERE workspace_id = ? AND status IN ('open', 'under_review', 'draft') ORDER BY updated_at DESC LIMIT 3").bind(id).all<any>();
  for (const r of open ?? []) {
    needsYou.push({ id: `record-${r.id}`, kind: 'review_decision', subject: r.title, title: r.title,
      why: 'Waiting for a decision', action: { label: 'Decide', screen: 'intelligence', ref: r.id } });
  }

  const published = await env.DB.prepare(
    `SELECT 1 FROM publications p JOIN contents c ON c.id = p.content_id JOIN campaigns k ON k.id = c.campaign_id
     WHERE k.workspace_id = ? AND p.status = 'published' LIMIT 1`).bind(id).first();

  return {
    workspaceId: id, isSample: false, environment: environment(env),
    goal: await goal(env, ws),
    needsYou: needsYou.slice(0, 3),
    upcoming: await upcoming(env, id),
    notes: [],
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
    const res = await crmFetch(env, url.toString(), { headers: { 'x-imi-feed-key': env.CRM_SERVICE_KEY! }, signal: AbortSignal.timeout(8000) });
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

// Round 1: the intelligence loop. Reading needs today.read (or results.read for
// outcomes); capturing and triage need content.create; deciding needs decide (owners).
// Brand settings (record domain, feed profile) come from the workspaces table, never the request.
async function handleIntel(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = path.match(/^\/v1\/workspaces\/([^/]+)\/(feed|inbox|records|outcomes)(?:\/([^/]+)(?:\/(status|promote|decision|decisions))?)?$/);
  if (!m) return null;
  const [, rawWs, area, rawItem, action] = m;
  const ws = decodeURIComponent(rawWs);
  const itemId = rawItem ? decodeURIComponent(rawItem) : '';
  const method = request.method;
  const body = method === 'POST' ? await request.json().catch(() => ({})) : null;
  const need = async (perm: Parameters<typeof requireWorkspace>[3]) => {
    const r = await requireWorkspace(request, env, ws, perm);
    return { ...r, info: { id: ws, domain: r.membership.record_domain || ws } };
  };

  if (area === 'feed' && method === 'GET' && !itemId) {
    const { membership } = await need('today.read');
    return json(await feeds(new URL(request.url).searchParams.get('q') ?? '', parseProfile(membership.feed_profile_json)));
  }
  if (area === 'inbox' && !itemId && method === 'GET') { await need('today.read'); return json(await listInbox(env, ws, new URL(request.url).searchParams.get('status'))); }
  if (area === 'inbox' && !itemId && method === 'POST') { const { email, info } = await need('content.create'); const r = await captureInbox(env, info, email, body); return json(r, r.duplicate ? 200 : 201); }
  if (area === 'inbox' && itemId && action === 'status' && method === 'POST') {
    await need('content.create'); await setInboxStatus(env, ws, itemId, String((body as any)?.status ?? '')); return json({ ok: true });
  }
  if (area === 'inbox' && itemId && action === 'promote' && method === 'POST') {
    const { email, info } = await need('content.create'); const r = await promoteInbox(env, info, itemId, email); return json(r, r.existing ? 200 : 201);
  }
  if (area === 'records' && !itemId && method === 'GET') { await need('today.read'); return json(await listRecords(env, ws)); }
  if (area === 'records' && itemId && action === 'decisions' && method === 'GET') { await need('today.read'); return json(await decisionHistory(env, ws, itemId)); }
  if (area === 'records' && itemId && action === 'decision' && method === 'POST') {
    const { email, info } = await need('decide'); const r = await decideOnRecord(env, info, itemId, email, body); return json(r, r.replayed ? 200 : 201);
  }
  if (area === 'outcomes' && !itemId && method === 'GET') { await need('results.read'); return json(await listOutcomes(env, ws)); }
  return json({ error: 'not found' }, 404);
}

// Round 2: Send to AI, Bring back from AI, drafts, approval, Mark as posted.
async function handleCreate(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = path.match(/^\/v1\/workspaces\/([^/]+)\/(ai-providers|drafts|records|calendar)(?:\/([^/]+)(?:\/(prompt|edit|approve|posted|media|schedule|outcome))?)?$/);
  if (!m) return null;
  const [, rawWs, area, rawId, action] = m;
  if (area === 'records' && action !== 'prompt') return null; // other record routes are handled by handleIntel
  const ws = decodeURIComponent(rawWs), id = rawId ? decodeURIComponent(rawId) : '';
  const method = request.method;
  const body = method === 'POST' ? await request.json().catch(() => ({})) : null;
  const need = (perm: Parameters<typeof requireWorkspace>[3]) => requireWorkspace(request, env, ws, perm);

  if (area === 'ai-providers' && !id && method === 'GET') { const { email } = await need('today.read'); return json(await listProviders(env, ws, email)); }
  if (area === 'ai-providers' && !id && method === 'POST') { const { email } = await need('channels.connect'); return json(await addProvider(env, ws, email, body), 201); }
  if (area === 'records' && action === 'prompt' && method === 'POST') { const { email, membership } = await need('content.create'); return json(await preparePrompt(env, membership, id, email, body)); }
  if (area === 'drafts' && !id && method === 'GET') { await need('today.read'); return json(await listDrafts(env, ws, new URL(request.url).searchParams.get('record'))); }
  if (area === 'drafts' && !id && method === 'POST') { const { email } = await need('content.create'); return json(await createDraft(env, ws, email, body), 201); }
  if (area === 'drafts' && id && action === 'edit' && method === 'POST') { await need('content.create'); return json(await editDraft(env, ws, id, body)); }
  if (area === 'drafts' && id && action === 'approve' && method === 'POST') { const { email } = await need('content.approve'); return json(await approveDraft(env, ws, id, email, body)); }
  if (area === 'drafts' && id && action === 'posted' && method === 'POST') { const { email } = await need('content.publish'); return json(await markPosted(env, ws, id, email, body)); }
  if (area === 'drafts' && id && action === 'media' && method === 'PUT') { await need('content.create'); return json(await putMedia(env, ws, id, request)); }
  if (area === 'drafts' && id && action === 'media' && method === 'GET') { await need('today.read'); return getMedia(env, ws, id); }
  if (area === 'drafts' && id && action === 'schedule' && method === 'POST') { await need('content.publish'); return json(await scheduleDraft(env, ws, id, body)); }
  if (area === 'drafts' && id && action === 'outcome' && method === 'POST') {
    const { email, membership } = await need('content.create');
    return json(await recordOutcome(env, { id: ws, domain: membership.record_domain || ws }, id, email, body), 201);
  }
  if (area === 'calendar' && !id && method === 'GET') { await need('today.read'); return json(await calendar(env, ws, new URL(request.url).searchParams.get('month') ?? '')); }
  return json({ error: 'not found' }, 404);
}

// The next scheduled posts (approved drafts with a time), in the Today shape.
async function upcoming(env: Env, ws: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, headline, scheduled_for, scheduled_channel FROM drafts WHERE workspace_id = ? AND status = 'approved' AND scheduled_for > ? ORDER BY scheduled_for LIMIT 3")
    .bind(ws, new Date().toISOString()).all<any>();
  return (results ?? []).map((d) => ({ id: d.id, title: d.headline, channels: [String(d.scheduled_channel ?? 'website').toLowerCase().replace(/\s.*$/, '')],
    when: d.scheduled_for, state: 'manual', stateNote: 'You post this; IMI ONE reminds you.' }));
}

// Round 4: Brand settings. Reading facts and the profile is open to members; changes are owners only.
async function handleAdmin(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = path.match(/^\/v1\/workspaces\/([^/]+)\/(members|brand-facts|profile|activity|ai-providers|ai-budget)(?:\/([^/]+)(?:\/(role|revoke|retire|toggle))?)?$/);
  if (!m) return null;
  const [, rawWs, area, rawId, action] = m;
  if (area === 'ai-providers' && action !== 'toggle') return null; // listing and adding are in handleCreate
  const ws = decodeURIComponent(rawWs), id = rawId ? decodeURIComponent(rawId) : '';
  const method = request.method;
  const body = method === 'POST' ? await request.json().catch(() => ({})) : null;
  const need = (perm: Parameters<typeof requireWorkspace>[3]) => requireWorkspace(request, env, ws, perm);

  if (area === 'members' && !id && method === 'GET') { await need('members.manage'); return json(await listMembers(env, ws)); }
  if (area === 'members' && !id && method === 'POST') { const { email, membership } = await need('members.manage'); return json(await addMember(env, { id: ws, tenant_id: membership.tenant_id }, email, body), 201); }
  if (area === 'members' && id && action === 'role' && method === 'POST') { const { email } = await need('members.manage'); return json(await changeRole(env, ws, email, id, body)); }
  if (area === 'members' && id && action === 'revoke' && method === 'POST') { const { email } = await need('members.manage'); return json(await revokeMember(env, ws, email, id)); }
  if (area === 'brand-facts' && !id && method === 'GET') { await need('today.read'); return json(await listFacts(env, ws)); }
  if (area === 'brand-facts' && !id && method === 'POST') { const { email } = await need('members.manage'); return json(await addFact(env, ws, email, body), 201); }
  if (area === 'brand-facts' && id && action === 'retire' && method === 'POST') { const { email } = await need('members.manage'); return json(await retireFact(env, ws, email, id)); }
  if (area === 'profile' && !id && method === 'GET') { await need('today.read'); return json(await getProfile(env, ws)); }
  if (area === 'profile' && !id && method === 'POST') { await need('members.manage'); return json(await updateProfile(env, ws, body)); }
  if (area === 'ai-providers' && id && action === 'toggle' && method === 'POST') { await need('channels.connect'); return json(await toggleProvider(env, ws, id, body)); }
  if (area === 'activity' && !id && method === 'GET') { await need('members.manage'); return json(await activity(env, ws)); }
  if (area === 'ai-budget' && !id && method === 'GET') { await need('members.manage'); return json(await aiUsage(env, ws)); }
  if (area === 'ai-budget' && !id && method === 'POST') { const { email } = await need('members.manage'); return json(await setAiBudget(env, ws, email, body)); }
  return json({ error: 'not found' }, 404);
}

// Round 7: CRM views. The CRM is the source of truth and filters fields itself; IMI ONE only
// states what this person's role allows (money, margin). Only the brand that owns the CRM has one.
async function crmPipeline(env: Env, ws: string, role: Parameters<typeof can>[0]) {
  if (ws !== legacyWorkspace(env) || !crmMode(env)) throw new HttpError(404, 'This brand has no CRM connected.');
  const scope = [can(role, 'money.read') ? 'money' : '', can(role, 'margin.read') ? 'margin' : ''].filter(Boolean).join(',');
  const url = new URL('/integrations/imi/pipeline', env.CRM_URL);
  const res = await crmFetch(env, url.toString(), { headers: { 'x-imi-feed-key': env.CRM_SERVICE_KEY!, ...(scope ? { 'x-imi-scope': scope } : {}) }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new HttpError(502, `The CRM answered ${res.status}.`);
  const body = await res.json() as Record<string, unknown>;
  return { ...body, crmUrl: env.CRM_PUBLIC_URL || null, source: 'Iddav CRM', retrievedAt: new Date().toISOString() };
}

// Round 9: Build 3, search and guest acquisition. Reading needs results.read; connecting, fetching and
// typing in figures are owner actions (channels.connect). The funnel's money and margin follow the role.
async function handleSearch(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/v1/admin/google/rotate-keys' && request.method === 'POST') {
    const email = verifiedEmail(request);
    if (!isOwner(env, email)) throw new HttpError(403, 'Only the platform owner can rotate encryption keys.');
    return json(await rotateKeys(env, email!));
  }
  const f = path.match(/^\/v1\/workspaces\/([^/]+)\/funnel$/);
  if (f && request.method === 'GET') {
    const ws = decodeURIComponent(f[1]);
    const { membership } = await requireWorkspace(request, env, ws, 'results.read');
    return json(await funnel(env, ws, membership.role, new URL(request.url).searchParams.get('days')));
  }
  // Round 17: searches grouped by topic. Reading: results.read. Changing topics: owners (channels.connect).
  const st = path.match(/^\/v1\/workspaces\/([^/]+)\/search-topics(?:\/([^/]+)(?:\/(retire))?)?$/);
  if (st) {
    const ws = decodeURIComponent(st[1]), id = st[2] ? decodeURIComponent(st[2]) : null;
    if (!id && request.method === 'GET') { await requireWorkspace(request, env, ws, 'results.read'); return json(await listTopics(env, ws)); }
    if (request.method !== 'POST') return json({ error: 'not found' }, 404);
    const { email } = await requireWorkspace(request, env, ws, 'channels.connect');
    if (st[3] === 'retire' && id) return json(await retireTopic(env, ws, id));
    if (!st[3]) return json(await saveTopic(env, ws, email, id, await request.json().catch(() => ({}))), id ? 200 : 201);
    return json({ error: 'not found' }, 404);
  }
  const m = path.match(/^\/v1\/workspaces\/([^/]+)\/google(?:\/([a-z_0-9]+)(?:\/(oauth-start|sync|disconnect|manual))?)?$/);
  if (!m) return null;
  const [, rawWs, rawConn, action] = m;
  const ws = decodeURIComponent(rawWs);
  const method = request.method;
  const origin = new URL(request.url).origin;
  const need = (perm: Parameters<typeof requireWorkspace>[3]) => requireWorkspace(request, env, ws, perm);
  if (!rawConn && method === 'GET') { await need('results.read'); return json(await listConnections(env, ws, origin)); }
  if (rawConn === 'runs' && !action && method === 'GET') {
    await need('results.read');
    const c = new URL(request.url).searchParams.get('connector');
    return json(await listRuns(env, ws, c ? parseConnector(c) : null));
  }
  if (!rawConn) return json({ error: 'not found' }, 404);
  // Membership first, so another brand's member learns nothing (404) before the connector name is checked.
  const body = method === 'POST' ? await request.json().catch(() => ({})) : null;
  if (action === 'manual' && method === 'GET') { await need('results.read'); if (rawConn !== 'business_profile') return json({ error: 'not found' }, 404); return json(await listManual(env, ws)); }
  const { email } = await need('channels.connect');
  const c = parseConnector(rawConn);
  if (!action && method === 'POST') return json(await updateConnection(env, ws, c, body));
  if (action === 'oauth-start' && method === 'POST') return json(await oauthStart(env, ws, c, email, origin));
  if (action === 'sync' && method === 'POST') return json(await runSync(env, ws, c, 'manual', email));
  if (action === 'disconnect' && method === 'POST') return json(await disconnect(env, ws, c));
  if (action === 'manual' && method === 'POST') { if (c !== 'business_profile') return json({ error: 'not found' }, 404); return json(await addManual(env, ws, email, body), 201); }
  return json({ error: 'not found' }, 404);
}

// Round 10: Build 1, Instagram read-only. Reading needs results.read; connecting, fetching, testing and
// disconnecting are owner actions (channels.connect). No route writes anything to Instagram.
async function handleSocial(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = path.match(/^\/v1\/workspaces\/([^/]+)\/social(?:\/(instagram|runs)(?:\/(connect|sync|test|disconnect|media|account-metrics))?)?$/);
  if (!m) return null;
  const [, rawWs, platform, action] = m;
  const ws = decodeURIComponent(rawWs);
  const method = request.method;
  const params = new URL(request.url).searchParams;
  const need = (perm: Parameters<typeof requireWorkspace>[3]) => requireWorkspace(request, env, ws, perm);
  if (!platform && method === 'GET') { await need('results.read'); return json(await ig.getAccount(env, ws)); }
  if (platform === 'runs' && !action && method === 'GET') { await need('results.read'); return json(await listRuns(env, ws, 'instagram')); }
  if (platform !== 'instagram') return json({ error: 'not found' }, 404);
  if (action === 'media' && method === 'GET') { await need('results.read'); return json(await ig.listMedia(env, ws, params.get('limit'))); }
  if (action === 'account-metrics' && method === 'GET') { await need('results.read'); return json(await ig.accountMetrics(env, ws, params.get('days'))); }
  if (method !== 'POST') return json({ error: 'not found' }, 404);
  const { email } = await need('channels.connect');
  const body = await request.json().catch(() => ({}));
  if (action === 'connect') return json(await ig.connect(env, ws, email, body));
  if (action === 'sync') return json(await ig.runSync(env, ws, 'manual', email));
  if (action === 'test') return json(await ig.connectionTest(env, ws));
  if (action === 'disconnect') return json(await ig.disconnect(env, ws));
  return json({ error: 'not found' }, 404);
}

// Round 11: Build 4, the Content Engine. Reading needs today.read; making packs needs content.create;
// changing the Brand Kit is an owner action (members.manage); scheduling from a plan needs content.publish.
async function handleEngine(request: Request, env: Env, path: string): Promise<Response | null> {
  const mm = path.match(/^\/v1\/workspaces\/([^/]+)\/packs\/([^/]+)\/media(?:\/([^/]+)(?:\/(remove))?)?$/);
  if (mm) {
    const ws = decodeURIComponent(mm[1]), pid = decodeURIComponent(mm[2]), mid = mm[3] ? decodeURIComponent(mm[3]) : '';
    if (!mid && request.method === 'PUT') { const { email } = await requireWorkspace(request, env, ws, 'content.create'); return json(await engine.addPackMedia(env, ws, pid, email, request), 201); }
    if (!mid && request.method === 'GET') { await requireWorkspace(request, env, ws, 'today.read'); return json(await engine.listPackMedia(env, ws, pid)); }
    if (mid && !mm[4] && request.method === 'GET') { await requireWorkspace(request, env, ws, 'today.read'); return engine.getPackMedia(env, ws, pid, mid); }
    if (mid && mm[4] === 'remove' && request.method === 'POST') { await requireWorkspace(request, env, ws, 'content.create'); return json(await engine.removePackMedia(env, ws, pid, mid)); }
    return json({ error: 'not found' }, 404);
  }
  const um = path.match(/^\/v1\/workspaces\/([^/]+)\/drafts\/([^/]+)\/use-media$/);
  if (um && request.method === 'POST') {
    const ws = decodeURIComponent(um[1]);
    await requireWorkspace(request, env, ws, 'content.create');
    return json(await engine.useMediaOnDraft(env, ws, decodeURIComponent(um[2]), await request.json().catch(() => ({}))));
  }
  const m = path.match(/^\/v1\/workspaces\/([^/]+)\/(brand-kit|packs)(?:\/([^/]+)(?:\/(prompt|bring-back|estimate|generate|plan))?)?$/);
  if (!m) return null;
  const [, rawWs, area, rawId, action] = m;
  const ws = decodeURIComponent(rawWs), id = rawId ? decodeURIComponent(rawId) : '';
  const method = request.method;
  const body = method === 'POST' ? await request.json().catch(() => ({})) : null;
  const need = (perm: Parameters<typeof requireWorkspace>[3]) => requireWorkspace(request, env, ws, perm);
  if (area === 'brand-kit' && !id && method === 'GET') { await need('today.read'); return json(await engine.getKit(env, ws)); }
  if (area === 'brand-kit' && !id && method === 'POST') { const { email } = await need('members.manage'); return json(await engine.saveKit(env, ws, email, body), 201); }
  if (area !== 'packs') return json({ error: 'not found' }, 404);
  if (!id && method === 'GET') { await need('today.read'); return json(await engine.listPacks(env, ws)); }
  if (!id && method === 'POST') { const { email, membership } = await need('content.create'); return json(await engine.createPack(env, membership, email, body), 201); }
  if (id && !action && method === 'GET') { await need('today.read'); return json(await engine.getPack(env, ws, id)); }
  if (action === 'estimate' && method === 'GET') { const { membership } = await need('content.create'); return json(await engine.estimate(env, membership, id)); }
  if (method !== 'POST') return json({ error: 'not found' }, 404);
  const { email, membership } = await need('content.create');
  if (action === 'prompt') return json(await engine.packPrompt(env, membership, id, email, body));
  if (action === 'bring-back') return json(await engine.bringBack(env, ws, id, email, body), 201);
  if (action === 'generate') return json(await engine.generate(env, membership, id, email), 201);
  if (action === 'plan') return json(await engine.plan(env, ws, id, body, can(membership.role, 'content.publish')));
  return json({ error: 'not found' }, 404);
}

// Round 12: season and demand calendar (reading: today.read; changes: owners via content.publish),
// and the baseline (reading: results.read; starting and taking a snapshot: owners via members.manage).
async function handleSeason(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = path.match(/^\/v1\/workspaces\/([^/]+)\/(events|baseline)(?:\/([^/]+)(?:\/(retire))?)?$/);
  if (!m) return null;
  const [, rawWs, area, rawId, action] = m;
  const ws = decodeURIComponent(rawWs), id = rawId ? decodeURIComponent(rawId) : '';
  const method = request.method;
  const need = (perm: Parameters<typeof requireWorkspace>[3]) => requireWorkspace(request, env, ws, perm);
  const body = method === 'POST' ? await request.json().catch(() => ({})) : null;
  const q = new URL(request.url).searchParams;
  if (area === 'events' && !id && method === 'GET') { await need('today.read'); return json(await season.listEvents(env, ws, q.get('from'), q.get('to'))); }
  if (area === 'events' && !id && method === 'POST') { const { email } = await need('content.publish'); return json(await season.addEvent(env, ws, email, body), 201); }
  if (area === 'events' && id && action === 'retire' && method === 'POST') { const { email } = await need('content.publish'); return json(await season.retireEvent(env, ws, email, id)); }
  if (area === 'baseline' && !id && method === 'GET') { await need('results.read'); return json(await season.baseline(env, ws)); }
  if (area === 'baseline' && id === 'start' && !action && method === 'POST') { const { email } = await need('members.manage'); return json(await season.startBaseline(env, ws, email, body), 201); }
  if (area === 'baseline' && id === 'snapshot' && !action && method === 'POST') { const { email } = await need('members.manage'); await season.takeSnapshot(env, ws, email); return json(await season.baseline(env, ws)); }
  return json({ error: 'not found' }, 404);
}

// Round 13: the brand's official links (reading: today.read; changing and checking: owners via members.manage).
async function handleLinks(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = path.match(/^\/v1\/workspaces\/([^/]+)\/links(?:\/([^/]+)\/(verify|retire))?$/);
  if (!m) return null;
  const ws = decodeURIComponent(m[1]), id = m[2] ? decodeURIComponent(m[2]) : '', action = m[3];
  const method = request.method;
  if (!id && method === 'GET') { await requireWorkspace(request, env, ws, 'today.read'); return json(await links.listLinks(env, ws, new URL(request.url).searchParams.get('campaign'))); }
  if (method !== 'POST') return json({ error: 'not found' }, 404);
  const { email } = await requireWorkspace(request, env, ws, 'members.manage');
  if (!id) return json(await links.setLink(env, ws, email, await request.json().catch(() => ({}))), 201);
  if (action === 'verify') return json(await links.verifyLink(env, ws, email, id));
  return json(await links.retireLink(env, ws, email, id));
}

// Round 14: Build 5, partner outreach. Reading: today.read. Adding prospects, checking websites, preparing emails,
// sequences from AI and logging replies: content.create. Approving a sequence and marking an email sent (a person
// sends it from their own mailbox): content.publish. The partner profile and OpenStreetMap search: members.manage.
async function handlePartners(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = path.match(/^\/v1\/workspaces\/([^/]+)\/partners(?:\/([a-z-]+)(?:\/([^/]+)(?:\/([a-z-]+))?)?)?$/);
  if (!m) return null;
  const ws = decodeURIComponent(m[1]), area = m[2] ?? '', id = m[3] ? decodeURIComponent(m[3]) : '', action = m[4] ?? '';
  const method = request.method;
  const need = (perm: Parameters<typeof requireWorkspace>[3]) => requireWorkspace(request, env, ws, perm);
  const body = method === 'POST' ? await request.json().catch(() => ({})) : null;
  const q = new URL(request.url).searchParams;
  if (method === 'GET') {
    await need('today.read');
    if (!area) return json(await partners.summary(env, ws));
    if (area === 'prospects' && !id) return json(await partners.listProspects(env, ws, q));
    if (area === 'prospects' && id && !action) return json(await partners.getProspect(env, ws, id));
    if (area === 'sequences' && !id) return json(await partners.listSequences(env, ws));
    if (area === 'outbox' && !id) return json(await partners.outbox(env, ws));
    if (area === 'suppressions' && !id) return json(await partners.listSuppressions(env, ws));
    return json({ error: 'not found' }, 404);
  }
  if (method !== 'POST') return json({ error: 'not found' }, 404);
  if (area === 'profile' && !id) { const { email } = await need('members.manage'); return json(await partners.saveProfile(env, ws, email, body)); }
  if (area === 'discover' && !id) { const { email } = await need('members.manage'); return json(await partners.discover(env, ws, email, body), 201); }
  if (area === 'sequences' && id && action === 'approve') { const { email } = await need('content.publish'); return json(await partners.approveSequence(env, ws, email, id)); }
  if (area === 'messages' && id && action === 'sent') { const { email } = await need('content.publish'); return json(await partners.markSent(env, ws, email, id)); }
  const { email, membership } = await need('content.create');
  if (area === 'prospects' && !id) return json(await partners.addProspect(env, ws, email, body), 201);
  if (area === 'import' && !id) return json(await partners.importCsv(env, ws, email, body), 201);
  if (area === 'prospects' && id && action === 'check') return json(await partners.checkProspect(env, ws, id));
  if (area === 'prospects' && id && action === 'reply') return json(await partners.logReply(env, ws, email, id, body), 201);
  if (area === 'prospects' && id && action === 'stage') return json(await partners.setStage(env, ws, id, body));
  if (area === 'prepare' && !id) return json(await partners.prepare(env, ws, email, body), 201);
  if (area === 'sequences' && id === 'prompt' && !action) return json(await partners.sequencePromptFor(env, membership, body));
  if (area === 'sequences' && id === 'generate' && !action) return json(await partners.generateSequence(env, membership, email, body), 201);
  if (area === 'sequences' && !id) return json(await partners.bringBackSequence(env, ws, email, body), 201);
  if (area === 'sequences' && id && action === 'edit') return json(await partners.editSequence(env, ws, email, id, body), 201);
  if (area === 'messages' && id && action === 'skip') return json(await partners.skipMessage(env, ws, id));
  if (area === 'suppressions' && !id) return json(await partners.suppress(env, ws, email, body), 201);
  return json({ error: 'not found' }, 404);
}
