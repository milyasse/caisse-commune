-- =====================================================================
-- 003_security.sql — Row Level Security (Supabase)
-- Rôles : admin (tout), user = « utilisateur autorisé » (saisie et corrections
-- des cotisations/dépenses, lecture de tout). Les anonymes n'ont accès à rien.
-- Requiert le schéma « auth » de Supabase (auth.uid()).
-- =====================================================================

create or replace function current_app_role() returns text
language sql stable security definer set search_path = public as $$
  select role from app_users where id = auth.uid() and active
$$;
create or replace function is_authorized() returns boolean language sql stable as $$ select current_app_role() is not null $$;
create or replace function is_admin() returns boolean language sql stable as $$ select current_app_role() = 'admin' $$;

-- Premier utilisateur inscrit = administrateur ; les suivants doivent être activés par un admin.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into app_users (id, display_name, role, active)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
          case when exists (select 1 from app_users) then 'user' else 'admin' end,
          not exists (select 1 from app_users));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

do $$ declare t text; begin
  foreach t in array array['app_users','app_settings','cash_accounts','opening_balances','members','contribution_rules',
                           'monthly_contributions','contribution_payments','expense_categories','expenses',
                           'month_closures','audit_logs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select to authenticated using (is_authorized())', t, t);
  end loop;
end $$;

-- Saisie courante : utilisateurs autorisés
do $$ declare t text; begin
  foreach t in array array['monthly_contributions','contribution_payments','expenses'] loop
    execute format('drop policy if exists %I_ins on %I', t, t);
    execute format('create policy %I_ins on %I for insert to authenticated with check (is_authorized())', t, t);
    execute format('drop policy if exists %I_upd on %I', t, t);
    execute format('create policy %I_upd on %I for update to authenticated using (is_authorized()) with check (is_authorized())', t, t);
  end loop;
end $$;

-- Paramétrage : administrateurs uniquement
do $$ declare t text; begin
  foreach t in array array['app_settings','cash_accounts','opening_balances','members','contribution_rules',
                           'expense_categories','month_closures','app_users'] loop
    execute format('drop policy if exists %I_admin_ins on %I', t, t);
    execute format('create policy %I_admin_ins on %I for insert to authenticated with check (is_admin())', t, t);
    execute format('drop policy if exists %I_admin_upd on %I', t, t);
    execute format('create policy %I_admin_upd on %I for update to authenticated using (is_admin()) with check (is_admin())', t, t);
  end loop;
end $$;

-- Audit : ajout par les utilisateurs autorisés, jamais de modification (trigger + aucune policy update)
drop policy if exists audit_logs_ins on audit_logs;
create policy audit_logs_ins on audit_logs for insert to authenticated with check (is_authorized() and source = 'app');

-- Aucune policy DELETE nulle part : la suppression est impossible via l'API.

-- Vues : exécutées avec les droits de l'appelant (RLS appliquée)
alter view v_contribution_status set (security_invoker = true);
alter view v_monthly_summary     set (security_invoker = true);
alter view v_yearly_summary      set (security_invoker = true);
alter view v_current_balance     set (security_invoker = true);
