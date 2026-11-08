// IMI ONE round 4: Brand settings. Owners only (members.manage), brand-scoped,
// every membership change logged append-only; a brand never loses its last owner.

import type { Env } from './env';
import { HttpError } from './http';
import type { Role } from './tenancy';

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const ROLES: Role[] = ['owner', 'manager', 'creator', 'sales', 'viewer'];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

// ------------------------------------------------------------------ members

export async function listMembers(env: Env, ws: string) {
  const { results } = await env.DB.prepare('SELECT id, email, role, created_by, created_at FROM memberships WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at').bind(ws).all();
  return results ?? [];
}

const owners = async (env: Env, ws: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner' AND revoked_at IS NULL").bind(ws).first<{ n: number }>())?.n ?? 0;
const logMember = (env: Env, ws: string, actor: string, subject: string, change: string) =>
  env.DB.prepare('INSERT INTO member_events (id, workspace_id, actor, subject_email, change, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), ws, actor, subject, change, now());

export async function addMember(env: Env, ws: { id: string; tenant_id: string }, actor: string, body: any) {
  const email = clip(body?.email, 254).toLowerCase(), role = body?.role as Role;
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a role.');
  const id = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, ws.tenant_id, ws.id, email, role, actor, now()),
      logMember(env, ws.id, actor, email, `added:${role}`),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new HttpError(409, 'That person is already a member of this brand.');
    throw e;
  }
  return { id, email, role };
}

export async function changeRole(env: Env, ws: string, actor: string, memberId: string, body: any) {
  const role = body?.role as Role;
  if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a role.');
  const m = await env.DB.prepare('SELECT id, email, role FROM memberships WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL').bind(memberId, ws).first<any>();
  if (!m) throw new HttpError(404, 'Member not found');
  if (m.role === role) return { id: m.id, role };
  if (m.role === 'owner' && (await owners(env, ws)) <= 1) throw new HttpError(409, 'A brand must keep at least one owner. Add another owner first.');
  await env.DB.batch([
    env.DB.prepare('UPDATE memberships SET role = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL').bind(role, m.id, ws),
    logMember(env, ws, actor, m.email, `role:${m.role}->${role}`),
  ]);
  return { id: m.id, role };
}

export async function revokeMember(env: Env, ws: string, actor: string, memberId: string) {
  const m = await env.DB.prepare('SELECT id, email, role FROM memberships WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL').bind(memberId, ws).first<any>();
  if (!m) throw new HttpError(404, 'Member not found');
  if (m.role === 'owner' && (await owners(env, ws)) <= 1) throw new HttpError(409, 'A brand must keep at least one owner. Add another owner first.');
  await env.DB.batch([
    env.DB.prepare('UPDATE memberships SET revoked_at = ? WHERE id = ? AND workspace_id = ?').bind(now(), m.id, ws),
    logMember(env, ws, actor, m.email, 'revoked'),
  ]);
  return { id: m.id, revoked: true };
}

// ------------------------------------------------------------------ Brand Facts

export async function listFacts(env: Env, ws: string) {
  const { results } = await env.DB.prepare('SELECT id, statement, wrong_forms_json, created_by, created_at FROM brand_facts WHERE workspace_id = ? AND retired_at IS NULL ORDER BY created_at').bind(ws).all<any>();
  return (results ?? []).map((f) => ({ id: f.id, statement: f.statement, wrongForms: JSON.parse(f.wrong_forms_json || '[]') as string[], created_by: f.created_by, created_at: f.created_at }));
}

export async function addFact(env: Env, ws: string, actor: string, body: any) {
  const statement = clip(body?.statement, 300);
  if (statement.length < 5) throw new HttpError(400, 'Write the fact as one clear sentence.');
  const wrong = (Array.isArray(body?.wrongForms) ? body.wrongForms : []).map((w: unknown) => clip(w, 120)).filter((w: string) => w.length >= 3).slice(0, 10);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO brand_facts (id, workspace_id, statement, wrong_forms_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, ws, statement, JSON.stringify(wrong), actor, now()).run();
  return { id, statement, wrongForms: wrong };
}

export async function retireFact(env: Env, ws: string, actor: string, id: string) {
  const r = await env.DB.prepare('UPDATE brand_facts SET retired_by = ?, retired_at = ? WHERE id = ? AND workspace_id = ? AND retired_at IS NULL').bind(actor, now(), id, ws).run();
  if (!(r as any).meta?.changes) throw new HttpError(404, 'Fact not found');
  return { id, retired: true };
}

// Lines added to every Send to AI prompt for this brand.
export async function factLines(env: Env, ws: string) {
  const facts = await listFacts(env, ws);
  if (!facts.length) return [];
  const lines = ['', 'BRAND FACTS (state them exactly; never use the wrong forms):'];
  for (const f of facts) lines.push(`- ${f.statement}${f.wrongForms.length ? ` Never write: ${f.wrongForms.map((w) => `"${w}"`).join(', ')}.` : ''}`);
  return lines;
}

// ------------------------------------------------------------------ brand profile and AI services

export async function updateProfile(env: Env, ws: string, body: any) {
  const description = body?.description === undefined ? undefined : clip(body.description, 600);
  let maxWords: number | null | undefined = undefined;
  if (body?.maxHeadlineWords !== undefined) {
    maxWords = body.maxHeadlineWords === null || body.maxHeadlineWords === '' ? null : Number(body.maxHeadlineWords);
    if (maxWords !== null && (!Number.isInteger(maxWords) || maxWords < 3 || maxWords > 40)) throw new HttpError(400, 'Headline limit: a whole number from 3 to 40, or empty.');
  }
  let profile: string | undefined = undefined;
  if (body?.feedQuery !== undefined || body?.newsKeywords !== undefined) {
    const cur = await env.DB.prepare('SELECT feed_profile_json FROM workspaces WHERE id = ?').bind(ws).first<any>();
    let p: any = {}; try { p = JSON.parse(cur?.feed_profile_json || '{}'); } catch { p = {}; }
    if (body.feedQuery !== undefined) p.query = clip(body.feedQuery, 80);
    if (body.newsKeywords !== undefined) p.newsKeywords = (Array.isArray(body.newsKeywords) ? body.newsKeywords : []).map((k: unknown) => clip(k, 40).toLowerCase()).filter(Boolean).slice(0, 20);
    profile = JSON.stringify(p);
  }
  await env.DB.prepare(`UPDATE workspaces SET description = COALESCE(?, description), max_headline_words = CASE WHEN ? = 1 THEN ? ELSE max_headline_words END,
      feed_profile_json = COALESCE(?, feed_profile_json) WHERE id = ?`)
    .bind(description ?? null, maxWords === undefined ? 0 : 1, maxWords ?? null, profile ?? null, ws).run();
  return getProfile(env, ws);
}

export async function getProfile(env: Env, ws: string) {
  const w = await env.DB.prepare('SELECT name, description, max_headline_words, feed_profile_json FROM workspaces WHERE id = ?').bind(ws).first<any>();
  let p: any = {}; try { p = JSON.parse(w?.feed_profile_json || '{}'); } catch { p = {}; }
  return { name: w?.name, description: w?.description ?? '', maxHeadlineWords: w?.max_headline_words ?? null, feedQuery: p.query ?? '', newsKeywords: p.newsKeywords ?? [],
    area: p.lat != null ? `${p.radiusKm ?? 50} km around ${p.lat}, ${p.lng}` : null };
}

export async function toggleProvider(env: Env, ws: string, id: string, body: any) {
  const r = await env.DB.prepare('UPDATE ai_providers SET enabled = ? WHERE id = ? AND workspace_id = ?').bind(body?.enabled ? 1 : 0, id, ws).run();
  if (!(r as any).meta?.changes) throw new HttpError(404, 'AI service not found');
  return { id, enabled: !!body?.enabled };
}

// ------------------------------------------------------------------ activity (read-only)

export async function activity(env: Env, ws: string) {
  const q = async (sql: string) => ((await env.DB.prepare(sql).bind(ws).all<any>()).results ?? []);
  const rows = [
    ...(await q(`SELECT e.created_at AS at, e.actor AS who, 'decision' AS kind, d.code || ': ' || d.selected_option AS what FROM decision_events e JOIN decision_items d ON d.id = e.decision_id WHERE d.workspace_id = ? ORDER BY e.created_at DESC LIMIT 50`)),
    ...(await q(`SELECT approved_at AS at, approved_by AS who, 'approval' AS kind, 'Approved "' || headline || '" v' || version AS what FROM drafts WHERE workspace_id = ? AND approved_at IS NOT NULL ORDER BY approved_at DESC LIMIT 50`)),
    ...(await q(`SELECT posted_at AS at, posted_by AS who, 'posted' AS kind, 'Posted "' || headline || '" on ' || posted_channel AS what FROM drafts WHERE workspace_id = ? AND posted_at IS NOT NULL ORDER BY posted_at DESC LIMIT 50`)),
    ...(await q(`SELECT created_at AS at, created_by AS who, 'ai' AS kind, 'Sent a record to ' || provider || ' (' || redactions || ' details removed)' AS what FROM ai_handoffs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50`)),
    ...(await q(`SELECT created_at AS at, actor AS who, 'member' AS kind, subject_email || ': ' || change AS what FROM member_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50`)),
  ];
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100);
}
