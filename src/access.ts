// Verified identity from Cloudflare Access (Gate 1: F-15, F-16).
//
// Cloudflare Access adds a signed JWT (Cf-Access-Jwt-Assertion) to every
// request it lets through. Plain headers such as Cf-Access-Authenticated-User-Email
// prove nothing: a caller that reaches the Worker without passing Access can set
// them to anything. Identity is therefore taken only from a JWT whose signature,
// issuer, audience, expiry and claims all check out. Any failure, including a
// malformed token or a cryptographic error, returns null: never an exception,
// never a partial identity.

export interface AccessConfig {
  teamDomain?: string; // e.g. "iddav.cloudflareaccess.com"
  aud?: string; // the Access application's Audience (AUD) tag
}

// Internal header. Only the request wrapper writes it, after verification.
export const IDENTITY_HEADER = 'X-IMI-Verified-Email';
// Headers a client must never be able to set.
export const UNTRUSTED_HEADERS = ['Cf-Access-Authenticated-User-Email', IDENTITY_HEADER];

const TEAM_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD_RE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_TOKEN_LENGTH = 8192;
const CLOCK_SKEW_SEC = 30;

// True only when both values are present and well-formed. Protected routes
// refuse to run when this is false (fail closed).
export function accessConfigValid(cfg: AccessConfig): boolean {
  return typeof cfg.teamDomain === 'string' && TEAM_DOMAIN_RE.test(cfg.teamDomain)
    && typeof cfg.aud === 'string' && AUD_RE.test(cfg.aud);
}

type Jwk = { kid?: unknown; kty?: unknown; n?: unknown; e?: unknown; alg?: unknown; use?: unknown };
let jwksCache: { url: string; at: number; keys: Jwk[] } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

export function resetJwksCache() {
  jwksCache = null;
}

function b64urlToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const decodeJson = (part: string): unknown => JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function getKeys(teamDomain: string, fetchImpl: typeof fetch, force = false): Promise<Jwk[]> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (!force && jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Access certs unavailable (${res.status})`);
  const body = await res.json();
  const keys = isObj(body) && Array.isArray(body.keys) ? (body.keys as Jwk[]) : [];
  jwksCache = { url, at: Date.now(), keys };
  return keys;
}

// A signing key is usable only if it is an RSA key meant for RS256 signatures.
function usableKey(k: Jwk | undefined): k is Jwk & { n: string; e: string } {
  return !!k && k.kty === 'RSA' && typeof k.n === 'string' && k.n.length > 300 && typeof k.e === 'string'
    && (k.alg === undefined || k.alg === 'RS256') && (k.use === undefined || k.use === 'sig');
}

// Returns the verified, lower-cased email, or null on any failure.
export async function verifyAccessJwt(
  token: string | null,
  cfg: AccessConfig,
  fetchImpl: typeof fetch = fetch,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  try {
    if (!token || token.length > MAX_TOKEN_LENGTH || !accessConfigValid(cfg)) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => !p)) return null;
    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    if (!isObj(header) || !isObj(payload)) return null;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return null;

    // Required claims, checked before any network or crypto work.
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(cfg.aud)) return null;
    if (payload.iss !== `https://${cfg.teamDomain}`) return null;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp < nowSec - CLOCK_SKEW_SEC) return null;
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > nowSec + CLOCK_SKEW_SEC)) return null;
    if (payload.iat !== undefined && (typeof payload.iat !== 'number' || payload.iat > nowSec + CLOCK_SKEW_SEC)) return null;
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;

    let keys = await getKeys(cfg.teamDomain!, fetchImpl);
    if (!keys.some((k) => k.kid === header.kid)) keys = await getKeys(cfg.teamDomain!, fetchImpl, true); // rotation
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!usableKey(jwk)) return null;

    const key = await crypto.subtle.importKey(
      'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return ok ? email : null;
  } catch {
    return null; // malformed input, bad key material, network or crypto failure: fail closed
  }
}
