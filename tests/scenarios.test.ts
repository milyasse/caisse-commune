/**
 * Scénarios du cahier des charges (§10, étape 5) + règles financières.
 * Lancement : node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, demoState } from '../src/domain/seed.ts';
import * as C from '../src/domain/commands.ts';
import { monthSummary, contributionRows, yearSummary, balanceAt, annualTable, memberTotals, memberStats, isActiveOn, receiptsBetween, expensesBetween } from '../src/domain/finance.ts';
import { formatMAD, parseMAD } from '../src/domain/money.ts';
import { buildPreview, applyImport, guessMapping, type Grid } from '../src/io/importer.ts';
import { MemoryRemote, syncOnce, emptyMeta, enqueue, diffToOutbox } from '../src/domain/sync.ts';
import { buildXlsx, readXlsx, readCsv } from '../src/io/xlsx.ts';
import { workbookFor, operationsCsv, monthlyReportHtml } from '../src/io/exports.ts';
import type { AppState } from '../src/domain/types.ts';

const TODAY = '2026-03-20';
const ctx: C.Ctx = { user: 'test', role: 'admin', today: TODAY, now: '2026-03-20T10:00:00.000Z' };

function base(): AppState {
  let s = emptyState(TODAY);
  s.settings.openingDate = '2026-01-01';
  s.settings.openingBalance = 1000_00;
  s = C.addMember(s, ctx, { name: 'Ahmed', joinDate: '2026-01-01', defaultAmount: 400_00 });
  s = C.addMember(s, ctx, { name: 'Bouazza', joinDate: '2026-01-01', defaultAmount: 600_00 });
  for (const p of ['2026-01', '2026-02', '2026-03']) s = C.generateMonth(s, ctx, p).state;
  return s;
}
const mid = (s: AppState, name: string) => s.members.find((m) => m.name === name)!.id;
const cid = (s: AppState, name: string, p: string) => s.contributions.find((c) => c.memberId === mid(s, name) && c.period === p)!.id;
const row = (s: AppState, name: string, p: string) => contributionRows(s, p, TODAY).find((r) => r.memberName === name)!;
const pay = (s: AppState, name: string, p: string, date: string, amount: number, opts?: { allowDuplicate?: boolean }) =>
  C.addPayment(s, ctx, { contributionId: cid(s, name, p), date, amount, method: 'especes' }, opts);

test('Format et saisie des montants (centimes, pas de flottants)', () => {
  assert.equal(formatMAD(160000), '1 600,00 MAD');
  assert.equal(parseMAD('1 600,50'), 160050);
  assert.equal(parseMAD('1600.5'), 160050);
  assert.equal(parseMAD('1.600'), 160000);
  assert.equal(parseMAD('400'), 40000);
  assert.equal(parseMAD('12,345'), 1234500);
  assert.equal(parseMAD('abc'), null);
  assert.equal(parseMAD('0,1')! + parseMAD('0,2')!, 30); // 0,1 + 0,2 = 0,30 exactement
});

test('1. Un membre paie intégralement sa cotisation', () => {
  const s = pay(base(), 'Ahmed', '2026-01', '2026-01-31', 400_00);
  const r = row(s, 'Ahmed', '2026-01');
  assert.equal(r.status, 'paye');
  assert.equal(r.remaining, 0);
  assert.equal(r.late, false);
});

test('2. Paiement partiel', () => {
  const s = pay(base(), 'Bouazza', '2026-01', '2026-01-31', 250_00);
  const r = row(s, 'Bouazza', '2026-01');
  assert.equal(r.status, 'partiel');
  assert.equal(r.remaining, 350_00);
  assert.equal(r.late, true); // échéance 31/01 dépassée
});

test('3. Paiement en deux fois — sans double comptage', () => {
  let s = pay(base(), 'Bouazza', '2026-02', '2026-02-10', 300_00);
  s = pay(s, 'Bouazza', '2026-02', '2026-02-27', 300_00);
  const r = row(s, 'Bouazza', '2026-02');
  assert.equal(r.paid, 600_00);
  assert.equal(r.status, 'paye');
  const m = monthSummary(s, '2026-02', TODAY);
  assert.equal(m.received, 600_00);
  assert.equal(m.allocated, 600_00);
  // un 3e versement dépasserait l'attendu : refusé
  assert.throws(() => pay(s, 'Bouazza', '2026-02', '2026-02-28', 1_00), /dépasse/);
});

test('4. Une cotisation reste impayée : comptée en « reste », jamais en caisse', () => {
  const s = pay(base(), 'Ahmed', '2026-01', '2026-01-31', 400_00);
  const m = monthSummary(s, '2026-01', TODAY);
  assert.equal(m.expected, 1000_00);
  assert.equal(m.received, 400_00);
  assert.equal(m.remaining, 600_00);
  assert.equal(m.closing, 1000_00 + 400_00); // l'impayé n'augmente pas la caisse
  assert.equal(row(s, 'Bouazza', '2026-01').status, 'non_paye');
  assert.equal(m.unpaidCount, 1);
});

test('5. Paiement après le mois concerné : trésorerie à la date réelle, rattaché au mois dû', () => {
  const s = pay(base(), 'Ahmed', '2026-01', '2026-02-03', 400_00);
  const jan = monthSummary(s, '2026-01', TODAY);
  const feb = monthSummary(s, '2026-02', TODAY);
  assert.equal(jan.received, 0); // pas encaissé en janvier
  assert.equal(jan.remaining, 600_00); // mais la cotisation de janvier d'Ahmed est soldée
  assert.equal(row(s, 'Ahmed', '2026-01').status, 'paye');
  assert.equal(feb.received, 400_00); // encaissé en février
  assert.equal(feb.allocated, 0); // rien imputé aux cotisations de février
});

test('6. Dépense en milieu de mois', () => {
  let s = pay(base(), 'Ahmed', '2026-02', '2026-02-28', 400_00);
  const cat = s.categories[0].id;
  s = C.addExpense(s, ctx, { date: '2026-02-14', categoryId: cat, description: 'Salaire gardien', beneficiary: 'Hassan', amount: 1200_00, method: 'especes' });
  assert.equal(balanceAt(s, '2026-02-13'), 1000_00);
  assert.equal(balanceAt(s, '2026-02-14'), -200_00);
  const m = monthSummary(s, '2026-02', TODAY);
  assert.equal(m.expenses, 1200_00);
  assert.equal(m.closing, 1000_00 + 400_00 - 1200_00);
});

test('7. Solde de clôture reporté au mois suivant + verrouillage', () => {
  let s = pay(base(), 'Ahmed', '2026-01', '2026-01-31', 400_00);
  s = C.closeMonth(s, ctx, '2026-01');
  const jan = monthSummary(s, '2026-01', TODAY);
  const feb = monthSummary(s, '2026-02', TODAY);
  assert.equal(jan.closing, 1400_00);
  assert.equal(feb.opening, jan.closing);
  assert.equal(jan.closure?.matches, true);
  // ordre obligatoire et verrouillage
  assert.throws(() => C.closeMonth(s, ctx, '2026-03'), /mois/);
  assert.throws(() => pay(s, 'Bouazza', '2026-01', '2026-01-30', 100_00), /clôturé/);
  // un versement tardif EN février pour janvier reste possible (trésorerie de février)
  s = pay(s, 'Bouazza', '2026-01', '2026-02-02', 600_00);
  assert.equal(monthSummary(s, '2026-01', TODAY).closure?.matches, true);
  assert.equal(monthSummary(s, '2026-02', TODAY).opening, 1400_00);
  // réouverture tracée
  s = C.reopenMonth(s, ctx, '2026-01', 'Erreur de saisie');
  assert.ok(s.audit.some((a) => a.action === 'reopen' && a.reason === 'Erreur de saisie'));
});

test('8. Correction d’une opération avec trace (et annulation sans suppression)', () => {
  let s = pay(base(), 'Ahmed', '2026-03', '2026-03-05', 300_00);
  const id = s.payments[0].id;
  assert.throws(() => C.updatePayment(s, ctx, id, { amount: 400_00 }, ''), /motif/);
  s = C.updatePayment(s, ctx, id, { amount: 400_00 }, 'Erreur de frappe');
  const log = s.audit.find((a) => a.action === 'update' && a.entityId === id)!;
  assert.equal((log.before as { amount: number }).amount, 300_00);
  assert.equal((log.after as { amount: number }).amount, 400_00);
  s = C.cancelPayment(s, ctx, id, 'Versement en double');
  assert.equal(s.payments.length, 1); // jamais supprimé
  assert.equal(s.payments[0].status, 'cancelled');
  assert.equal(monthSummary(s, '2026-03', TODAY).received, 0);
});

test('Doublon manuel détecté ; montant modifié sans effet rétroactif', () => {
  let s = pay(base(), 'Ahmed', '2026-01', '2026-01-31', 200_00);
  assert.throws(() => pay(s, 'Ahmed', '2026-01', '2026-01-31', 200_00), /identique/);
  s = pay(s, 'Ahmed', '2026-01', '2026-01-31', 200_00, { allowDuplicate: true });
  s = C.setMemberAmount(s, ctx, mid(s, 'Ahmed'), 600_00, '2026-03');
  assert.equal(s.contributions.find((c) => c.id === cid(s, 'Ahmed', '2026-01'))!.expected, 400_00);
  assert.equal(s.contributions.find((c) => c.id === cid(s, 'Ahmed', '2026-03'))!.expected, 600_00);
  s = C.generateMonth(s, { ...ctx, today: '2026-04-02' }, '2026-04').state;
  assert.equal(s.contributions.find((c) => c.id === cid(s, 'Ahmed', '2026-04'))!.expected, 600_00);
  // génération idempotente
  assert.equal(C.generateMonth(s, ctx, '2026-04').created, 0);
});

test('Dates futures et droits refusés', () => {
  const s = base();
  assert.throws(() => pay(s, 'Ahmed', '2026-03', '2026-03-25', 100_00), /futur/);
  assert.throws(() => C.addMember(s, { ...ctx, role: 'user' }, { name: 'X', joinDate: '2026-01-01', defaultAmount: 1 }), /administrateur/);
});

test('9. Import Excel contenant des doublons (grille mensuelle façon tableau actuel)', async () => {
  let s = pay(base(), 'Ahmed', '2026-01', '2026-01-31', 400_00); // déjà saisi dans l'app
  const grid: Grid = [
    ['Tableau des cotisations 2026'],
    ['Mois', 'Date', 'Ahmed', 'Bouazza', 'Dépenses'],
    ['Janvier 2026', '31/01/2026', 400, 600, 1200],
    ['Février 2026', '28/02/2026', 400, 300, 1200],
    ['Février 2026', '28/02/2026', 400, '', ''], // ligne dupliquée dans le fichier
    ['Mars 2026', '31/03/2026', 400, 600, ''], // date future (aujourd'hui = 20/03)
    ['Mois ??', '', 'abc', '', ''],
    ['Total', '', 1600, 1500, 2400],
  ];
  // via un vrai fichier xlsx (écriture puis relecture)
  const bin = buildXlsx([{ name: 'Feuil1', rows: grid as never }]);
  const [{ grid: read }] = await readXlsx(bin);
  const mapping = guessMapping(read, s);
  assert.equal(mapping.layout, 'grid');
  const lines = buildPreview(read, mapping, s, TODAY);
  const dupes = lines.filter((l) => l.duplicate);
  assert.equal(dupes.length, 2); // Ahmed janvier (déjà en base) + Ahmed février (2e fois)
  assert.ok(lines.some((l) => l.errors.some((e) => /futur/.test(e))));
  assert.ok(lines.some((l) => l.errors.some((e) => /illisible/.test(e))));
  const before = s.payments.length;
  const res = applyImport(s, ctx, lines);
  s = res.state;
  // importés : Bouazza jan 600, dépense jan, Ahmed fév 400, Bouazza fév 300, dépense fév = 5
  assert.equal(res.imported, 5);
  assert.equal(s.payments.length, before + 3);
  assert.equal(s.expenses.length, 2);
  assert.equal(monthSummary(s, '2026-02', TODAY).remaining, 300_00);
  // ré-importer le même fichier n'ajoute rien
  const again = applyImport(s, ctx, buildPreview(read, mapping, s, TODAY));
  assert.equal(again.imported, 0);
});

test('10. Deux appareils synchronisent sans doublon', async () => {
  const server = new MemoryRemote();
  // appareil A : crée membres + mois, pousse
  let a = base();
  let metaA = enqueue(emptyMeta(), diffToOutbox(emptyState(TODAY), a));
  ({ state: a, meta: metaA } = await syncOnce(a, metaA, server));
  // appareil B : part de vide, récupère tout
  let b = emptyState(TODAY);
  b.settings = a.settings;
  let metaB = emptyMeta();
  ({ state: b, meta: metaB } = await syncOnce(b, metaB, server));
  assert.equal(b.members.length, 2);
  // hors ligne : A enregistre un versement, B une dépense ; les deux génèrent avril (même id stable)
  const ctxApr = { ...ctx, today: '2026-04-15' };
  const a0 = a;
  a = C.addPayment(a, ctxApr, { contributionId: cid(a, 'Ahmed', '2026-03'), date: '2026-04-02', amount: 400_00, method: 'especes' });
  a = C.generateMonth(a, ctxApr, '2026-04').state;
  metaA = enqueue(metaA, diffToOutbox(a0, a));
  const b0 = b;
  b = C.addExpense(b, ctxApr, { date: '2026-04-05', categoryId: b.categories[0].id, description: 'Salaire', beneficiary: 'Hassan', amount: 1200_00, method: 'especes' });
  b = C.generateMonth(b, ctxApr, '2026-04').state;
  metaB = enqueue(metaB, diffToOutbox(b0, b));
  // A pousse deux fois (réseau coupé après envoi) : idempotent
  await syncOnce(a, metaA, server);
  ({ state: a, meta: metaA } = await syncOnce(a, metaA, server));
  ({ state: b, meta: metaB } = await syncOnce(b, metaB, server));
  ({ state: a, meta: metaA } = await syncOnce(a, metaA, server));
  for (const st of [a, b]) {
    assert.equal(st.payments.length, 1);
    assert.equal(st.expenses.length, 1);
    assert.equal(st.contributions.filter((c) => c.period === '2026-04').length, 2);
  }
  assert.equal(server.count('contributions'), 8);
  assert.deepEqual(monthSummary(a, '2026-04', '2026-04-15'), monthSummary(b, '2026-04', '2026-04-15'));
  // annulation sur B propagée, non « ressuscitée » par A
  const pid = b.payments[0].id;
  const b1 = b;
  b = C.cancelPayment(b, ctxApr, pid, 'Erreur');
  metaB = enqueue(metaB, diffToOutbox(b1, b));
  ({ state: b, meta: metaB } = await syncOnce(b, metaB, server));
  ({ state: a, meta: metaA } = await syncOnce(a, metaA, server));
  assert.equal(a.payments[0].status, 'cancelled');
});

test('Données de démonstration cohérentes', () => {
  const today = '2026-10-10';
  const s = demoState(today);
  assert.equal(s.settings.isDemo, true);
  assert.equal(s.members.length, 4);
  const y = yearSummary(s, 2026, today);
  assert.equal(y.closing, balanceAt(s, today));
  // le solde cumulé de fin de mois enchaîne bien
  for (let i = 1; i < 12; i++) assert.equal(y.months[i].opening, y.months[i - 1].closing);
  const oct = monthSummary(s, '2026-10', today);
  assert.ok(oct.remaining > 0);
  const t = annualTable(s, 2026);
  assert.equal(t.at(-1)!.closing, y.closing);
});

test('Exports : xlsx relisible, CSV, rapport HTML', async () => {
  const today = '2026-10-10';
  const s = demoState(today);
  const bin = workbookFor(s, 2026, '2026-09');
  const sheets = await readXlsx(bin);
  assert.deepEqual(sheets.map((x) => x.name), ['Annuel 2026', 'Par membre', 'Rapport mensuel', 'Versements', 'Dépenses']);
  assert.equal(sheets[0].grid[3][0], 'Mois');
  const csv = operationsCsv(s);
  assert.ok(readCsv(csv.slice(1)).length > 20);
  assert.match(monthlyReportHtml(s, '2026-09'), /Solde de clôture/);
});

test('Totaux par membre : mois, année, entre deux dates', () => {
  let s = base();
  s = pay(s, 'Ahmed', '2026-01', '2026-01-10', 400_00);
  s = pay(s, 'Ahmed', '2026-02', '2026-03-05', 400_00); // février payé en mars
  s = pay(s, 'Bouazza', '2026-01', '2026-01-20', 300_00);
  // Année (jan → mars)
  const y = memberTotals(s, '2026-01-01', '2026-12-31', TODAY);
  const a = y.rows.find((r) => r.name === 'Ahmed')!;
  assert.equal(a.expected, 1200_00);
  assert.equal(a.paidForPeriod, 800_00);
  assert.equal(a.remaining, 400_00);
  assert.equal(a.received, 800_00);
  assert.equal(a.payments, 2);
  assert.equal(y.total.expected, 3000_00);
  assert.equal(y.total.received, 1100_00);
  // Un mois : février -> versé pour février 400 (payé en mars), reçu en février 0
  const f = memberTotals(s, '2026-02-01', '2026-02-28', TODAY).rows.find((r) => r.name === 'Ahmed')!;
  assert.equal(f.paidForPeriod, 400_00);
  assert.equal(f.received, 0);
  // Entre deux dates (01/03 → 20/03) : reçu 400 (versement du 05/03)
  const m = memberTotals(s, '2026-03-01', '2026-03-20', TODAY).rows.find((r) => r.name === 'Ahmed')!;
  assert.equal(m.received, 400_00);
  assert.equal(m.expected, 400_00);
  // cohérence avec la trésorerie
  assert.equal(y.total.received, receiptsBetween(s, '2026-01-01', '2026-12-31'));
});

test('Désactivation d’un membre à partir d’une date précise (réversible)', () => {
  let s = base();
  s = pay(s, 'Bouazza', '2026-02', '2026-02-10', 600_00);
  // Bouazza n'est plus membre à partir du 01/03/2026 : mars n'est plus dû
  s = C.setMemberLeave(s, ctx, mid(s, 'Bouazza'), '2026-03-01');
  const b = s.members.find((m) => m.name === 'Bouazza')!;
  assert.equal(b.active, false);
  assert.equal(isActiveOn(b, '2026-02-28'), true);
  assert.equal(isActiveOn(b, '2026-03-01'), false);
  assert.equal(contributionRows(s, '2026-03', TODAY).some((r) => r.memberName === 'Bouazza'), false);
  assert.equal(monthSummary(s, '2026-03', TODAY).expected, 400_00);
  // Janvier impayé reste dû ; février payé reste payé
  assert.equal(row(s, 'Bouazza', '2026-01').remaining, 600_00);
  assert.equal(row(s, 'Bouazza', '2026-02').status, 'paye');
  // Plus de génération après la sortie
  s = C.generateMonth(s, ctx, '2026-04').state;
  assert.equal(s.contributions.some((c) => c.memberId === b.id && c.period === '2026-04'), false);
  const st = memberStats(s, b.id, '2026-01', '2026-04');
  assert.equal(st.expectedInRange, 1200_00);
  // Sortie en milieu de mois : le mois en cours reste dû
  const b2 = base();
  const s2 = C.setMemberLeave(b2, ctx, mid(b2, 'Bouazza'), '2026-03-15');
  assert.equal(contributionRows(s2, '2026-03', TODAY).some((r) => r.memberName === 'Bouazza'), true);
  // Date future : encore actif aujourd'hui
  const s3 = C.setMemberLeave(b2, ctx, mid(b2, 'Bouazza'), '2026-06-01');
  assert.equal(s3.members.find((m) => m.name === 'Bouazza')!.active, true);
  // Réactivation : mars redevient dû
  s = C.setMemberLeave(s, ctx, b.id, null);
  assert.equal(row(s, 'Bouazza', '2026-03').remaining, 600_00);
  assert.equal(s.members.find((m) => m.name === 'Bouazza')!.active, true);
  // Validation
  assert.throws(() => C.setMemberLeave(s, ctx, b.id, '2025-12-01'), /postérieure/);
  assert.throws(() => C.setMemberLeave(s, { ...ctx, role: 'lecteur' as any }, b.id, '2026-05-01'));
});

test('Performance : calculs mis en cache sur un gros historique', () => {
  let s = demoState('2026-10-10');
  // ~ 5 000 versements supplémentaires simulés
  const c0 = s.contributions[0];
  s = structuredClone(s);
  for (let i = 0; i < 5000; i++) s.payments.push({ ...structuredClone(s.payments[0]), id: 'x' + i, contributionId: c0.id, amount: 1, status: 'cancelled' });
  const t0 = performance.now();
  for (let k = 0; k < 50; k++) for (let m = 1; m <= 12; m++) monthSummary(s, `2026-${String(m).padStart(2, '0')}`, '2026-10-10');
  memberTotals(s, '2026-01-01', '2026-12-31', '2026-10-10');
  assert.ok(performance.now() - t0 < 1500, 'trop lent');
  assert.equal(expensesBetween(s, '2026-01-01', '2026-12-31') >= 0, true);
});

test('Export des totaux par membre (xlsx relisible + CSV)', async () => {
  const s = demoState('2026-10-10');
  const { memberTotalsWorkbook, memberTotalsCsv } = await import('../src/io/exports.ts');
  const sheets = await readXlsx(memberTotalsWorkbook(s, '2026-01-01', '2026-12-31', 'Année 2026', '2026-10-10'));
  assert.equal(sheets[0].name, 'Totaux par membre');
  assert.equal(sheets[0].grid[3][0], 'Membre');
  assert.equal(sheets[0].grid.length >= 9, true);
  assert.match(memberTotalsCsv(s, '2026-01-01', '2026-12-31', '2026-10-10'), /Total;/);
});
