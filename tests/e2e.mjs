// Test de bout en bout dans un vrai navigateur (Chromium, écran de smartphone 390×844).
// Prérequis : dist/ construit et servi sur http://localhost:8765 ; Playwright installé.
//   node tests/e2e.mjs [dossier-captures]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(process.env.PW_FROM ?? import.meta.url);
const { chromium } = require('playwright');

const out = process.argv[2] ?? 'shots';
mkdirSync(out, { recursive: true });
const URL = 'http://localhost:8765/';
const errors = [];
const results = [];
const check = (label, cond) => {
  results.push(`${cond ? 'OK ' : 'ÉCHEC'}  ${label}`);
  if (!cond) process.exitCode = 1;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'fr-FR', acceptDownloads: true, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(URL);
await page.waitForSelector('.hero-v');
const balance = async () => (await page.textContent('.hero-v')).replace(/\s/g, ' ');
const b0 = await balance();
check(`Tableau de bord affiché, solde ${b0}`, /MAD/.test(b0));
check('Bandeau « données fictives » visible', await page.isVisible('.demo-banner'));
await page.screenshot({ path: `${out}/1-accueil.png`, fullPage: true });

// Cotisations
await page.click('nav.tabs >> text=Cotisations');
await page.waitForSelector('.card .name');
await page.screenshot({ path: `${out}/2-cotisations.png`, fullPage: true });
await page.click('.seg >> text=Tableau');
await page.screenshot({ path: `${out}/3-cotisations-tableau.png` });
await page.click('.seg >> text=Cartes');

// Encaisser un versement partiel via le bouton rapide
const unpaid = page.locator('.card', { has: page.locator('text=+ Encaisser') }).first();
const who = await unpaid.locator('.name').textContent();
await unpaid.locator('text=+ Encaisser').click();
await page.waitForSelector('.sheet .money-in input');
await page.fill('.sheet .money-in input', '150');
await page.screenshot({ path: `${out}/4-versement.png` });
await page.click('.sheet-f button');
await page.waitForSelector('.toast');
check(`Versement partiel de 150 MAD enregistré pour ${who}`, (await page.textContent('.toast')).includes('Versement enregistré'));
const card = page.locator('.card', { has: page.locator(`.name:text-is("${who}")`) });
check('Statut passé à « Partiel »', /Partiel/.test(await card.textContent()));

// Doublon : même versement le même jour => confirmation
await card.locator('text=+ Encaisser').click();
await page.fill('.sheet .money-in input', '150');
await page.click('.sheet-f button');
await page.waitForSelector('.dialog');
check('Doublon détecté et confirmation demandée', (await page.textContent('.dialog')).includes('Doublon'));
await page.click('.dialog >> text=Annuler');
await page.click('.sheet-h button[aria-label=Fermer]');

// Dépense via « + Ajouter une opération »
await page.click('.fab');
await page.click('.pick-btn.out');
await page.fill('.sheet .money-in input', '75,50');
await page.fill('.sheet input[placeholder="Ex. : salaire du mois"]', 'Ampoules escalier');
await page.click('.sheet .chip >> text=Achat de matériel');
await page.click('.sheet-f button');
await page.waitForSelector('.toast >> text=Dépense enregistrée');
check('Dépense de 75,50 MAD enregistrée', true);

// Retour accueil : le solde a bougé de +150 − 75,50 = +74,50
await page.click('nav.tabs >> text=Accueil');
const b1 = await balance();
const num = (s) => Number(s.replace(/[^\d,-]/g, '').replace(',', '.'));
check(`Solde recalculé : ${b0} → ${b1} (attendu +74,50)`, Math.abs(num(b1) - num(b0) - 74.5) < 0.001);

// Historique, recherche et annulation tracée
await page.click('nav.tabs >> text=Historique');
await page.fill('.search input', 'Ampoules');
await page.click('.op >> text=Ampoules escalier');
await page.waitForSelector('.dl');
await page.screenshot({ path: `${out}/5-detail-operation.png` });
await page.click('.sheet-f >> text=Annuler');
await page.fill('.dialog input', 'Erreur de saisie');
await page.screenshot({ path: `${out}/debug-dialog.png` });
await page.click('.dialog .btn-danger');
await page.waitForSelector('.toast >> text=Opération annulée');
check('Opération annulée avec motif, toujours visible et barrée', await page.isVisible('.op.cancelled'));
await page.click('.sheet-h button[aria-label=Fermer]');
await page.fill('.search input', '');
await page.screenshot({ path: `${out}/6-historique.png` });

// Dépenses
await page.click('nav.tabs >> text=Dépenses');
await page.screenshot({ path: `${out}/7-depenses.png`, fullPage: true });

// Paramètres → export Excel
await page.click('nav.tabs >> text=Paramètres');
await page.screenshot({ path: `${out}/8-parametres.png` });
await page.click('text=Rapports et exports');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.pick-btn >> text=Excel')]);
const xlsxPath = `${out}/export.xlsx`;
await dl.saveAs(xlsxPath);
check(`Export Excel téléchargé (${dl.suggestedFilename()})`, dl.suggestedFilename().endsWith('.xlsx'));
await page.click('.sheet-h button[aria-label=Fermer]');

// Import : on réimporte un petit fichier CSV avec un doublon et une erreur
const csv = 'Date;Membre;Mois;Montant\n' + '10/10/2026;Ahmed;10/2026;50\n'.repeat(2) + '01/01/2001;Inconnu;01/2001;10\n';
writeFileSync(`${out}/import.csv`, csv);
await page.click('text=Importer l’ancien fichier Excel');
await page.setInputFiles('.sheet input[type=file]', `${out}/import.csv`);
await page.click('text=Contrôler les données');
await page.waitForSelector('text=Doublons');
await page.screenshot({ path: `${out}/9-import.png`, fullPage: false });
const kp = await page.locator('.sheet .kpis .mini b').allTextContents();
check(`Import : contrôle valides/doublons/erreurs = ${kp.join('/')}`, kp.join('/') === '1/1/1' || kp[1] === '1');
await page.click('.sheet-h button[aria-label=Fermer]');

// Persistance : rechargement de la page
await page.goto(URL + '#accueil'); await page.reload();
await page.waitForSelector('.hero-v');
const b2 = await balance();
check(`Données conservées après rechargement, solde ${b2}`, num(b2) === num(b0) + 150); // dépense annulée
check('Aucune erreur JavaScript', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
console.log(results.join('\n'));
