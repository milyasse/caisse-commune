-- Tests d'intégrité de la base. Chaque bloc doit afficher « OK ».
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create or replace function pg_temp.expect_error(sql text, pattern text, label text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlerrm ~* pattern then raise notice 'OK  %', label; return; end if;
    raise exception 'ÉCHEC % : erreur inattendue « % »', label, sqlerrm;
  end;
  raise exception 'ÉCHEC % : aucune erreur levée', label;
end $$;

-- Membre / cotisation de test
select pg_temp.expect_error($$delete from contribution_payments where true$$, 'Suppression interdite', 'suppression d''un versement refusée');
select pg_temp.expect_error($$delete from members where true$$, 'Suppression interdite', 'suppression d''un membre refusée');
select pg_temp.expect_error($$update audit_logs set reason = 'x' where true$$, 'ajout seul', 'journal d''audit immuable');

select pg_temp.expect_error($$
  insert into contribution_payments (contribution_id, member_id, paid_on, amount)
  select c.id, c.member_id, current_date, c.expected + 1 from v_contribution_status c where status = 'non_paye' limit 1
$$, 'dépasse', 'versement supérieur au reste refusé');

select pg_temp.expect_error($$
  insert into contribution_payments (contribution_id, member_id, paid_on, amount)
  select c.id, c.member_id, current_date + 1, 1 from v_contribution_status c where status = 'non_paye' limit 1
$$, 'futur', 'date future refusée');

select pg_temp.expect_error($$
  insert into contribution_payments (contribution_id, member_id, paid_on, amount)
  select c.id, (select id from members where id <> c.member_id limit 1), current_date, 1 from v_contribution_status c where status = 'non_paye' limit 1
$$, 'membre', 'membre incohérent refusé');

select pg_temp.expect_error($$insert into expenses (spent_on, category_id, description, amount) select current_date, id, 'x', -5 from expense_categories limit 1$$,
  'check', 'montant négatif refusé');

select pg_temp.expect_error($$update contribution_payments set status = 'cancelled' where id = (select id from contribution_payments limit 1)$$,
  'check', 'annulation sans motif refusée');

-- Annulation tracée puis interdiction de « dé-annuler »
update contribution_payments set status = 'cancelled', cancel_reason = 'Test annulation'
 where id = (select id from contribution_payments where paid_on >= date_trunc('month', current_date) order by paid_on limit 1);
select pg_temp.expect_error($$update contribution_payments set status = 'valid' where status = 'cancelled'$$, 'réactivée', 'annulation définitive');
do $$ begin
  if not exists (select 1 from audit_logs where source = 'db' and entity = 'contribution_payments' and action = 'update') then
    raise exception 'ÉCHEC audit serveur absent'; end if;
  raise notice 'OK  audit serveur des modifications';
end $$;

-- Clôture : ordre, cohérence du solde, verrouillage
select pg_temp.expect_error($$insert into month_closures (period, closing_balance) values (date_trunc('month', current_date)::date, 0)$$,
  'terminé', 'clôture du mois en cours refusée');
select pg_temp.expect_error($$insert into month_closures (period, closing_balance)
  select (select min(period) from v_monthly_summary), 1$$, 'incohérent', 'clôture avec un solde faux refusée');
insert into month_closures (period, closing_balance) select period, closing from v_monthly_summary order by period limit 1;
select pg_temp.expect_error($$insert into month_closures (period, closing_balance)
  select period, closing from v_monthly_summary order by period offset 2 limit 1$$, 'abord', 'clôture hors ordre refusée');
select pg_temp.expect_error($$update expenses set amount = amount + 1 where spent_on < (select min(period) + interval '1 month' from v_monthly_summary)$$,
  'clôturé', 'modification dans un mois clôturé refusée');
do $$ declare a numeric; b numeric; begin
  select closing into a from v_monthly_summary order by period limit 1;
  select opening into b from v_monthly_summary order by period offset 1 limit 1;
  if a <> b then raise exception 'ÉCHEC report du solde'; end if;
  raise notice 'OK  solde de clôture reporté en ouverture du mois suivant (%)', b;
end $$;

-- Sécurité (RLS) : un utilisateur non admin ne peut pas modifier les membres
insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000001', 'admin@test'), ('00000000-0000-4000-8000-000000000002', 'user@test');
update app_users set active = true;
grant select, insert, update on all tables in schema public to authenticated;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
select pg_temp.expect_error($$insert into members (name, join_date) values ('Intrus', current_date)$$, 'row-level security', 'RLS : membre réservé aux admins');
do $$ begin
  if (select count(*) from members) = 0 then raise exception 'ÉCHEC lecture autorisée'; end if;
  raise notice 'OK  RLS : lecture autorisée pour un utilisateur actif';
end $$;
set request.jwt.claim.sub = '';
do $$ begin
  if (select count(*) from members) <> 0 then raise exception 'ÉCHEC anonyme voit des données'; end if;
  raise notice 'OK  RLS : aucun accès sans authentification';
end $$;
reset role;
do $$ begin
  if (select role from app_users where id = '00000000-0000-4000-8000-000000000001') <> 'admin' then raise exception 'ÉCHEC 1er utilisateur admin'; end if;
  raise notice 'OK  premier utilisateur inscrit = administrateur';
end $$;
