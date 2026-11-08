// Minimal Cloudflare D1 stand-in backed by real SQLite (node:sqlite), built
// from the repository's own schema files, so tests exercise real SQL,
// constraints, triggers and transactions rather than a hand-written fake.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export const SCHEMAS = ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql', 'schema_v6.sql', 'schema_v7.sql', 'schema_v8.sql', 'schema_v9.sql', 'schema_v10.sql', 'schema_v11.sql'];
const clean = (a: unknown[]) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)) as any[];

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args); }
  async first<T = any>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...clean(this.args)) as any;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T = any>() { return { results: this.db.prepare(this.sql).all(...clean(this.args)).map((r: any) => ({ ...r })) as T[] }; }
  async run() { return this.runSync(); }
  runSync() { const r = this.db.prepare(this.sql).run(...clean(this.args)); return { success: true, meta: { changes: Number(r.changes) } }; }
}

export function makeD1(schemas: string[] = SCHEMAS) {
  const db = new DatabaseSync(':memory:');
  for (const f of schemas) db.exec(readFileSync(f, 'utf8'));
  return {
    raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.runSync());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
