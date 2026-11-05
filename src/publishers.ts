// One function per channel. Every channel has a test mode that proves the
// connection, permissions and media all work without anything going public.
// Where a platform has no private test, the test says exactly what it checked.

import type { Env } from './env';
import { sleep } from './http';
import {
  requireConn, googleAccessToken, threadsToken, META_GRAPH, THREADS_GRAPH, LINKEDIN_VERSION,
} from './connections';

export type Channel =
  | 'instagram' | 'facebook' | 'threads' | 'linkedin' | 'google_business' | 'youtube' | 'telegram' | 'whatsapp'
  | 'whatsapp_status' | 'website' | 'google_ads';

export const CHANNELS: Channel[] = [
  'instagram', 'facebook', 'threads', 'linkedin', 'google_business', 'youtube', 'telegram', 'whatsapp',
  'whatsapp_status', 'website', 'google_ads',
];

// No posting API exists (WhatsApp Status), or IMI deliberately does not post
// (website stays Phase 4 per spec; ads are bought in the ad manager).
export const COPY_ONLY = new Set<Channel>(['whatsapp_status', 'website', 'google_ads']);
export const VIDEO_CAPABLE = new Set<Channel>(['instagram', 'facebook', 'threads', 'telegram', 'youtube']);

export interface PublishInput {
  dryRun: boolean;
  imageUrl: string;
  imageKey: string;
  videoKey?: string;
  videoUrl?: string;
  postVideo?: boolean; // post the attached video instead of the poster
  caption: string;
  link: string; // tracked destination URL
  title: string; // headline, used where a title field exists
  ctaType: string;
}

export interface PublishResult {
  ok: boolean;
  dryRun: boolean;
  externalId?: string;
  permalink?: string;
  message: string;
}

async function call(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, init);
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const m = data.error?.message || data.message || data.description || (typeof data.error === 'string' ? data.error : '') || `HTTP ${res.status}`;
    throw new Error(m);
  }
  return data;
}

const form = (params: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(params) });

async function metaPage(env: Env) {
  const c = await requireConn(env, 'meta');
  if (!c.settings.pageId) throw new Error('Pick your Facebook Page in Connections first.');
  const page = await call(`${META_GRAPH}/${c.settings.pageId}?fields=id,access_token,instagram_business_account{id}&access_token=${c.secrets.token}`);
  return { pageId: page.id as string, token: page.access_token as string, igId: page.instagram_business_account?.id as string | undefined };
}

async function instagram(env: Env, i: PublishInput): Promise<PublishResult> {
  const m = await metaPage(env);
  if (!m.igId) throw new Error('No Instagram professional account is linked to the Facebook Page.');
  const video = i.postVideo && i.videoUrl;
  const container = await call(`${META_GRAPH}/${m.igId}/media`, form(video
    ? { media_type: 'REELS', video_url: i.videoUrl!, caption: i.caption, share_to_feed: 'true', access_token: m.token }
    : { image_url: i.imageUrl, caption: i.caption, access_token: m.token }));
  let status = '';
  const tries = video ? 50 : 12;
  for (let n = 0; n < tries && status !== 'FINISHED'; n++) {
    const s = await call(`${META_GRAPH}/${container.id}?fields=status_code,status&access_token=${m.token}`);
    status = s.status_code;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram rejected the ${video ? 'video' : 'image'}: ${s.status || status}`);
    if (status !== 'FINISHED') await sleep(video ? 3000 : 1500);
  }
  if (status !== 'FINISHED') throw new Error(`Instagram is still processing the ${video ? 'video' : 'image'}. Try again in a few minutes.`);
  if (i.dryRun) return { ok: true, dryRun: true, message: `Instagram accepted the ${video ? 'reel' : 'image'} and caption. Nothing was posted.` };
  const pub = await call(`${META_GRAPH}/${m.igId}/media_publish`, form({ creation_id: container.id, access_token: m.token }));
  const info = await call(`${META_GRAPH}/${pub.id}?fields=permalink&access_token=${m.token}`).catch(() => ({}));
  return { ok: true, dryRun: false, externalId: pub.id, permalink: info.permalink, message: 'Published to Instagram.' };
}

async function facebook(env: Env, i: PublishInput): Promise<PublishResult> {
  const m = await metaPage(env);
  if (i.postVideo && i.videoUrl) {
    const v = await call(`${META_GRAPH.replace('graph.', 'graph-video.')}/${m.pageId}/videos`, form({
      file_url: i.videoUrl, description: i.caption, published: i.dryRun ? 'false' : 'true', access_token: m.token,
    }));
    return {
      ok: true, dryRun: i.dryRun, externalId: v.id, permalink: `https://www.facebook.com/${m.pageId}/videos/${v.id}`,
      message: i.dryRun ? 'Video uploaded unpublished, visible only to Page admins.' : 'Video published to the Facebook Page.',
    };
  }
  const res = await call(`${META_GRAPH}/${m.pageId}/photos`, form({
    url: i.imageUrl, message: i.caption, published: i.dryRun ? 'false' : 'true', access_token: m.token,
  }));
  return {
    ok: true, dryRun: i.dryRun, externalId: res.post_id || res.id,
    permalink: res.post_id ? `https://www.facebook.com/${res.post_id}` : undefined,
    message: i.dryRun ? 'Uploaded as an unpublished photo, visible only to Page admins.' : 'Published to the Facebook Page.',
  };
}

async function threads(env: Env, i: PublishInput): Promise<PublishResult> {
  const c = await requireConn(env, 'threads');
  const token = await threadsToken(env, c);
  const uid = c.settings.userId;
  const video = i.postVideo && i.videoUrl;
  const container = await call(`${THREADS_GRAPH}/v1.0/${uid}/threads`, form(video
    ? { media_type: 'VIDEO', video_url: i.videoUrl!, text: i.caption.slice(0, 500), access_token: token }
    : { media_type: 'IMAGE', image_url: i.imageUrl, text: i.caption.slice(0, 500), access_token: token }));
  let status = '';
  for (let n = 0; n < (video ? 50 : 15) && status !== 'FINISHED'; n++) {
    await sleep(video ? 3000 : 2000);
    const s = await call(`${THREADS_GRAPH}/v1.0/${container.id}?fields=status,error_message&access_token=${token}`);
    status = s.status;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Threads rejected the post: ${s.error_message || status}`);
  }
  if (status !== 'FINISHED') throw new Error('Threads is still processing the image. Try again in a minute.');
  if (i.dryRun) return { ok: true, dryRun: true, message: 'Threads accepted the image and text. Nothing was posted.' };
  const pub = await call(`${THREADS_GRAPH}/v1.0/${uid}/threads_publish`, form({ creation_id: container.id, access_token: token }));
  const info = await call(`${THREADS_GRAPH}/v1.0/${pub.id}?fields=permalink&access_token=${token}`).catch(() => ({}));
  return { ok: true, dryRun: false, externalId: pub.id, permalink: info.permalink, message: 'Published to Threads.' };
}

// LinkedIn "little text" treats these characters as markup; escape them.
const liEscape = (s: string) => s.replace(/([\\|{}@[\]()<>#*_~])/g, '\\$1');

async function linkedin(env: Env, i: PublishInput): Promise<PublishResult> {
  const c = await requireConn(env, 'linkedin');
  const author = c.settings.organizationId ? `urn:li:organization:${c.settings.organizationId}` : `urn:li:person:${c.settings.memberId}`;
  const headers = {
    Authorization: `Bearer ${c.secrets.accessToken}`,
    'LinkedIn-Version': LINKEDIN_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
  };
  const init = await call('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST', headers, body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
  });
  const obj = await env.POSTERS.get(i.imageKey);
  if (!obj) throw new Error('Poster image is missing from storage.');
  const up = await fetch(init.value.uploadUrl, { method: 'PUT', headers: { Authorization: headers.Authorization }, body: await obj.arrayBuffer() });
  if (!up.ok) throw new Error(`LinkedIn image upload failed (${up.status}).`);
  if (i.dryRun) {
    return { ok: true, dryRun: true, message: `Signed in and uploaded the image as ${c.settings.organizationId ? 'the Company Page' : 'you'}. No post was created.` };
  }
  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST', headers,
    body: JSON.stringify({
      author,
      commentary: liEscape(i.caption).slice(0, 3000),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: init.value.image, altText: i.title.slice(0, 120) } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  if (res.status !== 201) {
    const d: any = await res.json().catch(() => ({}));
    throw new Error(d.message || `LinkedIn post failed (${res.status}).`);
  }
  const urn = res.headers.get('x-restli-id') || '';
  return { ok: true, dryRun: false, externalId: urn, permalink: urn ? `https://www.linkedin.com/feed/update/${urn}/` : undefined, message: 'Published to LinkedIn.' };
}

async function googleBusiness(env: Env, i: PublishInput): Promise<PublishResult> {
  const c = await requireConn(env, 'google');
  if (!c.settings.gbpLocationId || !c.settings.gbpAccountId) throw new Error('Pick your Business Profile listing in Connections first.');
  const token = await googleAccessToken(env, c);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (i.dryRun) {
    const loc = await call(`https://mybusinessbusinessinformation.googleapis.com/v1/locations/${c.settings.gbpLocationId}?readMask=title`, { headers: h });
    return { ok: true, dryRun: true, message: `Can reach "${loc.title}". Google has no draft mode, so nothing was posted.` };
  }
  const actionType = i.ctaType === 'booking_form' ? 'BOOK' : i.ctaType === 'call' ? 'CALL' : 'LEARN_MORE';
  const body: any = {
    languageCode: 'en', summary: i.caption.slice(0, 1500), topicType: 'STANDARD',
    media: [{ mediaFormat: 'PHOTO', sourceUrl: i.imageUrl }],
    callToAction: actionType === 'CALL' ? { actionType } : { actionType, url: i.link },
  };
  const res = await call(`https://mybusiness.googleapis.com/v4/accounts/${c.settings.gbpAccountId}/locations/${c.settings.gbpLocationId}/localPosts`, {
    method: 'POST', headers: h, body: JSON.stringify(body),
  });
  return { ok: true, dryRun: false, externalId: res.name, permalink: res.searchUrl, message: 'Published to Google Business Profile.' };
}

async function youtube(env: Env, i: PublishInput): Promise<PublishResult> {
  if (!i.videoKey) throw new Error('YouTube needs a video. Attach one to this content first.');
  const c = await requireConn(env, 'google');
  const token = await googleAccessToken(env, c);
  const head = await env.POSTERS.head(i.videoKey);
  if (!head) throw new Error('The video file is missing from storage.');
  if (i.dryRun) {
    const ch = await call('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${token}` } });
    if (!ch.items?.length) throw new Error('This Google account has no YouTube channel.');
    return { ok: true, dryRun: true, message: `Can upload to "${ch.items[0].snippet.title}"; video ready (${(head.size / 1e6).toFixed(1)} MB). Nothing was uploaded.` };
  }
  const start = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Upload-Content-Type': head.httpMetadata?.contentType || 'video/mp4',
      'X-Upload-Content-Length': String(head.size),
    },
    body: JSON.stringify({
      snippet: { title: i.title.slice(0, 100), description: i.caption.slice(0, 4900), categoryId: '19' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    }),
  });
  const session = start.headers.get('Location');
  if (!start.ok || !session) throw new Error(`YouTube refused the upload (${start.status}).`);
  const obj = await env.POSTERS.get(i.videoKey);
  const put = await fetch(session, {
    method: 'PUT',
    headers: { 'Content-Type': head.httpMetadata?.contentType || 'video/mp4', 'Content-Length': String(head.size) },
    body: obj!.body,
  });
  const d: any = await put.json().catch(() => ({}));
  if (!put.ok) throw new Error(d.error?.message || `YouTube upload failed (${put.status}).`);
  const forcedPrivate = d.status?.privacyStatus === 'private';
  return {
    ok: true, dryRun: false, externalId: d.id, permalink: `https://youtu.be/${d.id}`,
    message: forcedPrivate
      ? 'Uploaded, but YouTube kept it Private because the Google project has not passed YouTube’s audit. Make it public in YouTube Studio.'
      : 'Published to YouTube.',
  };
}

async function telegram(env: Env, i: PublishInput): Promise<PublishResult> {
  const c = await requireConn(env, 'telegram');
  const base = `https://api.telegram.org/bot${c.secrets.botToken}`;
  if (i.dryRun) {
    const me = await call(`${base}/getMe`);
    const mem = await call(`${base}/getChatMember?chat_id=${encodeURIComponent(c.settings.chatId)}&user_id=${me.result.id}`);
    if (!(mem.result.status === 'creator' || mem.result.can_post_messages)) throw new Error('The bot is not allowed to post in this channel.');
    return { ok: true, dryRun: true, message: 'The bot can post to the channel. Telegram has no draft mode, so nothing was sent.' };
  }
  const r = i.postVideo && i.videoUrl
    ? await call(`${base}/sendVideo`, form({ chat_id: c.settings.chatId, video: i.videoUrl, caption: i.caption.slice(0, 1024), supports_streaming: 'true' }))
    : await call(`${base}/sendPhoto`, form({ chat_id: c.settings.chatId, photo: i.imageUrl, caption: i.caption.slice(0, 1024) }));
  const user = r.result.chat?.username;
  return {
    ok: true, dryRun: false, externalId: String(r.result.message_id),
    permalink: user ? `https://t.me/${user}/${r.result.message_id}` : undefined, message: 'Posted to the Telegram channel.',
  };
}

async function whatsapp(env: Env, i: PublishInput): Promise<PublishResult> {
  const c = await requireConn(env, 'whatsapp');
  const to = i.dryRun
    ? [c.secrets.testRecipient]
    : (c.secrets.recipients || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
  if (!to.length || !to[0]) throw new Error(i.dryRun ? 'Add your own number for tests in Connections.' : 'No opted-in recipients are saved.');
  // Template variables cannot contain line breaks, tabs or 4+ spaces.
  const bodyText = `${i.caption} ${i.link}`.replace(/\s+/g, ' ').trim().slice(0, 1000);
  let sent = 0;
  const failures: string[] = [];
  for (const n of to) {
    try {
      await call(`${META_GRAPH}/${c.settings.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.secrets.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: n, type: 'template',
          template: {
            name: c.settings.templateName,
            language: { code: c.settings.templateLanguage || 'en' },
            components: [
              { type: 'header', parameters: [{ type: 'image', image: { link: i.imageUrl } }] },
              { type: 'body', parameters: [{ type: 'text', text: bodyText }] },
            ],
          },
        }),
      });
      sent++;
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (!sent) throw new Error(failures[0] || 'WhatsApp did not accept the message.');
  return {
    ok: true, dryRun: i.dryRun,
    message: i.dryRun
      ? 'Sent a test message to your own number only.'
      : `Sent to ${sent} of ${to.length} opted-in recipients.${failures.length ? ` ${failures.length} failed: ${failures[0]}` : ''}`,
  };
}

export async function publishTo(env: Env, channel: Channel, input: PublishInput): Promise<PublishResult> {
  switch (channel) {
    case 'instagram': return instagram(env, input);
    case 'facebook': return facebook(env, input);
    case 'threads': return threads(env, input);
    case 'linkedin': return linkedin(env, input);
    case 'google_business': return googleBusiness(env, input);
    case 'youtube': return youtube(env, input);
    case 'telegram': return telegram(env, input);
    case 'whatsapp': return whatsapp(env, input);
    case 'whatsapp_status':
    case 'website':
    case 'google_ads':
      throw new Error('Copy-only channel: copy it, post it yourself, then record the link.');
  }
}
