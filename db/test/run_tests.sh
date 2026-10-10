#!/bin/sh
# Tests de la base sur un PostgreSQL local :
#  1) les vues SQL donnent exactement les mêmes soldes que le moteur TypeScript ;
#  2) les règles d'intégrité et la sécurité (RLS) se comportent comme prévu.
set -e
cd "$(dirname "$0")/../.."
node scripts/gen-seed-sql.ts "$(date +%F)" >/dev/null
sh db/test/reset.sh >/dev/null
psql -U postgres -d caisse -At -c "select json_agg(json_build_object('period', period::text, 'opening', opening::text, 'expected', expected::text, 'received', received::text, 'expenses', expenses::text, 'closing', closing::text, 'remaining', remaining::text) order by period) from v_monthly_summary" > /tmp/sql_summary.json
node -e '
const a = JSON.parse(require("fs").readFileSync("db/test/expected_demo.json"));
const b = JSON.parse(require("fs").readFileSync("/tmp/sql_summary.json"));
const diff = a.filter((x, i) => JSON.stringify(x) !== JSON.stringify(b[i]));
if (diff.length || a.length !== b.length) { console.error("ÉCHEC : SQL ≠ TypeScript", diff, b); process.exit(1); }
console.log("OK  vues SQL identiques au moteur TypeScript sur " + a.length + " mois");'
psql -U postgres -d caisse -q -f db/test/integrity_tests.sql 2>&1 | sed -n 's/.*NOTICE:  //p'
