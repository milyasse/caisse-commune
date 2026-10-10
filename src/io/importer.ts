/**
 * Import de l'historique Excel/CSV.
 * Deux dispositions sont gérées :
 *  1. « liste »  : une ligne par opération (date, membre, mois concerné, montant… ou dépense) ;
 *  2. « grille » : une ligne par mois, une colonne par membre (montant versé), une colonne
 *                  date de versement et une colonne dépenses — la forme du tableau Excel actuel.
 * Rien n'est écrit tant que l'utilisateur n'a pas validé l'aperçu ; aucune donnée existante
 * n'est modifiée ni supprimée (ajout uniquement, doublons ignorés par défaut).
 */
import type { AppState, Cents, ISODate, Period } from '../domain/types.ts';
import { parseMAD } from '../domain/money.ts';
import { MONTHS_FR, makePeriod, parseDateFR, periodEnd, periodOf } from '../domain/dates.ts';
import { addExpense, addPayment, findDuplicateExpense, findDuplicatePayment, generateMonth, overrideExpected, DomainError, type Ctx } from '../domain/commands.ts';
import { paidFor } from '../domain/finance.ts';

export type Cell = string | number | null | undefined;
export type Grid = Cell[][];

export type PaymentField = 'date' | 'member' | 'period' | 'amount' | 'comment';
export type ExpenseField = 'date' | 'category' | 'description' | 'beneficiary' | 'amount' | 'method' | 'reference' | 'comment';

export type Mapping =
  | { layout: 'payments'; headerRow: number; columns: Partial<Record<PaymentField, number>> }
  | { layout: 'expenses'; headerRow: number; columns: Partial<Record<ExpenseField, number>> }
  | { layout: 'grid'; headerRow: number; periodCol: number; dateCol?: number; memberCols: Record<number, string>; expenseCol?: number; expenseLabel?: string };

export interface PreviewLine {
  row: number; // numéro de ligne Excel (1-based)
  kind: 'payment' | 'expense';
  date?: ISODate;
  memberName?: string;
  memberId?: string;
  period?: Period;
  amount?: Cents;
  category?: string;
  description?: string;
  beneficiary?: string;
  comment?: string;
  errors: string[];
  warnings: string[];
  duplicate: boolean;
}

const norm = (s: Cell) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Repère une période à partir d'un libellé ("Janvier 2026", "01/2026", "2026-01", date…). */
export function parsePeriod(c: Cell, fallbackYear?: number): Period | null {
  if (c === null || c === undefined || c === '') return null;
  const s = norm(c);
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return makePeriod(+m[1], +m[2]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{4})$/);
  if (m) return makePeriod(+m[2], +m[1]);
  const idx = MONTHS_FR.findIndex((n) => s.startsWith(norm(n).slice(0, 3)));
  if (idx >= 0) {
    const y = s.match(/(\d{4})/);
    const year = y ? +y[1] : fallbackYear;
    if (year) return makePeriod(year, idx + 1);
  }
  const d = parseDateFR(c as string | number);
  return d ? periodOf(d) : null;
}

/** Devine la correspondance des colonnes à partir de la ligne d'en-tête. */
export function guessMapping(grid: Grid, s: AppState): Mapping {
  const headerRow = Math.max(0, grid.findIndex((r) => r.filter((c) => c !== null && c !== '').length >= 2));
  const h = (grid[headerRow] ?? []).map(norm);
  const find = (...keys: string[]) => {
    const i = h.findIndex((x) => keys.some((k) => x.includes(k)));
    return i >= 0 ? i : undefined;
  };
  const memberCols: Record<number, string> = {};
  h.forEach((x, i) => {
    const m = s.members.find((mm) => norm(mm.name) === x);
    if (m) memberCols[i] = m.name;
  });
  if (Object.keys(memberCols).length >= 1) {
    return { layout: 'grid', headerRow, periodCol: find('mois', 'periode', 'month') ?? 0, dateCol: find('date'), memberCols, expenseCol: find('depense', 'charge', 'personnel'), expenseLabel: 'Dépenses (import)' };
  }
  if (find('categorie', 'beneficiaire', 'depense') !== undefined && find('membre') === undefined) {
    return {
      layout: 'expenses',
      headerRow,
      columns: { date: find('date'), category: find('categorie'), description: find('description', 'libelle', 'objet'), beneficiary: find('beneficiaire', 'paye a', 'personne'), amount: find('montant', 'somme'), method: find('mode', 'paiement'), reference: find('reference', 'justificatif'), comment: find('commentaire', 'remarque') },
    };
  }
  return { layout: 'payments', headerRow, columns: { date: find('date'), member: find('membre', 'nom'), period: find('mois', 'periode'), amount: find('montant', 'versement', 'somme'), comment: find('commentaire', 'remarque') } };
}

export function buildPreview(grid: Grid, mapping: Mapping, s: AppState, today: ISODate): PreviewLine[] {
  const lines: PreviewLine[] = [];
  const memberByName = new Map(s.members.map((m) => [norm(m.name), m]));
  const seenInFile = new Set<string>();
  const rows = grid.slice(mapping.headerRow + 1);

  const checkCommon = (l: PreviewLine) => {
    if (!l.date) l.errors.push('Date manquante ou invalide');
    else if (l.date > today) l.errors.push('Date dans le futur');
    else if (l.date < s.settings.openingDate) l.errors.push(`Date antérieure au solde initial (${s.settings.openingDate})`);
    if (l.amount === undefined || l.amount === null) l.errors.push('Montant manquant ou invalide');
    else if (l.amount <= 0) l.errors.push('Montant négatif ou nul');
  };

  const pushPayment = (rowNo: number, date: ISODate | null, name: Cell, period: Period | null, amount: Cents | null, comment?: string) => {
    const m = memberByName.get(norm(name));
    const l: PreviewLine = { row: rowNo, kind: 'payment', date: date ?? undefined, memberName: String(name ?? '').trim(), memberId: m?.id, period: period ?? (date ? periodOf(date) : undefined), amount: amount ?? undefined, comment, errors: [], warnings: [], duplicate: false };
    checkCommon(l);
    if (!m) l.errors.push(`Membre inconnu « ${l.memberName} » — créez-le d'abord ou corrigez le nom`);
    if (!l.period) l.errors.push('Mois concerné introuvable');
    if (l.period && l.date && l.period > periodOf(l.date)) l.warnings.push('Versement anticipé (date avant le mois concerné)');
    if (m && l.date && l.amount) {
      const key = `p|${m.id}|${l.date}|${l.amount}`;
      if (findDuplicatePayment(s, m.id, l.date, l.amount)) (l.duplicate = true), l.warnings.push('Doublon : versement déjà présent dans l’application');
      else if (seenInFile.has(key)) (l.duplicate = true), l.warnings.push('Doublon dans le fichier');
      seenInFile.add(key);
      if (l.period) {
        const c = s.contributions.find((cc) => cc.memberId === m.id && cc.period === l.period);
        if (c && l.amount > c.expected - paidFor(s, c.id)) l.warnings.push('Montant supérieur au reste attendu : l’attendu du mois sera ajusté');
      }
    }
    lines.push(l);
  };

  const pushExpense = (rowNo: number, date: ISODate | null, amount: Cents | null, category: string, description: string, beneficiary: string, comment?: string) => {
    const l: PreviewLine = { row: rowNo, kind: 'expense', date: date ?? undefined, amount: amount ?? undefined, category, description, beneficiary, comment, errors: [], warnings: [], duplicate: false };
    checkCommon(l);
    if (!s.categories.some((c) => norm(c.name) === norm(category))) l.warnings.push(`Catégorie « ${category} » inconnue → « Autres dépenses »`);
    if (l.date && l.amount) {
      const key = `e|${l.date}|${l.amount}|${norm(beneficiary)}`;
      if (findDuplicateExpense(s, { date: l.date, amount: l.amount, beneficiary })) (l.duplicate = true), l.warnings.push('Doublon : dépense déjà présente');
      else if (seenInFile.has(key)) (l.duplicate = true), l.warnings.push('Doublon dans le fichier');
      seenInFile.add(key);
    }
    lines.push(l);
  };

  rows.forEach((r, i) => {
    const rowNo = mapping.headerRow + i + 2;
    if (!r || r.every((c) => c === null || c === undefined || c === '')) return;
    if (mapping.layout === 'payments') {
      const c = mapping.columns;
      const get = (k: PaymentField) => (c[k] === undefined ? undefined : r[c[k]!]);
      const date = parseDateFR(get('date') as string);
      pushPayment(rowNo, date, get('member'), parsePeriod(get('period'), date ? +date.slice(0, 4) : undefined), parseMAD(get('amount') as string), get('comment') ? String(get('comment')) : undefined);
    } else if (mapping.layout === 'expenses') {
      const c = mapping.columns;
      const get = (k: ExpenseField) => (c[k] === undefined ? '' : String(r[c[k]!] ?? '').trim());
      const raw = c.date === undefined ? undefined : r[c.date];
      pushExpense(rowNo, parseDateFR(raw as string), parseMAD(c.amount === undefined ? '' : (r[c.amount] as string)), get('category') || 'Autres dépenses', get('description') || 'Dépense importée', get('beneficiary'), get('comment') || undefined);
    } else {
      const period = parsePeriod(r[mapping.periodCol]);
      if (!period) {
        const label = String(r[mapping.periodCol] ?? '');
        if (/total|solde|cumul/i.test(label)) return; // lignes de totaux ignorées
        lines.push({ row: rowNo, kind: 'payment', errors: [`Mois illisible « ${label} »`], warnings: [], duplicate: false });
        return;
      }
      const date = (mapping.dateCol !== undefined ? parseDateFR(r[mapping.dateCol] as string) : null) ?? periodEnd(period);
      for (const [col, name] of Object.entries(mapping.memberCols)) {
        const v = r[+col];
        if (v === null || v === undefined || v === '' || parseMAD(v as string) === 0) continue;
        pushPayment(rowNo, date, name, period, parseMAD(v as string));
      }
      if (mapping.expenseCol !== undefined) {
        const v = r[mapping.expenseCol];
        if (v !== null && v !== undefined && v !== '' && parseMAD(v as string) !== 0)
          pushExpense(rowNo, date, parseMAD(v as string), 'Paiement du personnel', mapping.expenseLabel ?? 'Dépenses (import)', 'Import Excel');
      }
    }
  });
  return lines;
}

export interface ImportResult {
  state: AppState;
  imported: number;
  skipped: number;
  errors: { row: number; message: string }[];
}

/** Applique l'import validé. Les lignes en erreur et (par défaut) les doublons sont ignorés. */
export function applyImport(s0: AppState, ctx: Ctx, lines: PreviewLine[], opts: { includeDuplicates?: boolean } = {}): ImportResult {
  let s = s0;
  let imported = 0;
  let skipped = 0;
  const errors: ImportResult['errors'] = [];
  const ordered = [...lines].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  for (const l of ordered) {
    if (l.errors.length || (l.duplicate && !opts.includeDuplicates)) {
      skipped++;
      continue;
    }
    try {
      if (l.kind === 'payment') {
        s = generateMonth(s, ctx, l.period!).state;
        const c = s.contributions.find((cc) => cc.memberId === l.memberId && cc.period === l.period);
        if (!c) throw new DomainError('member', 'Membre inactif ou non encore adhérent pour ce mois');
        const remaining = c.expected - paidFor(s, c.id);
        if (l.amount! > remaining) s = overrideExpected(s, ctx, c.id, paidFor(s, c.id) + l.amount!, `Import Excel ligne ${l.row}`);
        s = addPayment(s, ctx, { contributionId: c.id, date: l.date!, amount: l.amount!, method: 'especes', comment: l.comment ?? `Import Excel ligne ${l.row}` }, { allowDuplicate: true });
      } else {
        const cat = s.categories.find((c) => norm(c.name) === norm(l.category)) ?? s.categories.find((c) => norm(c.name) === norm('Autres dépenses'))!;
        s = addExpense(s, ctx, { date: l.date!, categoryId: cat.id, description: l.description!, beneficiary: l.beneficiary ?? '', amount: l.amount!, method: 'especes', comment: l.comment }, { allowDuplicate: true });
      }
      imported++;
    } catch (e) {
      skipped++;
      errors.push({ row: l.row, message: e instanceof DomainError ? e.message : String(e) });
    }
  }
  if (imported) s.audit.push({ id: crypto.randomUUID(), at: ctx.now ?? new Date().toISOString(), user: ctx.user, action: 'import', entity: 'import', entityId: 'excel', after: { imported, skipped } });
  return { state: s, imported, skipped, errors };
}
