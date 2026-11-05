// AES-GCM encryption for platform credentials stored in D1. Tokens never leave
// the Worker: the API returns connection status, never secrets.

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function key(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new Error('CONNECTIONS_KEY is not set on the Worker. Run: openssl rand -base64 32');
  const raw = b64ToBytes(secret);
  if (raw.length !== 32) throw new Error('CONNECTIONS_KEY must be 32 random bytes, base64-encoded.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptJson(secret: string | undefined, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

export async function decryptJson<T>(secret: string | undefined, b64: string): Promise<T> {
  const all = b64ToBytes(b64);
  const iv = all.slice(0, 12);
  const ct = all.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await key(secret), ct);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
