// IMI ONE milestone 1: who may see which brand, and do what.
// Identity is the verified Cloudflare Access email (policy.ts). Membership and
// role come from the memberships table, checked on the server for every request.
// A brand the person does not belong to answers 404, exactly like a brand that
// does not exist, so one brand's existence is never revealed to another's users.

import type { Env } from './env';
import { HttpError } from './http';
import { verifiedEmail } from './policy';

export type Role = 'owner' | 'manager' | 'creator' | 'sales' | 'viewer';
export type Perm =
  | 'today.read' | 'results.read' | 'content.create' | 'content.approve' | 'content.publish'
  | 'channels.connect' | 'money.read' | 'margin.read' | 'members.manage' | 'decide';

// The permission matrix. Approving, publishing, connecting channels, margins and
// members stay with owners until the founder approves wider delegation.
export const ROLE_PERMS: Record<Role, readonly Perm[]> = {
  owner: ['today.read', 'results.read', 'content.create', 'content.approve', 'content.publish', 'channels.connect', 'money.read', 'margin.read', 'members.manage', 'decide'],
  manager: ['today.read', 'results.read', 'content.create', 'money.read'],
  creator: ['today.read', 'content.create'],
  sales: ['today.read', 'results.read'],
  viewer: ['today.read', 'results.read'],
};

export const can = (role: Role, perm: Perm) => ROLE_PERMS[role].includes(perm);

export interface Membership {
  workspace_id: string; tenant_id: string; role: Role;
  name: string; kind: string; description: string; goal_key: string; max_headline_words: number | null;
  record_domain?: string | null; feed_profile_json?: string | null;
}

const WS_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

export async function membershipsOf(env: Env, email: string): Promise<Membership[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.workspace_id, m.tenant_id, m.role, w.name, w.kind, w.description, w.goal_key, w.max_headline_words, w.record_domain, w.feed_profile_json
     FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.email = ? AND m.revoked_at IS NULL ORDER BY w.created_at, w.name`,
  ).bind(email.toLowerCase()).all<Membership>();
  return results ?? [];
}

// Returns the caller's membership of this workspace, or throws: 401 without a
// verified identity, 404 without membership (indistinguishable from a missing
// workspace), 403 when the role lacks the permission.
export async function requireWorkspace(request: Request, env: Env, workspaceId: string, perm: Perm) {
  const email = verifiedEmail(request);
  if (!email) throw new HttpError(401, 'Sign in through Cloudflare Access first.');
  if (!WS_RE.test(workspaceId)) throw new HttpError(404, 'Workspace not found');
  const m = (await membershipsOf(env, email)).find((x) => x.workspace_id === workspaceId);
  if (!m) throw new HttpError(404, 'Workspace not found');
  if (!can(m.role, perm)) throw new HttpError(403, 'Your role does not allow this.');
  return { email, membership: m };
}
