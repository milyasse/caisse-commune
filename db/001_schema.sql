-- =====================================================================
-- Caisse commune — schéma PostgreSQL (Supabase)            001_schema.sql
-- Montants : numeric(12,2) (jamais de float). Dates : date. Périodes : 1er du mois.
-- Aucune suppression physique des opérations financières (trigger).
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- Utilisateurs & rôles
create table if not exists app_users (
  id            uuid primary key,                         -- = auth.users.id sur Supabase
  display_name  text not null check (length(trim(display_name)) > 0),
  role          text not null default 'user' check (role in ('admin', 'user')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- Paramètres & caisses
create table if not exists app_settings (
  id                      smallint primary key default 1 check (id = 1),   -- ligne unique
  group_name              text not null default 'Caisse commune',
  due_day                 smallint not null default 0 check (due_day between 0 and 28), -- 0 = fin de mois
  large_expense_threshold numeric(12,2) not null default 1000 check (large_expense_threshold >= 0),
  is_demo                 boolean not null default false,
  updated_at              timestamptz not null default now()
);

create table if not exists cash_accounts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index if not exists cash_accounts_one_default on cash_accounts (is_default) where is_default;

create table if not exists opening_balances (
  id               uuid primary key default gen_random_uuid(),
  cash_account_id  uuid not null references cash_accounts(id) on delete restrict,
  balance_date     date not null,
  amount           numeric(12,2) not null,
  updated_at       timestamptz not null default now(),
  unique (cash_account_id)
);

-- ---------------------------------------------------------------- Membres
create table if not exists members (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) > 0),
  join_date       date not null,
  active          boolean not null default true,
  default_amount  numeric(12,2) not null default 0 check (default_amount >= 0),
  phone           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists members_name_uq on members (lower(name));

-- Historique des montants : la règle applicable à un mois est la plus récente valid_from <= mois
create table if not exists contribution_rules (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id) on delete restrict,
  amount      numeric(12,2) not null check (amount >= 0),
  valid_from  date not null check (extract(day from valid_from) = 1),
  updated_at  timestamptz not null default now(),
  unique (member_id, valid_from)
);

-- ---------------------------------------------------------------- Cotisations attendues
create table if not exists monthly_contributions (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id) on delete restrict,
  period      date not null check (extract(day from period) = 1),
  expected    numeric(12,2) not null check (expected >= 0),
  due_date    date not null,
  overridden  boolean not null default false,
  note        text,
  updated_at  timestamptz not null default now(),
  unique (member_id, period),
  check (due_date >= period)
);
create index if not exists monthly_contributions_period_idx on monthly_contributions (period);

-- ---------------------------------------------------------------- Versements réels
create table if not exists contribution_payments (
  id               uuid primary key default gen_random_uuid(),   -- fourni par l'appareil (idempotence)
  contribution_id  uuid not null references monthly_contributions(id) on delete restrict,
  member_id        uuid not null references members(id) on delete restrict,
  cash_account_id  uuid references cash_accounts(id) on delete restrict,
  paid_on          date not null,                                -- date RÉELLE d'encaissement
  amount           numeric(12,2) not null check (amount > 0),
  method           text not null default 'especes' check (method in ('especes', 'virement', 'autre')),
  reference        text,
  comment          text,
  status           text not null default 'valid' check (status in ('valid', 'cancelled')),
  cancel_reason    text,
  created_by       text,
  updated_at       timestamptz not null default now(),
  check (status = 'valid' or length(trim(coalesce(cancel_reason, ''))) >= 3)
);
create index if not exists payments_contribution_idx on contribution_payments (contribution_id) where status = 'valid';
create index if not exists payments_paid_on_idx on contribution_payments (paid_on);
create index if not exists payments_member_idx on contribution_payments (member_id);
create index if not exists payments_updated_idx on contribution_payments (updated_at);

-- ---------------------------------------------------------------- Dépenses
create table if not exists expense_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);
create unique index if not exists expense_categories_name_uq on expense_categories (lower(name));

create table if not exists expenses (
  id               uuid primary key default gen_random_uuid(),
  spent_on         date not null,
  category_id      uuid not null references expense_categories(id) on delete restrict,
  cash_account_id  uuid references cash_accounts(id) on delete restrict,
  description      text not null check (length(trim(description)) > 0),
  beneficiary      text not null default '',
  amount           numeric(12,2) not null check (amount > 0),
  method           text not null default 'especes' check (method in ('especes', 'virement', 'autre')),
  reference        text,
  comment          text,
  receipt_path     text,                                   -- objet du bucket privé « receipts »
  status           text not null default 'valid' check (status in ('valid', 'cancelled')),
  cancel_reason    text,
  created_by       text,
  updated_at       timestamptz not null default now(),
  check (status = 'valid' or length(trim(coalesce(cancel_reason, ''))) >= 3)
);
create index if not exists expenses_spent_on_idx on expenses (spent_on);
create index if not exists expenses_category_idx on expenses (category_id);
create index if not exists expenses_updated_idx on expenses (updated_at);

-- ---------------------------------------------------------------- Clôtures mensuelles
create table if not exists month_closures (
  id               uuid primary key default gen_random_uuid(),
  period           date not null check (extract(day from period) = 1),
  closing_balance  numeric(12,2) not null,
  closed_at        timestamptz not null default now(),
  closed_by        text,
  reopened         boolean not null default false,
  updated_at       timestamptz not null default now()
);
create unique index if not exists month_closures_active_uq on month_closures (period) where not reopened;

-- ---------------------------------------------------------------- Journal d'audit (ajout seul)
create table if not exists audit_logs (
  id         uuid primary key default gen_random_uuid(),
  at         timestamptz not null default now(),
  user_name  text,
  action     text not null,
  entity     text not null,
  entity_id  text not null,
  before     jsonb,
  after      jsonb,
  reason     text,
  source     text not null default 'app' check (source in ('app', 'db'))
);
create index if not exists audit_logs_entity_idx on audit_logs (entity, entity_id);
create index if not exists audit_logs_at_idx on audit_logs (at);

-- =====================================================================
-- Règles d'intégrité (triggers)
-- =====================================================================

-- 1) Interdiction de suppression physique des données financières
create or replace function forbid_delete() returns trigger language plpgsql as $$
begin
  raise exception 'Suppression interdite sur % : utilisez une annulation tracée.', tg_table_name
    using errcode = 'P0001';
end $$;

do $$ declare t text; begin
  foreach t in array array['members','contribution_rules','monthly_contributions','contribution_payments',
                           'expenses','expense_categories','month_closures','audit_logs','opening_balances'] loop
    execute format('drop trigger if exists %I_no_delete on %I', t, t);
    execute format('create trigger %I_no_delete before delete on %I for each row execute function forbid_delete()', t, t);
  end loop;
end $$;

-- 2) Le journal d'audit est immuable
create or replace function forbid_update() returns trigger language plpgsql as $$
begin raise exception 'Le journal d''audit est en ajout seul.'; end $$;
drop trigger if exists audit_logs_no_update on audit_logs;
create trigger audit_logs_no_update before update on audit_logs for each row execute function forbid_update();

-- 3) Mois clôturé = opérations verrouillées
create or replace function is_closed(d date) returns boolean language sql stable as $$
  select exists (select 1 from month_closures where period = date_trunc('month', d)::date and not reopened)
$$;

-- 4) Contrôles des versements : cohérence membre, pas de dépassement, pas de « dé-annulation »
create or replace function check_payment() returns trigger language plpgsql as $$
declare c monthly_contributions; already numeric(12,2);
begin
  select * into c from monthly_contributions where id = new.contribution_id;
  if c.member_id <> new.member_id then
    raise exception 'Le versement ne correspond pas au membre de la cotisation.';
  end if;
  if tg_op = 'UPDATE' and old.status = 'cancelled' and new.status = 'valid' then
    raise exception 'Une opération annulée ne peut pas être réactivée.';
  end if;
  if is_closed(new.paid_on) or (tg_op = 'UPDATE' and is_closed(old.paid_on)) then
    raise exception 'Mois clôturé : opération verrouillée.';
  end if;
  if new.paid_on > current_date then
    raise exception 'Date d''encaissement dans le futur.';
  end if;
  if new.status = 'valid' then
    select coalesce(sum(amount), 0) into already from contribution_payments
     where contribution_id = new.contribution_id and status = 'valid' and id <> new.id;
    if already + new.amount > c.expected then
      raise exception 'Le versement dépasse le montant attendu (reste : %).', c.expected - already;
    end if;
  end if;
  new.updated_at := greatest(new.updated_at, now());
  return new;
end $$;
drop trigger if exists contribution_payments_check on contribution_payments;
create trigger contribution_payments_check before insert or update on contribution_payments
  for each row execute function check_payment();

-- 5) Contrôles des dépenses
create or replace function check_expense() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.status = 'cancelled' and new.status = 'valid' then
    raise exception 'Une opération annulée ne peut pas être réactivée.';
  end if;
  if is_closed(new.spent_on) or (tg_op = 'UPDATE' and is_closed(old.spent_on)) then
    raise exception 'Mois clôturé : opération verrouillée.';
  end if;
  if new.spent_on > current_date then
    raise exception 'Date de dépense dans le futur.';
  end if;
  new.updated_at := greatest(new.updated_at, now());
  return new;
end $$;
drop trigger if exists expenses_check on expenses;
create trigger expenses_check before insert or update on expenses for each row execute function check_expense();

-- 6) L'attendu d'une cotisation ne peut descendre sous le déjà versé
create or replace function check_contribution() returns trigger language plpgsql as $$
declare paid numeric(12,2);
begin
  select coalesce(sum(amount), 0) into paid from contribution_payments where contribution_id = new.id and status = 'valid';
  if new.expected < paid then
    raise exception 'Montant attendu (%) inférieur au déjà versé (%).', new.expected, paid;
  end if;
  if tg_op = 'UPDATE' and new.expected <> old.expected and is_closed(new.period) then
    raise exception 'Mois clôturé : cotisation verrouillée.';
  end if;
  new.updated_at := greatest(new.updated_at, now());
  return new;
end $$;
drop trigger if exists monthly_contributions_check on monthly_contributions;
create trigger monthly_contributions_check before insert or update on monthly_contributions
  for each row execute function check_contribution();

-- 7) Horodatage serveur (curseur de synchronisation fiable) pour les autres tables
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := greatest(new.updated_at, now()); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['members','contribution_rules','expense_categories','month_closures','opening_balances','app_settings'] loop
    execute format('drop trigger if exists %I_touch on %I', t, t);
    execute format('create trigger %I_touch before insert or update on %I for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

-- 8) Audit serveur automatique (en plus de l'audit applicatif) : trace toute modification
create or replace function db_audit() returns trigger language plpgsql as $$
begin
  insert into audit_logs (user_name, action, entity, entity_id, before, after, source)
  values (coalesce(current_setting('request.jwt.claim.email', true), current_user),
          lower(tg_op), tg_table_name, new.id::text,
          case when tg_op = 'UPDATE' then to_jsonb(old) end, to_jsonb(new), 'db');
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['members','contribution_rules','monthly_contributions','contribution_payments',
                           'expenses','month_closures','opening_balances'] loop
    execute format('drop trigger if exists %I_audit on %I', t, t);
    execute format('create trigger %I_audit after insert or update on %I for each row execute function db_audit()', t, t);
  end loop;
end $$;

-- 9) Clôture : uniquement un mois terminé, dans l'ordre, au solde recalculé
create or replace function check_closure() returns trigger language plpgsql as $$
declare expected_balance numeric(12,2); prev date := (new.period - interval '1 month')::date; first date;
begin
  if new.reopened then return new; end if;
  if new.period >= date_trunc('month', current_date)::date then
    raise exception 'Seul un mois terminé peut être clôturé.';
  end if;
  select date_trunc('month', min(balance_date))::date into first from opening_balances;
  if first is not null and new.period > first
     and not exists (select 1 from month_closures where period = prev and not reopened) then
    raise exception 'Clôturez d''abord le mois %.', to_char(prev, 'MM/YYYY');
  end if;
  select closing into expected_balance from v_monthly_summary where period = new.period;
  if expected_balance is not null and expected_balance <> new.closing_balance then
    raise exception 'Solde de clôture incohérent (calculé : %, reçu : %).', expected_balance, new.closing_balance;
  end if;
  return new;
end $$;
-- (le trigger est créé dans 002_views.sql, après la vue v_monthly_summary)

-- ---------------------------------------------------------------- Données de référence
insert into app_settings (id) values (1) on conflict do nothing;
insert into cash_accounts (name, is_default) values ('Caisse principale', true) on conflict do nothing;
insert into expense_categories (name) values
  ('Paiement du personnel'), ('Charges communes'), ('Achat de matériel'),
  ('Entretien et réparation'), ('Autres dépenses')
on conflict do nothing;
