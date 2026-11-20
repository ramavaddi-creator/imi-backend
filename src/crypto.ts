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

// ---- Round 9: bound encryption with key versions (design 2.4) ----
// A fresh random 96-bit nonce for every encryption (stored with the ciphertext);
// additional authenticated data binds the ciphertext to one brand, connector and
// account, so a copy pasted into another brand's row fails to decrypt; every
// ciphertext records the key version that sealed it. Keys are Worker secrets:
// CONNECTIONS_KEY is version 1, CONNECTIONS_KEY_V2, _V3 ... are later ones.
// CONNECTIONS_KEY_CURRENT picks the version for new encryptions (default: highest).

export function keyring(env: Record<string, unknown>): { current: number; keys: Map<number, string> } {
  const keys = new Map<number, string>();
  if (typeof env.CONNECTIONS_KEY === 'string' && env.CONNECTIONS_KEY) keys.set(1, env.CONNECTIONS_KEY);
  for (let v = 2; v <= 9; v++) {
    const k = env[`CONNECTIONS_KEY_V${v}`];
    if (typeof k === 'string' && k) keys.set(v, k);
  }
  if (!keys.size) throw new Error('CONNECTIONS_KEY is not set on the Worker. Run: openssl rand -base64 32');
  const wanted = Number(env.CONNECTIONS_KEY_CURRENT);
  const current = wanted && keys.has(wanted) ? wanted : Math.max(...keys.keys());
  return { current, keys };
}

export async function sealBound(env: Record<string, unknown>, aad: string, value: unknown): Promise<{ ciphertext: string; keyVersion: number }> {
  const ring = keyring(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, await key(ring.keys.get(ring.current)), data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return { ciphertext: bytesToB64(out), keyVersion: ring.current };
}

export async function openBound<T>(env: Record<string, unknown>, aad: string, b64: string, keyVersion: number): Promise<T> {
  const secret = keyring(env).keys.get(keyVersion);
  if (!secret) throw new Error(`Encryption key version ${keyVersion} is not on the Worker.`);
  const all = b64ToBytes(b64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12), additionalData: new TextEncoder().encode(aad) }, await key(secret), all.slice(12));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
