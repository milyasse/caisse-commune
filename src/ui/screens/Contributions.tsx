import React, { useMemo, useState } from 'react';
import { run, useStore } from '../../store/store.ts';
import { contributionRows, monthSummary, type ContributionRow } from '../../domain/finance.ts';
import { cancelPayment, generateMonth, overrideExpected } from '../../domain/commands.ts';
import { dueDateFor, fmtDate, periodLabel, periodYear, MONTHS_FR, periodMonth, todayISO } from '../../domain/dates.ts';
import { formatMAD } from '../../domain/money.ts';
import type { Payment, Period } from '../../domain/types.ts';
import { Badge, Btn, Card, confirmDialog, Empty, errorMessage, Field, Icon, MoneyInput, PeriodPicker, Seg, Sheet, StatusBadge, toast } from '../components/kit.tsx';
import { PaymentForm } from '../forms.tsx';
import { MemberTotals } from './MemberTotals.tsx';
import { isActiveOn, isOwedFor } from '../../domain/finance.ts';

const METHOD: Record<string, string> = { especes: 'Espèces', virement: 'Virement', autre: 'Autre' };

export function Contributions({ period, setPeriod }: { period: Period; setPeriod: (p: Period) => void }) {
  const { state: s } = useStore();
  const [view, setView] = useState<'cartes' | 'tableau'>('cartes');
  const [top, setTop] = useState<'mois' | 'totaux'>('mois');
  const [open, setOpen] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<string | null>(null);
  const rows = useMemo(() => contributionRows(s, period, todayISO()), [s, period]);
  const m = monthSummary(s, period);
  const missing = s.members.filter((mm) => isOwedFor(mm, period) && !rows.some((r) => r.contribution.memberId === mm.id)).length;
  const closed = !!m.closure;

  const generate = () => {
    try {
      let created = 0;
      run((st, k) => {
        const r = generateMonth(st, k, period);
        created = r.created;
        return r.state;
      });
      toast(created ? `${created} cotisation(s) générée(s) pour ${periodLabel(period)}` : 'Toutes les cotisations existent déjà');
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  const current = rows.find((r) => r.contribution.id === open);

  const topSeg = <div className="top-seg"><Seg value={top} onChange={setTop} options={[['mois', 'Par mois'], ['totaux', 'Totaux par membre']]} /></div>;
  if (top === 'totaux')
    return (
      <div className="screen">
        {topSeg}
        <MemberTotals period={period} />
      </div>
    );

  return (
    <div className="screen">
      {topSeg}
      <PeriodPicker value={period} onChange={setPeriod} />
      <div className="meta-line">
        <span>
          Année <b>{periodYear(period)}</b> · Mois <b>{MONTHS_FR[periodMonth(period) - 1]}</b>
        </span>
        <span>
          Date limite <b>{fmtDate(rows[0]?.contribution.dueDate ?? dueDateFor(period, s.settings.dueDay))}</b>
        </span>
        {closed && (
          <Badge tone="muted">
            <Icon name="lock" size={12} /> clôturé
          </Badge>
        )}
      </div>

      <div className="kpis three">
        <div className="mini">
          <span>Attendu (MAD)</span>
          <b>{formatMAD(m.expected, false)}</b>
        </div>
        <div className="mini">
          <span>Versé (MAD)</span>
          <b className="t-pos">{formatMAD(m.allocated, false)}</b>
        </div>
        <div className="mini">
          <span>Reste (MAD)</span>
          <b className={m.remaining ? 't-warn' : ''}>{formatMAD(m.remaining, false)}</b>
        </div>
      </div>

      {missing > 0 && (
        <Card className="callout">
          <p>
            {rows.length === 0 ? `Les cotisations de ${periodLabel(period)} ne sont pas encore générées.` : `${missing} membre(s) actif(s) sans cotisation ce mois.`}
          </p>
          <Btn onClick={generate}>Générer les cotisations</Btn>
        </Card>
      )}

      {rows.length > 0 && <Seg value={view} onChange={setView} options={[['cartes', 'Cartes'], ['tableau', 'Tableau']]} />}

      {view === 'cartes' ? (
        <div className="list">
          {rows.map((r) => (
            <Card key={r.contribution.id} onClick={() => setOpen(r.contribution.id)} className={r.late ? 'late' : undefined}>
              <div className="row-between">
                <b className="name">{r.memberName}</b>
                <StatusBadge status={r.status} late={r.late} />
              </div>
              <div className="trio">
                <div>
                  <span>Attendu</span>
                  {formatMAD(r.contribution.expected)}
                  {r.contribution.overridden && <sup title="Montant modifié pour ce mois"> *</sup>}
                </div>
                <div>
                  <span>Versé</span>
                  <b className="t-pos">{formatMAD(r.paid)}</b>
                </div>
                <div>
                  <span>Reste</span>
                  <b className={r.remaining ? 't-warn' : ''}>{formatMAD(r.remaining)}</b>
                </div>
              </div>
              <div className="row-between small muted">
                <span>{r.payments.length ? `Versé le ${r.payments.map((p) => fmtDate(p.date)).join(', ')}` : 'Aucun versement'}</span>
                {r.remaining > 0 && !closed && (
                  <button
                    className="link strong"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPayFor(r.contribution.id);
                    }}
                  >
                    + Encaisser
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Membre</th>
                <th className="n">Attendu</th>
                <th className="n">Versé</th>
                <th className="n">Reste</th>
                <th>Date(s)</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.contribution.id} onClick={() => setOpen(r.contribution.id)}>
                  <td>{r.memberName}</td>
                  <td className="n">{formatMAD(r.contribution.expected, false)}</td>
                  <td className="n t-pos">{formatMAD(r.paid, false)}</td>
                  <td className={r.remaining ? 'n t-warn' : 'n'}>{formatMAD(r.remaining, false)}</td>
                  <td>{r.payments.map((p) => fmtDate(p.date).slice(0, 5)).join(' ')}</td>
                  <td>
                    <StatusBadge status={r.status} late={r.late} />
                  </td>
                </tr>
              ))}
              <tr className="tot">
                <td>Total</td>
                <td className="n">{formatMAD(m.expected, false)}</td>
                <td className="n">{formatMAD(rows.reduce((a, r) => a + r.paid, 0), false)}</td>
                <td className="n">{formatMAD(m.remaining, false)}</td>
                <td colSpan={2} className="muted small">
                  MAD
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {rows.length === 0 && missing === 0 && <Empty>{s.members.some((mm) => isActiveOn(mm)) ? 'Aucune cotisation due ce mois-ci.' : 'Aucun membre actif. Ajoutez des membres dans Paramètres.'}</Empty>}

      <p className="note">
        « Versé » compte les versements rattachés à ce mois, même s'ils ont été encaissés plus tard. L'argent n'entre en caisse qu'à sa date réelle d'encaissement.
      </p>

      {current && !payFor && <ContributionSheet row={current} closed={closed} onPay={() => setPayFor(current.contribution.id)} onClose={() => setOpen(null)} />}
      {payFor && <PaymentForm contributionId={payFor} onDone={() => setPayFor(null)} />}
    </div>
  );
}

function ContributionSheet({ row, closed, onPay, onClose }: { row: ContributionRow; closed: boolean; onPay: () => void; onClose: () => void }) {
  const [editing, setEditing] = useState<Payment | null>(null);
  const [newExpected, setNewExpected] = useState<number | null>(null);
  const c = row.contribution;

  const cancel = async (p: Payment) => {
    const reason = await confirmDialog({ title: 'Annuler ce versement ?', message: `${formatMAD(p.amount)} du ${fmtDate(p.date)}. L'opération reste visible dans l'historique, barrée.`, confirm: 'Annuler le versement', danger: true, reason: true });
    if (reason === false) return;
    try {
      run((st, k) => cancelPayment(st, k, p.id, reason));
      toast('Versement annulé');
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };
  const saveExpected = async () => {
    if (newExpected === null) return;
    const reason = await confirmDialog({ title: 'Modifier le montant attendu', message: `Passer de ${formatMAD(c.expected)} à ${formatMAD(newExpected)} pour ${periodLabel(c.period)} uniquement.`, confirm: 'Modifier', reason: true });
    if (reason === false) return;
    try {
      run((st, k) => overrideExpected(st, k, c.id, newExpected, reason));
      toast('Montant attendu modifié');
      setNewExpected(null);
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  if (editing) return <PaymentForm edit={editing} onDone={() => setEditing(null)} />;
  return (
    <Sheet title={`${row.memberName} — ${periodLabel(c.period)}`} onClose={onClose} footer={row.remaining > 0 && !closed ? <Btn full onClick={onPay}>Encaisser {formatMAD(row.remaining)}</Btn> : undefined}>
      <div className="trio big">
        <div>
          <span>Attendu</span>
          {formatMAD(c.expected)}
        </div>
        <div>
          <span>Versé</span>
          <b className="t-pos">{formatMAD(row.paid)}</b>
        </div>
        <div>
          <span>Reste</span>
          <b className={row.remaining ? 't-warn' : ''}>{formatMAD(row.remaining)}</b>
        </div>
      </div>
      <p className="small muted">
        Date limite : {fmtDate(c.dueDate)} · <StatusBadge status={row.status} late={row.late} />
        {c.overridden && ' · montant modifié pour ce mois'}
      </p>
      <h4>Versements</h4>
      {row.payments.length === 0 && <Empty>Aucun versement pour ce mois.</Empty>}
      {row.payments.map((p) => (
        <div key={p.id} className="pay-line">
          <div>
            <b>{formatMAD(p.amount)}</b>
            <div className="small muted">
              {fmtDate(p.date)} · {METHOD[p.method]}
              {p.comment ? ` · ${p.comment}` : ''}
            </div>
          </div>
          {!closed && (
            <div className="row-gap">
              <button className="icon-btn" aria-label="Corriger" onClick={() => setEditing(p)}>
                <Icon name="edit" />
              </button>
              <button className="icon-btn danger" aria-label="Annuler" onClick={() => cancel(p)}>
                <Icon name="ban" />
              </button>
            </div>
          )}
        </div>
      ))}
      {!closed && (
        <details className="more">
          <summary>Modifier exceptionnellement le montant attendu</summary>
          <Field label={`Nouveau montant pour ${periodLabel(c.period)}`} hint="Les autres mois ne changent pas.">
            <MoneyInput value={newExpected} onChange={setNewExpected} />
          </Field>
          <Btn kind="soft" onClick={saveExpected} disabled={newExpected === null}>
            Appliquer
          </Btn>
        </details>
      )}
    </Sheet>
  );
}
