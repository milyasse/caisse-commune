/**
 * Import de l'historique Excel/CSV.
 * Dispositions gérées :
 *  1. « grille »   : une ligne par mois, une colonne par membre (montant versé), une colonne date,
 *                    une colonne dépenses du mois — la forme du tableau « المساهمات » ;
 *                    l'année peut être dans une colonne à part (cellules fusionnées) et le mois un simple numéro.
 *  2. « versements »: une ligne par versement (date, membre, mois concerné, montant) ;
 *  3. « dépenses » : une ligne par dépense, avec un montant dans une colonne unique ou réparti dans des
 *                    colonnes « شهر 3, شهر 4… » (feuille hebdomadaire « المصاريف »).
 * En-têtes reconnus en français et en arabe. Rien n'est écrit tant que l'aperçu n'est pas validé ;
 * aucune donnée existante n'est modifiée ni supprimée (ajout uniquement, doublons ignorés par défaut).
 */
import type { AppState, Cents, ISODate, Period } from '../domain/types.ts';
import { parseMAD } from '../domain/money.ts';
import { MONTHS_FR, daysInMonth, fmtDate, makePeriod, parseDateFR, periodEnd, periodLabel, periodOf, periodStart } from '../domain/dates.ts';
import { addExpense, addMember, addPayment, findDuplicateExpense, findDuplicatePayment, generateMonth, overrideExpected, DomainError, type Ctx } from '../domain/commands.ts';
import { paidFor } from '../domain/finance.ts';

export type Cell = string | number | null | undefined;
export type Grid = Cell[][];

export type PaymentField = 'date' | 'member' | 'period' | 'amount' | 'comment';
export type ExpenseField = 'date' | 'category' | 'description' | 'beneficiary' | 'amount' | 'method' | 'reference' | 'comment' | 'payer';

export type Mapping =
  | { layout: 'payments'; headerRow: number; columns: Partial<Record<PaymentField, number>> }
  | { layout: 'expenses'; headerRow: number; columns: Partial<Record<ExpenseField, number>>; amountCols?: number[] }
  | {
      layout: 'grid';
      headerRow: number;
      periodCol: number;
      yearCol?: number;
      dateCol?: number;
      /** colonne → nom du membre (existant, ou nouveau membre créé à l'import) */
      memberCols: Record<number, string>;
      expenseCol?: number;
      totalCol?: number; // contrôle : total mensuel des cotisations
      checkCol?: number; // contrôle : reste du mois (cotisations − dépenses)
      expenseLabel?: string;
    };

export interface PreviewLine {
  row: number; // numéro de ligne Excel (1-based)
  kind: 'payment' | 'expense';
  date?: ISODate;
  memberName?: string;
  memberId?: string;
  newMember?: boolean;
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

/** Normalisation pour comparer des libellés (accents latins, variantes de lettres arabes). */
export const norm = (s: Cell) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ًͯ-ٰٟـ]/g, '')
    .normalize('NFC')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ');

const isEmpty = (c: Cell) => c === null || c === undefined || String(c).trim() === '' || String(c).trim() === '-';
const TOTAL_RE = /total|solde|cumul|اجمالي|مجموع/;
const isTotalRow = (r: Cell[]) => r.some((c) => typeof c === 'string' && TOTAL_RE.test(norm(c)));

/** Montant positif d'une cellule, sinon null (vide, « - », 0). */
const amountOf = (c: Cell): Cents | null => {
  if (isEmpty(c)) return null;
  const v = parseMAD(c as string);
  return v && v > 0 ? v : null;
};

/** Date tolérante : corrige un jour inexistant (31/06 → 30/06) et le signale. */
export function parseDateLoose(c: Cell): { date: ISODate | null; fixed?: string } {
  if (isEmpty(c)) return { date: null };
  const d = parseDateFR(c as string | number);
  if (d) return { date: d };
  const m = String(c).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
    const last = daysInMonth(+m[3], +m[2]);
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    return { date: iso, fixed: `${String(c).trim()} n'existe pas → ${fmtDate(iso)}` };
  }
  return { date: null };
}

/** Repère une période : "Janvier 2026", "01/2026", "2026-01", une date, ou un numéro de mois + année. */
export function parsePeriod(c: Cell, fallbackYear?: number): Period | null {
  if (isEmpty(c)) return null;
  const raw = String(c).trim();
  if (/^\d{1,2}$/.test(raw)) return fallbackYear && +raw >= 1 && +raw <= 12 ? makePeriod(fallbackYear, +raw) : null;
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

/** Ligne d'en-tête = celle qui a le plus de libellés texte parmi les 15 premières. */
function findHeaderRow(grid: Grid): number {
  let best = 0;
  let bestN = -1;
  grid.slice(0, 15).forEach((r, i) => {
    const n = (r ?? []).filter((c) => typeof c === 'string' && c.trim() && !/^[\d\s.,\/-]+$/.test(c)).length;
    if (n > bestN) (best = i), (bestN = n);
  });
  return best;
}

const MONTH_COL_RE = /^(?:(?:شهر|mois)\s*(\d{1,2})|(\d{1,2})\s*(?:شهر|mois))$/;
/** Numéro de mois d'un en-tête « شهر 3 », « 3 شهر » ou « mois 3 », sinon 0. */
const monthOfHeader = (c: Cell) => {
  const m = norm(c).match(MONTH_COL_RE);
  return m ? +(m[1] ?? m[2]) : 0;
};

/** Devine la correspondance des colonnes à partir de la ligne d'en-tête. */
export function guessMapping(grid: Grid, s: AppState): Mapping {
  const headerRow = findHeaderRow(grid);
  const h = (grid[headerRow] ?? []).map(norm);
  const find = (pred: (x: string) => boolean) => {
    const i = h.findIndex((x) => !!x && pred(x));
    return i >= 0 ? i : undefined;
  };
  const has = (...keys: string[]) => (x: string) => keys.some((k) => x.includes(k));

  // Feuille de dépenses avec un montant par colonne de mois (شهر 3, شهر 4…)
  const monthCols = h.map((x, i) => (MONTH_COL_RE.test(x) ? i : -1)).filter((i) => i >= 0);
  if (monthCols.length >= 3) {
    return {
      layout: 'expenses',
      headerRow,
      amountCols: monthCols,
      columns: {
        date: find(has('date', 'تاريخ')),
        description: find(has('rubrique', 'libelle', 'description', 'البيان', 'objet')),
        payer: find(has('المكلف', 'paye par', 'payeur', 'responsable')),
        category: find(has('categorie', 'الصنف', 'النوع')),
        beneficiary: find(has('beneficiaire', 'المستفيد')),
        comment: find(has('commentaire', 'remarque', 'ملاحظه')),
      },
    };
  }

  const yearCol = find((x) => x === 'annee' || x === 'السنه' || x === 'سنه' || x === 'year');
  const periodCol = find((x) => x === 'mois' || x === 'الشهر' || x === 'شهر' || x === 'periode' || x === 'month' || x.startsWith('mois '));
  const dateCol = find(has('date', 'تاريخ'));
  const totalCol = find((x) => (x.includes('total') && x.includes('mois')) || (x.includes('مجموع') && x.includes('الشهري')) || x === 'total');
  const expenseCol = find(has('depense', 'charge', 'المصاريف', 'مصاريف'));
  const checkCol = find((x) => (x.includes('متبقي') && x.includes('الشهري')) || x.includes('reste du mois') || x.includes('solde du mois'));
  const annualCols = h.map((x, i) => (/اجمالي|annuel|cumul|للسنه/.test(x) ? i : -1)).filter((i) => i >= 0);

  const memberCols: Record<number, string> = {};
  const raw = grid[headerRow] ?? [];
  const known = new Set([yearCol, periodCol, dateCol, totalCol, expenseCol, checkCol, ...annualCols].filter((i) => i !== undefined));
  h.forEach((x, i) => {
    const m = s.members.find((mm) => norm(mm.name) === x);
    if (m) memberCols[i] = m.name;
  });
  const FIELD_RE = /montant|membre|^nom|commentaire|remarque|reference|mode|categorie|description|beneficiaire|المبلغ|ملاحظ|البيان/;
  const memberColumn = find(has('membre'));
  if (periodCol !== undefined && memberColumn === undefined) {
    // Colonnes entre « mois / date » et le premier total : une par membre
    const start = Math.max(periodCol, dateCol ?? -1, yearCol ?? -1) + 1;
    const ends = [totalCol, expenseCol, checkCol, ...annualCols].filter((i): i is number => i !== undefined && i >= start);
    const end = ends.length ? Math.min(...ends) : h.length;
    for (let i = start; i < end; i++) if (!known.has(i) && h[i] && !FIELD_RE.test(h[i]) && memberCols[i] === undefined) memberCols[i] = String(raw[i]).trim();
  }
  if (Object.keys(memberCols).length >= 1 && periodCol !== undefined) {
    return { layout: 'grid', headerRow, periodCol, yearCol, dateCol, memberCols, expenseCol, totalCol, checkCol, expenseLabel: 'Dépenses du mois (import)' };
  }
  if (Object.keys(memberCols).length >= 1) {
    return { layout: 'grid', headerRow, periodCol: find(has('mois', 'periode', 'month')) ?? 0, dateCol, memberCols, expenseCol, expenseLabel: 'Dépenses du mois (import)' };
  }
  if (find(has('categorie', 'beneficiaire', 'depense')) !== undefined && find(has('membre')) === undefined) {
    return {
      layout: 'expenses',
      headerRow,
      columns: {
        date: find(has('date')),
        category: find(has('categorie')),
        description: find(has('description', 'libelle', 'objet')),
        beneficiary: find(has('beneficiaire', 'paye a', 'personne')),
        amount: find(has('montant', 'somme')),
        method: find(has('mode', 'paiement')),
        reference: find(has('reference', 'justificatif')),
        comment: find(has('commentaire', 'remarque')),
      },
    };
  }
  return { layout: 'payments', headerRow, columns: { date: find(has('date')), member: find(has('membre', 'nom')), period: find(has('mois', 'periode')), amount: find(has('montant', 'versement', 'somme')), comment: find(has('commentaire', 'remarque')) } };
}

const PERSONNEL_RE = /اجره|الحارس|اجور|salaire|gardien|personnel/;
const CHARGES_RE = /كهرباء|الماء|electricit|eau |charges|عداد/;

export function buildPreview(grid: Grid, mapping: Mapping, s: AppState, today: ISODate): PreviewLine[] {
  const lines: PreviewLine[] = [];
  const memberByName = new Map(s.members.map((m) => [norm(m.name), m]));
  const seenInFile = new Set<string>();
  const rows = grid.slice(mapping.headerRow + 1);
  const monthlyLumps = new Set(s.expenses.filter((e) => e.status === 'valid' && e.description.startsWith('Dépenses du mois')).map((e) => periodOf(e.date)));

  const checkCommon = (l: PreviewLine) => {
    if (!l.date) l.errors.push('Date manquante ou invalide');
    else if (l.date > today) l.errors.push('Date dans le futur');
    else if (l.date < s.settings.openingDate) l.errors.push(`Date antérieure au solde initial (${fmtDate(s.settings.openingDate)})`);
    if (l.amount === undefined || l.amount === null) l.errors.push('Montant manquant ou invalide');
    else if (l.amount <= 0) l.errors.push('Montant négatif ou nul');
  };

  const pushPayment = (rowNo: number, date: ISODate | null, name: Cell, period: Period | null, amount: Cents | null, comment?: string, allowNew = false) => {
    const nameStr = String(name ?? '').trim();
    const m = memberByName.get(norm(name));
    const l: PreviewLine = { row: rowNo, kind: 'payment', date: date ?? undefined, memberName: nameStr, memberId: m?.id, period: period ?? (date ? periodOf(date) : undefined), amount: amount ?? undefined, comment, errors: [], warnings: [], duplicate: false };
    checkCommon(l);
    if (!m && allowNew && nameStr) (l.newMember = true), l.warnings.push(`Nouveau membre « ${nameStr} » créé à l'import`);
    else if (!m) l.errors.push(`Membre inconnu « ${nameStr} » — créez-le d'abord ou corrigez le nom`);
    if (!l.period) l.errors.push('Mois concerné introuvable');
    if (l.period && l.date && l.period > periodOf(l.date)) l.warnings.push('Versement anticipé (reçu avant le mois concerné)');
    if (l.date && l.amount && nameStr) {
      const key = `p|${norm(nameStr)}|${l.date}|${l.amount}`;
      if (m && findDuplicatePayment(s, m.id, l.date, l.amount)) (l.duplicate = true), l.warnings.push('Doublon : versement déjà présent dans l’application');
      else if (seenInFile.has(key)) (l.duplicate = true), l.warnings.push('Doublon dans le fichier');
      seenInFile.add(key);
      if (m && l.period) {
        const c = s.contributions.find((cc) => cc.memberId === m.id && cc.period === l.period);
        if (c && l.amount > c.expected - paidFor(s, c.id)) l.warnings.push('Montant supérieur au reste attendu : l’attendu du mois sera ajusté');
      }
    }
    lines.push(l);
    return l;
  };

  const pushExpense = (rowNo: number, date: ISODate | null, amount: Cents | null, category: string, description: string, beneficiary: string, comment?: string) => {
    const l: PreviewLine = { row: rowNo, kind: 'expense', date: date ?? undefined, amount: amount ?? undefined, category, description, beneficiary, comment, errors: [], warnings: [], duplicate: false };
    checkCommon(l);
    if (!s.categories.some((c) => norm(c.name) === norm(category))) l.warnings.push(`Catégorie « ${category} » inconnue → « Autres dépenses »`);
    if (l.date && l.amount) {
      const key = `e|${l.date}|${l.amount}|${norm(beneficiary)}|${norm(description)}`;
      if (findDuplicateExpense(s, { date: l.date, amount: l.amount, beneficiary }) && s.expenses.some((e) => e.status === 'valid' && e.date === l.date && e.amount === l.amount && norm(e.description) === norm(description)))
        (l.duplicate = true), l.warnings.push('Doublon : dépense déjà présente');
      else if (seenInFile.has(key)) (l.duplicate = true), l.warnings.push('Doublon dans le fichier');
      seenInFile.add(key);
      if (!description.startsWith('Dépenses du mois') && monthlyLumps.has(periodOf(l.date)))
        l.warnings.push('Une dépense mensuelle globale existe déjà pour ce mois : risque de double comptage');
    }
    lines.push(l);
    return l;
  };

  let year: number | undefined;
  let section = ''; // titre de rubrique en cours (« أجرة الحارس الأسبوعية », « الكهرباء »…)
  const headerNorm = (grid[mapping.headerRow] ?? []).map(norm);
  rows.forEach((r, i) => {
    const rowNo = mapping.headerRow + i + 2;
    if (!r || r.every(isEmpty)) return;
    // En-tête répété plus bas dans la feuille
    if (r.filter((c, j) => !isEmpty(c) && norm(c) === headerNorm[j]).length >= 3) return;

    if (mapping.layout === 'payments') {
      const c = mapping.columns;
      const get = (k: PaymentField) => (c[k] === undefined ? undefined : r[c[k]!]);
      if (isTotalRow(r) && !parseDateFR(get('date') as string)) return;
      const { date, fixed } = parseDateLoose(get('date'));
      const l = pushPayment(rowNo, date, get('member'), parsePeriod(get('period'), date ? +date.slice(0, 4) : undefined), parseMAD(get('amount') as string), get('comment') ? String(get('comment')) : undefined, true);
      if (fixed) l.warnings.push(`Date corrigée : ${fixed}`);
      return;
    }

    if (mapping.layout === 'expenses') {
      const c = mapping.columns;
      const get = (k: ExpenseField) => (c[k] === undefined ? '' : String(r[c[k]!] ?? '').trim());
      let amount: Cents | null = null;
      let amountCol: number | undefined;
      if (mapping.amountCols?.length) {
        for (const ac of mapping.amountCols) {
          const v = amountOf(r[ac]);
          if (v) ((amount = v), (amountCol = ac));
          if (v) break;
        }
        if (amount === null) {
          // Ligne de titre de rubrique : on retient le libellé pour les lignes suivantes
          const label = [get('description'), ...r.map((x) => (typeof x === 'string' ? x.trim() : ''))].find((x) => x && !/^العدد$|^n°?$/i.test(norm(x)) && !/^[\d\s.,\/-]+$/.test(x));
          if (label && !isTotalRow(r) && (c.date === undefined || isEmpty(r[c.date]))) section = label;
          return;
        }
      } else {
        if (c.amount === undefined || isEmpty(r[c.amount])) {
          if (c.date === undefined || isEmpty(r[c.date])) return;
        }
        amount = c.amount === undefined ? null : parseMAD(r[c.amount] as string);
      }
      if (isTotalRow(r) && (c.date === undefined || isEmpty(r[c.date]))) return;
      const { date, fixed } = parseDateLoose(c.date === undefined ? undefined : r[c.date]);
      const description = get('description') || section || 'Dépense importée';
      const context = norm(`${description} ${section}`);
      const personnel = PERSONNEL_RE.test(context);
      const category = get('category') || (personnel ? 'Paiement du personnel' : CHARGES_RE.test(context) ? 'Charges communes' : 'Autres dépenses');
      const beneficiary = get('beneficiary') || (personnel ? 'Gardien' : '');
      const payer = get('payer');
      const comment = [get('comment'), payer ? `Payé par ${payer}` : ''].filter(Boolean).join(' · ') || undefined;
      const l = pushExpense(rowNo, date, amount, category, description, beneficiary, comment);
      if (fixed) l.warnings.push(`Date corrigée : ${fixed}`);
      // Contrôle : date de paiement proche de la semaine indiquée (« من 03/03 … »)
      const wk = description.match(/(\d{1,2})\/(\d{1,2})/);
      if (date && wk) {
        const start = Date.UTC(+date.slice(0, 4), +wk[2] - 1, +wk[1]);
        const gap = Math.abs(Date.parse(date + 'T00:00:00Z') - start) / 86_400_000;
        const gapPrev = Math.abs(Date.parse(date + 'T00:00:00Z') - Date.UTC(+date.slice(0, 4) - 1, +wk[2] - 1, +wk[1])) / 86_400_000;
        if (Math.min(gap, gapPrev) > 15) l.warnings.push(`Date de paiement éloignée de la période indiquée (${wk[0]}) : à vérifier`);
      }
      if (date && amountCol !== undefined) {
        const colMonth = monthOfHeader((grid[mapping.headerRow] ?? [])[amountCol]);
        const dm = +date.slice(5, 7);
        const diff = (colMonth - dm + 12) % 12;
        if (colMonth && diff > 1) l.warnings.push(`Date ${fmtDate(date)} classée en « ${(grid[mapping.headerRow] ?? [])[amountCol]} » : à vérifier`);
      }
      return;
    }

    // ---- Grille mensuelle
    if (mapping.yearCol !== undefined) {
      const y = String(r[mapping.yearCol] ?? '').trim().match(/^(\d{4})/);
      if (y) year = +y[1];
    }
    const period = parsePeriod(r[mapping.periodCol], year);
    if (!period) {
      if (isTotalRow(r)) return; // lignes de totaux ignorées
      const label = String(r[mapping.periodCol] ?? '').trim();
      if (!label && Object.keys(mapping.memberCols).every((c) => isEmpty(r[+c]))) return;
      lines.push({ row: rowNo, kind: 'payment', errors: [label ? `Mois illisible « ${label} »` : 'Mois ou année introuvable'], warnings: [], duplicate: false });
      return;
    }
    const parsed = mapping.dateCol !== undefined ? parseDateLoose(r[mapping.dateCol]) : { date: null };
    const date = parsed.date ?? periodEnd(period);
    const rowLines: PreviewLine[] = [];
    let rowSum = 0;
    for (const [col, name] of Object.entries(mapping.memberCols)) {
      const v = amountOf(r[+col]);
      if (!v) continue;
      rowSum += v;
      const l = pushPayment(rowNo, date, name, period, v, undefined, true);
      if (parsed.fixed) l.warnings.push(`Date corrigée : ${parsed.fixed}`);
      rowLines.push(l);
    }
    let expense = 0;
    if (mapping.expenseCol !== undefined) {
      const v = amountOf(r[mapping.expenseCol]);
      if (v) {
        expense = v;
        const end = periodEnd(period);
        const d = end > today ? (today >= periodStart(period) ? today : end) : end;
        rowLines.push(pushExpense(rowNo, d, v, 'Paiement du personnel', `${mapping.expenseLabel ?? 'Dépenses du mois (import)'} — ${periodLabel(period).toLowerCase()}`, 'Dépenses communes'));
      }
    }
    // Contrôles de cohérence avec les totaux du fichier
    const first = rowLines[0];
    if (first && mapping.totalCol !== undefined && !isEmpty(r[mapping.totalCol])) {
      const t = parseMAD(r[mapping.totalCol] as string);
      if (t !== null && t !== rowSum) first.warnings.push(`Total du fichier ${fmtDate(date).slice(3)} : ${(t / 100).toFixed(2)} ≠ somme des membres ${(rowSum / 100).toFixed(2)}`);
    }
    if (first && mapping.checkCol !== undefined && !isEmpty(r[mapping.checkCol])) {
      const t = parseMAD(r[mapping.checkCol] as string);
      if (t !== null && t !== rowSum - expense) first.warnings.push(`Reste du mois dans le fichier ${(t / 100).toFixed(2)} ≠ calculé ${((rowSum - expense) / 100).toFixed(2)}`);
    }
  });
  return lines;
}

export interface ImportResult {
  state: AppState;
  imported: number;
  skipped: number;
  membersCreated: string[];
  errors: { row: number; message: string }[];
}

/** Date la plus ancienne parmi les lignes (pour proposer le solde initial). */
export const earliestDate = (lines: PreviewLine[]) => lines.map((l) => l.date).filter((d): d is string => !!d).sort()[0];

/** Applique l'import validé. Les lignes en erreur et (par défaut) les doublons sont ignorés. */
export function applyImport(s0: AppState, ctx: Ctx, lines: PreviewLine[], opts: { includeDuplicates?: boolean } = {}): ImportResult {
  let s = s0;
  let imported = 0;
  let skipped = 0;
  const errors: ImportResult['errors'] = [];
  const keep = (l: PreviewLine) => !l.errors.length && (!l.duplicate || opts.includeDuplicates);

  // 1. Création des nouveaux membres (montant par défaut = montant le plus fréquent)
  const membersCreated: string[] = [];
  const byName = new Map<string, PreviewLine[]>();
  for (const l of lines) if (l.kind === 'payment' && l.newMember && keep(l)) byName.set(l.memberName!, [...(byName.get(l.memberName!) ?? []), l]);
  for (const [name, ls] of byName) {
    if (s.members.some((m) => norm(m.name) === norm(name))) continue;
    const counts = new Map<number, number>();
    ls.forEach((l) => counts.set(l.amount!, (counts.get(l.amount!) ?? 0) + 1));
    const defaultAmount = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    const firstPeriod = ls.map((l) => l.period!).sort()[0];
    s = addMember(s, ctx, { name, joinDate: periodStart(firstPeriod), defaultAmount });
    membersCreated.push(name);
  }
  const idOf = new Map(s.members.map((m) => [norm(m.name), m.id]));

  // 2. Opérations, dans l'ordre chronologique
  const ordered = [...lines].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || (a.kind === 'payment' ? -1 : 1));
  for (const l of ordered) {
    if (!keep(l)) {
      skipped++;
      continue;
    }
    try {
      if (l.kind === 'payment') {
        const memberId = l.memberId ?? idOf.get(norm(l.memberName));
        s = generateMonth(s, ctx, l.period!).state;
        const c = s.contributions.find((cc) => cc.memberId === memberId && cc.period === l.period);
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
  if (imported) s.audit.push({ id: crypto.randomUUID(), at: ctx.now ?? new Date().toISOString(), user: ctx.user, action: 'import', entity: 'import', entityId: 'excel', after: { imported, skipped, membersCreated } });
  return { state: s, imported, skipped, membersCreated, errors };
}
