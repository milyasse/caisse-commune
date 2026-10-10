/**
 * Totaux des cotisations par membre sur une période au choix :
 * un mois, une année, ou entre deux dates — avec export Excel / CSV.
 */
import React, { useDeferredValue, useMemo, useState } from 'react';
import { useStore } from '../../store/store.ts';
import { memberTotals } from '../../domain/finance.ts';
import { fmtDate, MONTHS_FR, periodEnd, periodLabel, periodMonth, periodStart, periodYear, todayISO } from '../../domain/dates.ts';
import { formatMAD } from '../../domain/money.ts';
import type { Period } from '../../domain/types.ts';
import { memberTotalsCsv, memberTotalsWorkbook } from '../../io/exports.ts';
import { saveFile } from '../download.ts';
import { Badge, Btn, Card, DateInput, Empty, errorMessage, Field, Seg, toast } from '../components/kit.tsx';

type Mode = 'mois' | 'annee' | 'dates';
const COLORS = ['#16a34a', '#2563eb', '#f59e0b', '#db2777', '#7c3aed', '#0d9488', '#ea580c', '#dc2626'];

export function MemberTotals({ period }: { period: Period }) {
  const { state: s } = useStore();
  const today = todayISO();
  const [mode, setMode] = useState<Mode>('annee');
  const [month, setMonth] = useState<Period>(period);
  const [year, setYear] = useState(periodYear(period));
  const [from, setFrom] = useState(`${periodYear(period)}-01-01`);
  const [to, setTo] = useState(today);

  const years = useMemo(() => {
    const first = Math.min(periodYear(today.slice(0, 7)), ...s.contributions.map((c) => periodYear(c.period)), ...s.payments.map((p) => Number(p.date.slice(0, 4))));
    const out: number[] = [];
    for (let y = periodYear(today.slice(0, 7)); y >= first; y--) out.push(y);
    return out;
  }, [s.contributions, s.payments, today]);

  const range = useMemo(() => {
    if (mode === 'mois') return { from: periodStart(month), to: periodEnd(month), label: periodLabel(month) };
    if (mode === 'annee') return { from: `${year}-01-01`, to: `${year}-12-31`, label: `Année ${year}` };
    const a = from <= to ? from : to, b = from <= to ? to : from;
    return { from: a, to: b, label: `Du ${fmtDate(a)} au ${fmtDate(b)}` };
  }, [mode, month, year, from, to]);

  // Le calcul suit la saisie sans bloquer l'écran (React 19)
  const deferred = useDeferredValue(range);
  const data = useMemo(() => memberTotals(s, deferred.from, deferred.to, today), [s, deferred.from, deferred.to, today]);
  const { rows, total } = data;
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : a > 0 ? 100 : 0);
  const color = (id: string) => COLORS[Math.max(0, s.members.findIndex((m) => m.id === id)) % COLORS.length];
  const maxReceived = Math.max(1, ...rows.map((r) => r.received));

  const slug = range.label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const exp = async (kind: 'xlsx' | 'csv') => {
    try {
      if (kind === 'xlsx') await saveFile(`totaux-membres-${slug}.xlsx`, memberTotalsWorkbook(s, range.from, range.to, range.label, today), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      else await saveFile(`totaux-membres-${slug}.csv`, memberTotalsCsv(s, range.from, range.to, today), 'text/csv;charset=utf-8');
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  return (
    <div className="totals">
      <Card>
        <Seg value={mode} onChange={setMode} options={[['mois', 'Mois'], ['annee', 'Année'], ['dates', 'Entre deux dates']]} />
        <div className="totals-pick">
          {mode === 'mois' && (
            <Field label="Mois">
              <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Mois" />
            </Field>
          )}
          {mode === 'annee' && (
            <div className="chips wrap" role="radiogroup" aria-label="Année">
              {years.map((y) => (
                <button key={y} className={y === year ? 'chip on' : 'chip'} onClick={() => setYear(y)} role="radio" aria-checked={y === year}>
                  {y}
                </button>
              ))}
            </div>
          )}
          {mode === 'dates' && (
            <div className="two">
              <Field label="Du">
                <DateInput value={from} onChange={setFrom} max="2100-12-31" />
              </Field>
              <Field label="Au">
                <DateInput value={to} onChange={setTo} max="2100-12-31" />
              </Field>
            </div>
          )}
        </div>
        <p className="small muted">
          {range.label} · {fmtDate(range.from)} → {fmtDate(range.to)}
        </p>
      </Card>

      <div className="kpis four-mini">
        <div className="mini">
          <span>Attendu (MAD)</span>
          <b>{formatMAD(total.expected, false)}</b>
        </div>
        <div className="mini">
          <span>Versé (MAD)</span>
          <b className="t-pos">{formatMAD(total.paidForPeriod, false)}</b>
        </div>
        <div className="mini">
          <span>Reste (MAD)</span>
          <b className={total.remaining ? 't-warn' : ''}>{formatMAD(total.remaining, false)}</b>
        </div>
        <div className="mini">
          <span>Reçu (MAD)</span>
          <b className="t-info">{formatMAD(total.received, false)}</b>
        </div>
      </div>

      {rows.length === 0 ? (
        <Empty>Aucune cotisation sur cette période.</Empty>
      ) : (
        <div className="list">
          {rows.map((r) => {
            const p = pct(r.paidForPeriod, r.expected);
            return (
              <Card key={r.memberId} className="mt-card">
                <div className="row-between">
                  <b className="name">
                    <i className="dot" style={{ background: color(r.memberId) }} />
                    {r.name}
                  </b>
                  <span className="row-gap">
                    {r.leftDate && <Badge tone="muted">{r.leftDate > today ? `sortie ${fmtDate(r.leftDate)}` : `inactif dep. ${fmtDate(r.leftDate)}`}</Badge>}
                    {!r.leftDate && !r.active && <Badge tone="muted">inactif</Badge>}
                    <Badge tone={r.expected === 0 ? 'muted' : p >= 100 ? 'ok' : r.lateMonths ? 'bad' : 'warn'}>{r.expected === 0 ? '—' : `${p} %`}</Badge>
                  </span>
                </div>
                <div className="mt-bar" role="img" aria-label={`${p} % versé`}>
                  <i style={{ width: `${p}%`, background: color(r.memberId) }} />
                </div>
                <div className="trio">
                  <div>
                    <span>Attendu</span>
                    {formatMAD(r.expected)}
                  </div>
                  <div>
                    <span>Versé</span>
                    <b className="t-pos">{formatMAD(r.paidForPeriod)}</b>
                  </div>
                  <div>
                    <span>Reste</span>
                    <b className={r.remaining ? 't-warn' : ''}>{formatMAD(r.remaining)}</b>
                  </div>
                </div>
                <div className="row-between small muted">
                  <span>
                    {r.months} mois dû{r.months > 1 ? 's' : ''}
                    {r.lateMonths ? ` · ${r.lateMonths} en retard` : ''}
                  </span>
                  <span>
                    Reçu : <b>{formatMAD(r.received)}</b> ({r.payments} vers.)
                  </span>
                </div>
                <div className="mt-recv" aria-hidden="true">
                  <i style={{ width: `${(r.received / maxReceived) * 100}%` }} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Membre</th>
                <th className="n">Attendu</th>
                <th className="n">Versé</th>
                <th className="n">Reste</th>
                <th className="n">Reçu</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.memberId}>
                  <td>{r.name}</td>
                  <td className="n">{formatMAD(r.expected, false)}</td>
                  <td className="n t-pos">{formatMAD(r.paidForPeriod, false)}</td>
                  <td className={r.remaining ? 'n t-warn' : 'n'}>{formatMAD(r.remaining, false)}</td>
                  <td className="n">{formatMAD(r.received, false)}</td>
                </tr>
              ))}
              <tr className="tot">
                <td>Total</td>
                <td className="n">{formatMAD(total.expected, false)}</td>
                <td className="n">{formatMAD(total.paidForPeriod, false)}</td>
                <td className="n">{formatMAD(total.remaining, false)}</td>
                <td className="n">{formatMAD(total.received, false)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="row-gap">
        <Btn kind="soft" onClick={() => exp('xlsx')}>
          Exporter Excel
        </Btn>
        <Btn kind="ghost" onClick={() => exp('csv')}>
          Exporter CSV
        </Btn>
      </div>
      <p className="note">
        « Attendu / Versé / Reste » portent sur les cotisations des mois de la période ({MONTHS_FR[periodMonth(range.from.slice(0, 7)) - 1].toLowerCase()} à {MONTHS_FR[periodMonth(range.to.slice(0, 7)) - 1].toLowerCase()}), même payées plus tard. « Reçu » est l'argent réellement reçu entre les deux dates. Un membre désactivé ne doit plus rien à partir de sa date de sortie.
      </p>
    </div>
  );
}
