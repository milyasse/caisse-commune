import type { Cents } from './types.ts';

const NBSP = ' ';

/** 160000 -> "1 600,00 MAD" */
export function formatMAD(c: Cents, withCurrency = true): string {
  if (!Number.isInteger(c)) throw new Error('Montant non entier (centimes attendus)');
  const neg = c < 0;
  const abs = Math.abs(c);
  const units = Math.floor(abs / 100).toString();
  const dec = (abs % 100).toString().padStart(2, '0');
  const grouped = units.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${neg ? '-' : ''}${grouped},${dec}${withCurrency ? NBSP + 'MAD' : ''}`;
}

/**
 * Analyse une saisie utilisateur ("1 600,50", "1600.5", "400") en centimes.
 * Retourne null si invalide. N'utilise jamais de calcul flottant.
 */
export function parseMAD(input: string | number | null | undefined): Cents | null {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/MAD|DH|dhs?/gi, '').replace(/[\s  ]/g, '');
  if (!s) return null;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  // Si virgule et point : le dernier est le séparateur décimal
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart = s;
  let decPart = '';
  const sep = Math.max(lastComma, lastDot);
  if (sep >= 0) {
    const after = s.slice(sep + 1);
    if (after.length <= 2 || (lastComma >= 0 && lastDot >= 0)) {
      intPart = s.slice(0, sep).replace(/[.,]/g, '');
      decPart = after;
    } else {
      // "1.600" ou "1,600" = séparateur de milliers
      intPart = s.replace(/[.,]/g, '');
    }
  }
  if (!/^\d+$/.test(intPart || '0') || !/^\d{0,2}$/.test(decPart)) return null;
  const c = Number(intPart || '0') * 100 + Number(decPart.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(c)) return null;
  return neg ? -c : c;
}

export const sum = (xs: Cents[]): Cents => xs.reduce((a, b) => a + b, 0);
