// Parcours réel : import → valeurs faussées par un 2e import → vider (code) → réimport propre.
//   node tests/e2e-vider.mjs [dossier-captures]   (dist servi sur :8765)
import { createRequire } from 'node:module';
const require = createRequire(process.env.PW_FROM ?? import.meta.url);
const { chromium, devices } = require('playwright');
const out = process.argv[2] ?? 'shots';
const FILE = import.meta.dirname + '/fixtures/canevas-donnees-reelles.xlsx';
const results = [];
const check = (l, c) => (results.push(`${c ? 'OK ' : 'ÉCHEC'}  ${l}`), c || (process.exitCode = 1));
const b = await chromium.launch();
const p = await (await b.newContext({ ...devices['iPhone 13'], locale: 'fr-FR' })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
const balance = async () => {
  await p.click('nav.tabs >> text=Accueil');
  return Number((await p.textContent('.hero-v')).replace(/[^\d,-]/g, '').replace(',', '.'));
};
const importSheet = async (i, includeDupes = false) => {
  await p.click('nav.tabs >> text=Paramètres');
  await p.click('text=Importer l’ancien fichier Excel');
  await p.setInputFiles('.sheet input[type=file]', FILE);
  await p.selectOption('.sheet select >> nth=0', String(i));
  await p.click('text=Contrôler les données');
  if (includeDupes) await p.check('.sheet label.check:has-text("doublons") input');
  await p.click('.sheet-f button');
  await p.click('.dialog .row-end button >> nth=1');
  await p.waitForSelector('.toast');
  await p.waitForTimeout(400);
};
const vider = async (code, confirm) => {
  await p.click('nav.tabs >> text=Paramètres');
  await p.click('.op:has-text("Sauvegarde et données")');
  await p.click('text=Vider toutes les données');
  await p.fill('#pin', code);
  if (confirm !== undefined) await p.fill('#pin2', confirm);
};

await p.goto('http://localhost:8765/#parametres');
await importSheet(0);
await importSheet(1);
check('Import propre : solde 1 600,00', (await balance()) === 1600);
await importSheet(1, true); // erreur typique : dépenses importées deux fois
const wrong = await balance();
check(`Dépenses importées deux fois : solde faussé (${wrong})`, wrong !== 1600);

await vider('2468', '2468');
await p.screenshot({ path: `${out}/vider-code.png` });
await p.click('.dialog .btn-danger');
await p.waitForSelector('.toast >> text=Données vidées');
await p.click('.op:has-text("Sauvegarde et données")');
check('Après vidage : 0 membre, 0 versement, 0 dépense', (await p.textContent('.sheet')).includes('0 membre(s), 0 versement(s), 0 dépense(s)'));
await p.click('.sheet-h button[aria-label=Fermer]');

await importSheet(0);
await importSheet(1);
check('Réimport après vidage : solde 1 600,00', (await balance()) === 1600);

await vider('0000');
await p.click('.dialog .btn-danger');
check('Mauvais code refusé', (await p.textContent('.dialog')).includes('Code incorrect'));
await p.click('.dialog .btn-ghost');
await p.click('.sheet-h button[aria-label=Fermer]');
check('Données intactes après refus : 1 600,00', (await balance()) === 1600);
check('Aucune erreur JavaScript', errs.length === 0);
await b.close();
console.log(results.join('\n'));
