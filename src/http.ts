export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Owner-PIN',
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

// Who is acting. With Cloudflare Access in front, this is the signed-in email;
// otherwise the owner PIN is the proof and we record that honestly.
export function actor(request: Request, ownerPin?: string): string {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (email) return email;
  return ownerPin && request.headers.get('X-Owner-PIN') === ownerPin ? 'Owner (verified by PIN)' : 'IMI user (no PIN)';
}

export function requireOwner(request: Request, pin: string | undefined) {
  if (!pin) throw new HttpError(403, 'OWNER_PIN is not set on the Worker, so this action is disabled.');
  if (request.headers.get('X-Owner-PIN') !== pin) throw new HttpError(403, 'Incorrect owner PIN.');
}

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
