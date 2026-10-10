import React from 'react';
import { useStore } from '../../store/store.ts';
import { balanceAt, balanceSeries, contributionRows, monthSummary, yearSummary, allOperations } from '../../domain/finance.ts';
import { addMonths, fmtDate, MONTHS_SHORT, periodLabel, periodMonth, periodYear, todayISO } from '../../domain/dates.ts';
import { formatMAD } from '../../domain/money.ts';
import type { Period } from '../../domain/types.ts';
import { BarChart, Card, Icon, Kpi, LineChart, Money, PeriodPicker } from '../components/kit.tsx';
import { OperationRow } from './History.tsx';

export function Dashboard({ period, setPeriod, go }: { period: Period; setPeriod: (p: Period) => void; go: (tab: string, extra?: { member?: string }) => void }) {
  const { state: s } = useStore();
  const today = todayISO();
  const m = monthSummary(s, period, today);
  const prev = monthSummary(s, addMonths(period, -1), today);
  const y = yearSummary(s, periodYear(period), today);
  const ytd = y.months.filter((x) => x.period <= period);
  const ytdReceived = ytd.reduce((a, x) => a + x.received, 0);
  const ytdExpenses = ytd.reduce((a, x) => a + x.expenses, 0);
  const balance = balanceAt(s, today);
  const series = balanceSeries(s, period, 12);
  const periodsUpTo = [...new Set(s.contributions.filter((c) => c.period <= period).map((c) => c.period))];
  const lateAll = periodsUpTo.flatMap((p) => contributionRows(s, p, today).filter((r) => r.late));
  const lateTotal = lateAll.reduce((a, r) => a + r.remaining, 0);
  const bigExpenses = s.expenses.filter((e) => e.status === 'valid' && e.date.startsWith(period) && e.amount >= s.settings.largeExpenseThreshold);
  const recent = allOperations(s).filter((o) => o.item.status === 'valid').slice(0, 5);

  return (
    <div className="screen">
      <PeriodPicker value={period} onChange={setPeriod} />

      <Card className="hero">
        <div className="hero-l">Solde disponible en caisse</div>
        <div className={balance < 0 ? 'hero-v neg' : 'hero-v'}>{formatMAD(balance)}</div>
        <div className="hero-s">
          au {fmtDate(today)} · calculé à partir de {s.payments.length + s.expenses.length} opérations
        </div>
      </Card>

      {(lateAll.length > 0 || bigExpenses.length > 0 || m.closure?.matches === false) && (
        <div className="alerts">
          {lateAll.length > 0 && (
            <button className="alert a-bad" onClick={() => go('cotisations')}>
              <Icon name="alert" />
              <span>
                <b>{lateAll.length} cotisation(s) en retard</b> — {formatMAD(lateTotal)} à encaisser ({[...new Set(lateAll.map((r) => r.memberName))].join(', ')})
              </span>
            </button>
          )}
          {bigExpenses.map((e) => (
            <div key={e.id} className="alert a-warn">
              <Icon name="alert" />
              <span>
                Dépense importante : <b>{formatMAD(e.amount)}</b> le {fmtDate(e.date)} — {e.description}
              </span>
            </div>
          ))}
          {m.closure?.matches === false && (
            <div className="alert a-bad">
              <Icon name="lock" /> Le solde clôturé ({formatMAD(m.closure.closingBalance)}) ne correspond plus au calcul ({formatMAD(m.closing)}).
            </div>
          )}
        </div>
      )}

      <h3 className="sec">{periodLabel(period)}</h3>
      <div className="kpis">
        <Kpi label="Attendu" value={<Money c={m.expected} />} />
        <Kpi label="Encaissé" value={<Money c={m.received} tone="pos" />} tone="pos" hint="date réelle d'encaissement" />
        <Kpi label="Dépenses" value={<Money c={m.expenses} />} />
        <Kpi label="Reste à encaisser" value={<Money c={m.remaining} />} tone={m.remaining ? 'warn' : undefined} hint="n'est pas en caisse" />
      </div>
      <Card onClick={() => go('cotisations')}>
        <div className="status-strip">
          <div>
            <b className="t-pos">{m.paidCount}</b>
            <span>payé</span>
          </div>
          <div>
            <b className="t-warn">{m.partialCount}</b>
            <span>partiel</span>
          </div>
          <div>
            <b className="t-neg">{m.unpaidCount}</b>
            <span>non payé</span>
          </div>
          <Icon name="right" />
        </div>
      </Card>

      <div className="kpis">
        <Kpi label="Ouverture du mois" value={<Money c={m.opening} tone="auto" />} hint={`clôture de ${MONTHS_SHORT[periodMonth(prev.period) - 1].toLowerCase()}. : ${formatMAD(prev.closing)}`} />
        <Kpi label="Clôture du mois" value={<Money c={m.closing} tone="auto" />} hint={m.closure ? 'mois clôturé' : 'provisoire'} />
        <Kpi label={`Cotisations ${periodYear(period)}`} value={<Money c={ytdReceived} />} hint="cumul depuis janvier" />
        <Kpi label={`Dépenses ${periodYear(period)}`} value={<Money c={ytdExpenses} />} hint="cumul depuis janvier" />
      </div>

      <Card>
        <div className="card-h">
          <h3>Cotisations et dépenses</h3>
          <div className="legend">
            <i className="lg-a" />
            Encaissé <i className="lg-b" />
            Dépenses
          </div>
        </div>
        <BarChart data={series.map((x) => ({ label: MONTHS_SHORT[periodMonth(x.period) - 1].slice(0, 3), a: x.received, b: x.expenses }))} />
      </Card>
      <Card>
        <div className="card-h">
          <h3>Solde de fin de mois</h3>
        </div>
        <LineChart data={series.map((x) => ({ label: MONTHS_SHORT[periodMonth(x.period) - 1].slice(0, 3), v: x.closing }))} />
      </Card>

      <div className="card-h">
        <h3 className="sec">Dernières opérations</h3>
        <button className="link" onClick={() => go('historique')}>
          Tout voir
        </button>
      </div>
      <div className="list">
        {recent.map((o) => (
          <OperationRow key={o.item.id} op={o} />
        ))}
      </div>
    </div>
  );
}
