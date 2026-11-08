#!/usr/bin/env bash
# Migration rehearsal on an ISOLATED COPY of the live IMI database.
# Live is only read (export). Everything is applied to a new, separate database,
# imi-db-migtest, which no Worker uses. Remove it afterwards (step 7).
#   ./scripts/migration-rehearsal.sh
set -euo pipefail
LIVE=imi-db
TEST=imi-db-migtest
COUNTS="SELECT (SELECT COUNT(*) FROM inbox_items) AS inbox, (SELECT COUNT(*) FROM intelligence_records) AS records, (SELECT COUNT(*) FROM decision_items) AS decisions, (SELECT COUNT(*) FROM outcome_items) AS outcomes, (SELECT COUNT(*) FROM campaigns) AS campaigns"

echo "== 1/7 Read-only export of the live database (a few seconds)"
npx wrangler d1 export "$LIVE" --remote --output migtest-live-export.sql

echo "== 2/7 Create the isolated copy: $TEST"
npx wrangler d1 create "$TEST" > /dev/null
ID=$(npx wrangler d1 info "$TEST" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).uuid))')
cat > wrangler.migtest.toml <<TOML
# Temporary, for the rehearsal only. Not deployed. Delete with the database.
name = "imi-migtest-not-deployed"
main = "src/index.ts"
compatibility_date = "2026-07-17"
[[d1_databases]]
binding = "DB"
database_name = "$TEST"
database_id = "$ID"
TOML
q() { npx wrangler d1 execute "$TEST" -c wrangler.migtest.toml --remote -y "$@"; }
q --file=migtest-live-export.sql > /dev/null

echo "== 3/7 BEFORE (copy of live)"
q --command "$COUNTS"

echo "== 4/7 Apply schema_v8, schema_v9, schema_v10, then the approved assignment"
for f in schema_v8.sql schema_v9.sql schema_v10.sql scripts/assign-workspaces.sql; do echo "   $f"; q --file="$f" > /dev/null; done

echo "== 5/7 AFTER: counts must equal BEFORE"
q --command "$COUNTS"

echo "== 6/7 Checks: brand per table, unassigned rows, broken links, code numbering"
q --command "SELECT 'inbox' AS t, workspace_id, COUNT(*) AS n FROM inbox_items GROUP BY workspace_id"
q --command "SELECT 'records' AS t, workspace_id, COUNT(*) AS n FROM intelligence_records GROUP BY workspace_id"
q --command "SELECT (SELECT COUNT(*) FROM inbox_items WHERE workspace_id IS NULL) AS inbox_unassigned, (SELECT COUNT(*) FROM intelligence_records WHERE workspace_id IS NULL) AS records_unassigned"
q --command "PRAGMA foreign_key_check"
q --command "SELECT name, n FROM code_counters ORDER BY name"

echo "== 7/7 Done. The live database was only read."
echo "   Remove the copy when finished:  npx wrangler d1 delete $TEST -y && rm wrangler.migtest.toml migtest-live-export.sql"
