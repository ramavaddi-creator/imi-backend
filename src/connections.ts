// One place for every outside account IMI talks to. Each platform declares how
// it connects (sign-in button or a short form), what it can do, its setup
// steps and its manual fallback (TFR-REU-008). Secrets are encrypted in D1 and
// never returned to the browser. This is the connector registry required by
// CIL-FR-018 / CILA-FR-192: status, expiry, last check and last error.

import type { Env } from './env';
import { HttpError, json, now, errMsg, requireOwner } from './http';
import { encryptJson, decryptJson } from './crypto';

export type ConnectionId =
  | 'meta' | 'threads' | 'linkedin' | 'google' | 'telegram' | 'whatsapp' | 'claude' | 'chatgpt';

interface Field {
  key: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
}

interface PlatformDef {
  id: ConnectionId;
  name: string;
  group: 'social' | 'messaging' | 'ai';
  channels: string[]; // publication channels this connection powers
  method: 'oauth' | 'form';
  effort: string; // honest one-liner on what setup takes
  needsAppEnv?: string[]; // Worker secrets for the developer app (OAuth only)
  fields: Field[]; // form fields, or optional pre-sign-in settings for OAuth
  steps: string[];
  limits: string[];
  manualFallback: string;
}

export const PLATFORMS: PlatformDef[] = [
  {
    id: 'meta', name: 'Facebook + Instagram', group: 'social', channels: ['facebook', 'instagram'], method: 'form',
    effort: 'About 15 minutes, once. No Meta review needed for your own Page.',
    fields: [
      { key: 'token', label: 'System User access token', secret: true, help: 'Business Settings → System users → Generate token (expiry: Never).' },
      { key: 'pageId', label: 'Facebook Page ID', optional: true, help: 'Leave empty: IMI will list your Pages to pick from.' },
    ],
    steps: [
      'Make Instagram a Professional account and link it to the Iddav WildStay Facebook Page.',
      'developers.facebook.com → Create app → type Business → attach to the Iddav business portfolio.',
      'business.facebook.com → Settings → System users → Add (Admin) → Assign assets: the Page (full control) and the Instagram account.',
      'Generate token → choose the app → expiry Never → tick instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement, pages_manage_posts, business_management.',
      'Paste the token here and press Connect.',
    ],
    limits: ['Instagram captions cannot carry clickable links.', 'Accounts under 100 followers get limited insights.'],
    manualFallback: 'Download the poster and post from the Meta Business Suite app; then record the post link in IMI.',
  },
  {
    id: 'threads', name: 'Threads', group: 'social', channels: ['threads'], method: 'oauth',
    effort: 'About 10 minutes, once, then a Sign in button.',
    needsAppEnv: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
    fields: [],
    steps: [
      'In the same Meta app, add the "Access the Threads API" use case.',
      'Add permissions threads_basic and threads_content_publish.',
      'Under Threads settings, add the Redirect URI shown below.',
      'Add your Threads account as a Threads Tester and accept the invite in the Threads app (Settings → Account → Website permissions).',
      'Put the Threads App ID and App Secret on the Worker, then press Sign in with Threads.',
    ],
    limits: ['Sign-in lasts 60 days; IMI renews it automatically while it is used.'],
    manualFallback: 'Download the poster and post from the Threads app; then record the post link.',
  },
  {
    id: 'linkedin', name: 'LinkedIn', group: 'social', channels: ['linkedin'], method: 'oauth',
    effort: '10 minutes for your profile. Company Page needs LinkedIn approval (weeks).',
    needsAppEnv: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    fields: [
      { key: 'organizationId', label: 'Company Page ID (only if approved)', optional: true, help: 'Leave empty to post as yourself. Needs the Community Management API to post as the Page.' },
    ],
    steps: [
      'linkedin.com/developers → Create app (link it to the Iddav WildStay Page).',
      'Products tab → add "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn".',
      'Auth tab → add the Redirect URI shown below.',
      'Optional, for posting as the Company Page: request the Community Management API (LinkedIn reviews it).',
      'Put the Client ID and Secret on the Worker, then press Sign in with LinkedIn.',
    ],
    limits: ['Sign-in lasts 60 days; IMI shows the reconnect date.', 'Founder posts and Iddav Page posts are tracked as separate identities.'],
    manualFallback: 'Download the poster and post on LinkedIn; then record the post link.',
  },
  {
    id: 'google', name: 'Google Business Profile + YouTube', group: 'social', channels: ['google_business', 'youtube'], method: 'oauth',
    effort: '15 minutes once. Business Profile needs Google API approval (days–weeks).',
    needsAppEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    fields: [],
    steps: [
      'console.cloud.google.com → your project → enable "YouTube Data API v3" (and the Business Profile APIs once approved).',
      'Apply for Business Profile API access (form "Application for Basic API Access").',
      'OAuth consent screen → External → Publishing status: In production.',
      'Credentials → OAuth client ID → Web application → add the Redirect URI shown below.',
      'Put the Client ID and Secret on the Worker, then press Sign in with Google using the account that owns the listing and channel.',
    ],
    limits: [
      'YouTube needs a video; posters alone cannot be posted there.',
      'Until Google audits your project, YouTube uploads stay Private (you can make them public in YouTube Studio).',
    ],
    manualFallback: 'Post the update from Google Business Profile on your phone, upload video in YouTube Studio; then record links.',
  },
  {
    id: 'telegram', name: 'Telegram channel', group: 'messaging', channels: ['telegram'], method: 'form',
    effort: 'About 3 minutes. The easiest of all.',
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true, help: 'From @BotFather → /newbot.' },
      { key: 'chatId', label: 'Channel username or ID', placeholder: '@iddavwildstay' },
    ],
    steps: [
      'In Telegram, message @BotFather → /newbot → copy the token.',
      'Open your channel → Administrators → add the bot with "Post messages".',
      'Paste the token and channel username here and press Connect.',
    ],
    limits: [],
    manualFallback: 'Share the downloaded poster to the channel from your phone.',
  },
  {
    id: 'whatsapp', name: 'WhatsApp Business', group: 'messaging', channels: ['whatsapp'], method: 'form',
    effort: '30–60 minutes once, plus Meta approving one message template.',
    fields: [
      { key: 'token', label: 'Permanent access token', secret: true, help: 'A System User token with whatsapp_business_messaging.' },
      { key: 'phoneNumberId', label: 'Phone number ID', help: 'WhatsApp Manager → API setup.' },
      { key: 'templateName', label: 'Approved template name', placeholder: 'iddav_update', help: 'Marketing template with an IMAGE header and one body variable {{1}}.' },
      { key: 'templateLanguage', label: 'Template language code', placeholder: 'en' },
      { key: 'testRecipient', label: 'Your own number for tests', secret: true, placeholder: '9198xxxxxxxx' },
      { key: 'recipients', label: 'Opted-in recipients (comma separated)', secret: true, optional: true, help: 'Only people who agreed to receive Iddav updates. Each message is charged by Meta.' },
    ],
    steps: [
      'business.facebook.com → WhatsApp accounts → add a phone number that is not on the WhatsApp app.',
      'Create a Marketing template with an Image header and body containing {{1}}; wait for approval.',
      'Give your System User the WhatsApp account asset and generate a token with whatsapp_business_messaging.',
      'Fill in the form and press Connect.',
    ],
    limits: [
      'There is no API for WhatsApp Status or Channels; IMI gives you a share link for those.',
      'Only message people who opted in; marketing messages are charged per message.',
    ],
    manualFallback: 'Use the Share to WhatsApp link to post to Status or a Channel from your phone.',
  },
  {
    id: 'claude', name: 'Claude', group: 'ai', channels: [], method: 'form',
    effort: '2 minutes.',
    fields: [{ key: 'apiKey', label: 'Anthropic API key', secret: true, help: 'console.anthropic.com → API keys.' }],
    steps: ['console.anthropic.com → API keys → Create key.', 'Paste it here and press Connect.'],
    limits: ['Writes copy only; Claude does not make images.'],
    manualFallback: 'Draft in claude.ai and paste the text into IMI.',
  },
  {
    id: 'chatgpt', name: 'ChatGPT (OpenAI)', group: 'ai', channels: [], method: 'form',
    effort: '2 minutes.',
    fields: [{ key: 'apiKey', label: 'OpenAI API key', secret: true, help: 'platform.openai.com → API keys.' }],
    steps: ['platform.openai.com → API keys → Create key.', 'Paste it here and press Connect.'],
    limits: ['Image generation may need your OpenAI organisation verified.'],
    manualFallback: 'Draft in chatgpt.com and paste the text into IMI.',
  },
];

export const CHANNEL_TO_CONNECTION: Record<string, ConnectionId> = {
  facebook: 'meta', instagram: 'meta', threads: 'threads', linkedin: 'linkedin',
  google_business: 'google', youtube: 'google', telegram: 'telegram', whatsapp: 'whatsapp',
};

const def = (id: string) => {
  const d = PLATFORMS.find((p) => p.id === id);
  if (!d) throw new HttpError(404, 'Unknown connection.');
  return d;
};

// ---------------------------------------------------------------- Store

export interface Conn {
  settings: Record<string, string>;
  secrets: Record<string, string>;
  accountLabel?: string;
  expiresAt?: string;
}

export async function getConn(env: Env, id: ConnectionId): Promise<Conn | null> {
  const row = await env.DB.prepare('SELECT * FROM connections WHERE platform = ?').bind(id).first<any>();
  if (!row) return null;
  return {
    settings: JSON.parse(row.settings_json || '{}'),
    secrets: row.secret_enc ? await decryptJson(env.CONNECTIONS_KEY, row.secret_enc) : {},
    accountLabel: row.account_label || undefined,
    expiresAt: row.expires_at || undefined,
  };
}

export async function requireConn(env: Env, id: ConnectionId): Promise<Conn> {
  const c = await getConn(env, id);
  if (!c) throw new Error(`${def(id).name} is not connected. Open Connections to set it up.`);
  return c;
}

export async function saveConn(env: Env, id: ConnectionId, c: Conn) {
  const enc = await encryptJson(env.CONNECTIONS_KEY, c.secrets);
  await env.DB.prepare(
    `INSERT INTO connections (platform, settings_json, secret_enc, account_label, expires_at, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform) DO UPDATE SET settings_json = excluded.settings_json, secret_enc = excluded.secret_enc,
       account_label = excluded.account_label, expires_at = excluded.expires_at, updated_at = excluded.updated_at`
  ).bind(id, JSON.stringify(c.settings), enc, c.accountLabel ?? null, c.expiresAt ?? null, now(), now()).run();
}

async function recordCheck(env: Env, id: ConnectionId, ok: boolean, message: string) {
  await env.DB.prepare('UPDATE connections SET last_checked_at = ?, last_ok = ?, last_message = ? WHERE platform = ?')
    .bind(now(), ok ? 1 : 0, message, id).run();
}

// ---------------------------------------------------------------- Small HTTP helpers

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, init);
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const m = data.error?.message || data.error_description || data.message || (typeof data.error === 'string' ? data.error : '') || `HTTP ${res.status}`;
    throw new Error(m);
  }
  return data;
}

export const META_GRAPH = 'https://graph.facebook.com/v25.0';
export const THREADS_GRAPH = 'https://graph.threads.net';
export const LINKEDIN_VERSION = '202610';

export async function googleAccessToken(env: Env, c: Conn): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on the Worker.');
  const d = await getJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: c.secrets.refreshToken, grant_type: 'refresh_token',
    }),
  });
  return d.access_token;
}

export async function threadsToken(env: Env, c: Conn): Promise<string> {
  // Renew the 60-day token when fewer than 15 days remain.
  const exp = c.expiresAt ? Date.parse(c.expiresAt.replace(' ', 'T') + 'Z') : 0;
  if (exp && exp - Date.now() < 15 * 86400_000) {
    try {
      const d = await getJson(`${THREADS_GRAPH}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(c.secrets.accessToken)}`);
      c.secrets.accessToken = d.access_token;
      c.expiresAt = new Date(Date.now() + d.expires_in * 1000).toISOString().replace('T', ' ').slice(0, 19);
      await saveConn(env, 'threads', c);
    } catch { /* keep using the current token until it expires */ }
  }
  return c.secrets.accessToken;
}

// ---------------------------------------------------------------- Health checks

interface Health {
  ok: boolean;
  message: string;
  options?: { label: string; settings: Record<string, string> }[]; // things to pick from
}

async function checkHealth(env: Env, id: ConnectionId, c: Conn): Promise<Health> {
  switch (id) {
    case 'meta': {
      const t = c.secrets.token;
      const accounts = await getJson(`${META_GRAPH}/me/accounts?fields=id,name,instagram_business_account{id,username}&limit=50&access_token=${t}`);
      const options = (accounts.data || []).map((p: any) => ({
        label: `${p.name}${p.instagram_business_account ? ` · Instagram @${p.instagram_business_account.username}` : ' · no Instagram linked'}`,
        settings: { pageId: p.id },
      }));
      if (!c.settings.pageId) return { ok: false, message: 'Token works. Pick the Iddav WildStay Page below.', options };
      const page = await getJson(`${META_GRAPH}/${c.settings.pageId}?fields=name,access_token,instagram_business_account{username}&access_token=${t}`);
      if (!page.access_token) return { ok: false, message: 'Assign this Page to the System User with full control.', options };
      const ig = page.instagram_business_account?.username;
      return { ok: true, message: `Posting to "${page.name}"${ig ? ` and Instagram @${ig}` : ' (no Instagram linked)'}.` };
    }
    case 'threads': {
      const t = await threadsToken(env, c);
      const me = await getJson(`${THREADS_GRAPH}/v1.0/me?fields=id,username&access_token=${t}`);
      return { ok: true, message: `Posting as @${me.username}.${c.expiresAt ? ` Sign-in valid until ${c.expiresAt.slice(0, 10)}.` : ''}` };
    }
    case 'linkedin': {
      const me = await getJson('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${c.secrets.accessToken}` } });
      const as = c.settings.organizationId ? `Company Page ${c.settings.organizationId}` : `${me.name} (personal profile)`;
      return { ok: true, message: `Posting as ${as}.${c.expiresAt ? ` Reconnect by ${c.expiresAt.slice(0, 10)}.` : ''}` };
    }
    case 'google': {
      const token = await googleAccessToken(env, c);
      const parts: string[] = [];
      let options: Health['options'];
      try {
        const yt = await getJson('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${token}` } });
        parts.push(yt.items?.[0] ? `YouTube: ${yt.items[0].snippet.title}` : 'YouTube: no channel on this account');
      } catch (e) { parts.push(`YouTube: ${errMsg(e)}`); }
      try {
        const accs = await getJson('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { headers: { Authorization: `Bearer ${token}` } });
        options = [];
        for (const a of (accs.accounts || []).slice(0, 5)) {
          const locs = await getJson(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title&pageSize=20`, { headers: { Authorization: `Bearer ${token}` } });
          for (const l of locs.locations || []) {
            options.push({ label: l.title, settings: { gbpAccountId: String(a.name).split('/')[1], gbpLocationId: String(l.name).split('/')[1] } });
          }
        }
        const sel = options.find((o) => o.settings.gbpLocationId === c.settings.gbpLocationId);
        parts.push(sel ? `Business Profile: ${sel.label}` : 'Business Profile: pick your listing below');
      } catch (e) {
        const m = errMsg(e);
        parts.push(/quota|429|has not been used|disabled/i.test(m)
          ? 'Business Profile: waiting for Google to approve API access'
          : `Business Profile: ${m}`);
      }
      return { ok: true, message: parts.join(' · '), options };
    }
    case 'telegram': {
      const base = `https://api.telegram.org/bot${c.secrets.botToken}`;
      const me = await getJson(`${base}/getMe`);
      const chat = await getJson(`${base}/getChat?chat_id=${encodeURIComponent(c.settings.chatId)}`);
      const member = await getJson(`${base}/getChatMember?chat_id=${encodeURIComponent(c.settings.chatId)}&user_id=${me.result.id}`);
      const canPost = member.result.status === 'creator' || member.result.can_post_messages;
      return canPost
        ? { ok: true, message: `@${me.result.username} can post to "${chat.result.title}".` }
        : { ok: false, message: `@${me.result.username} is in "${chat.result.title}" but is not allowed to post. Make it an admin with "Post messages".` };
    }
    case 'whatsapp': {
      const p = await getJson(`${META_GRAPH}/${c.settings.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating&access_token=${c.secrets.token}`);
      const n = (c.secrets.recipients || '').split(',').filter((x) => x.trim()).length;
      return { ok: true, message: `Sending from ${p.verified_name} (${p.display_phone_number}) with template "${c.settings.templateName}". ${n} opted-in recipient(s).` };
    }
    case 'claude': {
      await getJson('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': c.secrets.apiKey, 'anthropic-version': '2023-06-01' } });
      return { ok: true, message: `Ready. Copy model: ${env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'}.` };
    }
    case 'chatgpt': {
      const h = { Authorization: `Bearer ${c.secrets.apiKey}` };
      const tm = env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';
      const im = env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
      const [t, i] = await Promise.all([
        fetch(`https://api.openai.com/v1/models/${tm}`, { headers: h }),
        fetch(`https://api.openai.com/v1/models/${im}`, { headers: h }),
      ]);
      if (t.status === 401) throw new Error('OpenAI rejected the API key.');
      if (!t.ok || !i.ok) return { ok: false, message: `Key works, but this account cannot use ${!t.ok ? tm : ''}${!t.ok && !i.ok ? ' and ' : ''}${!i.ok ? im : ''}.` };
      return { ok: true, message: `Ready. Copy: ${tm}. Images: ${im}.` };
    }
  }
}

// ---------------------------------------------------------------- OAuth

function redirectUri(origin: string, id: string) {
  return `${origin}/oauth/${id}/callback`;
}

function authorizeUrl(env: Env, id: ConnectionId, origin: string, state: string, settings: Record<string, string>): string {
  const ru = encodeURIComponent(redirectUri(origin, id));
  if (id === 'google') {
    if (!env.GOOGLE_CLIENT_ID) throw new HttpError(400, 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the Worker first.');
    const scope = encodeURIComponent('https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly');
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=${ru}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&include_granted_scopes=true&state=${state}`;
  }
  if (id === 'linkedin') {
    if (!env.LINKEDIN_CLIENT_ID) throw new HttpError(400, 'Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET on the Worker first.');
    const scopes = ['openid', 'profile', 'w_member_social'];
    if (settings.organizationId) scopes.push('w_organization_social');
    return `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${env.LINKEDIN_CLIENT_ID}&redirect_uri=${ru}&state=${state}&scope=${encodeURIComponent(scopes.join(' '))}`;
  }
  if (id === 'threads') {
    if (!env.THREADS_APP_ID) throw new HttpError(400, 'Set THREADS_APP_ID and THREADS_APP_SECRET on the Worker first.');
    return `https://threads.net/oauth/authorize?client_id=${env.THREADS_APP_ID}&redirect_uri=${ru}&scope=threads_basic,threads_content_publish&response_type=code&state=${state}`;
  }
  throw new HttpError(400, 'This connection does not use sign-in.');
}

async function finishOAuth(env: Env, id: ConnectionId, origin: string, code: string, settings: Record<string, string>): Promise<Conn> {
  const ru = redirectUri(origin, id);
  const plusSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString().replace('T', ' ').slice(0, 19);
  if (id === 'google') {
    const d = await getJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: ru, grant_type: 'authorization_code' }),
    });
    if (!d.refresh_token) throw new Error('Google did not return a long-lived token. Remove IMI from your Google account permissions and sign in again.');
    return { settings, secrets: { refreshToken: d.refresh_token }, accountLabel: 'Google account' };
  }
  if (id === 'linkedin') {
    const d = await getJson('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: ru, client_id: env.LINKEDIN_CLIENT_ID!, client_secret: env.LINKEDIN_CLIENT_SECRET! }),
    });
    const me = await getJson('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${d.access_token}` } });
    return {
      settings: { ...settings, memberId: me.sub },
      secrets: { accessToken: d.access_token, ...(d.refresh_token ? { refreshToken: d.refresh_token } : {}) },
      accountLabel: me.name, expiresAt: plusSeconds(d.expires_in || 5184000),
    };
  }
  if (id === 'threads') {
    const short = await getJson(`${THREADS_GRAPH}/oauth/access_token`, {
      method: 'POST',
      body: new URLSearchParams({ client_id: env.THREADS_APP_ID!, client_secret: env.THREADS_APP_SECRET!, grant_type: 'authorization_code', redirect_uri: ru, code }),
    });
    const long = await getJson(`${THREADS_GRAPH}/access_token?grant_type=th_exchange_token&client_secret=${env.THREADS_APP_SECRET}&access_token=${short.access_token}`);
    const me = await getJson(`${THREADS_GRAPH}/v1.0/me?fields=id,username&access_token=${long.access_token}`);
    return { settings: { ...settings, userId: String(me.id) }, secrets: { accessToken: long.access_token }, accountLabel: `@${me.username}`, expiresAt: plusSeconds(long.expires_in) };
  }
  throw new Error('Unsupported sign-in.');
}

function callbackPage(env: Env, ok: boolean, message: string): Response {
  const back = env.APP_URL ? `<p><a href="${env.APP_URL}">Back to IMI</a></p>` : '';
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>IMI</title>
<body style="font-family:system-ui;background:#080F08;color:#F0E8CC;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:420px;padding:24px;text-align:center"><h2 style="color:${ok ? '#C9A84C' : '#e88'}">${ok ? 'Connected' : 'Not connected'}</h2>
<p>${message.replace(/</g, '&lt;')}</p><p>You can close this tab and press Refresh in IMI.</p>${back}</div>
<script>try{window.opener&&window.opener.postMessage('imi-connected','*')}catch(e){}</script></body>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Public: the platform redirects the browser here. Protected by the one-time state.
export async function handleOAuthCallback(request: Request, env: Env, url: URL): Promise<Response | null> {
  const m = url.pathname.match(/^\/oauth\/(google|linkedin|threads)\/callback$/);
  if (!m) return null;
  const id = m[1] as ConnectionId;
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code');
  const st = await env.DB.prepare('SELECT * FROM oauth_states WHERE state = ? AND platform = ?').bind(state, id).first<any>();
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ? OR created_at < ?')
    .bind(state, new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').slice(0, 19)).run();
  if (!st || Date.now() - Date.parse(st.created_at.replace(' ', 'T') + 'Z') > 15 * 60_000) {
    return callbackPage(env, false, 'This sign-in link expired. Start again from IMI → Connections.');
  }
  if (!code) return callbackPage(env, false, url.searchParams.get('error_description') || 'Sign-in was cancelled.');
  try {
    const conn = await finishOAuth(env, id, url.origin, code, JSON.parse(st.settings_json || '{}'));
    await saveConn(env, id, conn);
    return callbackPage(env, true, `${def(id).name} is connected${conn.accountLabel ? ` as ${conn.accountLabel}` : ''}.`);
  } catch (e) {
    return callbackPage(env, false, errMsg(e));
  }
}

// ---------------------------------------------------------------- Routes

export async function handleConnectionRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && path === '/api/connections') {
    const { results } = await env.DB.prepare('SELECT platform, settings_json, account_label, expires_at, connected_at, last_checked_at, last_ok, last_message FROM connections').all<any>();
    const rows = new Map((results || []).map((r) => [r.platform, r]));
    return json({
      ownerPinSet: Boolean(env.OWNER_PIN),
      encryptionReady: Boolean(env.CONNECTIONS_KEY),
      platforms: PLATFORMS.map((p) => {
        const r = rows.get(p.id);
        return {
          ...p,
          redirectUri: p.method === 'oauth' ? redirectUri(url.origin, p.id) : undefined,
          appConfigured: p.needsAppEnv ? p.needsAppEnv.every((k) => Boolean((env as any)[k])) : true,
          connected: Boolean(r),
          settings: r ? JSON.parse(r.settings_json || '{}') : {},
          accountLabel: r?.account_label || null,
          expiresAt: r?.expires_at || null,
          lastCheckedAt: r?.last_checked_at || null,
          lastOk: r ? r.last_ok === 1 : null,
          lastMessage: r?.last_message || null,
        };
      }),
    });
  }

  const m = path.match(/^\/api\/connections\/([a-z]+)(?:\/(check|oauth-start|settings))?$/);
  if (!m) return null;
  const id = m[1] as ConnectionId;
  const action = m[2];
  const d = def(id);

  if (method === 'POST' && action === 'check') {
    const c = await getConn(env, id);
    if (!c) return json({ ok: false, message: 'Not connected yet.' });
    try {
      const h = await checkHealth(env, id, c);
      await recordCheck(env, id, h.ok, h.message);
      return json(h);
    } catch (e) {
      const msg = errMsg(e);
      await recordCheck(env, id, false, msg);
      return json({ ok: false, message: msg });
    }
  }

  requireOwner(request, env.OWNER_PIN);

  if (method === 'POST' && action === 'oauth-start') {
    const b = await request.json<any>().catch(() => ({}));
    const settings: Record<string, string> = {};
    for (const f of d.fields) if (typeof b[f.key] === 'string' && b[f.key].trim()) settings[f.key] = b[f.key].trim();
    const state = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO oauth_states (state, platform, settings_json, created_at) VALUES (?, ?, ?, ?)')
      .bind(state, id, JSON.stringify(settings), now()).run();
    return json({ url: authorizeUrl(env, id, url.origin, state, settings) });
  }

  if (method === 'POST' && !action) {
    if (d.method !== 'form') throw new HttpError(400, `${d.name} connects with the Sign in button.`);
    const b = await request.json<any>();
    const existing = await getConn(env, id);
    const settings: Record<string, string> = { ...(existing?.settings || {}) };
    const secrets: Record<string, string> = { ...(existing?.secrets || {}) };
    for (const f of d.fields) {
      const v = typeof b[f.key] === 'string' ? b[f.key].trim() : '';
      if (!v) {
        if (!f.optional && !(f.secret ? secrets[f.key] : settings[f.key])) throw new HttpError(400, `${f.label} is required.`);
        continue;
      }
      if (f.secret) secrets[f.key] = v; else settings[f.key] = v;
    }
    const conn: Conn = { settings, secrets };
    let health: Health;
    try {
      health = await checkHealth(env, id, conn);
    } catch (e) {
      throw new HttpError(400, `Could not connect: ${errMsg(e)}`);
    }
    await saveConn(env, id, conn);
    await recordCheck(env, id, health.ok, health.message);
    return json(health);
  }

  if (method === 'PATCH' && action === 'settings') {
    const c = await requireConn(env, id);
    const b = await request.json<any>();
    const allowed = ['pageId', 'gbpAccountId', 'gbpLocationId', 'organizationId', 'chatId', 'templateName', 'templateLanguage'];
    for (const k of allowed) if (typeof b[k] === 'string') c.settings[k] = b[k].trim();
    await saveConn(env, id, c);
    const h = await checkHealth(env, id, c).catch((e) => ({ ok: false, message: errMsg(e) }));
    await recordCheck(env, id, h.ok, h.message);
    return json(h);
  }

  if (method === 'DELETE' && !action) {
    await env.DB.prepare('DELETE FROM connections WHERE platform = ?').bind(id).run();
    return json({ ok: true });
  }

  return null;
}
