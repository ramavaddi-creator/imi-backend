// Gate 1 security regression tests (review of 7 Nov 2026, requirement 7).
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessJwt, resetJwksCache, accessConfigValid, IDENTITY_HEADER } from '../src/access.ts';
import { classify } from '../src/policy.ts';
import worker from '../src/index.ts';
import { makeD1 } from './helpers/d1.ts';

const TEAM = 'iddav.cloudflareaccess.com';
const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OWNER = 'rama@iddav.com';
const STAFF = 'staff@iddav.com';
const APP = 'https://imi.iddav.com';
const cfg = { teamDomain: TEAM, aud: AUD };
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

const gen = async () => (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
)) as CryptoKeyPair;
let pair: CryptoKeyPair, other: CryptoKeyPair;
let certs: { keys: any[] };
let certFetches = 0;
// Optional handler for other outbound calls (for example the CRM) in a test.
let outbound: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
const realFetch = globalThis.fetch;

before(async () => {
  pair = await gen();
  other = await gen();
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  certs = { keys: [{ kid: 'k1', kty: 'RSA', n: pub.n, e: pub.e, alg: 'RS256', use: 'sig' }] };
  // The Worker fetches Access signing keys with the global fetch; serve them here.
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input?.url ?? input);
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) { certFetches++; return new Response(JSON.stringify(certs)); }
    if (outbound) return outbound(url, init);
    return new Response('blocked in tests', { status: 599 });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { resetJwksCache(); certFetches = 0; outbound = null; });

async function token(claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; kid?: string; alg?: string } = {}) {
  const h = enc({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' });
  const p = enc({ aud: [AUD], iss: `https://${TEAM}`, email: OWNER, exp: now() + 600, iat: now(), ...claims });
  const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? pair.privateKey, new TextEncoder().encode(`${h}.${p}`))).toString('base64url');
  return `${h}.${p}.${sig}`;
}

// ------------------------------------------------------------ JWT verifier

test('valid Access token yields the verified email (lower-cased)', async () => {
  assert.equal(await verifyAccessJwt(await token({ email: 'Rama@Iddav.com' }), cfg), OWNER);
});

test('invalid tokens are rejected without throwing', async () => {
  const good = await token();
  const [h, p, s] = good.split('.');
  const cases: [string, string | null][] = [
    ['wrong signing key', await token({}, { key: other.privateKey })],
    ['wrong audience', await token({ aud: ['x'.repeat(32)] })],
    ['wrong issuer', await token({ iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', await token({ exp: now() - 3600 })],
    ['not yet valid', await token({ nbf: now() + 3600 })],
    ['issued in the future', await token({ iat: now() + 3600 })],
    ['exp missing', await token({ exp: undefined })],
    ['exp not a number', await token({ exp: 'soon' })],
    ['email missing', await token({ email: undefined })],
    ['email malformed', await token({ email: 'not-an-email' })],
    ['unknown key id', await token({}, { kid: 'nope' })],
    ['alg none', `${enc({ alg: 'none', kid: 'k1' })}.${p}.${s}`],
    ['alg HS256', `${enc({ alg: 'HS256', kid: 'k1' })}.${p}.${s}`],
    ['tampered payload', `${h}.${enc({ aud: [AUD], iss: `https://${TEAM}`, email: 'attacker@x.com', exp: now() + 600 })}.${s}`],
    ['signature not base64url', `${h}.${p}.***`],
    ['signature truncated', `${h}.${p}.${s.slice(0, 10)}`],
    ['header not JSON', `bm90anNvbg.${p}.${s}`],
    ['payload is an array', `${h}.${enc([1, 2])}.${s}`],
    ['two segments', `${h}.${p}`],
    ['empty segment', `${h}..${s}`],
    ['oversized', 'a'.repeat(9000)],
    ['garbage', 'not-a-jwt'],
    ['empty', ''],
    ['null', null],
  ];
  for (const [name, t] of cases) {
    assert.equal(await verifyAccessJwt(t, cfg), null, name);
  }
});

test('malformed signing keys from the certs endpoint fail closed, not with an exception', async () => {
  const saved = certs;
  for (const bad of [
    { keys: [{ kid: 'k1', kty: 'RSA', n: 'short', e: 'AQAB' }] },
    { keys: [{ kid: 'k1', kty: 'EC', n: saved.keys[0].n, e: 'AQAB' }] },
    { keys: [{ kid: 'k1', kty: 'RSA', n: saved.keys[0].n, e: 'AQAB', alg: 'RS512' }] },
    { keys: [{ kid: 'k1', kty: 'RSA', n: '!'.repeat(400), e: 'AQAB' }] },
    { nokeys: true },
  ]) {
    certs = bad as any;
    resetJwksCache();
    assert.equal(await verifyAccessJwt(await token(), cfg), null, JSON.stringify(bad).slice(0, 60));
  }
  certs = saved;
});

test('certs endpoint failure fails closed', async () => {
  const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
  const throws = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
  assert.equal(await verifyAccessJwt(await token(), cfg, down), null);
  assert.equal(await verifyAccessJwt(await token(), cfg, throws), null);
});

test('missing or malformed Access configuration accepts no identity', async () => {
  for (const c of [{}, { teamDomain: TEAM }, { aud: AUD }, { teamDomain: 'evil.com', aud: AUD }, { teamDomain: TEAM, aud: 'short' }]) {
    assert.equal(accessConfigValid(c), false);
    assert.equal(await verifyAccessJwt(await token(), c), null);
  }
});

test('signing keys are cached between requests', async () => {
  await verifyAccessJwt(await token(), cfg);
  await verifyAccessJwt(await token(), cfg);
  assert.equal(certFetches, 1);
});

// ------------------------------------------------------------ Worker

type R2 = { get: (k: string) => Promise<any> };
function env(over: Record<string, unknown> = {}) {
  return {
    DB: makeD1(),
    POSTERS: { get: async () => null } as R2,
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD,
    OWNER_EMAILS: `${OWNER}, other-owner@iddav.com`, OWNER_PIN: '4321',
    APP_URL: APP, ENQUIRY_ORIGINS: 'https://iddavwildstay.com',
    ...over,
  } as any;
}
const HOSTS = ['https://imi.iddav.com', 'https://imi-backend.ramavaddi.workers.dev', 'https://abc123.imi-backend.ramavaddi.workers.dev'];

async function call(e: any, method: string, path: string, opts: { as?: string | null; pin?: string; body?: unknown; headers?: Record<string, string>; host?: string } = {}) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.as) headers['Cf-Access-Jwt-Assertion'] = await token({ email: opts.as });
  if (opts.pin) headers['X-Owner-PIN'] = opts.pin;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`${opts.host ?? HOSTS[0]}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), e);
}

const decisionBody = {
  title: 'Test decision', problemStatement: 'p', associatedRecordCode: 'REC-0001', approvalClass: 'A', approverRequired: 'Owner',
  retrospective: 'no', optionsConsidered: [], selectedOption: 's', rationale: 'r', confidence: { level: 'low', reason: 'r' },
  approvalStatus: 'approved', approvedBy: 'Founder', approvedAt: '2020-01-01',
};
async function newDecision(e: any) {
  const res = await call(e, 'POST', '/api/decisions', { as: STAFF, body: decisionBody });
  assert.equal(res.status, 201);
  return (await res.json()) as any;
}
const events = (e: any, id: string) => e.DB.raw.prepare('SELECT * FROM decision_events WHERE decision_id = ?').all(id) as any[];

test('SEC: forged identity headers never authenticate, on any hostname', async () => {
  const e = env();
  for (const host of HOSTS) {
    const res = await call(e, 'GET', '/api/decisions', { host, headers: { 'Cf-Access-Authenticated-User-Email': OWNER, [IDENTITY_HEADER]: OWNER, 'X-API-Key': 'anything' } });
    assert.equal(res.status, 401, host);
  }
});

test('SEC: protected routes fail closed when Access configuration is missing or invalid', async () => {
  for (const over of [{ ACCESS_TEAM_DOMAIN: undefined }, { ACCESS_AUD: undefined }, { ACCESS_TEAM_DOMAIN: 'evil.com' }, { ACCESS_AUD: 'short' }]) {
    const res = await call(env(over), 'GET', '/api/decisions', { as: OWNER });
    assert.equal(res.status, 503, JSON.stringify(over));
  }
});

test('a verified person can use the app without any API key', async () => {
  const res = await call(env(), 'GET', '/api/whoami', { as: STAFF });
  assert.deepEqual(await res.json(), { email: STAFF, owner: false });
});

test('SEC: new decisions always start pending, whatever the request says', async () => {
  const d = await newDecision(env());
  assert.equal(d.approvalStatus, 'pending');
  assert.equal(d.approvedBy, undefined);
});

test('SEC: a verified person without owner permission cannot approve', async () => {
  const e = env();
  const d = await newDecision(e);
  const res = await call(e, 'PATCH', `/api/decisions/${d.id}`, { as: STAFF, pin: '4321', body: { approvalStatus: 'approved' } });
  assert.equal(res.status, 403);
  assert.equal(events(e, d.id).length, 0);
});

test('SEC: the owner PIN alone, without a verified owner identity, cannot approve', async () => {
  const e = env();
  const d = await newDecision(e);
  const res = await call(e, 'PATCH', `/api/decisions/${d.id}`, { pin: '4321', body: { approvalStatus: 'approved' }, headers: { 'Cf-Access-Authenticated-User-Email': OWNER } });
  assert.equal(res.status, 401);
});

test('SEC: an owner must still confirm with the PIN when one is set', async () => {
  const e = env();
  const d = await newDecision(e);
  assert.equal((await call(e, 'PATCH', `/api/decisions/${d.id}`, { as: OWNER, body: { approvalStatus: 'approved' } })).status, 403);
  assert.equal((await call(e, 'PATCH', `/api/decisions/${d.id}`, { as: OWNER, pin: '0000', body: { approvalStatus: 'approved' } })).status, 403);
});

test('SEC: the server records the verified approver and time; browser-supplied names and dates are ignored', async () => {
  const e = env();
  const d = await newDecision(e);
  const res = await call(e, 'PATCH', `/api/decisions/${d.id}`, { as: OWNER, pin: '4321', body: { approvalStatus: 'approved', approvedBy: 'Someone Else', approvedAt: '2020-01-01' } });
  assert.equal(res.status, 200);
  const saved = (await res.json()) as any;
  assert.equal(saved.approvedBy, OWNER);
  assert.notEqual(saved.approvedAt, '2020-01-01');
  const ev = events(e, d.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, OWNER);
  assert.equal(ev[0].from_status, 'pending');
  assert.equal(ev[0].to_status, 'approved');
});

test('SEC: repeated and concurrent approvals record exactly one change', async () => {
  const e = env();
  const d = await newDecision(e);
  const results = await Promise.all([1, 2, 3].map(() => call(e, 'PATCH', `/api/decisions/${d.id}`, { as: OWNER, pin: '4321', body: { approvalStatus: 'approved' } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(events(e, d.id).length, 1);
});

test('approval history: approve, revert to pending, approve again gives three events in order', async () => {
  const e = env();
  const d = await newDecision(e);
  for (const s of ['approved', 'pending', 'approved']) {
    assert.equal((await call(e, 'PATCH', `/api/decisions/${d.id}`, { as: OWNER, pin: '4321', body: { approvalStatus: s } })).status, 200);
  }
  assert.deepEqual(events(e, d.id).map((x: any) => x.to_status), ['approved', 'pending', 'approved']);
  const hist = (await (await call(e, 'GET', `/api/decisions/${d.id}/events`, { as: STAFF })).json()) as any[];
  assert.equal(hist.length, 3);
});

test('SEC: approving a decision that does not exist returns 404 and writes nothing', async () => {
  const e = env();
  const res = await call(e, 'PATCH', '/api/decisions/dec-missing', { as: OWNER, pin: '4321', body: { approvalStatus: 'approved' } });
  assert.equal(res.status, 404);
  assert.equal(e.DB.raw.prepare('SELECT COUNT(*) n FROM decision_events').get().n, 0);
});

test('an unknown approval status is rejected', async () => {
  const e = env();
  const d = await newDecision(e);
  assert.equal((await call(e, 'PATCH', `/api/decisions/${d.id}`, { as: OWNER, pin: '4321', body: { approvalStatus: 'whatever' } })).status, 400);
});

test('SEC: decision_events is append-only at the database level', async () => {
  const e = env();
  const d = await newDecision(e);
  await call(e, 'PATCH', `/api/decisions/${d.id}`, { as: OWNER, pin: '4321', body: { approvalStatus: 'approved' } });
  assert.throws(() => e.DB.raw.exec("UPDATE decision_events SET actor = 'x'"), /append-only/);
  assert.throws(() => e.DB.raw.exec('DELETE FROM decision_events'), /append-only/);
});

test('SEC: content approval, publishing and channel connection need a verified owner', async () => {
  const e = env();
  for (const [m, p] of [['POST', '/api/contents/c1/approve'], ['POST', '/api/contents/c1/publish'], ['POST', '/api/connections/linkedin/oauth-start'], ['POST', '/api/campaigns/x/outcome']] as const) {
    const res = await call(e, m, p, { as: STAFF, pin: '4321', body: { dryRun: false } });
    assert.equal(res.status, 403, p);
  }
});

test('public route boundaries are exact (method and path)', () => {
  assert.equal(classify('GET', '/media/posters/0b2f8c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.jpg'), 'public-media');
  assert.equal(classify('HEAD', '/media/videos/0b2f8c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.mp4'), 'public-media');
  assert.equal(classify('POST', '/public/enquiry'), 'public-enquiry');
  assert.equal(classify('OPTIONS', '/public/enquiry'), 'public-enquiry');
  for (const [m, p] of [
    ['POST', '/media/posters/0b2f8c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.jpg'],
    ['GET', '/media/../api/decisions'],
    ['GET', '/media/secrets/0b2f8c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.jpg'],
    ['GET', '/media/posters/anything.jpg'],
    ['GET', '/mediafake/posters/x.jpg'],
    ['GET', '/public/enquiry'],
    ['POST', '/public/enquiry/extra'],
    ['POST', '/public/other'],
    ['GET', '/oauth/google/callback'],
    ['GET', '/api/decisions'],
  ]) assert.equal(classify(m, p), 'protected', `${m} ${p}`);
});

test('public routes work without sign-in; near-misses do not', async () => {
  const e = env();
  const media = await call(e, 'GET', '/media/posters/0b2f8c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.jpg');
  assert.equal(media.status, 404); // reached the media handler; no such file
  assert.equal(media.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await call(e, 'GET', '/public/enquiry')).status, 401);
  assert.equal((await call(e, 'GET', '/oauth/google/callback?state=x&code=y')).status, 401);
});

test('CORS: the app origin gets credentialed access; other origins get none', async () => {
  const e = env();
  const ok = await call(e, 'GET', '/api/whoami', { as: STAFF, headers: { Origin: APP } });
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), APP);
  assert.equal(ok.headers.get('Access-Control-Allow-Credentials'), 'true');
  const bad = await call(e, 'GET', '/api/whoami', { as: STAFF, headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(ok.headers.get('X-Frame-Options'), 'DENY');
});

test('CORS: the enquiry form allows only listed brand websites', async () => {
  const e = env();
  const pre = await call(e, 'OPTIONS', '/public/enquiry', { headers: { Origin: 'https://iddavwildstay.com' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://iddavwildstay.com');
  assert.equal(pre.headers.get('Access-Control-Allow-Credentials'), null);
  const other = await call(e, 'OPTIONS', '/public/enquiry', { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
});

test('OAuth: the callback must come from the verified owner who started it', async () => {
  const e = env({ LINKEDIN_CLIENT_ID: 'id', LINKEDIN_CLIENT_SECRET: 'secret' });
  const start = await call(e, 'POST', '/api/connections/linkedin/oauth-start', { as: OWNER, pin: '4321', body: {} });
  assert.equal(start.status, 200);
  const state = new URL(((await start.json()) as any).url).searchParams.get('state');
  const stored = e.DB.raw.prepare('SELECT settings_json FROM oauth_states WHERE state = ?').get(state);
  assert.equal(JSON.parse(stored.settings_json).initiatedBy, OWNER);
  // Someone else (even another owner) arriving with the state is refused.
  const hijack = await call(e, 'GET', `/oauth/linkedin/callback?state=${state}&code=abc`, { as: 'other-owner@iddav.com' });
  assert.match(await hijack.text(), /different signed-in person/);
});

test('OAuth: the same owner passes the binding check (then reaches the provider)', async () => {
  const e = env({ LINKEDIN_CLIENT_ID: 'id', LINKEDIN_CLIENT_SECRET: 'secret' });
  const start = await call(e, 'POST', '/api/connections/linkedin/oauth-start', { as: OWNER, pin: '4321', body: {} });
  const state = new URL(((await start.json()) as any).url).searchParams.get('state');
  const res = await call(e, 'GET', `/oauth/linkedin/callback?state=${state}&code=abc`, { as: OWNER });
  const text = await res.text();
  assert.doesNotMatch(text, /different signed-in person/);
});

test('local development identity works only on localhost', async () => {
  const dev = { ENVIRONMENT: 'development', DEV_IDENTITY: OWNER, ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined };
  const local = await call(env(dev), 'GET', '/api/whoami', { host: 'http://localhost:8787' });
  assert.deepEqual(await local.json(), { email: OWNER, owner: true });
  for (const host of HOSTS) {
    assert.equal((await call(env(dev), 'GET', '/api/whoami', { host })).status, 503, host);
  }
});

test('CRM outcomes bridge still works for a signed-in user, and the CRM stays the source of truth', async () => {
  const e = env({ CRM_URL: 'https://crm.example', CRM_SERVICE_KEY: 'key-123' });
  e.DB.raw.prepare(`INSERT INTO campaigns (id, code, name, objective, primary_metric, audience_json, cta_type, destination_url, expected_outcome, outcome_window_days, status, created_by, created_at)
    VALUES ('c1', 'CMP-0003', 'Test', 'awareness', 'enquiries', '[]', 'whatsapp', 'https://wa.me/1', 'x', 14, 'active', 'test', '2026-11-01 00:00:00')`).run();
  let seen: { url: string; key: string | null; jwt: string | null } | null = null;
  outbound = async (url, init) => {
    const h = new Headers(init?.headers);
    seen = { url, key: h.get('x-intake-key'), jwt: h.get('Cf-Access-Jwt-Assertion') };
    return new Response(JSON.stringify({ imi_campaigns: [{ code: 'CMP-0003', enquiries: 5, tracked: 5, qualified: 3, quoted: 2, booked: 1, lost: 2, room_nights: 2,
      booked_value: 16798, revenue_paid: 16798, contribution: 9998, contribution_known: true, top_loss_reason: 'price', median_first_reply_hours: null, by_tag: {}, by_post: {} }] }));
  };
  const res = await call(e, 'GET', '/api/campaigns/c1/funnel', { as: STAFF });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.source, 'crm');
  assert.equal(body.totals.enquiries, 5);
  assert.ok(seen!.url.startsWith('https://crm.example/integrations/imi/outcomes?campaign=CMP-0003'));
  assert.equal(seen!.key, 'key-123');
  assert.equal(seen!.jwt, null); // the user's sign-in token is never forwarded to the CRM
});
