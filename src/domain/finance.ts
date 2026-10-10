/**
 * Moteur de calcul financier — fonctions PURES, sans effet de bord.
 * Toutes les valeurs affichées sont recalculées à partir des opérations.
 *
 * Règles (cf. docs/ANALYSE.md §3) :
 *  - Encaissé du mois  = versements VALIDES dont la DATE RÉELLE tombe dans le mois (trésorerie).
 *  - Imputé au mois    = versements valides rattachés aux cotisations DU mois (quelle que soit leur date).
 *  - Reste à encaisser = Σ max(0, attendu − imputé) sur les cotisations du mois. Jamais compté en caisse.
 *  - Clôture = ouverture + encaissé − dépenses.
 *  - Ouverture(mois) = solde initial + encaissements − dépenses de toutes les dates antérieures.
 */
import type { AppState, Cents, ContributionStatus, ISODate, MonthlyContribution, Period, Payment, Expense } from './types.ts';
import { addMonths, makePeriod, periodEnd, periodOf, periodStart, periodsBetween, todayISO } from './dates.ts';
import { sum } from './money.ts';

export const validPayments = (s: AppState) => s.payments.filter((p) => p.status === 'valid');
export const validExpenses = (s: AppState) => s.expenses.filter((e) => e.status === 'valid');

const inRange = (d: ISODate, from: ISODate, to: ISODate) => d >= from && d <= to;
const afterOpening = (s: AppState, d: ISODate) => d >= s.settings.openingDate;

/** Total versé (valide) pour une cotisation — base de l'anti double-comptage. */
export function paidFor(s: AppState, contributionId: string): Cents {
  return sum(validPayments(s).filter((p) => p.contributionId === contributionId).map((p) => p.amount));
}

export function contributionStatus(expected: Cents, paid: Cents): ContributionStatus {
  if (paid <= 0) return expected === 0 ? 'paye' : 'non_paye';
  return paid >= expected ? 'paye' : 'partiel';
}

export interface ContributionRow {
  contribution: MonthlyContribution;
  memberName: string;
  paid: Cents;
  remaining: Cents;
  status: ContributionStatus;
  late: boolean;
  lastPaymentDate?: ISODate;
  payments: Payment[];
}

export function contributionRows(s: AppState, period: Period, today = todayISO()): ContributionRow[] {
  const names = new Map(s.members.map((m) => [m.id, m.name]));
  return s.contributions
    .filter((c) => c.period === period)
    .map((c) => {
      const pays = validPayments(s).filter((p) => p.contributionId === c.id).sort((a, b) => a.date.localeCompare(b.date));
      const paid = sum(pays.map((p) => p.amount));
      const status = contributionStatus(c.expected, paid);
      return {
        contribution: c,
        memberName: names.get(c.memberId) ?? '?',
        paid,
        remaining: Math.max(0, c.expected - paid),
        status,
        late: status !== 'paye' && today > c.dueDate,
        lastPaymentDate: pays.at(-1)?.date,
        payments: pays,
      };
    })
    .sort((a, b) => a.memberName.localeCompare(b.memberName, 'fr'));
}

/** Encaissements effectifs (trésorerie) entre deux dates incluses. */
export function receiptsBetween(s: AppState, from: ISODate, to: ISODate): Cents {
  return sum(validPayments(s).filter((p) => afterOpening(s, p.date) && inRange(p.date, from, to)).map((p) => p.amount));
}
export function expensesBetween(s: AppState, from: ISODate, to: ISODate): Cents {
  return sum(validExpenses(s).filter((e) => afterOpening(s, e.date) && inRange(e.date, from, to)).map((e) => e.amount));
}

/** Solde de trésorerie à la fin d'une date (incluse). */
export function balanceAt(s: AppState, date: ISODate): Cents {
  const from = s.settings.openingDate;
  if (date < from) return s.settings.openingBalance;
  return s.settings.openingBalance + receiptsBetween(s, from, date) - expensesBetween(s, from, date);
}

/** Solde la veille d'une date. */
export function balanceBefore(s: AppState, date: ISODate): Cents {
  const from = s.settings.openingDate;
  if (date <= from) return s.settings.openingBalance;
  return s.settings.openingBalance + receiptsBetween(s, from, prevDay(date)) - expensesBetween(s, from, prevDay(date));
}

function prevDay(d: ISODate): ISODate {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

export interface MonthSummary {
  period: Period;
  opening: Cents;
  expected: Cents;
  received: Cents; // trésorerie (date réelle dans le mois)
  allocated: Cents; // versements imputés aux cotisations du mois
  expenses: Cents;
  closing: Cents;
  remaining: Cents; // reste à encaisser (≠ argent en caisse)
  paidCount: number;
  partialCount: number;
  unpaidCount: number;
  lateCount: number;
  closure?: { closingBalance: Cents; matches: boolean };
}

export function monthSummary(s: AppState, period: Period, today = todayISO()): MonthSummary {
  const from = periodStart(period);
  const to = periodEnd(period);
  const rows = contributionRows(s, period, today);
  const opening = balanceBefore(s, from);
  const received = receiptsBetween(s, from, to);
  const expenses = expensesBetween(s, from, to);
  const closing = opening + received - expenses;
  const closure = s.closures.find((c) => c.period === period && !c.reopened);
  return {
    period,
    opening,
    expected: sum(rows.map((r) => r.contribution.expected)),
    received,
    allocated: sum(rows.map((r) => Math.min(r.paid, r.contribution.expected))),
    expenses,
    closing,
    remaining: sum(rows.map((r) => r.remaining)),
    paidCount: rows.filter((r) => r.status === 'paye').length,
    partialCount: rows.filter((r) => r.status === 'partiel').length,
    unpaidCount: rows.filter((r) => r.status === 'non_paye').length,
    lateCount: rows.filter((r) => r.late).length,
    closure: closure ? { closingBalance: closure.closingBalance, matches: closure.closingBalance === closing } : undefined,
  };
}

export interface YearSummary {
  year: number;
  opening: Cents;
  received: Cents;
  expenses: Cents;
  closing: Cents;
  expected: Cents;
  remaining: Cents;
  months: MonthSummary[];
}

export function yearSummary(s: AppState, year: number, today = todayISO()): YearSummary {
  const months = periodsBetween(makePeriod(year, 1), makePeriod(year, 12)).map((p) => monthSummary(s, p, today));
  const opening = balanceBefore(s, `${year}-01-01`);
  const received = sum(months.map((m) => m.received));
  const expenses = sum(months.map((m) => m.expenses));
  return {
    year,
    opening,
    received,
    expenses,
    closing: opening + received - expenses,
    expected: sum(months.map((m) => m.expected)),
    remaining: sum(months.map((m) => m.remaining)),
    months,
  };
}

/** Tableau annuel « façon Excel » : une ligne par mois, colonnes par membre. */
export interface AnnualRow {
  period: Period;
  expectedByMember: Record<string, Cents>;
  paidByMember: Record<string, Cents>; // imputé au mois
  totalAllocated: Cents;
  received: Cents; // trésorerie
  cumulativeReceived: Cents;
  expenses: Cents;
  monthlyBalance: Cents; // encaissé − dépenses
  closing: Cents; // solde cumulé fin de mois
}

export function annualTable(s: AppState, year: number): AnnualRow[] {
  let cumul = 0;
  return yearSummary(s, year).months.map((m) => {
    const rows = contributionRows(s, m.period);
    const expectedByMember: Record<string, Cents> = {};
    const paidByMember: Record<string, Cents> = {};
    for (const r of rows) {
      expectedByMember[r.contribution.memberId] = r.contribution.expected;
      paidByMember[r.contribution.memberId] = r.paid;
    }
    cumul += m.received;
    return {
      period: m.period,
      expectedByMember,
      paidByMember,
      totalAllocated: sum(rows.map((r) => r.paid)),
      received: m.received,
      cumulativeReceived: cumul,
      expenses: m.expenses,
      monthlyBalance: m.received - m.expenses,
      closing: m.closing,
    };
  });
}

export interface MemberStats {
  totalPaid: Cents;
  expectedInRange: Cents;
  remainingInRange: Cents;
}

export function memberStats(s: AppState, memberId: string, fromP: Period, toP: Period): MemberStats {
  const totalPaid = sum(validPayments(s).filter((p) => p.memberId === memberId).map((p) => p.amount));
  const contribs = s.contributions.filter((c) => c.memberId === memberId && c.period >= fromP && c.period <= toP);
  const expectedInRange = sum(contribs.map((c) => c.expected));
  const remainingInRange = sum(contribs.map((c) => Math.max(0, c.expected - paidFor(s, c.id))));
  return { totalPaid, expectedInRange, remainingInRange };
}

/** Montant applicable à un membre pour une période (dernière règle dont validFrom ≤ période). */
export function amountFor(s: AppState, memberId: string, period: Period): Cents {
  const rules = s.rules.filter((r) => r.memberId === memberId && r.validFrom <= period).sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  if (rules.length) return rules[0].amount;
  return s.members.find((m) => m.id === memberId)?.defaultAmount ?? 0;
}

/** Évolution du solde de fin de mois sur N mois jusqu'à `to`. */
export function balanceSeries(s: AppState, to: Period, n = 12): { period: Period; closing: Cents; received: Cents; expenses: Cents }[] {
  return periodsBetween(addMonths(to, -(n - 1)), to).map((p) => {
    const m = monthSummary(s, p);
    return { period: p, closing: m.closing, received: m.received, expenses: m.expenses };
  });
}

export type Operation =
  | { kind: 'payment'; date: ISODate; amount: Cents; item: Payment }
  | { kind: 'expense'; date: ISODate; amount: Cents; item: Expense };

export function allOperations(s: AppState): Operation[] {
  const ops: Operation[] = [
    ...s.payments.map((p) => ({ kind: 'payment' as const, date: p.date, amount: p.amount, item: p })),
    ...s.expenses.map((e) => ({ kind: 'expense' as const, date: e.date, amount: e.amount, item: e })),
  ];
  return ops.sort((a, b) => b.date.localeCompare(a.date) || b.item.updatedAt.localeCompare(a.item.updatedAt));
}

export const isClosed = (s: AppState, d: ISODate) => s.closures.some((c) => c.period === periodOf(d) && !c.reopened);
