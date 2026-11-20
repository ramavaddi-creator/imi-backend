// IMI ONE round 13: the brand's official links and tracked links.
//
//   Official links: website, WhatsApp, email, Google review link and each social account, one per kind.
//   Each is cleaned when saved (https, tracking added by other tools removed, e.g. utm_source=chatgpt.com)
//   and stays "not checked" until an owner confirms it. Placeholder links are refused.
//   Tracked links: the website link tagged for each place it is shared (Instagram bio, Business Profile,
//   WhatsApp, LinkedIn, QR codes...), so Google Analytics shows which channel brings visits; and a WhatsApp
//   link with a short reference in the first message, so a WhatsApp enquiry shows where it came from.

import type { Env } from './env';
import { HttpError } from './http';

const iso = () => new Date().toISOString();

export const LINK_KINDS = ['website', 'whatsapp', 'email', 'google_review', 'instagram', 'facebook', 'youtube', 'threads', 'linkedin'] as const;
export type LinkKind = typeof LINK_KINDS[number];

const HOSTS: Partial<Record<LinkKind, string[]>> = {
  instagram: ['instagram.com'],
  facebook: ['facebook.com', 'fb.com', 'fb.me'],
  youtube: ['youtube.com', 'youtu.be'],
  threads: ['threads.net', 'threads.com'],
  linkedin: ['linkedin.com'],
  google_review: ['search.google.com', 'g.page', 'maps.app.goo.gl', 'maps.google.com', 'google.com', 'goo.gl'],
};
const onHost = (host: string, d: string) => host === d || host.endsWith(`.${d}`);
const SOCIAL_HOSTS = Object.values(HOSTS).flat().filter((h) => !h.startsWith('google') && h !== 'goo.gl');

// Parameters other tools add to links. Removed when saving, warned about in drafts.
const FOREIGN = /^(utm_[a-z]+|fbclid|gclid|gbraid|wbraid|igsh|igshid|si|mibextid|ref_src|_gl|mc_[a-z]+|srsltid)$/i;
const PLACEHOLDER = /example\.(com|org|net)|your[-_ ]?(site|website|handle|page|link|number)|placeholder|not verified|<|>|xxx|\.\.\./i;

export interface Cleaned { url: string; notes: string[] }

export function normaliseLink(kind: string, raw: unknown): Cleaned {
  if (!(LINK_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'Unknown kind of link.');
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw new HttpError(400, 'Paste the link.');
  if (s.length > 500) throw new HttpError(400, 'That link is too long.');
  if (PLACEHOLDER.test(s)) throw new HttpError(400, 'This looks like a placeholder, not a real link. Copy the exact link from the app or the browser.');
  const notes: string[] = [];
  if (kind === 'email') {
    const e = s.replace(/^mailto:/i, '').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) throw new HttpError(400, 'That is not an email address.');
    return { url: `mailto:${e}`, notes };
  }
  if (kind === 'whatsapp') {
    let digits = '';
    if (/wa\.me|whatsapp\.com/i.test(s)) {
      const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      digits = (u.hostname.endsWith('wa.me') ? u.pathname : u.searchParams.get('phone') ?? '').replace(/\D/g, '');
    } else digits = s.replace(/\D/g, '');
    if (digits.length === 10) throw new HttpError(400, 'Include the country code, for example 91 for India: 91 and then the 10-digit number.');
    if (digits.length < 11 || digits.length > 15) throw new HttpError(400, 'That is not a WhatsApp number with its country code.');
    return { url: `https://wa.me/${digits}`, notes };
  }
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new HttpError(400, 'That is not a web link.'); }
  if (u.protocol === 'http:') { u.protocol = 'https:'; notes.push('Changed to https.'); }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Use a web link that starts with https://.');
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const allowed = HOSTS[kind as LinkKind];
  if (allowed && !allowed.some((d) => onHost(host, d))) throw new HttpError(400, `This is not a ${kind.replace('_', ' ')} link (it points to ${host}).`);
  if (kind === 'website' && SOCIAL_HOSTS.some((d) => onHost(host, d))) throw new HttpError(400, 'Use your own website address here; social accounts have their own rows.');
  const removed = [...u.searchParams.keys()].filter((k) => FOREIGN.test(k));
  for (const k of removed) u.searchParams.delete(k);
  if (removed.length) notes.push(`Removed tracking added by another tool (${removed.join(', ')}).`);
  if (kind === 'linkedin' && /^\/in\//i.test(u.pathname)) notes.push('This is a personal LinkedIn profile. A business needs a Company Page (linkedin.com/company/...); only a Company Page has page figures.');
  if (kind === 'google_review' && onHost(host, 'search.google.com') && !u.searchParams.get('placeid')) throw new HttpError(400, 'A Google review link needs the placeid. Use "Ask for reviews" in your Business Profile to copy it.');
  let url = u.toString();
  if (u.pathname === '/' && !u.search && !u.hash) url = url.replace(/\/$/, '');
  return { url, notes };
}

const row = (r: any) => ({ id: r.id, kind: r.kind, url: r.url, notes: JSON.parse(r.notes_json || '[]'), verified: !!r.verified, verifiedBy: r.verified_by, verifiedAt: r.verified_at, createdBy: r.created_by, createdAt: r.created_at });

export async function activeLinks(env: Env, ws: string) {
  const { results } = await env.DB.prepare('SELECT * FROM brand_links WHERE workspace_id = ? AND retired_at IS NULL').bind(ws).all<any>();
  return (results ?? []).map(row).sort((a, b) => LINK_KINDS.indexOf(a.kind) - LINK_KINDS.indexOf(b.kind));
}

// ---------------------------------------------------------------- tracked links

export const PLACEMENTS = [
  { key: 'instagram_bio', label: 'Instagram bio', source: 'instagram', medium: 'social', campaign: 'bio', ref: 'IG-BIO' },
  { key: 'instagram_story', label: 'Instagram story link sticker', source: 'instagram', medium: 'social', campaign: 'story', ref: 'IG-STORY' },
  { key: 'business_profile', label: 'Google Business Profile (website button)', source: 'google', medium: 'organic', campaign: 'gbp', ref: 'GBP' },
  { key: 'whatsapp', label: 'WhatsApp messages and status', source: 'whatsapp', medium: 'messaging', campaign: 'share', ref: 'WA' },
  { key: 'facebook', label: 'Facebook page and posts', source: 'facebook', medium: 'social', campaign: 'page', ref: 'FB' },
  { key: 'linkedin', label: 'LinkedIn posts', source: 'linkedin', medium: 'social', campaign: 'post', ref: 'LI' },
  { key: 'youtube', label: 'YouTube descriptions', source: 'youtube', medium: 'social', campaign: 'description', ref: 'YT' },
  { key: 'threads', label: 'Threads', source: 'threads', medium: 'social', campaign: 'post', ref: 'TH' },
  { key: 'email', label: 'Email signature and replies', source: 'email', medium: 'email', campaign: 'signature', ref: 'EMAIL' },
  { key: 'qr_print', label: 'Printed QR codes (brochures, room cards)', source: 'qr', medium: 'offline', campaign: 'print', ref: 'QR' },
] as const;
const OUR_SOURCES = new Set<string>(PLACEMENTS.map((p) => p.source));

const slug = (s: unknown) => (typeof s === 'string' ? s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) : '');

export function tracked(links: ReturnType<typeof row>[], brand: string, campaign?: string | null) {
  const site = links.find((l) => l.kind === 'website'), wa = links.find((l) => l.kind === 'whatsapp');
  const c = slug(campaign);
  return PLACEMENTS.map((p) => {
    let url: string | null = null;
    if (site) {
      const u = new URL(site.url);
      u.searchParams.set('utm_source', p.source); u.searchParams.set('utm_medium', p.medium); u.searchParams.set('utm_campaign', c || p.campaign);
      url = u.toString();
    }
    const ref = c ? `${p.ref}-${c.toUpperCase().replace(/_/g, '-')}` : p.ref;
    const whatsapp = wa ? `${wa.url}?text=${encodeURIComponent(`Hello ${brand}, I would like to know more. (ref: ${ref})`)}` : null;
    return { placement: p.key, label: p.label, url, whatsapp, ref, utm: { source: p.source, medium: p.medium, campaign: c || p.campaign } };
  });
}

async function brandName(env: Env, ws: string) {
  return (await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(ws).first<any>())?.name ?? 'us';
}

export async function listLinks(env: Env, ws: string, campaign?: string | null) {
  const links = await activeLinks(env, ws);
  const missing = LINK_KINDS.filter((k) => !links.some((l) => l.kind === k));
  return {
    links, missing, tracked: tracked(links, await brandName(env, ws), campaign),
    note: links.some((l) => l.kind === 'website') ? null : 'Add the website link first: every tracked link is built from it.',
  };
}

export async function setLink(env: Env, ws: string, who: string, body: any) {
  const kind = String(body?.kind ?? '');
  const { url, notes } = normaliseLink(kind, body?.url);
  const cur = await env.DB.prepare('SELECT * FROM brand_links WHERE workspace_id = ? AND kind = ? AND retired_at IS NULL').bind(ws, kind).first<any>();
  const verify = body?.verified === true;
  if (cur && cur.url === url) {
    if (verify && !cur.verified) await env.DB.prepare('UPDATE brand_links SET verified = 1, verified_by = ?, verified_at = ? WHERE id = ?').bind(who, iso(), cur.id).run();
  } else {
    const at = iso();
    const stmts: D1PreparedStatement[] = [];
    if (cur) stmts.push(env.DB.prepare('UPDATE brand_links SET retired_by = ?, retired_at = ? WHERE id = ?').bind(who, at, cur.id));
    stmts.push(env.DB.prepare('INSERT INTO brand_links (id, workspace_id, kind, url, notes_json, verified, verified_by, verified_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), ws, kind, url, JSON.stringify(notes), verify ? 1 : 0, verify ? who : null, verify ? at : null, who, at));
    await env.DB.batch(stmts);
  }
  return listLinks(env, ws);
}

export async function verifyLink(env: Env, ws: string, who: string, id: string) {
  const r = await env.DB.prepare('UPDATE brand_links SET verified = 1, verified_by = ?, verified_at = ? WHERE id = ? AND workspace_id = ? AND retired_at IS NULL').bind(who, iso(), id, ws).run();
  if (!(r as any).meta?.changes) throw new HttpError(404, 'Link not found');
  return listLinks(env, ws);
}

export async function retireLink(env: Env, ws: string, who: string, id: string) {
  const r = await env.DB.prepare('UPDATE brand_links SET retired_by = ?, retired_at = ? WHERE id = ? AND workspace_id = ? AND retired_at IS NULL').bind(who, iso(), id, ws).run();
  if (!(r as any).meta?.changes) throw new HttpError(404, 'Link not found');
  return listLinks(env, ws);
}

// ---------------------------------------------------------------- content packs and draft checks

// Which placement each format's link belongs to. Instagram captions cannot hold a clickable link.
const FORMAT_PLACEMENT: Record<string, string> = {
  carousel: 'instagram_bio', reel_script: 'instagram_bio', poster_text: 'instagram_bio', caption: 'instagram_bio', story: 'instagram_story',
  linkedin_post: 'linkedin', whatsapp_status: 'whatsapp',
};

// The LINKS block of a pack prompt. Added after redaction: these are the brand's own public contact details.
export async function packLinkLines(env: Env, ws: string, formatKeys: string[]) {
  const links = await activeLinks(env, ws);
  if (!links.length) return ['', 'LINKS: none saved. Do not write any link, phone number or email address.'];
  const t = tracked(links, await brandName(env, ws));
  const by = (k: string) => t.find((x) => x.placement === k)!;
  const review = links.find((l) => l.kind === 'google_review');
  const out = ['', 'LINKS (the brand\'s own; use only these, exactly as written; never invent a link, phone number or address):'];
  const seen = new Set<string>();
  for (const f of formatKeys) {
    const p = FORMAT_PLACEMENT[f]; if (!p || seen.has(p)) continue; seen.add(p);
    const x = by(p);
    if (p === 'instagram_bio') out.push('- Instagram posts: links in captions are not clickable; write "link in bio" or "message us on WhatsApp", not a web address.');
    else if (p === 'instagram_story') { if (x.url) out.push(`- Story link sticker: ${x.url}`); }
    else if (p === 'whatsapp') { if (x.whatsapp) out.push(`- WhatsApp: ${x.whatsapp}`); if (x.url) out.push(`- Website on WhatsApp: ${x.url}`); }
    else if (x.url) out.push(`- Website in ${x.label}: ${x.url}`);
  }
  const wa = links.find((l) => l.kind === 'whatsapp');
  if (wa && !seen.has('whatsapp')) {
    const first = [...seen][0] ?? 'whatsapp';
    out.push(`- WhatsApp for enquiries: +${wa.url.replace(/\D/g, '')} (where links can be clicked: ${by(first).whatsapp})`);
  }
  if (review) out.push(`- Google review link (only when asking guests for a review): ${review.url}`);
  return out;
}

const URLS = /\b(?:https?:\/\/|www\.|wa\.me\/|(?:instagram|facebook|youtube|threads|linkedin)\.(?:com|net)\/)[^\s<>()\]"']+/gi;
const kindOf = (host: string): LinkKind | null => {
  for (const k of Object.keys(HOSTS) as LinkKind[]) if (HOSTS[k]!.some((d) => onHost(host, d))) return k;
  if (onHost(host, 'wa.me') || onHost(host, 'api.whatsapp.com')) return 'whatsapp';
  return null;
};
const pathKey = (u: URL) => u.pathname.toLowerCase().replace(/\/+$/, '');

// Warnings only: a link that is not the brand's own, is not checked yet, or carries another tool's tracking.
export async function linkChecks(env: Env, ws: string, text: string) {
  const out: { level: 'warn'; code: string; message: string }[] = [];
  const found = [...new Set((text.match(URLS) ?? []).map((s) => s.replace(/[.,;:!?]+$/, '')))];
  const emails = [...new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])].map((e) => e.toLowerCase());
  if (!found.length && !emails.length) return out;
  const links = await activeLinks(env, ws);
  const get = (k: LinkKind) => links.find((l) => l.kind === k);
  const site = get('website'), siteHost = site ? new URL(site.url).hostname.replace(/^www\./, '') : null;
  for (const raw of found) {
    let u: URL;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { continue; }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const foreign = [...u.searchParams.entries()].filter(([k, v]) => FOREIGN.test(k) && !(k === 'utm_source' && OUR_SOURCES.has(v)) && !(/^utm_(medium|campaign)$/.test(k) && u.searchParams.has('utm_source') && OUR_SOURCES.has(u.searchParams.get('utm_source')!)));
    if (foreign.length) out.push({ level: 'warn', code: 'link_tracking', message: `${raw} carries tracking from another tool (${foreign.map(([k, v]) => `${k}=${v}`).join(', ')}). Use the tracked link from Brand settings > Links.` });
    const kind = siteHost && (host === siteHost) ? 'website' : kindOf(host);
    if (!kind) { out.push({ level: 'warn', code: 'link_unknown', message: `${raw} is not one of this brand's saved links. Check it before posting.` }); continue; }
    const own = get(kind);
    if (!own) { out.push({ level: 'warn', code: 'link_unknown', message: `No official ${kind.replace('_', ' ')} link is saved, so ${raw} cannot be checked. Add it in Brand settings > Links.` }); continue; }
    const o = new URL(own.url);
    const same = kind === 'website' ? true
      : kind === 'whatsapp' ? (host.endsWith('wa.me') ? u.pathname : u.searchParams.get('phone') ?? '').replace(/\D/g, '') === o.pathname.replace(/\D/g, '')
        : kind === 'google_review' ? (u.searchParams.get('placeid') ?? '') === (o.searchParams.get('placeid') ?? '') || pathKey(u) === pathKey(o)
          : pathKey(u).split('/')[1] === pathKey(o).split('/')[1] && pathKey(u).split('/')[2] === pathKey(o).split('/')[2];
    if (!same) out.push({ level: 'warn', code: 'link_not_official', message: `${raw} is not the official ${kind.replace('_', ' ')} link (${own.url}).` });
    else if (!own.verified) out.push({ level: 'warn', code: 'link_unchecked', message: `The ${kind.replace('_', ' ')} link has not been checked by an owner yet (Brand settings > Links).` });
  }
  const mail = get('email');
  for (const e of emails) {
    if (!mail) out.push({ level: 'warn', code: 'link_unknown', message: `No official email is saved, so ${e} cannot be checked.` });
    else if (`mailto:${e}` !== mail.url) out.push({ level: 'warn', code: 'link_not_official', message: `${e} is not the official email (${mail.url.slice(7)}).` });
  }
  return out;
}
