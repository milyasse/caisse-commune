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

// ---------------------------------------------------------------- Index mis en cache
// L'état est immuable (chaque commande renvoie un nouvel objet) : on peut donc mettre en cache
// les index calculés pour un état donné. Les écrans recalculent sans parcourir toute la liste
// des opérations à chaque fois (gain important quand l'historique grandit).
function memo<T>(cache: WeakMap<AppState, T>, s: AppState, build: () => T): T {
  let v = cache.get(s);
  if (v === undefined) cache.set(s, (v = build()));
  return v;
}
const vpCache = new WeakMap<AppState, Payment[]>();
const veCache = new WeakMap<AppState, Expense[]>();
const paidCache = new WeakMap<AppState, Map<string, { paid: Cents; list: Payment[] }>>();
const cashCache = new WeakMap<AppState, { dates: ISODate[]; prefix: Cents[]; inDates: ISODate[]; inPrefix: Cents[]; outDates: ISODate[]; outPrefix: Cents[] }>();
const summaryCache = new WeakMap<AppState, Map<string, MonthSummary>>();

export const validPayments = (s: AppState) => memo(vpCache, s, () => s.payments.filter((p) => p.status === 'valid'));
export const validExpenses = (s: AppState) => memo(veCache, s, () => s.expenses.filter((e) => e.status === 'valid'));

const inRange = (d: ISODate, from: ISODate, to: ISODate) => d >= from && d <= to;

function paidIndex(s: AppState) {
  return memo(paidCache, s, () => {
    const m = new Map<string, { paid: Cents; list: Payment[] }>();
    for (const p of validPayments(s)) {
      const e = m.get(p.contributionId) ?? { paid: 0, list: [] };
      e.paid += p.amount;
      e.list.push(p);
      m.set(p.contributionId, e);
    }
    for (const e of m.values()) e.list.sort((a, b) => a.date.localeCompare(b.date));
    return m;
  });
}

/** Total versé (valide) pour une cotisation — base de l'anti double-comptage. */
export function paidFor(s: AppState, contributionId: string): Cents {
  return paidIndex(s).get(contributionId)?.paid ?? 0;
}

/** Sommes cumulées des encaissements et dépenses (à partir du solde initial), triées par date. */
function cashIndex(s: AppState) {
  return memo(cashCache, s, () => {
    const from = s.settings.openingDate;
    const ins = validPayments(s).filter((p) => p.date >= from).map((p) => [p.date, p.amount] as const).sort((a, b) => a[0].localeCompare(b[0]));
    const outs = validExpenses(s).filter((e) => e.date >= from).map((e) => [e.date, e.amount] as const).sort((a, b) => a[0].localeCompare(b[0]));
    const cum = (xs: readonly (readonly [string, number])[]) => {
      const prefix: number[] = [];
      let acc = 0;
      for (const [, a] of xs) prefix.push((acc += a));
      return prefix;
    };
    return { dates: [], prefix: [], inDates: ins.map((x) => x[0]), inPrefix: cum(ins), outDates: outs.map((x) => x[0]), outPrefix: cum(outs) };
  });
}
/** Somme cumulée jusqu'à une date incluse (recherche dichotomique). */
function cumUpTo(dates: ISODate[], prefix: Cents[], d: ISODate): Cents {
  let lo = 0, hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= d) lo = mid + 1;
    else hi = mid;
  }
  return lo ? prefix[lo - 1] : 0;
}
const dayBefore = (d: ISODate) => {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
};

/** Le membre doit-il une cotisation pour ce mois ? (adhésion et date de sortie) */
export function isOwedFor(m: { joinDate: ISODate; leftDate?: ISODate; active?: boolean }, period: Period): boolean {
  if (m.joinDate > periodEnd(period)) return false;
  if (m.leftDate) return periodStart(period) < m.leftDate;
  return m.active !== false;
}
/** Le membre est-il actif à cette date ? (tient compte d'une date de sortie future ou passée) */
export function isActiveOn(m: { leftDate?: ISODate; active?: boolean }, date: ISODate = todayISO()): boolean {
  return m.leftDate ? date < m.leftDate : m.active !== false;
}

/** Cotisation non due : mois postérieur à la sortie du membre, sans aucun versement. */
export function isWaived(s: AppState, c: MonthlyContribution): boolean {
  return hiddenAfterLeave(s, c, memo(membersCache, s, () => new Map(s.members.map((m) => [m.id, m]))));
}
const membersCache = new WeakMap<AppState, Map<string, { leftDate?: ISODate }>>();
function hiddenAfterLeave(s: AppState, c: MonthlyContribution, members: Map<string, { leftDate?: ISODate }>): boolean {
  const left = members.get(c.memberId)?.leftDate;
  return !!left && periodStart(c.period) >= left && paidFor(s, c.id) === 0;
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
  const members = new Map(s.members.map((m) => [m.id, m]));
  const idx = paidIndex(s);
  return s.contributions
    .filter((c) => c.period === period && !hiddenAfterLeave(s, c, members))
    .map((c) => {
      const e = idx.get(c.id);
      const pays = e?.list ?? [];
      const paid = e?.paid ?? 0;
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
  const x = cashIndex(s);
  const f = from < s.settings.openingDate ? s.settings.openingDate : from;
  if (to < f) return 0;
  return cumUpTo(x.inDates, x.inPrefix, to) - cumUpTo(x.inDates, x.inPrefix, dayBefore(f));
}
export function expensesBetween(s: AppState, from: ISODate, to: ISODate): Cents {
  const x = cashIndex(s);
  const f = from < s.settings.openingDate ? s.settings.openingDate : from;
  if (to < f) return 0;
  return cumUpTo(x.outDates, x.outPrefix, to) - cumUpTo(x.outDates, x.outPrefix, dayBefore(f));
}

/** Solde de trésorerie à la fin d'une date (incluse). */
export function balanceAt(s: AppState, date: ISODate): Cents {
  if (date < s.settings.openingDate) return s.settings.openingBalance;
  const x = cashIndex(s);
  return s.settings.openingBalance + cumUpTo(x.inDates, x.inPrefix, date) - cumUpTo(x.outDates, x.outPrefix, date);
}

/** Solde la veille d'une date. */
export function balanceBefore(s: AppState, date: ISODate): Cents {
  if (date <= s.settings.openingDate) return s.settings.openingBalance;
  return balanceAt(s, dayBefore(date));
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
  const cache = memo(summaryCache, s, () => new Map<string, MonthSummary>());
  const key = `${period}|${today}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = computeMonthSummary(s, period, today);
  cache.set(key, r);
  return r;
}

function computeMonthSummary(s: AppState, period: Period, today: ISODate): MonthSummary {
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
  const members = new Map(s.members.map((m) => [m.id, m]));
  const contribs = s.contributions.filter((c) => c.memberId === memberId && c.period >= fromP && c.period <= toP && !hiddenAfterLeave(s, c, members));
  const expectedInRange = sum(contribs.map((c) => c.expected));
  const remainingInRange = sum(contribs.map((c) => Math.max(0, c.expected - paidFor(s, c.id))));
  return { totalPaid, expectedInRange, remainingInRange };
}

export interface MemberTotal {
  memberId: string;
  name: string;
  active: boolean;
  leftDate?: ISODate;
  /** Cotisations des mois de la période */
  expected: Cents;
  /** Versé pour ces mois (quelle que soit la date de versement) */
  paidForPeriod: Cents;
  remaining: Cents;
  /** Argent effectivement reçu de ce membre pendant la période (dates réelles) */
  received: Cents;
  payments: number;
  months: number;
  lateMonths: number;
}

/**
 * Totaux par membre sur une période quelconque (un mois, une année, entre deux dates).
 * « Attendu / versé pour ces mois / reste » portent sur les cotisations des mois compris
 * dans la période ; « reçu » compte l'argent versé pendant la période, à sa date réelle.
 */
export function memberTotals(s: AppState, from: ISODate, to: ISODate, today = todayISO()): { rows: MemberTotal[]; total: Omit<MemberTotal, 'memberId' | 'name' | 'active' | 'leftDate'> } {
  const pFrom = periodOf(from), pTo = periodOf(to);
  const members = new Map(s.members.map((m) => [m.id, m]));
  const rows = s.members.map((m) => {
    const cs = s.contributions.filter((c) => c.memberId === m.id && c.period >= pFrom && c.period <= pTo && !hiddenAfterLeave(s, c, members));
    const expected = sum(cs.map((c) => c.expected));
    const paidForPeriod = sum(cs.map((c) => Math.min(c.expected, paidFor(s, c.id))));
    const pays = validPayments(s).filter((p) => p.memberId === m.id && inRange(p.date, from, to));
    return {
      memberId: m.id,
      name: m.name,
      active: isActiveOn(m, today),
      leftDate: m.leftDate,
      expected,
      paidForPeriod,
      remaining: Math.max(0, expected - paidForPeriod),
      received: sum(pays.map((p) => p.amount)),
      payments: pays.length,
      months: cs.filter((c) => c.expected > 0).length,
      lateMonths: cs.filter((c) => paidFor(s, c.id) < c.expected && today > c.dueDate).length,
    };
  }).filter((r) => r.expected > 0 || r.received > 0 || r.active);
  rows.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const tot = (k: 'expected' | 'paidForPeriod' | 'remaining' | 'received' | 'payments' | 'months' | 'lateMonths') => rows.reduce((a, r) => a + r[k], 0);
  return { rows, total: { expected: tot('expected'), paidForPeriod: tot('paidForPeriod'), remaining: tot('remaining'), received: tot('received'), payments: tot('payments'), months: tot('months'), lateMonths: tot('lateMonths') } };
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
