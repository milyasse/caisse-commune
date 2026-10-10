import React, { useState } from 'react';
import { useStore } from '../../store/store.ts';
import { periodLabel } from '../../domain/dates.ts';
import { formatMAD } from '../../domain/money.ts';
import type { Period } from '../../domain/types.ts';
import { Btn, Card, Empty, PeriodPicker } from '../components/kit.tsx';
import { ExpenseForm } from '../forms.tsx';
import { OperationRow } from './History.tsx';

export function Expenses({ period, setPeriod }: { period: Period; setPeriod: (p: Period) => void }) {
  const { state: s } = useStore();
  const [adding, setAdding] = useState(false);
  const [cat, setCat] = useState<string>('');
  const list = s.expenses
    .filter((e) => e.date.startsWith(period) && (!cat || e.categoryId === cat))
    .sort((a, b) => b.date.localeCompare(a.date));
  const valid = list.filter((e) => e.status === 'valid');
  const total = valid.reduce((a, e) => a + e.amount, 0);
  const byCat = s.categories
    .map((c) => ({ c, t: s.expenses.filter((e) => e.status === 'valid' && e.date.startsWith(period) && e.categoryId === c.id).reduce((a, e) => a + e.amount, 0) }))
    .filter((x) => x.t > 0);
  const max = Math.max(1, ...byCat.map((x) => x.t));

  return (
    <div className="screen">
      <PeriodPicker value={period} onChange={setPeriod} />
      <Card>
        <div className="row-between">
          <div>
            <div className="small muted">Dépenses de {periodLabel(period)}</div>
            <div className="big-num">{formatMAD(total)}</div>
          </div>
          <Btn onClick={() => setAdding(true)}>+ Dépense</Btn>
        </div>
        {byCat.length > 0 && (
          <div className="cat-bars">
            {byCat.map(({ c, t }) => (
              <button key={c.id} className={cat === c.id ? 'cat-bar on' : 'cat-bar'} onClick={() => setCat(cat === c.id ? '' : c.id)}>
                <span>{c.name}</span>
                <i style={{ width: `${(t / max) * 100}%` }} />
                <b>{formatMAD(t)}</b>
              </button>
            ))}
          </div>
        )}
      </Card>
      {cat && (
        <button className="link" onClick={() => setCat('')}>
          × Retirer le filtre catégorie
        </button>
      )}
      <div className="list">
        {list.map((e) => (
          <OperationRow key={e.id} op={{ kind: 'expense', date: e.date, amount: e.amount, item: e }} />
        ))}
      </div>
      {list.length === 0 && <Empty>Aucune dépense ce mois-ci.</Empty>}
      {adding && <ExpenseForm onDone={() => setAdding(false)} />}
    </div>
  );
}
