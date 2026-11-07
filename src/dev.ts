// IMI-LOCAL-DEVELOPMENT-ENTRY-POINT
// Local development only. Run with: npm run dev:local
// Uses wrangler.dev.toml (main = src/dev.ts). Never deployed: the deployed
// configuration (wrangler.toml, wrangler.staging.toml) uses src/index.ts, and
// CI fails if this file's marker appears in the deployed bundle.
//
// It signs every localhost request in as DEV_IDENTITY_LOCAL from .dev.vars.
// Requests to any other hostname get no identity.
import { createWorker } from './index';
import type { Env } from './env';

const MODE = 'IMI-LOCAL-DEVELOPMENT-ENTRY-POINT';

export default {
  async fetch(request: Request, env: Env & { DEV_IDENTITY_LOCAL?: string }): Promise<Response> {
    const res = await createWorker({ devIdentity: env.DEV_IDENTITY_LOCAL }).fetch(request, env);
    const out = new Response(res.body, res);
    out.headers.set('X-IMI-Mode', MODE); // visible proof a response came from local development
    return out;
  },
};
