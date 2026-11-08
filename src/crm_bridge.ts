// The bridge to the Iddav CRM. The CRM is the one place where enquiries, guests, quotes and bookings live (decision DEC-IMI-003).
// IMI does not keep a second copy: it reads each campaign's results from the CRM, using the CRM's service key, and never sees a name,
// a phone number or an email address. If CRM_URL and CRM_SERVICE_KEY are not both set, IMI behaves as it did before.

import type { Env } from './env';
import { HttpError } from './http';

export const crmMode = (env: Env): boolean => !!(env.CRM_URL && env.CRM_SERVICE_KEY);

// Calls the CRM: through the private service binding when one is configured, otherwise over HTTPS.
export const crmFetch = (env: Env, url: string, init: RequestInit, fetchImpl: typeof fetch = fetch): Promise<Response> =>
  env.CRM_SERVICE ? env.CRM_SERVICE.fetch(url, init) : fetchImpl(url, init);

export const crmReadOnlyMessage = (env: Env): string =>
  `Enquiries are kept in the Iddav CRM now, not in IMI.${env.CRM_URL ? ` Open ${env.CRM_URL} to add or change one.` : ''} IMI shows the results.`;

interface Slice { enquiries: number; booked: number; booked_value: number }
export interface CrmCampaign {
  code: string; enquiries: number; tracked: number; qualified: number; quoted: number; booked: number; lost: number;
  room_nights: number; booked_value: number; revenue_paid: number; contribution: number; contribution_known: boolean;
  top_loss_reason: string | null; median_first_reply_hours: number | null;
  by_tag: Record<string, Slice>; by_post: Record<string, Slice>;
}

// One call per campaign. The key travels in a header, never in the address, and the answer is checked before it is trusted.
export async function fetchCrmCampaign(env: Env, code: string, since?: string | null, fetchImpl: typeof fetch = fetch): Promise<CrmCampaign | null> {
  const url = new URL('/integrations/imi/outcomes', env.CRM_URL);
  url.searchParams.set('campaign', code);
  if (since) url.searchParams.set('since', since);
  let res: Response;
  try { res = await crmFetch(env, url.toString(), { headers: { 'x-imi-feed-key': env.CRM_SERVICE_KEY! }, signal: AbortSignal.timeout(8000) }, fetchImpl); }
  catch { throw new HttpError(502, 'The CRM could not be reached. Try again in a minute.'); }
  if (res.status === 401) throw new HttpError(502, "The CRM rejected IMI's feed key. CRM_SERVICE_KEY here must equal IMI_FEED_KEY on the CRM.");
  if (!res.ok) throw new HttpError(502, `The CRM answered ${res.status}.`);
  const body = (await res.json().catch(() => null)) as { imi_campaigns?: CrmCampaign[] } | null;
  if (!body || !Array.isArray(body.imi_campaigns)) throw new HttpError(502, 'The CRM answered in a form IMI does not recognise. Update the CRM to its latest version.');
  return body.imi_campaigns.find((c) => c.code === code.trim().toUpperCase()) ?? null;
}

// The CRM's numbers in the shape IMI's funnel already uses. A campaign the CRM has not heard of yet is all zeros: nobody has enquired.
export function crmTotals(c: CrmCampaign | null, abbrToChannel: Record<string, string>) {
  const byChannel: Record<string, { enquiries: number; booked: number; bookedValue: number }> = {};
  for (const [tag, s] of Object.entries(c?.by_tag ?? {})) {
    const k = tag === 'not recorded' ? 'not recorded' : abbrToChannel[tag] || tag.toLowerCase();
    const b = (byChannel[k] ||= { enquiries: 0, booked: 0, bookedValue: 0 });
    b.enquiries += s.enquiries; b.booked += s.booked; b.bookedValue += s.booked_value;
  }
  return {
    totals: {
      enquiries: c?.enquiries ?? 0, tracked: c?.tracked ?? 0, qualified: c?.qualified ?? 0, quoted: c?.quoted ?? 0, booked: c?.booked ?? 0, lost: c?.lost ?? 0,
      roomNights: c?.room_nights ?? 0, bookedValue: c?.booked_value ?? 0, contribution: c?.contribution ?? 0, contributionKnown: c?.contribution_known ?? false,
      medianFirstReplyHours: c?.median_first_reply_hours ?? null,
    },
    byChannel,
    topLossReason: c?.top_loss_reason ?? null,
  };
}
