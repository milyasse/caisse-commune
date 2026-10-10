/**
 * État initial vide et jeu de données de DÉMONSTRATION (fictif).
 * Les données de démo sont marquées settings.isDemo = true et un bandeau
 * « Données fictives » est affiché tant qu'elles sont présentes.
 */
import type { AppState, ISODate } from './types.ts';
import { addMonths, periodEnd, periodOf, todayISO } from './dates.ts';
import { addExpense, addMember, addPayment, generateMonth, overrideExpected, setMemberAmount, stableUuid, type Ctx } from './commands.ts';

export const DEFAULT_CATEGORIES = ['Paiement du personnel', 'Charges communes', 'Achat de matériel', 'Entretien et réparation', 'Autres dépenses'];

export function emptyState(today: ISODate = todayISO()): AppState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    settings: {
      groupName: 'Caisse commune',
      openingBalance: 0,
      openingDate: `${today.slice(0, 4)}-01-01`,
      dueDay: 0,
      largeExpenseThreshold: 1000_00,
      isDemo: false,
      currentUser: 'Administrateur',
      currentRole: 'admin',
      updatedAt: now,
    },
    members: [],
    rules: [],
    contributions: [],
    payments: [],
    categories: DEFAULT_CATEGORIES.map((name) => ({ id: stableUuid(`category:${name}`), name, active: true, updatedAt: now })),
    expenses: [],
    closures: [],
    audit: [],
  };
}

/**
 * Démo sur les 10 derniers mois jusqu'au mois courant :
 *  - 4 membres à 400 MAD ; Bouazza passe à 600 MAD il y a 4 mois ;
 *  - Ahmed : 600 MAD exceptionnels un mois ;
 *  - Benchaabich : paiement en deux fois + paiement partiel ;
 *  - Moussa : retard payé le mois suivant + un mois impayé ;
 *  - dépenses : personnel (début de mois), électricité/eau, réparation, matériel.
 */
export function demoState(today: ISODate = todayISO()): AppState {
  const ctx: Ctx = { user: 'Démo', role: 'admin', today, now: new Date().toISOString() };
  const cur = periodOf(today);
  const start = addMonths(cur, -9);
  let s = emptyState(today);
  s.settings.isDemo = true;
  s.settings.groupName = 'Caisse commune (démo)';
  s.settings.openingDate = `${start}-01`;
  s.settings.openingBalance = 1500_00;

  for (const name of ['Ahmed', 'Bouazza', 'Benchaabich', 'Moussa']) s = addMember(s, ctx, { name, joinDate: `${start}-01`, defaultAmount: 400_00 });
  const id = (n: string) => s.members.find((m) => m.name === n)!.id;
  s = setMemberAmount(s, ctx, id('Bouazza'), 600_00, addMonths(cur, -4));

  const cat = (n: string) => s.categories.find((c) => c.name === n)!.id;
  const ok = (d: ISODate) => d <= today;
  const contrib = (member: string, p: string) => s.contributions.find((c) => c.memberId === id(member) && c.period === p)!;
  const pay = (member: string, p: string, date: ISODate, amount: number, comment?: string) => {
    if (!ok(date)) return;
    s = addPayment(s, ctx, { contributionId: contrib(member, p).id, date, amount, method: 'especes', comment }, { allowDuplicate: true });
  };
  const spend = (date: ISODate, c: string, description: string, beneficiary: string, amount: number, method: 'especes' | 'virement' = 'especes') => {
    if (!ok(date)) return;
    s = addExpense(s, ctx, { date, categoryId: cat(c), description, beneficiary, amount, method }, { allowDuplicate: true });
  };

  for (let i = 0; i < 10; i++) {
    const p = addMonths(start, i);
    s = generateMonth(s, ctx, p).state;
    const end = periodEnd(p);
    const isCur = p === cur;
    if (i === 2) s = overrideExpected(s, ctx, contrib('Ahmed', p).id, 600_00, 'Rattrapage convenu en réunion');

    // Ahmed et Bouazza : payent en fin de mois
    pay('Ahmed', p, end, contrib('Ahmed', p).expected);
    pay('Bouazza', p, isCur ? `${p}-05` : end, contrib('Bouazza', p).expected);

    // Benchaabich : deux versements à i=3, partiel à i=6
    if (i === 3) {
      pay('Benchaabich', p, `${p}-15`, 200_00, '1er versement');
      pay('Benchaabich', p, end, 200_00, '2e versement');
    } else if (i === 6) pay('Benchaabich', p, end, 250_00, 'Paiement partiel');
    else if (!isCur) pay('Benchaabich', p, end, 400_00);

    // Moussa : en retard (payé le 3 du mois suivant), impayé à i=5
    if (i !== 5) pay('Moussa', p, `${addMonths(p, 1)}-03`, 400_00, i === 8 ? 'Payé en retard' : undefined);

    // Dépenses
    spend(`${p}-05`, 'Paiement du personnel', 'Salaire mensuel gardien', 'Hassan (gardien)', 1200_00);
    spend(`${p}-12`, 'Charges communes', 'Électricité parties communes', 'ONEE', 180_00 + i * 5_00, 'virement');
    if (i === 4) spend(`${p}-18`, 'Entretien et réparation', 'Réparation porte d’entrée', 'Menuiserie Atlas', 650_00);
    if (i === 7) spend(`${p}-16`, 'Achat de matériel', 'Produits et matériel de nettoyage', 'Droguerie du quartier', 320_00);
    if (i === 8) spend(`${p}-20`, 'Paiement du personnel', 'Prime exceptionnelle', 'Hassan (gardien)', 1500_00);
  }
  s.audit = s.audit.map((a) => ({ ...a, user: 'Démo' }));
  return s;
}
