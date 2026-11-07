// Gate 1 check 1: build exactly what `wrangler deploy` would upload, for each
// deployable configuration, and prove it does not contain the local-development
// entry point (src/dev.ts). Also checks the configs themselves.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MARKER = 'IMI-LOCAL-DEVELOPMENT-ENTRY-POINT';
let failed = false;
const fail = (m) => { console.error('FAIL', m); failed = true; };

const bundle = (cfg) => {
  const out = mkdtempSync(join(tmpdir(), 'imi-bundle-'));
  execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '-c', cfg, '--outdir', out], { stdio: 'pipe' });
  return readdirSync(out).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
};

for (const cfg of ['wrangler.toml', 'wrangler.staging.toml']) {
  let t; try { t = readFileSync(cfg, 'utf8'); } catch { continue; }
  if (!/^main\s*=\s*"src\/index\.ts"/m.test(t)) fail(`${cfg}: main must be src/index.ts`);
  if (/DEV_IDENTITY|src\/dev\.ts/.test(t)) fail(`${cfg}: must not reference the development identity or src/dev.ts`);
  if (cfg !== 'wrangler.toml' && /^\s*PUBLISHING_ENABLED\s*=\s*"true"/m.test(t)) fail(`${cfg}: staging must not enable live publishing`);
  const code = bundle(cfg);
  if (code.includes(MARKER) || code.includes('DEV_IDENTITY_LOCAL')) fail(`${cfg}: deployed bundle contains the local development entry point`);
  else console.log(`${cfg}: deployed bundle clean (${Math.round(code.length / 1024)} kB)`);
}
// Positive control: the check must be able to see the marker when it is there.
if (!bundle('wrangler.dev.toml').includes(MARKER)) fail('positive control failed: marker not found in the local bundle');
if (failed) process.exit(1);
console.log('Production bundle check passed.');
