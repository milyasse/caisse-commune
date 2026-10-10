-- Simule le minimum de Supabase (schéma auth, rôle authenticated) pour tester
-- les scripts sur un PostgreSQL local. NE PAS exécuter sur Supabase.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public, auth to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
