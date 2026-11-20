# Round 10: connect Instagram (read-only) on STAGING

IMI ONE reads, for @iddav_wildstay only: account identity, posts, and the insights Meta makes available.
It never posts, comments, messages, or touches ads, Threads or WhatsApp. The Meta app stays in Development mode.

Prerequisite: the previously exposed Cloudflare Access session has been revoked.

## 1. Use the existing app (do not create another)
developers.facebook.com → My Apps → **IMI Integration.** (App ID 1377316238789751), Development mode.

## 2. Instagram permissions on the app
Use cases / Instagram → **API setup with Instagram business login**. Make sure only these two permissions are added:
- `instagram_business_basic`
- `instagram_business_manage_insights`

Do not add publishing, comments or messaging permissions.

## 3. Generate the token for @iddav_wildstay
In the same "API setup with Instagram business login" page → **Generate access tokens** → **Add account** → sign in
as @iddav_wildstay → allow the two permissions → copy the token shown.
- In Development mode Meta only lets accounts with a role on the app do this; if @iddav_wildstay is refused,
  add it under App roles (Instagram tester) and accept the invite in the Instagram app, then try again.
- The token is copied once, straight into IMI ONE. Never paste it into a chat, email, GitHub or a note.

## 4. In IMI ONE (staging)
Intelligence → Social:
1. Instagram username: `iddav_wildstay`. Paste the token. Connect.
   A token for any other account is refused and nothing is saved.
2. **Fetch now**: posts, then insights. Figures can arrive up to 48 hours late.
3. **Run connection test**: twelve checks (T1–T12) with a redacted report. Expect all to pass;
   "Pagination" shows *blocked* if the account has only one page of posts.

## What happens afterwards
- Daily fetch at 08:45 IST (same schedule as Google).
- The sign-in lasts 60 days. IMI ONE renews it automatically once it is at least 24 hours old;
  Today warns 7 days before expiry if renewal fails, and asks to reconnect if Meta stops accepting it.
- Disconnect removes the sign-in; posts and figures already fetched stay, read-only.

## Database
Apply `schema_v16.sql` to **imi-db-staging** only:
```
npx wrangler d1 execute imi-db-staging --remote --file=schema_v16.sql -c wrangler.staging.toml
```
