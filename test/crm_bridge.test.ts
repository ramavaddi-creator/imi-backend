import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crmMode, crmTotals, fetchCrmCampaign, crmReadOnlyMessage, type CrmCampaign } from '../src/crm_bridge.ts';

const env = (o: object = {}) => ({ CRM_URL: 'https://crm.example', CRM_SERVICE_KEY: 'key-123', ...o }) as any;
const camp: CrmCampaign = { code: 'CMP-0003', enquiries: 5, tracked: 5, qualified: 3, quoted: 2, booked: 1, lost: 2, room_nights: 2, booked_value: 16798, revenue_paid: 16798, contribution: 9998, contribution_known: true, top_loss_reason: 'price', median_first_reply_hours: null,
  by_tag: { IG: { enquiries: 2, booked: 1, booked_value: 16798 }, FB: { enquiries: 1, booked: 0, booked_value: 0 }, INSTAGRAM: { enquiries: 1, booked: 0, booked_value: 0 }, 'not recorded': { enquiries: 1, booked: 0, booked_value: 0 } }, by_post: {} };
const ABBR = { IG: 'instagram', FB: 'facebook' };
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

test('CRM mode needs both the address and the service key; with either missing IMI behaves as before', () => {
  assert.equal(crmMode(env()), true); assert.equal(crmMode(env({ CRM_SERVICE_KEY: '' })), false); assert.equal(crmMode(env({ CRM_URL: undefined })), false);
  assert.match(crmReadOnlyMessage(env()), /kept in the Iddav CRM/); assert.match(crmReadOnlyMessage(env()), /https:\/\/crm\.example/);
});

test("the CRM's numbers become IMI's funnel; channels are merged by name and a campaign with no enquiries is all zeros", () => {
  const t = crmTotals(camp, ABBR);
  assert.deepEqual([t.totals.enquiries, t.totals.booked, t.totals.roomNights, t.totals.bookedValue, t.totals.contribution, t.totals.contributionKnown, t.topLossReason], [5, 1, 2, 16798, 9998, true, 'price']);
  assert.deepEqual(t.byChannel.instagram, { enquiries: 3, booked: 1, bookedValue: 16798 }, 'IG and instagram are one channel');
  assert.deepEqual(Object.keys(t.byChannel).sort(), ['facebook', 'instagram', 'not recorded']);
  const none = crmTotals(null, ABBR); assert.deepEqual([none.totals.enquiries, none.totals.bookedValue, none.totals.contributionKnown, none.topLossReason], [0, 0, false, null]);
});

test('the CRM is asked with its key in a header, the answer is checked, and every failure is a plain message', async () => {
  const seen: { url: string; headers: any }[] = [];
  const spy = (async (u: string, init: RequestInit) => { seen.push({ url: u, headers: init.headers }); return new Response(JSON.stringify({ imi_campaigns: [camp] }), { status: 200 }); }) as unknown as typeof fetch;
  const got = await fetchCrmCampaign(env(), 'cmp-0003', '2026-11-01T00:00:00Z', spy);
  assert.equal(got!.enquiries, 5);
  assert.equal(seen[0]!.headers['x-imi-feed-key'], 'key-123'); assert.ok(!seen[0]!.url.includes('key-123'), 'the key is never in the address');
  assert.match(seen[0]!.url, /^https:\/\/crm\.example\/integrations\/imi\/outcomes\?campaign=cmp-0003&since=/);
  assert.equal(await fetchCrmCampaign(env(), 'CMP-9999', null, spy), null, 'a campaign the CRM has not seen');
  await assert.rejects(fetchCrmCampaign(env(), 'CMP-0003', null, reply(401, {})), /rejected IMI's feed key/);
  await assert.rejects(fetchCrmCampaign(env(), 'CMP-0003', null, reply(500, {})), /answered 500/);
  await assert.rejects(fetchCrmCampaign(env(), 'CMP-0003', null, reply(200, { campaigns: [] })), /does not recognise/);
  await assert.rejects(fetchCrmCampaign(env(), 'CMP-0003', null, (async () => { throw new Error('down'); }) as unknown as typeof fetch), /could not be reached/);
});
