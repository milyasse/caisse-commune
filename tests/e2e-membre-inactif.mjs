// Régression : désactiver un membre (données de démonstration, mois impayés après la date)
// ne doit jamais afficher une page blanche. Prérequis : dist/ servi sur localhost:$PORT (8765).
import { createRequire } from 'node:module';
const require = createRequire(process.env.PW_FROM ?? import.meta.url);
const { chromium } = require('playwright');
const URL = `http://localhost:${process.env.PORT ?? 8765}/`;
const results = [];
const check = (label, cond) => {
  results.push(`${cond ? 'OK ' : 'ÉCHEC'}  ${label}`);
  if (!cond) process.exitCode = 1;
};
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR', isMobile: true, hasTouch: true })).newPage();
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL);
await page.waitForSelector('.hero-v');
const filled = async () => (await page.textContent('#root')).trim().length > 50 && !(await page.isVisible('.crash'));
for (const date of ['2026-09-01', '2026-03-15', '2026-12-01']) {
  await page.click('nav.tabs >> text=Paramètres');
  await page.click('.op >> text=Membres');
  await page.locator('.sheet .op').first().click();
  await page.waitForSelector('.leave-box');
  await page.fill('.leave-box input[type=date]', date);
  await page.click('.leave-box >> text=/Désactiver à cette date|Modifier la date/');
  await page.click('.dialog .btn-danger');
  await page.waitForTimeout(300);
  check(`Fiche membre affichée après sortie au ${date}`, await filled() && (await page.isVisible('.leave-box')));
  for (let i = 0; i < 3 && (await page.isVisible('.sheet')); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  for (const tab of ['Accueil', 'Cotisations', 'Dépenses', 'Historique', 'Paramètres']) {
    await page.click(`nav.tabs >> text=${tab}`);
    await page.waitForTimeout(150);
    if (!(await filled())) check(`Écran ${tab} après sortie au ${date}`, false);
  }
  await page.click('nav.tabs >> text=Cotisations');
  await page.click('.top-seg >> text=Totaux par membre');
  check(`Totaux par membre affichés (sortie ${date})`, await page.isVisible('.totals .mt-card'));
  await page.click('.top-seg >> text=Par mois');
}
check('Aucune erreur JavaScript', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
console.log(results.join('\n'));
