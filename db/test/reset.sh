#!/bin/sh
# Recrée une base de test locale et applique tous les scripts. Usage : PGHOST=... PGPORT=... sh db/test/reset.sh
set -e
cd "$(dirname "$0")/.."
export PGOPTIONS='-c client_min_messages=warning'
psql -U postgres -q -c "drop database if exists caisse" -c "create database caisse"
for f in test/000_supabase_stub.sql 001_schema.sql 002_views.sql 003_security.sql seed_demo.sql; do
  psql -U postgres -d caisse -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "Base de test prête."
