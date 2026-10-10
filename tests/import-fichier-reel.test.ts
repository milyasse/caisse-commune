/**
 * Import du fichier Excel réel du groupe (reconstitué à partir des captures du 10/10/2026) :
 *  - feuille « المساهمات » : une ligne par mois, année fusionnée, mois en chiffres, en-têtes en arabe ;
 *  - feuille « المصاريف لسنة 2025 » : une ligne par semaine de salaire du gardien, montant dans « شهر N ».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../src/domain/seed.ts';
import { balanceAt, memberStats, monthSummary, yearSummary } from '../src/domain/finance.ts';
import { readXlsx } from '../src/io/xlsx.ts';
import { fixtureWorkbook } from './fixtures/fichier-reel.ts';
import { applyImport, buildPreview, earliestDate, guessMapping } from '../src/io/importer.ts';
import { periodOf, periodStart } from '../src/domain/dates.ts';
import type { Ctx } from '../src/domain/commands.ts';

const TODAY = '2026-10-10';
const ctx: Ctx = { user: 'test', role: 'admin', today: TODAY, now: '2026-10-10T12:00:00.000Z' };

async function workbook() {
  return readXlsx(fixtureWorkbook());
}
test('Feuille المساهمات : détection automatique des colonnes en arabe', async () => {
  const [sheet] = await workbook();
  const m = guessMapping(sheet.grid, emptyState(TODAY));
  assert.equal(m.layout, 'grid');
  if (m.layout !== 'grid') return;
  assert.deepEqual([m.yearCol, m.periodCol, m.dateCol, m.totalCol, m.expenseCol, m.checkCol], [0, 1, 2, 7, 9, 10]);
  assert.deepEqual(Object.values(m.memberCols), ['امحمد', 'بوعزة', 'بنعاشير', 'موسى']);
});

test('Feuille المساهمات : import complet dans une caisse vide, soldes identiques au fichier', async () => {
  const [sheet] = await workbook();
  // 1er passage pour trouver la date de départ, comme le fait l'écran d'import
  let base = emptyState(TODAY);
  base.settings.openingDate = '1900-01-01';
  const mapping = guessMapping(sheet.grid, base);
  const first = earliestDate(buildPreview(sheet.grid, mapping, base, TODAY))!;
  assert.equal(first, '2025-03-01');
  base = emptyState(TODAY);
  base.settings.openingDate = periodStart(periodOf(first));
  const lines = buildPreview(sheet.grid, mapping, base, TODAY);

  assert.equal(lines.filter((l) => l.errors.length).length, 0, JSON.stringify(lines.filter((l) => l.errors.length)));
  assert.equal(lines.filter((l) => l.kind === 'payment').length, 40 + 37);
  assert.equal(lines.filter((l) => l.kind === 'expense').length, 20);
  // 31/06/2025 n'existe pas : date corrigée et signalée
  assert.ok(lines.some((l) => l.warnings.some((w) => w.includes('31/06/2025'))));
  // Les totaux et restes du fichier sont cohérents ligne par ligne
  assert.equal(lines.filter((l) => l.warnings.some((w) => w.includes('≠'))).length, 0);

  const res = applyImport(base, ctx, lines);
  const s = res.state;
  assert.deepEqual(res.membersCreated, ['امحمد', 'بوعزة', 'بنعاشير', 'موسى']);
  assert.equal(res.imported, 97);
  assert.equal(res.errors.length, 0);
  assert.ok(s.members.every((m) => m.defaultAmount === 400_00));

  const y25 = yearSummary(s, 2025, TODAY);
  const y26 = yearSummary(s, 2026, TODAY);
  assert.equal(y25.received, 16150_00);
  assert.equal(y25.expenses, 15950_00);
  assert.equal(y25.closing, 200_00); // « إجمالي المبلغ المتبقي للسنة » 2025
  assert.equal(y26.received, 15400_00);
  assert.equal(y26.expenses, 14000_00);
  assert.equal(balanceAt(s, TODAY), 1600_00); // « 1600,00 » en bas du fichier
  const id = (n: string) => s.members.find((m) => m.name === n)!.id;
  assert.equal(memberStats(s, id('امحمد'), '2025-01', '2025-12').expectedInRange, 4150_00);
  // Totaux par personne 2026 : l'app trouve 4400 / 3800 / 3200 / 4000 (le fichier affiche 3600 / 3000 / 2400 / 3200)
  const paid26 = (n: string) => s.payments.filter((p) => p.memberId === id(n) && p.date >= '2026-01-01').reduce((a, p) => a + p.amount, 0);
  assert.deepEqual(['امحمد', 'بوعزة', 'بنعاشير', 'موسى'].map(paid26), [4400_00, 3800_00, 3200_00, 4000_00]);
  // Benachir n'a pas payé septembre ni octobre 2026 → reste 800
  assert.equal(memberStats(s, id('بنعاشير'), '2026-01', '2026-10').remainingInRange, 800_00);
  // Octobre 2026 : امحمد 600 (attendu ajusté), موسى 400 payés ; بوعزة et بنعاشير doivent 400 chacun
  assert.equal(monthSummary(s, '2026-10', TODAY).remaining, 800_00);
  // Réimporter le même fichier n'ajoute rien
  assert.equal(applyImport(s, ctx, buildPreview(sheet.grid, mapping, s, TODAY)).imported, 0);
});

test('Feuille المصاريف : une dépense par semaine, contrôles et risque de double comptage', async () => {
  const sheets = await workbook();
  const exp = sheets[2];
  const base = emptyState(TODAY);
  base.settings.openingDate = '2025-03-01';
  const m = guessMapping(exp.grid, base);
  assert.equal(m.layout, 'expenses');
  const lines = buildPreview(exp.grid, m, base, TODAY);
  assert.equal(lines.length, 40);
  assert.equal(lines.filter((l) => l.errors.length).length, 0);
  assert.equal(lines.reduce((a, l) => a + l.amount!, 0), (38 * 350 + 400 + 300) * 100);
  assert.equal(lines[0].category, 'Paiement du personnel');
  assert.equal(lines[0].beneficiary, 'Gardien');
  assert.equal(lines[0].comment, 'Payé par بوعزة');
  // Semaine 28 : payée « 06/08/2025 » pour la semaine du 08/09 → signalée
  const w28 = lines.find((l) => l.description?.includes('08/09'))!;
  assert.ok(w28.warnings.some((w) => w.includes('à vérifier')));
  assert.equal(lines.filter((l) => l.warnings.some((w) => w.includes('à vérifier'))).length, 1);

  // Si les dépenses mensuelles de la feuille المساهمات sont déjà importées : avertissement
  const [contrib] = sheets;
  const cm = guessMapping(contrib.grid, base);
  const withLumps = applyImport(base, ctx, buildPreview(contrib.grid, cm, base, TODAY)).state;
  const again = buildPreview(exp.grid, m, withLumps, TODAY);
  assert.ok(again.every((l) => l.warnings.some((w) => w.includes('double comptage'))));
});

test('Canevas pré-rempli (écrit par openpyxl, caractères encodés &#…;) : deux feuilles, solde 1 600 MAD', async () => {
  const { readFileSync } = await import('node:fs');
  const sheets = await readXlsx(new Uint8Array(readFileSync(new URL('./fixtures/canevas-donnees-reelles.xlsx', import.meta.url))));
  assert.deepEqual(sheets.map((x) => x.name), ['Versements', 'Dépenses', "Mode d'emploi"]);
  let s = emptyState(TODAY);
  s.settings.openingDate = '2025-03-01';
  for (const sh of sheets.slice(0, 2)) {
    const m = guessMapping(sh.grid, s);
    const lines = buildPreview(sh.grid, m, s, TODAY);
    assert.equal(lines.filter((l) => l.errors.length).length, 0);
    s = applyImport(s, ctx, lines).state;
  }
  assert.deepEqual(s.members.map((m) => m.name), ['امحمد', 'بوعزة', 'بنعاشير', 'موسى']);
  assert.equal(s.payments.length, 77);
  assert.equal(s.expenses.length, 90);
  assert.equal(balanceAt(s, TODAY), 1600_00);
});

test('Extrait réel de la feuille المصاريف (copié depuis Excel) : 90 dépenses, totaux = ligne « مجموع المصاريف »', async () => {
  const { readFileSync } = await import('node:fs');
  const { readCsv } = await import('../src/io/xlsx.ts');
  const grid = readCsv(readFileSync(new URL('./fixtures/extrait-depenses-reel.tsv', import.meta.url), 'utf8'));
  const base = emptyState(TODAY);
  base.settings.openingDate = '2025-03-01';
  const m = guessMapping(grid, base);
  assert.equal(m.layout, 'expenses');
  if (m.layout !== 'expenses') return;
  assert.equal(m.amountCols?.length, 22); // « 3 شهر » … « 12 شهر » (2025) + « 1 شهر » … « 12 شهر » (2026)
  const lines = buildPreview(grid, m, base, TODAY);
  assert.equal(lines.filter((l) => l.errors.length).length, 0, JSON.stringify(lines.filter((l) => l.errors.length).slice(0, 2)));
  const salaires = lines.filter((l) => l.category === 'Paiement du personnel');
  const elec = lines.filter((l) => l.category === 'Charges communes');
  assert.equal(salaires.length, 84);
  assert.equal(elec.length, 6);
  assert.equal(lines.length, 90);
  // Les lignes 2026 sans libellé reprennent le titre de la rubrique
  assert.equal(lines.find((l) => l.date === '2026-01-03')!.description, 'أجرة الحارس الأسبوعية');
  assert.equal(lines.find((l) => l.date === '2025-03-08' && l.category === 'Charges communes')!.amount, 100_00);
  const sumYear = (y: string) => lines.filter((l) => l.date!.startsWith(y)).reduce((a, l) => a + l.amount!, 0);
  assert.equal(sumYear('2025'), 15950_00); // « مجموع المصاريف السنوي »
  assert.equal(sumYear('2026'), 14000_00);
  // Seule la semaine 28 (payée « 06/08/2025 » pour la semaine du 08/09) est signalée
  const flagged = lines.filter((l) => l.warnings.some((w) => w.includes('à vérifier')));
  assert.deepEqual(flagged.map((l) => l.row), [32]);
  const s = applyImport(base, ctx, lines).state;
  assert.equal(s.expenses.length, 90);
  assert.ok(s.expenses.every((e) => e.comment?.startsWith('Payé par ')));
});
