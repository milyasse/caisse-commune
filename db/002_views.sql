-- =====================================================================
-- 002_views.sql — Calculs côté base (mêmes règles que src/domain/finance.ts)
-- =====================================================================

-- État de chaque cotisation : versé (sans double comptage), reste, statut, retard
create or replace view v_contribution_status as
select c.id, c.member_id, m.name as member_name, c.period, c.expected, c.due_date, c.overridden,
       coalesce(p.paid, 0)                                   as paid,
       greatest(c.expected - coalesce(p.paid, 0), 0)         as remaining,
       case when coalesce(p.paid, 0) >= c.expected then 'paye'
            when coalesce(p.paid, 0) > 0 then 'partiel'
            else 'non_paye' end                              as status,
       (coalesce(p.paid, 0) < c.expected and current_date > c.due_date) as late,
       p.last_paid_on
from monthly_contributions c
join members m on m.id = c.member_id
left join (
  select contribution_id, sum(amount) as paid, max(paid_on) as last_paid_on
  from contribution_payments where status = 'valid' group by contribution_id
) p on p.contribution_id = c.id
-- mois postérieurs à la sortie du membre, sans versement : non dus (même règle que isWaived)
where not (m.left_date is not null and c.period >= m.left_date and coalesce(p.paid, 0) = 0);

-- Synthèse mensuelle de trésorerie : ouverture, attendu, encaissé (date réelle),
-- dépenses (date réelle), clôture, reste à encaisser.
create or replace view v_monthly_summary as
with ob as (
  select coalesce(sum(amount), 0) as amount, min(balance_date) as d from opening_balances
),
bounds as (
  select date_trunc('month', coalesce((select d from ob), current_date))::date as first,
         date_trunc('month', greatest(current_date,
           coalesce((select max(period) from monthly_contributions), current_date)))::date as last
),
months as (
  select generate_series(first, last, interval '1 month')::date as period from bounds
),
rec as (
  select date_trunc('month', p.paid_on)::date as period, sum(p.amount) as amount
  from contribution_payments p, ob where p.status = 'valid' and p.paid_on >= coalesce(ob.d, p.paid_on) group by 1
),
dep as (
  select date_trunc('month', e.spent_on)::date as period, sum(e.amount) as amount
  from expenses e, ob where e.status = 'valid' and e.spent_on >= coalesce(ob.d, e.spent_on) group by 1
),
att as (
  select period, sum(expected) as expected, sum(remaining) as remaining,
         count(*) filter (where status = 'paye') as paid_count,
         count(*) filter (where status = 'partiel') as partial_count,
         count(*) filter (where status = 'non_paye') as unpaid_count
  from v_contribution_status group by period
),
flows as (
  select m.period,
         coalesce(att.expected, 0) as expected, coalesce(att.remaining, 0) as remaining,
         coalesce(rec.amount, 0) as received, coalesce(dep.amount, 0) as expenses,
         coalesce(att.paid_count, 0) as paid_count, coalesce(att.partial_count, 0) as partial_count,
         coalesce(att.unpaid_count, 0) as unpaid_count
  from months m
  left join att on att.period = m.period
  left join rec on rec.period = m.period
  left join dep on dep.period = m.period
)
select f.period,
       (select amount from ob) + coalesce(sum(f.received - f.expenses) over w_prev, 0) as opening,
       f.expected, f.received, f.expenses,
       (select amount from ob) + sum(f.received - f.expenses) over w_cur              as closing,
       f.remaining, f.paid_count, f.partial_count, f.unpaid_count
from flows f
window w_prev as (order by f.period rows between unbounded preceding and 1 preceding),
       w_cur  as (order by f.period rows between unbounded preceding and current row);

-- Synthèse annuelle
create or replace view v_yearly_summary as
select extract(year from period)::int as year,
       (array_agg(opening order by period))[1]       as opening,
       sum(received) as received, sum(expenses) as expenses,
       (array_agg(closing order by period desc))[1]  as closing,
       sum(expected) as expected, sum(remaining) as remaining
from v_monthly_summary group by 1;

-- Solde de trésorerie actuel (calculé, jamais stocké)
create or replace view v_current_balance as
select (select coalesce(sum(amount), 0) from opening_balances)
     + (select coalesce(sum(amount), 0) from contribution_payments where status = 'valid' and paid_on <= current_date)
     - (select coalesce(sum(amount), 0) from expenses where status = 'valid' and spent_on <= current_date) as balance;

drop trigger if exists month_closures_check on month_closures;
create trigger month_closures_check before insert or update on month_closures
  for each row execute function check_closure();

-- Note : la génération des cotisations mensuelles est faite par l'application avec des
-- identifiants déterministes (membre + mois) pour que plusieurs appareils hors ligne
-- produisent le MÊME identifiant ; la contrainte unique (member_id, period) protège la base.
