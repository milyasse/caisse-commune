import type { ISODate, Period } from './types.ts';

export const MONTHS_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
export const MONTHS_SHORT = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

const pad = (n: number) => String(n).padStart(2, '0');

export function todayISO(now = new Date()): ISODate {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isValidISO(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, day] = d.split('-').map(Number);
  return m >= 1 && m <= 12 && day >= 1 && day <= daysInMonth(y, m);
}

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export const periodOf = (d: ISODate): Period => d.slice(0, 7);
export const makePeriod = (y: number, m: number): Period => `${y}-${pad(m)}`;
export const periodYear = (p: Period) => Number(p.slice(0, 4));
export const periodMonth = (p: Period) => Number(p.slice(5, 7));

export function addMonths(p: Period, n: number): Period {
  const idx = periodYear(p) * 12 + (periodMonth(p) - 1) + n;
  return makePeriod(Math.floor(idx / 12), (idx % 12) + 1);
}

export const periodStart = (p: Period): ISODate => `${p}-01`;
export const periodEnd = (p: Period): ISODate => `${p}-${pad(daysInMonth(periodYear(p), periodMonth(p)))}`;

/** dueDay = 0 => dernier jour du mois ; sinon jour N (borné à la fin du mois). */
export function dueDateFor(p: Period, dueDay: number): ISODate {
  const last = daysInMonth(periodYear(p), periodMonth(p));
  const d = dueDay <= 0 ? last : Math.min(dueDay, last);
  return `${p}-${pad(d)}`;
}

/** "2026-10-10" -> "10/10/2026" */
export function fmtDate(d: ISODate | undefined): string {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${day}/${m}/${y}`;
}

/** "10/10/2026" ou "2026-10-10" ou numéro de série Excel -> ISO, sinon null */
export function parseDateFR(s: string | number | null | undefined): ISODate | null {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number' || /^\d{5}(\.\d+)?$/.test(String(s))) {
    // date série Excel (base 1899-12-30)
    const serial = Math.floor(Number(s));
    const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }
  const str = String(s).trim();
  let m = str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
    return isValidISO(iso) ? iso : null;
  }
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return isValidISO(m[0]) ? m[0] : null;
  return null;
}

export const periodLabel = (p: Period) => `${MONTHS_FR[periodMonth(p) - 1]} ${periodYear(p)}`;

export function periodsBetween(from: Period, to: Period): Period[] {
  const out: Period[] = [];
  for (let p = from; p <= to; p = addMonths(p, 1)) out.push(p);
  return out;
}
