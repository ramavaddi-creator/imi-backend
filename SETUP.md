# IMI Content Studio + Connections — setup

Everything after step A happens inside the app, on the **Connections** screen,
which shows each platform's steps, a Test button and a manual fallback.

## A. One-time Worker setup (≈10 minutes)

From the `imi-backend` folder:

    npm install
    npx wrangler r2 bucket create imi-posters
    npx wrangler d1 execute imi-db --remote --file=schema_v5.sql
    npx wrangler d1 execute imi-db --remote --file=schema_v6.sql
    npx wrangler d1 execute imi-db --remote --file=schema_v7.sql
    npx wrangler secret put OWNER_PIN                                  # a PIN you will type to approve/publish
    openssl rand -base64 32 | npx wrangler secret put CONNECTIONS_KEY  # encrypts saved tokens
    npx wrangler deploy

Then push the `IMI` frontend repo so Cloudflare Pages rebuilds. Open IMI →
**Connections**, enter your PIN in the black bar, and connect platforms.

If `APP_URL` in wrangler.toml is not your Pages address, change it and redeploy.

## B. Connect platforms — easiest first

| Platform | Time | What you do |
| --- | --- | --- |
| Telegram | 3 min | Create a bot in @BotFather, make it a channel admin, paste token + channel. |
| Claude / ChatGPT | 2 min each | Paste an API key. (Already-set Worker keys also work.) |
| Facebook + Instagram | 15 min | System User token from Business Manager; then pick your Page in IMI. |
| Threads | 10 min | Add the Threads use case to the same Meta app, then **Sign in with Threads**. |
| LinkedIn (you) | 10 min | Create an app, add two self-serve products, then **Sign in with LinkedIn**. |
| LinkedIn (Company Page) | weeks | Needs LinkedIn's Community Management API approval. |
| YouTube | 15 min | Google OAuth client, then **Sign in with Google**. Uploads stay Private until Google audits the project. |
| Google Business Profile | days–weeks | Same Google sign-in; works once Google approves API access. |
| WhatsApp Business | 1 h + approval | Cloud API number, one approved template with an image header and `{{1}}`. |

Sign-in platforms need their app keys on the Worker once:

    npx wrangler secret put THREADS_APP_ID
    npx wrangler secret put THREADS_APP_SECRET
    npx wrangler secret put LINKEDIN_CLIENT_ID
    npx wrangler secret put LINKEDIN_CLIENT_SECRET
    npx wrangler secret put GOOGLE_CLIENT_ID
    npx wrangler secret put GOOGLE_CLIENT_SECRET

Each platform card shows the exact Redirect URI to paste into its developer app.

## C. First campaign

1. Content Studio → New campaign: objective, success metric, audience, call to
   action + link, expected outcome, and either an approved decision or your facts.
2. New content: tick channels, choose Claude or ChatGPT, upload your own photo.
3. Edit poster text (max 12 words) and each channel's caption → Save poster.
4. **Test** — nothing goes public. Fix anything red.
5. Approve (PIN) → **Publish live**. Channels that aren't connected: post
   yourself, then paste the link into "Record it".

## C2. Claude, ChatGPT and outside creative tools

- **Start from an approved decision:** Decision Review → *Create content from this
  decision* opens Content Studio with the campaign pre-filled.
- **Channels Claude/ChatGPT write for:** Instagram, Facebook, Threads, LinkedIn,
  Google Business, YouTube, Telegram, WhatsApp, plus three copy-only channels:
  **WhatsApp Status**, **Iddav website** (title, article, meta description) and
  **Google Ads** (headlines ≤30 characters, descriptions ≤90). Copy-only means
  IMI writes and tracks it; you paste it and record the link.
- **Per channel:** *Rewrite with Claude* or *Rewrite with ChatGPT*, with an
  optional instruction ("shorter", "more about birds"). *+ Add channel* writes a
  new one later.
- **Outside tools** (Gemini, Google Flow, Runway, Adobe Firefly, Canva, CapCut,
  ChatGPT, Claude): pick the tool → Claude or ChatGPT writes the prompt → *Copy
  prompt & open* → sign in there with your own account → make it → *Choose file*
  to bring the video, finished poster or background back into IMI.
- Imported AI media is labelled "Made with AI (tool)" in every caption. If it
  shows animals, approval becomes Class A.
- With a video attached, choose whether Instagram (Reel), Facebook, Threads and
  Telegram post the **poster** or the **video**. YouTube always uses the video.
- Videos up to 95 MB. Instagram Reels must be vertical MP4; Telegram accepts
  videos up to 20 MB by link.

## D. Enquiries (CRM) — already inside IMI

Nothing extra to install: Enquiries uses the same database, login and PIN.

- **WhatsApp / calls:** New enquiry → paste the guest's message. If it came
  from an IMI post, its "ref CMP-…" code links the campaign automatically.
- **Website:** paste `docs/website-enquiry-form.html` into iddavwildstay.com
  and set WORKER_URL once. Website enquiries arrive in IMI with their campaign.
- **Every day:** open Enquiries → Follow up. The menu badge shows how many are
  due. Each enquiry has one "Mark next step" button.
- **When a campaign's window ends:** Content Studio → Results → Record outcome.
  IMI fills in the numbers; you write the lesson. It appears in Outcome Review.
- Guest phone numbers and messages are never sent to Claude or ChatGPT.
  "Delete personal data" on an enquiry erases them and keeps the anonymous numbers.

## Ads inside AI tools

ChatGPT Ads are bought in OpenAI's Ads Manager (ads.openai.com). Claude has no
ads. Connections → "Ads inside AI tools" makes a tracked link per campaign so
ad enquiries are counted.

## Notes

- `/media/*` and `/oauth/*` are public on purpose (platforms fetch images; sign-in
  redirects land there). Keep them open if you add Cloudflare Access.
- Tokens are encrypted in D1 with CONNECTIONS_KEY. If you lose that key, just
  reconnect each platform.
- See `docs/decisions/DEC-IMI-002.md` for what this pilot is and is not.

## Connect IMI to the Iddav CRM (DEC-IMI-003)

The CRM keeps enquiries, quotes and bookings. IMI reads each campaign's results from it. Do this once, after the CRM is deployed.

1. Choose one long random value, for example `openssl rand -base64 32`. It is the **service key**.
2. On the **CRM** Worker (the `iddav-crm` project): `wrangler secret put INTAKE_KEY` and paste the key. (If you already set one, reuse it.)
3. On **this** Worker: `wrangler secret put CRM_SERVICE_KEY` and paste the same key.
4. `CRM_URL` is already in `wrangler.toml`. Change it if the CRM address changes. Then `npm run deploy`.
5. Check it: in IMI open Enquiries (a banner says enquiries now live in the CRM) and open a campaign in Content Studio. The results header reads
   **Results from the Iddav CRM**.

Until both `CRM_URL` and `CRM_SERVICE_KEY` are set, IMI works as before, with its own enquiries. The key must never be put in the repository or in
the frontend build. If the CRM rejects the key, IMI says so in plain words.

Campaign codes: the CRM groups enquiries by the IMI campaign code in the link or message the guest arrived with (`REF CMP-0003-2-IG`). Keep using
the tracked links IMI issues, so every enquiry is tied to its campaign.

Tests: `npm test`. Type-check: `npm run typecheck`.
