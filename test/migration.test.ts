// Migration rehearsal: a database shaped like live IMI on 8 Nov 2026 (schemas up to
// v8; 6 inbox items and 4 records, all labelled Iddav), then v9, v10 and the
// assignment script, exactly as they would run on Cloudflare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeD1, SCHEMAS } from './helpers/d1.ts';
import { createWorker } from '../src/index.ts';

const BEFORE = SCHEMAS.filter((f) => !['schema_v8.sql', 'schema_v9.sql', 'schema_v10.sql', 'schema_v11.sql', 'schema_v12.sql'].includes(f)); // live may not have v8 yet
const IDDAV = 'iddav-marketing-intelligence';

function liveShaped() {
  const DB = makeD1(BEFORE);
  const ins = DB.raw.prepare(`INSERT INTO inbox_items (id, code, domain, type, date, summary, origin, submitted_by, submitter_role, retrospective, status, full_text, source_category, source_type, created_at)
    VALUES (?, ?, ?, ?, '2026-10-01', ?, ?, 'Founder / Admin', 'owner_admin', 'none', ?, ?, ?, ?, ?)`);
  const rows = [
    ['C_scientific_research', 'SCIENTIFIC', 'secondary_external', 'evidence'], ['C_scientific_research', 'SCIENTIFIC', 'secondary_external', 'evidence'],
    ['A_wildlife_tiger_india', 'OFFICIAL', 'original', 'evidence'], ['B_global_biodiversity', 'OFFICIAL', 'secondary_external', 'evidence'],
    ['B_global_biodiversity', 'SCIENTIFIC', 'secondary_external', 'observation'], ['P_social_conversation', 'SOCIAL', 'primary_external', 'outcome'],
  ];
  rows.forEach(([cat, st, origin, type], i) => ins.run(`inb-${i + 1}`, `INB-000${i + 1}`, IDDAV, type, `LIVE item ${i + 1}`, origin, i < 2 ? 'pending' : 'promoted', `text ${i + 1}`, cat, st, `2026-10-0${i + 1} 10:00:00`));
  const rec = DB.raw.prepare(`INSERT INTO intelligence_records (id, code, domain, record_type, title, status, created_at, updated_at, author, author_role, observation_json, learning_strength)
    VALUES (?, ?, ?, 'observation', ?, 'under_review', '2026-10-05', '2026-10-05', 'Founder / Admin', 'owner_admin', '{}', 'provisional')`);
  for (let i = 1; i <= 4; i++) rec.run(`rec-${i}`, `INT-000${i}`, IDDAV, `LIVE record ${i}`);
  return DB;
}
const apply = (DB: any, f: string) => DB.raw.exec(readFileSync(f, 'utf8'));
const counts = (DB: any) => DB.raw.prepare(`SELECT (SELECT COUNT(*) FROM inbox_items) AS inbox, (SELECT COUNT(*) FROM intelligence_records) AS records, (SELECT COUNT(*) FROM decision_items) AS decisions, (SELECT COUNT(*) FROM outcome_items) AS outcomes`).get();

test('rehearsal: v9 + v10 + assignment keep every live row, assign only Iddav-labelled rows, and leave nothing unassigned', () => {
  const DB = liveShaped();
  const before = { ...counts(DB) };
  const snapshot = JSON.stringify(DB.raw.prepare('SELECT id, code, summary, status, full_text FROM inbox_items ORDER BY id').all());
  apply(DB, 'schema_v8.sql'); apply(DB, 'schema_v9.sql'); apply(DB, 'schema_v10.sql');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM inbox_items WHERE workspace_id IS NOT NULL').get().n, 0, 'the schema files assign nothing by themselves');
  apply(DB, 'scripts/assign-workspaces.sql');
  assert.deepEqual({ ...counts(DB) }, before, 'no row lost or added');
  assert.equal(JSON.stringify(DB.raw.prepare('SELECT id, code, summary, status, full_text FROM inbox_items ORDER BY id').all()), snapshot, 'content unchanged');
  for (const t of ['inbox_items', 'intelligence_records']) {
    assert.deepEqual(DB.raw.prepare(`SELECT workspace_id, COUNT(*) AS n FROM ${t} GROUP BY workspace_id`).all().map((r: any) => [r.workspace_id, r.n]), [['ws-iddav', t === 'inbox_items' ? 6 : 4]]);
  }
  assert.equal(DB.raw.prepare('PRAGMA foreign_key_check').all().length, 0, 'all relationships valid');
  assert.deepEqual(DB.raw.prepare("SELECT name, n FROM code_counters ORDER BY name").all().map((r: any) => [r.name, r.n]), [['DEC', 0], ['INB', 6], ['INT', 4]], 'numbering continues after the existing codes');
});

test('rehearsal: a row with another or no label is never assigned by the script', () => {
  const DB = liveShaped();
  DB.raw.prepare(`INSERT INTO inbox_items (id, code, domain, type, date, summary, origin, submitted_by, submitter_role, retrospective, status, full_text)
    VALUES ('other-1', 'INB-0099', 'antardrishti', 'evidence', '2026-11-01', 'NOT IDDAV', 'original', 'x', 'x', 'none', 'pending', 'x')`).run();
  apply(DB, 'schema_v8.sql'); apply(DB, 'schema_v9.sql'); apply(DB, 'schema_v10.sql'); apply(DB, 'scripts/assign-workspaces.sql');
  assert.equal(DB.raw.prepare("SELECT workspace_id FROM inbox_items WHERE id = 'other-1'").get().workspace_id, null);
});

test('rehearsal: after migration the live rows appear for the Iddav owner, not for another brand, and new codes follow on', async () => {
  const DB = liveShaped();
  apply(DB, 'schema_v8.sql'); apply(DB, 'schema_v9.sql'); apply(DB, 'schema_v10.sql'); apply(DB, 'scripts/assign-workspaces.sql');
  DB.raw.prepare("INSERT INTO workspaces (id, tenant_id, name, kind, goal_key, created_at) VALUES ('ws-antardrishti','tnt-rama','Antardrishti','app','sign_ups','2026-11-01')").run();
  DB.raw.prepare("INSERT INTO memberships (id, tenant_id, workspace_id, email, role, created_by, created_at) VALUES ('m1','tnt-rama','ws-iddav','rama@iddav.com','owner','x','x'), ('m2','tnt-rama','ws-antardrishti','ad@x.com','owner','x','x')").run();
  const env = { DB } as any;
  const as = (who: string, method: string, path: string, body?: unknown) => createWorker({ devIdentity: who }).fetch(new Request(`http://localhost:8787${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), env).then(async (r) => ({ status: r.status, data: await r.json() as any }));
  const records = await as('rama@iddav.com', 'GET', '/v1/workspaces/ws-iddav/records');
  assert.equal(records.data.length, 4);
  const inbox = await as('rama@iddav.com', 'GET', '/v1/workspaces/ws-iddav/inbox');
  assert.equal(inbox.data.length, 2, 'the 2 pending items are open; 4 were already promoted');
  assert.deepEqual((await as('ad@x.com', 'GET', '/v1/workspaces/ws-antardrishti/records')).data, []);
  assert.equal((await as('ad@x.com', 'GET', '/v1/workspaces/ws-iddav/records')).status, 404);
  const next = await as('rama@iddav.com', 'POST', '/v1/workspaces/ws-iddav/inbox', { summary: 'First item after migration' });
  assert.equal(next.data.code, 'INB-0007');
});
