/**
 * Exports : classeur Excel (avec formules cohérentes), CSV des opérations,
 * et rapports HTML imprimables (→ PDF via « Imprimer / Enregistrer en PDF »).
 */
import type { AppState, Period } from '../domain/types.ts';
import { annualTable, allOperations, monthSummary, yearSummary, contributionRows, balanceBefore, memberTotals } from '../domain/finance.ts';
import { fmtDate, makePeriod, MONTHS_FR, periodLabel } from '../domain/dates.ts';
import { formatMAD } from '../domain/money.ts';
import { buildXlsx, colName, type XCell, type XSheet } from './xlsx.ts';

const mad = (c: number) => Math.round(c) / 100; // centimes -> nombre Excel (2 décimales exactes)
const money = (c: number): XCell => ({ v: mad(c), money: true });
const H = (s: string): XCell => ({ s, bold: true });
const METHOD: Record<string, string> = { especes: 'Espèces', virement: 'Virement', autre: 'Autre' };

export function workbookFor(s: AppState, year: number, month: Period): Uint8Array {
  const members = [...s.members].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const table = annualTable(s, year);
  const n = members.length;
  const opening = balanceBefore(s, `${year}-01-01`);

  // ---- Feuille 1 : tableau annuel (logique du tableau Excel actuel)
  const r1: XCell[][] = [];
  r1.push([H(`Tableau annuel ${year} — ${s.settings.groupName}`)]);
  r1.push([H("Solde d'ouverture de l'année"), money(opening)]);
  r1.push([]);
  const header = [H('Mois'), ...members.map((m) => H(`${m.name} (versé)`)), H('Total imputé'), H('Encaissé (trésorerie)'), H('Cumul encaissé'), H('Dépenses'), H('Solde du mois'), H('Solde cumulé fin de mois')];
  r1.push(header);
  const first = 5; // première ligne de données (1-based)
  const cTot = n + 1, cEnc = n + 2, cCum = n + 3, cDep = n + 4, cSol = n + 5, cFin = n + 6;
  table.forEach((row, i) => {
    const r = first + i;
    const L = (c: number) => `${colName(c)}${r}`;
    const P = (c: number) => `${colName(c)}${r - 1}`;
    r1.push([
      MONTHS_FR[i],
      ...members.map((m) => money(row.paidByMember[m.id] ?? 0)),
      { f: n ? `SUM(${colName(1)}${r}:${colName(n)}${r})` : '0', v: mad(row.totalAllocated), money: true },
      money(row.received),
      { f: i === 0 ? `${L(cEnc)}` : `${P(cCum)}+${L(cEnc)}`, v: mad(row.cumulativeReceived), money: true },
      money(row.expenses),
      { f: `${L(cEnc)}-${L(cDep)}`, v: mad(row.monthlyBalance), money: true },
      { f: i === 0 ? `$B$2+${L(cSol)}` : `${P(cFin)}+${L(cSol)}`, v: mad(row.closing), money: true },
    ]);
  });
  const last = first + 11;
  r1.push([
    H('Total'),
    ...members.map((_, j) => ({ f: `SUM(${colName(j + 1)}${first}:${colName(j + 1)}${last})`, money: true, bold: true }) as XCell),
    { f: `SUM(${colName(cTot)}${first}:${colName(cTot)}${last})`, money: true, bold: true },
    { f: `SUM(${colName(cEnc)}${first}:${colName(cEnc)}${last})`, money: true, bold: true },
    null,
    { f: `SUM(${colName(cDep)}${first}:${colName(cDep)}${last})`, money: true, bold: true },
    { f: `SUM(${colName(cSol)}${first}:${colName(cSol)}${last})`, money: true, bold: true },
    { f: `${colName(cFin)}${last}`, money: true, bold: true },
  ]);
  r1.push([]);
  r1.push(['Note : « Total imputé » = versements rattachés aux cotisations du mois ; « Encaissé » = argent reçu pendant le mois (date réelle). Les soldes utilisent l’encaissé.']);

  // ---- Feuille 2 : attendu / versé / reste par membre
  const r2: XCell[][] = [[H('Mois'), ...members.flatMap((m) => [H(`${m.name} attendu`), H(`${m.name} versé`), H(`${m.name} reste`)]), H('Total attendu'), H('Total reste')]];
  table.forEach((row, i) => {
    const r = i + 2;
    const cells: XCell[] = [MONTHS_FR[i]];
    members.forEach((m, j) => {
      const a = 1 + j * 3;
      cells.push(money(row.expectedByMember[m.id] ?? 0), money(row.paidByMember[m.id] ?? 0), { f: `MAX(0,${colName(a)}${r}-${colName(a + 1)}${r})`, money: true });
    });
    cells.push({ f: members.map((_, j) => `${colName(1 + j * 3)}${r}`).join('+') || '0', money: true });
    cells.push({ f: members.map((_, j) => `${colName(3 + j * 3)}${r}`).join('+') || '0', money: true });
    r2.push(cells);
  });

  // ---- Feuille 3 : rapport mensuel
  const ms = monthSummary(s, month);
  const r3: XCell[][] = [
    [H(`Rapport mensuel — ${periodLabel(month)}`)],
    [H('Indicateur'), H('Montant')],
    ["Solde d'ouverture", money(ms.opening)],
    ['Cotisations attendues', money(ms.expected)],
    ['Cotisations encaissées', money(ms.received)],
    ['Dépenses du mois', money(ms.expenses)],
    [H('Solde de clôture'), { f: 'B3+B5-B6', v: mad(ms.closing), money: true, bold: true }],
    ['Reste à encaisser', money(ms.remaining)],
    [],
    [H('Membre'), H('Attendu'), H('Versé'), H('Reste'), H('Statut'), H('Dernier versement')],
    ...contributionRows(s, month).map((r, i) => [r.memberName, money(r.contribution.expected), money(r.paid), { f: `B${11 + i}-C${11 + i}`, money: true }, statusLabel(r.status), fmtDate(r.lastPaymentDate)] as XCell[]),
  ];

  // ---- Feuilles 4/5 : opérations détaillées
  const names = new Map(s.members.map((m) => [m.id, m.name]));
  const contrib = new Map(s.contributions.map((c) => [c.id, c]));
  const cats = new Map(s.categories.map((c) => [c.id, c.name]));
  const r4: XCell[][] = [[H('Date'), H('Membre'), H('Mois concerné'), H('Montant'), H('Mode'), H('Statut'), H('Commentaire'), H('Identifiant')]];
  for (const p of [...s.payments].sort((a, b) => a.date.localeCompare(b.date)))
    r4.push([fmtDate(p.date), names.get(p.memberId) ?? '', contrib.get(p.contributionId)?.period ?? '', money(p.amount), METHOD[p.method], p.status === 'valid' ? 'Valide' : `Annulé (${p.cancelReason ?? ''})`, p.comment ?? '', p.id]);
  const r5: XCell[][] = [[H('Date'), H('Catégorie'), H('Description'), H('Bénéficiaire'), H('Montant'), H('Mode'), H('Référence'), H('Statut'), H('Commentaire'), H('Identifiant')]];
  for (const e of [...s.expenses].sort((a, b) => a.date.localeCompare(b.date)))
    r5.push([fmtDate(e.date), cats.get(e.categoryId) ?? '', e.description, e.beneficiary, money(e.amount), METHOD[e.method], e.reference ?? '', e.status === 'valid' ? 'Valide' : `Annulé (${e.cancelReason ?? ''})`, e.comment ?? '', e.id]);

  const sheets: XSheet[] = [
    { name: `Annuel ${year}`, rows: r1, colWidths: [14, ...members.map(() => 15), 15, 18, 16, 14, 15, 20] },
    { name: 'Par membre', rows: r2, colWidths: [14, ...members.flatMap(() => [14, 14, 14]), 15, 15] },
    { name: 'Rapport mensuel', rows: r3, colWidths: [26, 16, 16, 16, 12, 18] },
    { name: 'Versements', rows: r4, colWidths: [12, 16, 14, 14, 10, 18, 30, 38] },
    { name: 'Dépenses', rows: r5, colWidths: [12, 22, 32, 22, 14, 10, 14, 18, 30, 38] },
  ];
  return buildXlsx(sheets);
}

export const statusLabel = (st: string) => ({ paye: 'Payé', partiel: 'Partiel', non_paye: 'Non payé' })[st] ?? st;

/** CSV des opérations (séparateur « ; », décimales « , » — ouvrable directement dans Excel FR). */
export function operationsCsv(s: AppState): string {
  const names = new Map(s.members.map((m) => [m.id, m.name]));
  const contrib = new Map(s.contributions.map((c) => [c.id, c]));
  const cats = new Map(s.categories.map((c) => [c.id, c.name]));
  const q = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const amount = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  const lines = ['Date;Type;Membre / Bénéficiaire;Mois concerné;Catégorie;Description;Montant (MAD);Mode;Statut;Commentaire;Identifiant'];
  for (const op of [...allOperations(s)].reverse()) {
    if (op.kind === 'payment') {
      const p = op.item;
      lines.push([fmtDate(p.date), 'Cotisation', names.get(p.memberId) ?? '', contrib.get(p.contributionId)?.period ?? '', '', 'Versement', amount(p.amount), METHOD[p.method], p.status === 'valid' ? 'Valide' : 'Annulé', p.comment ?? '', p.id].map(q).join(';'));
    } else {
      const e = op.item;
      lines.push([fmtDate(e.date), 'Dépense', e.beneficiary, '', cats.get(e.categoryId) ?? '', e.description, '-' + amount(e.amount), METHOD[e.method], e.status === 'valid' ? 'Valide' : 'Annulé', e.comment ?? '', e.id].map(q).join(';'));
    }
  }
  return '﻿' + lines.join('\r\n');
}

// ------------------------------------------------------------------ Rapports imprimables
const css = `body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#17231c;margin:24px;font-size:12px}
h1{font-size:18px;margin:0 0 2px}h2{font-size:14px;margin:18px 0 6px}.muted{color:#5b6b62}
table{border-collapse:collapse;width:100%;margin-top:6px}th,td{border:1px solid #cfd8d2;padding:4px 6px;text-align:left}
th{background:#eef3ef}td.n,th.n{text-align:right;white-space:nowrap}tr.tot td{font-weight:700;background:#f6f8f6}
.demo{border:1px solid #c26a00;color:#8a4b00;padding:4px 8px;display:inline-block;margin:6px 0}
@page{size:A4 landscape;margin:12mm}`;

function page(title: string, s: AppState, body: string) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>
<h1>${title}</h1><div class="muted">${s.settings.groupName} — édité le ${fmtDate(new Date().toISOString().slice(0, 10))}</div>
${s.settings.isDemo ? '<div class="demo">Données fictives de démonstration</div>' : ''}${body}</body></html>`;
}

export function monthlyReportHtml(s: AppState, p: Period): string {
  const m = monthSummary(s, p);
  const rows = contributionRows(s, p);
  const ind = [
    ["Solde d'ouverture", m.opening],
    ['Cotisations attendues', m.expected],
    ['Cotisations encaissées', m.received],
    ['Dépenses du mois', m.expenses],
    ['Solde de clôture', m.closing],
    ['Reste à encaisser', m.remaining],
  ] as const;
  const cats = new Map(s.categories.map((c) => [c.id, c.name]));
  const exp = s.expenses.filter((e) => e.status === 'valid' && e.date.startsWith(p)).sort((a, b) => a.date.localeCompare(b.date));
  return page(
    `Rapport mensuel — ${periodLabel(p)}`,
    s,
    `<h2>Synthèse</h2><table><tr><th>Indicateur</th><th class="n">Montant</th></tr>${ind.map(([k, v]) => `<tr${k === 'Solde de clôture' ? ' class="tot"' : ''}><td>${k}</td><td class="n">${formatMAD(v)}</td></tr>`).join('')}</table>
<h2>Cotisations</h2><table><tr><th>Membre</th><th class="n">Attendu</th><th class="n">Versé</th><th class="n">Reste</th><th>Statut</th><th>Date(s) de versement</th></tr>
${rows.map((r) => `<tr><td>${r.memberName}</td><td class="n">${formatMAD(r.contribution.expected)}</td><td class="n">${formatMAD(r.paid)}</td><td class="n">${formatMAD(r.remaining)}</td><td>${statusLabel(r.status)}${r.late ? ' (en retard)' : ''}</td><td>${r.payments.map((x) => fmtDate(x.date)).join(', ')}</td></tr>`).join('')}</table>
<h2>Dépenses</h2><table><tr><th>Date</th><th>Catégorie</th><th>Description</th><th>Bénéficiaire</th><th class="n">Montant</th></tr>
${exp.map((e) => `<tr><td>${fmtDate(e.date)}</td><td>${cats.get(e.categoryId) ?? ''}</td><td>${e.description}</td><td>${e.beneficiary}</td><td class="n">${formatMAD(e.amount)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucune dépense</td></tr>'}</table>`,
  );
}

export function annualReportHtml(s: AppState, year: number): string {
  const members = [...s.members].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const t = annualTable(s, year);
  const y = yearSummary(s, year);
  return page(
    `Rapport annuel ${year}`,
    s,
    `<h2>Synthèse</h2><table><tr><th>Solde d'ouverture</th><th>Encaissé</th><th>Dépenses</th><th>Solde de fin d'année</th><th>Attendu</th><th>Reste à encaisser</th></tr>
<tr>${[y.opening, y.received, y.expenses, y.closing, y.expected, y.remaining].map((v) => `<td class="n">${formatMAD(v)}</td>`).join('')}</tr></table>
<h2>Détail mensuel</h2><table><tr><th>Mois</th>${members.map((m) => `<th class="n">${m.name}</th>`).join('')}<th class="n">Total imputé</th><th class="n">Encaissé</th><th class="n">Cumul</th><th class="n">Dépenses</th><th class="n">Solde mois</th><th class="n">Solde cumulé</th></tr>
${t.map((r, i) => `<tr><td>${MONTHS_FR[i]}</td>${members.map((m) => `<td class="n">${r.expectedByMember[m.id] === undefined ? '—' : formatMAD(r.paidByMember[m.id] ?? 0, false) + ' / ' + formatMAD(r.expectedByMember[m.id], false)}</td>`).join('')}<td class="n">${formatMAD(r.totalAllocated)}</td><td class="n">${formatMAD(r.received)}</td><td class="n">${formatMAD(r.cumulativeReceived)}</td><td class="n">${formatMAD(r.expenses)}</td><td class="n">${formatMAD(r.monthlyBalance)}</td><td class="n">${formatMAD(r.closing)}</td></tr>`).join('')}
</table><p class="muted">Colonnes membres : versé / attendu pour le mois concerné.</p>`,
  );
}

export const defaultMonth = (year: number) => makePeriod(year, 1);

/** Totaux des cotisations par membre sur une période (mois, année ou entre deux dates). */
export function memberTotalsWorkbook(s: AppState, from: string, to: string, label: string, today?: string): Uint8Array {
  const { rows, total } = memberTotals(s, from, to, today);
  const r: XCell[][] = [];
  r.push([H(`Totaux des cotisations par membre — ${label}`)]);
  r.push([`Du ${fmtDate(from)} au ${fmtDate(to)} — ${s.settings.groupName}`]);
  r.push([]);
  r.push([H('Membre'), H('Statut'), H('Mois dus'), H('Attendu'), H('Versé pour ces mois'), H('Reste'), H('Reçu pendant la période'), H('Nb versements'), H('Mois en retard')]);
  const first = 5;
  for (const x of rows) {
    r.push([x.name, x.leftDate ? `Inactif depuis le ${fmtDate(x.leftDate)}` : x.active ? 'Actif' : 'Inactif', x.months, money(x.expected), money(x.paidForPeriod), money(x.remaining), money(x.received), x.payments, x.lateMonths]);
  }
  const last = first + rows.length - 1;
  const S = (c: string): XCell => (rows.length ? { f: `SUM(${c}${first}:${c}${last})`, money: c !== 'C' && c !== 'H' && c !== 'I', bold: true } : { v: 0 });
  r.push([H('Total'), null, S('C'), S('D'), S('E'), S('F'), S('G'), S('H'), S('I')]);
  r.push([]);
  r.push(['« Versé pour ces mois » : versements rattachés aux cotisations des mois de la période (même payés plus tard). « Reçu » : argent réellement reçu entre les deux dates.']);
  void total;
  return buildXlsx([{ name: 'Totaux par membre', rows: r, colWidths: [22, 26, 10, 16, 20, 16, 22, 14, 14] }]);
}

export function memberTotalsCsv(s: AppState, from: string, to: string, today?: string): string {
  const { rows, total } = memberTotals(s, from, to, today);
  const n = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  const lines = [['Membre', 'Statut', 'Mois dus', 'Attendu', 'Versé pour ces mois', 'Reste', 'Reçu pendant la période', 'Nb versements', 'Mois en retard'].join(';')];
  for (const x of rows) lines.push([x.name, x.leftDate ? `Inactif depuis le ${fmtDate(x.leftDate)}` : x.active ? 'Actif' : 'Inactif', x.months, n(x.expected), n(x.paidForPeriod), n(x.remaining), n(x.received), x.payments, x.lateMonths].join(';'));
  lines.push(['Total', '', total.months, n(total.expected), n(total.paidForPeriod), n(total.remaining), n(total.received), total.payments, total.lateMonths].join(';'));
  return '﻿' + lines.join('\r\n');
}
