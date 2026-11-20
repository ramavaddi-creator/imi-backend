# Round 9: connect Google (read-only) on STAGING

What IMI ONE reads: Search Console (searches, impressions, clicks, position) and GA4 (visits by source, two key events).
It never writes to Google. Business Profile figures are typed in by hand until Google approves API access.

Do these as the owner, once. No secret is ever pasted into a chat, GitHub or a log.

## 1. Google Cloud project (check first, do not duplicate)
1. console.cloud.google.com → project picker. If an Iddav project already exists, use it. Otherwise create "imi-one-staging".
   It should be owned by the Iddav business Google account, with a second owner (decision D2).
2. APIs & Services → Library → enable **Google Search Console API** and **Google Analytics Data API**.
   (IMI ONE shows state 2 "API enabled" as *confirmed by the owner* until a call proves it.)

## 2. OAuth consent screen (Google Auth Platform)
1. Audience: **Internal** if the Iddav account is Google Workspace (no expiry, no warning, only your organisation can sign in).
   Otherwise **External**.
2. If External: after testing, set Publishing status to **In production**.
   - While it stays in **Testing**, Google expires the sign-in after **7 days**; IMI ONE will then show "needs reconnect" on Today every week.
   - In production but unverified, Google shows an "unverified app" warning on sign-in and allows at most 100 people in the project's lifetime. That is fine for the Iddav team.
3. Data access → add only:
   - `https://www.googleapis.com/auth/webmasters.readonly`
   - `https://www.googleapis.com/auth/analytics.readonly`

## 3. OAuth client (staging only)
1. Clients → Create client → **Web application** → name "IMI ONE staging".
2. Authorised redirect URI, exactly:
   `https://imi-one-staging.ramavaddi.workers.dev/oauth/google-measure/callback`
3. Put the two values on the staging Worker only (they never go into a chat):
   ```
   npx wrangler secret put GOOGLE_CLIENT_ID -c wrangler.staging.toml
   npx wrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.staging.toml
   ```
   `CONNECTIONS_KEY` is already set on staging; it encrypts the sign-in.

## 4. Search Console and GA4 access
- Search Console: the Google account you will sign in with must be an Owner or Full user of the iddavwildstay.com property.
- GA4: that account needs at least Viewer on the property. Note the Property ID (Admin → Property settings).
- On the website, the two events IMI ONE counts must exist in GA4 (names can be changed in IMI ONE):
  `enquiry_submitted` (form sent) and `whatsapp_tap` (WhatsApp button pressed). A tap is never counted as an enquiry.

## 5. In IMI ONE (staging)
Intelligence → Search → Google connections:
1. Enter the site (`https://www.iddavwildstay.com/` or `sc-domain:iddavwildstay.com`, exactly as Search Console shows it) → Save.
2. Sign in with Google → allow read access.
3. Fetch now. The five states should read: available, enabled, authorised, access, first data.
4. Repeat for GA4 with the Property ID.
5. Business Profile: enter last month's figures from the Performance page by hand.

## Key rotation (when needed)
1. `npx wrangler secret put CONNECTIONS_KEY_V2 -c wrangler.staging.toml` (new random value: `openssl rand -base64 32`).
2. POST `/v1/admin/google/rotate-keys` as the platform owner. It re-encrypts every stored sign-in, verifies each, and records a run.
3. Only when it reports `safeToRemoveOldKeys: true`, remove the old key.

## Database
Apply `schema_v15.sql` to **imi-db-staging** only:
```
npx wrangler d1 execute imi-db-staging --remote --file=schema_v15.sql -c wrangler.staging.toml
```
Production is unchanged until the founder approves.
