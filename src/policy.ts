// Gate 1 request policy: one place that decides, before any route runs,
// (1) which requests may skip sign-in, (2) who the caller is, (3) which browser
// origins may read the response. Everything not listed as public is protected,
// and protected requests fail closed when sign-in is missing, invalid or
// not configured.

import type { Env } from './env';
import { json, safeEqual, HttpError } from './http';
import { accessConfigValid, verifyAccessJwt, IDENTITY_HEADER, UNTRUSTED_HEADERS } from './access';

export type RouteClass = 'public-media' | 'public-enquiry' | 'protected';

// Exact public rules (method + path). Nothing else is public.
//   GET/HEAD /media/<kind>s/<uuid>.<ext>  platforms fetch published images and videos by URL
//   POST/OPTIONS /public/enquiry          the website enquiry form on brand websites
// OAuth callbacks are deliberately NOT public: the user's own browser arrives
// there signed in to Access, and the callback must match the person who started it.
const MEDIA_RE = /^\/media\/(?:image|video|poster|background)s\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

export function classify(method: string, path: string): RouteClass {
  if ((method === 'GET' || method === 'HEAD') && MEDIA_RE.test(path)) return 'public-media';
  if ((method === 'POST' || method === 'OPTIONS') && path === '/public/enquiry') return 'public-enquiry';
  return 'protected';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const list = (v?: string) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Strips client identity headers; adds IDENTITY_HEADER only after verification.
// Local development: with ENVIRONMENT="development" in .dev.vars (never
// deployed) and a localhost URL, DEV_IDENTITY stands in for Access.
export async function identify(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<{ request: Request; email: string | null }> {
  const url = new URL(request.url);
  let email: string | null = null;
  if (env.ENVIRONMENT === 'development' && LOCAL_HOSTS.has(url.hostname) && env.DEV_IDENTITY) {
    email = env.DEV_IDENTITY.trim().toLowerCase();
  } else {
    email = await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }, fetchImpl);
  }
  const headers = new Headers(request.headers);
  for (const h of UNTRUSTED_HEADERS) headers.delete(h);
  if (email) headers.set(IDENTITY_HEADER, email);
  return { request: new Request(request, { headers }), email };
}

export function verifiedEmail(request: Request): string | null {
  return request.headers.get(IDENTITY_HEADER);
}

export function isOwner(env: Env, email: string | null): boolean {
  return !!email && list(env.OWNER_EMAILS).map((e) => e.toLowerCase()).includes(email);
}

// Authorization for privileged actions (approve, publish, connect accounts,
// record outcomes, forget a person): a verified person on the server-side
// owner list. When OWNER_PIN is set it is an extra confirmation, never a
// substitute for identity.
export function requireOwner(request: Request, env: Env): string {
  const email = verifiedEmail(request);
  if (!email) throw new HttpError(401, 'Sign in through Cloudflare Access first.');
  if (!isOwner(env, email)) throw new HttpError(403, 'Your account does not have owner permission for this action.');
  if (env.OWNER_PIN && !safeEqual(request.headers.get('X-Owner-PIN') ?? '', env.OWNER_PIN)) {
    throw new HttpError(403, 'Enter the owner PIN to confirm this action.');
  }
  return email;
}

// CORS per route class. Protected routes: only APP origins, with credentials.
// Enquiry form: only listed brand websites. Media: any origin (public files).
// Unlisted origins get no CORS header, so the browser blocks the read.
export function applyCors(res: Response, request: Request, env: Env, cls: RouteClass): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  for (const k of ['Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers']) h.delete(k);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('X-Frame-Options', 'DENY');
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const origin = request.headers.get('Origin') || '';
  if (cls === 'public-media') {
    h.set('Access-Control-Allow-Origin', '*');
    return out;
  }
  const allowed = cls === 'public-enquiry' ? list(env.ENQUIRY_ORIGINS) : list(env.ALLOWED_ORIGINS || env.APP_URL);
  h.append('Vary', 'Origin');
  if (origin && allowed.includes(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    if (cls === 'protected') h.set('Access-Control-Allow-Credentials', 'true');
    h.set('Access-Control-Allow-Methods', cls === 'public-enquiry' ? 'POST, OPTIONS' : 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Content-Type, X-Owner-PIN');
  }
  return out;
}

// The single entry point. Returns a response to send, or the identified
// request for the router.
export async function gate(request: Request, env: Env, fetchImpl: typeof fetch = fetch):
  Promise<{ stop: Response; cls: RouteClass } | { request: Request; cls: RouteClass }> {
  const url = new URL(request.url);
  const cls = classify(request.method, url.pathname);
  if (request.method === 'OPTIONS') return { stop: new Response(null, { status: 204 }), cls };
  const { request: req, email } = await identify(request, env, fetchImpl);
  if (cls !== 'protected') return { request: req, cls };
  const devMode = env.ENVIRONMENT === 'development' && LOCAL_HOSTS.has(url.hostname) && !!env.DEV_IDENTITY;
  if (!devMode && !accessConfigValid({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD })) {
    return { stop: json({ error: 'Sign-in is not configured on this server, so private actions are switched off.' }, 503), cls };
  }
  if (!email) return { stop: json({ error: 'Sign in through Cloudflare Access to use IMI.' }, 401), cls };
  return { request: req, cls };
}
