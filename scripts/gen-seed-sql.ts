/**
 * Génère db/seed_demo.sql à partir du jeu de démo TypeScript (une seule source de vérité),
 * ainsi que db/test/expected_demo.json (soldes attendus calculés par le moteur TS)
 * qui sert à vérifier que les vues SQL donnent EXACTEMENT les mêmes résultats.
 *   node scripts/gen-seed-sql.ts [AAAA-MM-JJ]
 */
import { writeFileSync } from 'node:fs';
import { demoState } from '../src/domain/seed.ts';
import { monthSummary } from '../src/domain/finance.ts';
import { addMonths, periodOf, todayISO } from '../src/domain/dates.ts';
import type { AppState } from '../src/domain/types.ts';

const today = process.argv[2] ?? todayISO();
const s: AppState = demoState(today);
const q = (v: unknown) => (v === undefined || v === null ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const m = (c: number) => (c / 100).toFixed(2);
const out: string[] = [
  '-- =====================================================================',
  `-- DONNÉES DE DÉMONSTRATION FICTIVES — générées le ${today} par scripts/gen-seed-sql.ts`,
  '-- À ne pas charger sur une base contenant des données réelles.',
  '-- =====================================================================',
  'begin;',
  "update app_settings set group_name = 'Caisse commune (démo)', is_demo = true, due_day = 0 where id = 1;",
  `insert into opening_balances (cash_account_id, balance_date, amount) select id, ${q(s.settings.openingDate)}, ${m(s.settings.openingBalance)} from cash_accounts where is_default on conflict (cash_account_id) do update set balance_date = excluded.balance_date, amount = excluded.amount;`,
];
const catName = new Map(s.categories.map((c) => [c.id, c.name]));
for (const x of s.members) out.push(`insert into members (id, name, join_date, active, default_amount) values (${q(x.id)}, ${q(x.name)}, ${q(x.joinDate)}, ${x.active}, ${m(x.defaultAmount)});`);
for (const r of s.rules) out.push(`insert into contribution_rules (id, member_id, amount, valid_from) values (${q(r.id)}, ${q(r.memberId)}, ${m(r.amount)}, ${q(r.validFrom + '-01')});`);
for (const c of s.contributions) out.push(`insert into monthly_contributions (id, member_id, period, expected, due_date, overridden) values (${q(c.id)}, ${q(c.memberId)}, ${q(c.period + '-01')}, ${m(c.expected)}, ${q(c.dueDate)}, ${c.overridden});`);
for (const p of s.payments) out.push(`insert into contribution_payments (id, contribution_id, member_id, paid_on, amount, method, comment, created_by) values (${q(p.id)}, ${q(p.contributionId)}, ${q(p.memberId)}, ${q(p.date)}, ${m(p.amount)}, ${q(p.method)}, ${q(p.comment)}, 'Démo');`);
for (const e of s.expenses) out.push(`insert into expenses (id, spent_on, category_id, description, beneficiary, amount, method, created_by) select ${q(e.id)}, ${q(e.date)}, id, ${q(e.description)}, ${q(e.beneficiary)}, ${m(e.amount)}, ${q(e.method)}, 'Démo' from expense_categories where name = ${q(catName.get(e.categoryId))};`);
out.push('commit;', '');
writeFileSync(new URL('../db/seed_demo.sql', import.meta.url), out.join('\n'));

const expected = [];
for (let p = periodOf(s.settings.openingDate); p <= periodOf(today); p = addMonths(p, 1)) {
  const ms = monthSummary(s, p, today);
  expected.push({ period: p + '-01', opening: m(ms.opening), expected: m(ms.expected), received: m(ms.received), expenses: m(ms.expenses), closing: m(ms.closing), remaining: m(ms.remaining) });
}
writeFileSync(new URL('../db/test/expected_demo.json', import.meta.url), JSON.stringify(expected, null, 1));
console.log(`seed_demo.sql : ${out.length} lignes ; ${expected.length} mois attendus`);
