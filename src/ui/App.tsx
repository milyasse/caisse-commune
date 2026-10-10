import React, { useEffect, useState } from 'react';
import { init, useStore } from '../store/store.ts';
import { periodOf, todayISO } from '../domain/dates.ts';
import { Dialogs, Icon, Toasts } from './components/kit.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { Contributions } from './screens/Contributions.tsx';
import { Expenses } from './screens/Expenses.tsx';
import { History } from './screens/History.tsx';
import { Settings } from './screens/Settings.tsx';
import { ExpenseForm, PaymentForm, QuickAdd } from './forms.tsx';
import { BackupReminder, InstallBanner } from './install.tsx';

type Tab = 'accueil' | 'cotisations' | 'depenses' | 'historique' | 'parametres';
const TABS: [Tab, string, string][] = [
  ['accueil', 'home', 'Accueil'],
  ['cotisations', 'users', 'Cotisations'],
  ['depenses', 'out', 'Dépenses'],
  ['historique', 'clock', 'Historique'],
  ['parametres', 'gear', 'Paramètres'],
];
const TITLES: Record<Tab, string> = { accueil: 'Tableau de bord', cotisations: 'Cotisations', depenses: 'Dépenses', historique: 'Historique', parametres: 'Paramètres' };

export function App() {
  const { ready, state: s, session, syncing, sync, online, persistError } = useStore();
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || 'accueil');
  const [period, setPeriod] = useState(periodOf(todayISO()));
  const [quick, setQuick] = useState<null | 'menu' | 'payment' | 'expense'>(null);

  useEffect(() => void init(), []);
  useEffect(() => {
    history.replaceState(null, '', '#' + tab);
    window.scrollTo(0, 0);
  }, [tab]);

  if (!ready) return <div className="splash">Chargement…</div>;

  return (
    <div className="app">
      <header className="top">
        <div>
          <div className="top-sub">{s.settings.groupName}</div>
          <h1>{TITLES[tab]}</h1>
        </div>
        <div className="top-st" title={session ? `${sync.outbox.length} opération(s) en attente d'envoi` : 'Données enregistrées sur cet appareil'}>
          {!online && <span className="pill warn">hors ligne</span>}
          {session ? <span className={sync.lastError ? 'pill bad' : sync.outbox.length ? 'pill warn' : 'pill ok'}>{syncing ? 'synchro…' : sync.lastError ? 'erreur synchro' : sync.outbox.length ? `${sync.outbox.length} en attente` : 'synchronisé'}</span> : <span className="pill">local</span>}
        </div>
      </header>
      {s.settings.isDemo && (
        <button className="demo-banner" onClick={() => setTab('parametres')}>
          Données fictives de démonstration — Paramètres › Sauvegarde et données pour passer à vos données réelles
        </button>
      )}
      {persistError && <div className="demo-banner bad">{persistError}</div>}
      <BackupReminder onOpen={() => setTab('parametres')} />
      {tab === 'accueil' && <InstallBanner />}

      <main>
        {tab === 'accueil' && <Dashboard period={period} setPeriod={setPeriod} go={(t) => setTab(t as Tab)} />}
        {tab === 'cotisations' && <Contributions period={period} setPeriod={setPeriod} />}
        {tab === 'depenses' && <Expenses period={period} setPeriod={setPeriod} />}
        {tab === 'historique' && <History />}
        {tab === 'parametres' && <Settings period={period} />}
      </main>

      {tab !== 'parametres' && (
        <button className="fab" onClick={() => setQuick('menu')} aria-label="Ajouter une opération">
          <Icon name="plus" size={22} /> <span>Ajouter une opération</span>
        </button>
      )}

      <nav className="tabs" aria-label="Navigation principale">
        {TABS.map(([k, ic, l]) => (
          <button key={k} className={k === tab ? 'on' : ''} onClick={() => setTab(k)} aria-current={k === tab ? 'page' : undefined}>
            <Icon name={ic} size={22} />
            <span>{l}</span>
          </button>
        ))}
      </nav>

      {quick === 'menu' && <QuickAdd onClose={() => setQuick(null)} onPick={setQuick} />}
      {quick === 'payment' && <PaymentForm onDone={() => setQuick(null)} />}
      {quick === 'expense' && <ExpenseForm onDone={() => setQuick(null)} />}
      <Dialogs />
      <Toasts />
    </div>
  );
}
