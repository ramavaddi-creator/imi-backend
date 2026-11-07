export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Owner-PIN',
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Who is acting: the identity verified by the request policy (src/policy.ts).
// Protected routes never run without one, so the fallback appears only on the
// public enquiry form. Authorization lives in policy.requireOwner, not here.
export function actor(request: Request, _legacyPin?: string): string {
  return request.headers.get('X-IMI-Verified-Email') || 'Unverified caller';
}

// Constant-time string comparison for secrets such as the owner PIN.
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
