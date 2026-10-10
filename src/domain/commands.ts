/**
 * Commandes métier : chaque commande reçoit l'état, le valide, retourne un NOUVEL état
 * et ajoute une entrée d'audit. Aucune suppression physique d'opération financière :
 * on annule (status = 'cancelled') avec un motif tracé.
 */
import type { AppState, Cents, Expense, ID, ISODate, Member, MonthlyContribution, Payment, PayMethod, Period, Role, Settings } from './types.ts';
import { addMonths, dueDateFor, isValidISO, periodOf, todayISO } from './dates.ts';
import { amountFor, isClosed, isOwedFor, monthSummary, paidFor } from './finance.ts';
import { formatMAD } from './money.ts';

export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const uuid = (): ID =>
  globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

/**
 * UUID déterministe (format v4-like) dérivé d'une clé métier : deux appareils qui génèrent
 * la même cotisation (membre + mois) obtiennent le même identifiant => pas de doublon à la synchro.
 */
export function stableUuid(key: string): ID {
  const h = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    for (let j = 0; j < 4; j++) h[j] = Math.imul(h[j] ^ c, 0x01000193 + j * 0x9e37) >>> 0;
  }
  for (let j = 0; j < 4; j++) h[j] = Math.imul(h[j] ^ (h[(j + 1) % 4] >>> 15), 0x2c1b3c6d) >>> 0;
  const hex = h.map((x) => x.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface Ctx {
  user: string;
  role: Role;
  now?: string; // horodatage ISO (injectable pour les tests)
  today?: ISODate;
}

const nowOf = (ctx: Ctx) => ctx.now ?? new Date().toISOString();
const todayOf = (ctx: Ctx) => ctx.today ?? todayISO();

function clone(s: AppState): AppState {
  return structuredClone(s);
}

function audit(s: AppState, ctx: Ctx, action: AppState['audit'][number]['action'], entity: string, entityId: ID, before?: unknown, after?: unknown, reason?: string) {
  s.audit.push({ id: uuid(), at: nowOf(ctx), user: ctx.user, action, entity, entityId, before, after, reason });
}

function requireAdmin(ctx: Ctx) {
  if (ctx.role !== 'admin') throw new DomainError('forbidden', 'Action réservée à un administrateur.');
}

function checkAmount(a: Cents, allowZero = false) {
  if (!Number.isInteger(a)) throw new DomainError('amount', 'Montant invalide.');
  if (allowZero ? a < 0 : a <= 0) throw new DomainError('amount', 'Le montant doit être positif.');
  if (a > 100_000_000_00) throw new DomainError('amount', 'Montant anormalement élevé.');
}

function checkDate(s: AppState, ctx: Ctx, d: ISODate) {
  if (!isValidISO(d)) throw new DomainError('date', 'Date invalide.');
  if (d > todayOf(ctx)) throw new DomainError('date', 'La date ne peut pas être dans le futur.');
  if (d < s.settings.openingDate) throw new DomainError('date', 'Date antérieure au solde initial.');
  if (isClosed(s, d)) throw new DomainError('closed', `Le mois ${periodOf(d)} est clôturé. Rouvrez-le pour le modifier.`);
}

function requireReason(reason?: string) {
  if (!reason || reason.trim().length < 3) throw new DomainError('reason', 'Un motif de correction est obligatoire.');
}

// ---------------------------------------------------------------- Membres

export function addMember(s0: AppState, ctx: Ctx, input: { name: string; joinDate: ISODate; defaultAmount: Cents; phone?: string }): AppState {
  requireAdmin(ctx);
  const name = input.name.trim();
  if (!name) throw new DomainError('name', 'Le nom est obligatoire.');
  if (!isValidISO(input.joinDate)) throw new DomainError('date', "Date d'adhésion invalide.");
  checkAmount(input.defaultAmount, true);
  if (s0.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) throw new DomainError('duplicate', 'Un membre porte déjà ce nom.');
  const s = clone(s0);
  const m: Member = { id: uuid(), name, joinDate: input.joinDate, active: true, defaultAmount: input.defaultAmount, phone: input.phone, updatedAt: nowOf(ctx) };
  s.members.push(m);
  s.rules.push({ id: stableUuid(`rule:${m.id}:${periodOf(m.joinDate)}`), memberId: m.id, amount: m.defaultAmount, validFrom: periodOf(m.joinDate), updatedAt: nowOf(ctx) });
  audit(s, ctx, 'create', 'member', m.id, undefined, m);
  return s;
}

export function updateMember(s0: AppState, ctx: Ctx, id: ID, patch: Partial<Pick<Member, 'name' | 'joinDate' | 'active' | 'phone'>>): AppState {
  requireAdmin(ctx);
  const s = clone(s0);
  const m = s.members.find((x) => x.id === id);
  if (!m) throw new DomainError('notfound', 'Membre introuvable.');
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) throw new DomainError('name', 'Le nom est obligatoire.');
    if (s.members.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) throw new DomainError('duplicate', 'Un membre porte déjà ce nom.');
    patch.name = n;
  }
  if (patch.joinDate !== undefined && !isValidISO(patch.joinDate)) throw new DomainError('date', "Date d'adhésion invalide.");
  const before = { ...m };
  Object.assign(m, patch, { updatedAt: nowOf(ctx) });
  if (patch.active === true) delete m.leftDate; // réactivation complète
  audit(s, ctx, 'update', 'member', id, before, { ...m });
  return s;
}

/**
 * Sortie d'un membre à partir d'une date précise (ou réactivation avec `leftDate = null`).
 * - Les mois qui commencent à cette date ou après ne sont plus dus : leurs cotisations sans
 *   versement sont exclues des calculs (rien n'est supprimé : réactiver les fait réapparaître).
 * - Le mois en cours à la date de sortie reste dû (ex. sortie le 15/03 → mars dû, avril non).
 * - Les versements déjà faits sont conservés tels quels.
 */
export function setMemberLeave(s0: AppState, ctx: Ctx, id: ID, leftDate: ISODate | null, reason = ''): AppState {
  requireAdmin(ctx);
  const s = clone(s0);
  const m = s.members.find((x) => x.id === id);
  if (!m) throw new DomainError('notfound', 'Membre introuvable.');
  if (leftDate !== null) {
    if (!isValidISO(leftDate)) throw new DomainError('date', 'Date de sortie invalide.');
    if (leftDate <= m.joinDate) throw new DomainError('date', "La date de sortie doit être postérieure à la date d'adhésion.");
  }
  const before = { ...m };
  if (leftDate) m.leftDate = leftDate;
  else delete m.leftDate;
  m.active = !leftDate || leftDate > todayOf(ctx);
  m.updatedAt = nowOf(ctx);
  audit(s, ctx, 'update', 'member', id, before, { ...m }, reason || (leftDate ? `Inactif à partir du ${leftDate}` : 'Réactivé'));
  return s;
}

/**
 * Nouveau montant mensuel à partir d'une période. Les cotisations antérieures ne changent pas.
 * Les cotisations déjà générées à partir de `fromPeriod`, sans versement, non modifiées
 * manuellement et hors mois clôturé sont alignées sur le nouveau montant.
 */
export function setMemberAmount(s0: AppState, ctx: Ctx, memberId: ID, amount: Cents, fromPeriod: Period): AppState {
  requireAdmin(ctx);
  checkAmount(amount, true);
  if (!/^\d{4}-\d{2}$/.test(fromPeriod)) throw new DomainError('period', 'Période invalide.');
  const s = clone(s0);
  const m = s.members.find((x) => x.id === memberId);
  if (!m) throw new DomainError('notfound', 'Membre introuvable.');
  const existing = s.rules.find((r) => r.memberId === memberId && r.validFrom === fromPeriod);
  if (existing) {
    existing.amount = amount;
    existing.updatedAt = nowOf(ctx);
  } else s.rules.push({ id: stableUuid(`rule:${memberId}:${fromPeriod}`), memberId, amount, validFrom: fromPeriod, updatedAt: nowOf(ctx) });
  const before = m.defaultAmount;
  if (fromPeriod <= periodOf(todayOf(ctx)) || !s.rules.some((r) => r.memberId === memberId && r.validFrom > fromPeriod)) m.defaultAmount = amount;
  m.updatedAt = nowOf(ctx);
  for (const c of s.contributions) {
    if (c.memberId === memberId && c.period >= fromPeriod && !c.overridden && paidFor(s, c.id) === 0 && !isClosed(s, c.dueDate)) {
      c.expected = amountFor(s, memberId, c.period);
      c.updatedAt = nowOf(ctx);
    }
  }
  audit(s, ctx, 'update', 'member_amount', memberId, { amount: before }, { amount, fromPeriod });
  return s;
}

// ---------------------------------------------------------------- Cotisations

/** Génère les cotisations manquantes d'un mois pour les membres actifs. Idempotent. */
export function generateMonth(s0: AppState, ctx: Ctx, period: Period): { state: AppState; created: number } {
  const s = clone(s0);
  let created = 0;
  for (const m of s.members) {
    if (!isOwedFor(m, period)) continue;
    if (s.contributions.some((c) => c.memberId === m.id && c.period === period)) continue;
    const c: MonthlyContribution = {
      id: stableUuid(`contribution:${m.id}:${period}`),
      memberId: m.id,
      period,
      expected: amountFor(s, m.id, period),
      dueDate: dueDateFor(period, s.settings.dueDay),
      overridden: false,
      updatedAt: nowOf(ctx),
    };
    s.contributions.push(c);
    created++;
  }
  if (created) audit(s, ctx, 'create', 'contributions', period, undefined, { created });
  return { state: s, created };
}

/** Modifie exceptionnellement le montant attendu d'un mois précis. */
export function overrideExpected(s0: AppState, ctx: Ctx, contributionId: ID, expected: Cents, reason: string): AppState {
  requireReason(reason);
  checkAmount(expected, true);
  const s = clone(s0);
  const c = s.contributions.find((x) => x.id === contributionId);
  if (!c) throw new DomainError('notfound', 'Cotisation introuvable.');
  if (isClosed(s, c.dueDate)) throw new DomainError('closed', 'Mois clôturé.');
  const paid = paidFor(s, c.id);
  if (expected < paid) throw new DomainError('amount', `Le montant attendu ne peut pas être inférieur au déjà versé (${formatMAD(paid)}).`);
  const before = { ...c };
  c.expected = expected;
  c.overridden = true;
  c.updatedAt = nowOf(ctx);
  audit(s, ctx, 'update', 'contribution', c.id, before, { ...c }, reason);
  return s;
}

export interface PaymentInput {
  id?: ID; // identifiant client (idempotence de synchronisation)
  contributionId: ID;
  date: ISODate;
  amount: Cents;
  method: PayMethod;
  reference?: string;
  comment?: string;
}

export function findDuplicatePayment(s: AppState, memberId: ID, date: ISODate, amount: Cents, exceptId?: ID): Payment | undefined {
  return s.payments.find((p) => p.status === 'valid' && p.id !== exceptId && p.memberId === memberId && p.date === date && p.amount === amount);
}

export function addPayment(s0: AppState, ctx: Ctx, input: PaymentInput, opts: { allowDuplicate?: boolean } = {}): AppState {
  if (input.id && s0.payments.some((p) => p.id === input.id)) return s0; // déjà enregistré : idempotent
  const c = s0.contributions.find((x) => x.id === input.contributionId);
  if (!c) throw new DomainError('notfound', 'Cotisation introuvable.');
  checkAmount(input.amount);
  checkDate(s0, ctx, input.date);
  const remaining = c.expected - paidFor(s0, c.id);
  if (input.amount > remaining)
    throw new DomainError('overpay', `Le versement dépasse le reste à payer (${formatMAD(Math.max(0, remaining))}).`);
  if (!opts.allowDuplicate && findDuplicatePayment(s0, c.memberId, input.date, input.amount))
    throw new DomainError('duplicate', 'Un versement identique (même membre, date et montant) existe déjà.');
  const s = clone(s0);
  const p: Payment = {
    id: input.id ?? uuid(),
    contributionId: c.id,
    memberId: c.memberId,
    date: input.date,
    amount: input.amount,
    method: input.method,
    reference: input.reference?.trim() || undefined,
    comment: input.comment?.trim() || undefined,
    status: 'valid',
    createdBy: ctx.user,
    updatedAt: nowOf(ctx),
  };
  s.payments.push(p);
  audit(s, ctx, 'create', 'payment', p.id, undefined, p);
  return s;
}

export function updatePayment(s0: AppState, ctx: Ctx, id: ID, patch: Partial<Pick<Payment, 'date' | 'amount' | 'method' | 'reference' | 'comment'>>, reason: string): AppState {
  requireReason(reason);
  const old = s0.payments.find((p) => p.id === id);
  if (!old) throw new DomainError('notfound', 'Versement introuvable.');
  if (old.status !== 'valid') throw new DomainError('cancelled', 'Versement annulé : non modifiable.');
  if (isClosed(s0, old.date)) throw new DomainError('closed', `Le mois ${periodOf(old.date)} est clôturé.`);
  const next = { ...old, ...patch };
  checkAmount(next.amount);
  checkDate(s0, ctx, next.date);
  const c = s0.contributions.find((x) => x.id === old.contributionId)!;
  const otherPaid = paidFor(s0, c.id) - old.amount;
  if (next.amount > c.expected - otherPaid) throw new DomainError('overpay', `Le versement dépasse le reste à payer (${formatMAD(c.expected - otherPaid)}).`);
  const s = clone(s0);
  const p = s.payments.find((x) => x.id === id)!;
  Object.assign(p, patch, { updatedAt: nowOf(ctx) });
  audit(s, ctx, 'update', 'payment', id, old, { ...p }, reason);
  return s;
}

export function cancelPayment(s0: AppState, ctx: Ctx, id: ID, reason: string): AppState {
  requireReason(reason);
  const old = s0.payments.find((p) => p.id === id);
  if (!old) throw new DomainError('notfound', 'Versement introuvable.');
  if (old.status === 'cancelled') return s0;
  if (isClosed(s0, old.date)) throw new DomainError('closed', `Le mois ${periodOf(old.date)} est clôturé.`);
  const s = clone(s0);
  const p = s.payments.find((x) => x.id === id)!;
  p.status = 'cancelled';
  p.cancelReason = reason;
  p.updatedAt = nowOf(ctx);
  audit(s, ctx, 'cancel', 'payment', id, old, { ...p }, reason);
  return s;
}

// ---------------------------------------------------------------- Dépenses

export interface ExpenseInput {
  id?: ID;
  date: ISODate;
  categoryId: ID;
  description: string;
  beneficiary: string;
  amount: Cents;
  method: PayMethod;
  reference?: string;
  comment?: string;
  receipt?: string;
}

export function findDuplicateExpense(s: AppState, e: { date: ISODate; amount: Cents; beneficiary: string }, exceptId?: ID) {
  return s.expenses.find(
    (x) => x.status === 'valid' && x.id !== exceptId && x.date === e.date && x.amount === e.amount && x.beneficiary.trim().toLowerCase() === e.beneficiary.trim().toLowerCase(),
  );
}

function validateExpense(s: AppState, ctx: Ctx, e: ExpenseInput) {
  checkAmount(e.amount);
  checkDate(s, ctx, e.date);
  if (!s.categories.some((c) => c.id === e.categoryId)) throw new DomainError('category', 'Catégorie inconnue.');
  if (!e.description.trim()) throw new DomainError('description', 'La description est obligatoire.');
}

export function addExpense(s0: AppState, ctx: Ctx, input: ExpenseInput, opts: { allowDuplicate?: boolean } = {}): AppState {
  if (input.id && s0.expenses.some((x) => x.id === input.id)) return s0;
  validateExpense(s0, ctx, input);
  if (!opts.allowDuplicate && findDuplicateExpense(s0, input))
    throw new DomainError('duplicate', 'Une dépense identique (même date, montant et bénéficiaire) existe déjà.');
  const s = clone(s0);
  const e: Expense = {
    id: input.id ?? uuid(),
    date: input.date,
    categoryId: input.categoryId,
    description: input.description.trim(),
    beneficiary: input.beneficiary.trim(),
    amount: input.amount,
    method: input.method,
    reference: input.reference?.trim() || undefined,
    comment: input.comment?.trim() || undefined,
    receipt: input.receipt,
    status: 'valid',
    createdBy: ctx.user,
    updatedAt: nowOf(ctx),
  };
  s.expenses.push(e);
  audit(s, ctx, 'create', 'expense', e.id, undefined, { ...e, receipt: e.receipt ? '[justificatif]' : undefined });
  return s;
}

export function updateExpense(s0: AppState, ctx: Ctx, id: ID, patch: Partial<ExpenseInput>, reason: string): AppState {
  requireReason(reason);
  const old = s0.expenses.find((x) => x.id === id);
  if (!old) throw new DomainError('notfound', 'Dépense introuvable.');
  if (old.status !== 'valid') throw new DomainError('cancelled', 'Dépense annulée : non modifiable.');
  if (isClosed(s0, old.date)) throw new DomainError('closed', `Le mois ${periodOf(old.date)} est clôturé.`);
  const next = { ...old, ...patch } as ExpenseInput;
  validateExpense(s0, ctx, next);
  const s = clone(s0);
  const e = s.expenses.find((x) => x.id === id)!;
  delete (patch as { id?: string }).id;
  Object.assign(e, patch, { updatedAt: nowOf(ctx) });
  audit(s, ctx, 'update', 'expense', id, { ...old, receipt: undefined }, { ...e, receipt: undefined }, reason);
  return s;
}

export function cancelExpense(s0: AppState, ctx: Ctx, id: ID, reason: string): AppState {
  requireReason(reason);
  const old = s0.expenses.find((x) => x.id === id);
  if (!old) throw new DomainError('notfound', 'Dépense introuvable.');
  if (old.status === 'cancelled') return s0;
  if (isClosed(s0, old.date)) throw new DomainError('closed', `Le mois ${periodOf(old.date)} est clôturé.`);
  const s = clone(s0);
  const e = s.expenses.find((x) => x.id === id)!;
  e.status = 'cancelled';
  e.cancelReason = reason;
  e.updatedAt = nowOf(ctx);
  audit(s, ctx, 'cancel', 'expense', id, { status: 'valid' }, { status: 'cancelled' }, reason);
  return s;
}

export function addCategory(s0: AppState, ctx: Ctx, name: string): AppState {
  requireAdmin(ctx);
  const n = name.trim();
  if (!n) throw new DomainError('name', 'Nom obligatoire.');
  if (s0.categories.some((c) => c.name.toLowerCase() === n.toLowerCase())) throw new DomainError('duplicate', 'Catégorie existante.');
  const s = clone(s0);
  const c = { id: uuid(), name: n, active: true, updatedAt: nowOf(ctx) };
  s.categories.push(c);
  audit(s, ctx, 'create', 'category', c.id, undefined, c);
  return s;
}

// ---------------------------------------------------------------- Clôture mensuelle

/**
 * Clôture un mois terminé : fige son solde de clôture (= ouverture du mois suivant)
 * et verrouille les opérations datées dans ce mois. Les mois doivent être clôturés dans l'ordre.
 */
export function closeMonth(s0: AppState, ctx: Ctx, period: Period): AppState {
  requireAdmin(ctx);
  if (period >= periodOf(todayOf(ctx))) throw new DomainError('period', 'Seul un mois terminé peut être clôturé.');
  if (s0.closures.some((c) => c.period === period && !c.reopened)) throw new DomainError('closed', 'Mois déjà clôturé.');
  const first = periodOf(s0.settings.openingDate);
  const prev = addMonths(period, -1);
  if (period > first && !s0.closures.some((c) => c.period === prev && !c.reopened))
    throw new DomainError('order', `Clôturez d'abord le mois précédent (${prev}).`);
  const closingBalance = monthSummary(s0, period, todayOf(ctx)).closing;
  const s = clone(s0);
  const c = { id: stableUuid(`closure:${period}:${s0.closures.length}`), period, closingBalance, closedAt: nowOf(ctx), closedBy: ctx.user, reopened: false, updatedAt: nowOf(ctx) };
  s.closures.push(c);
  audit(s, ctx, 'close', 'month', period, undefined, { closingBalance });
  return s;
}

/** Réouverture tracée ; rouvre aussi les mois suivants (leur solde dépend de celui-ci). */
export function reopenMonth(s0: AppState, ctx: Ctx, period: Period, reason: string): AppState {
  requireAdmin(ctx);
  requireReason(reason);
  const s = clone(s0);
  for (const c of s.closures) {
    if (!c.reopened && c.period >= period) {
      c.reopened = true;
      c.updatedAt = nowOf(ctx);
      audit(s, ctx, 'reopen', 'month', c.period, { closingBalance: c.closingBalance }, undefined, reason);
    }
  }
  return s;
}

export function updateSettings(s0: AppState, ctx: Ctx, patch: Partial<Settings>): AppState {
  if (Object.keys(patch).some((k) => !['currentUser', 'currentRole'].includes(k))) requireAdmin(ctx);
  if (patch.openingDate !== undefined && !isValidISO(patch.openingDate)) throw new DomainError('date', 'Date invalide.');
  if ((patch.openingBalance !== undefined || patch.openingDate !== undefined) && s0.closures.some((c) => !c.reopened))
    throw new DomainError('closed', 'Rouvrez les mois clôturés avant de modifier le solde initial.');
  const s = clone(s0);
  const before = { ...s.settings };
  Object.assign(s.settings, patch, { updatedAt: nowOf(ctx) });
  audit(s, ctx, 'update', 'settings', 'settings', before, { ...s.settings });
  return s;
}
