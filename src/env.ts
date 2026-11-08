export interface Env {
  DB: D1Database;
  // Posters, original photos, AI backgrounds and videos. Served read-only at
  // /media/<key> because Meta, Google, LinkedIn and Telegram fetch by URL.
  POSTERS: R2Bucket;
  // Retired by Gate 1: no longer checked. Kept so old deployments type-check.
  API_SECRET?: string;

  // Owner PIN: typed by hand to connect accounts, approve content and publish
  // live. Checked server-side only; never part of the frontend build.
  OWNER_PIN?: string;
  // 32-byte base64 key that encrypts every stored platform token in D1.
  CONNECTIONS_KEY?: string;
  // Where to send the browser after a "Sign in with..." flow finishes.
  APP_URL?: string;
  // ---- Gate 1 sign-in and permissions (src/policy.ts) ----
  // Cloudflare Access application. Both required: without valid values every
  // private request is refused with 503 (fail closed).
  ACCESS_TEAM_DOMAIN?: string; // e.g. iddav.cloudflareaccess.com
  ACCESS_AUD?: string; // Access application Audience (AUD) tag
  // Comma-separated emails with owner permission (approve, publish, connect).
  OWNER_EMAILS?: string;
  // Comma-separated browser origins for the app (default APP_URL) and for
  // brand websites that host the enquiry form. Unlisted origins are refused.
  ALLOWED_ORIGINS?: string;
  ENQUIRY_ORIGINS?: string;
  // Live publishing switch and emergency stop. Anything other than "true"
  // blocks real posts (tests/dry runs still work). Staging never sets it.
  PUBLISHING_ENABLED?: string;
  // 'production' only in the production config. Anything else is labelled staging in the app.
  DATA_ENVIRONMENT?: string;
  // Optional service binding to the CRM Worker. When present, IMI calls the CRM
  // privately, Worker to Worker, never over the public internet (so a CRM behind
  // Cloudflare Access is still reachable). CRM_URL is then only used for the path.
  CRM_SERVICE?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };

  // The Iddav CRM: the one place enquiries, quotes and bookings live (DEC-IMI-003). IMI reads campaign results from it.
  // CRM_SERVICE_KEY must equal INTAKE_KEY on the CRM Worker. Set it with `wrangler secret put CRM_SERVICE_KEY`.
  CRM_URL?: string;
  CRM_SERVICE_KEY?: string;

  // AI providers (server-side only; TFR-AI-001 provider adapter)
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string; // default claude-sonnet-5-5
  OPENAI_API_KEY?: string;
  OPENAI_TEXT_MODEL?: string; // default gpt-4o-mini
  OPENAI_IMAGE_MODEL?: string; // default gpt-image-2
  AI_MONTHLY_IMAGE_CAP?: string; // default 60
  AI_MONTHLY_TEXT_CAP?: string; // default 600

  // OAuth app credentials (one-time developer-app setup per platform)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  THREADS_APP_ID?: string;
  THREADS_APP_SECRET?: string;
}
