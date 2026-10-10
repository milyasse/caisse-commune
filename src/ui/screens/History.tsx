import React, { useMemo, useState } from 'react';
import { run, useStore } from '../../store/store.ts';
import { allOperations, contributionStatus, paidFor, type Operation } from '../../domain/finance.ts';
import { cancelExpense, cancelPayment } from '../../domain/commands.ts';
import { fmtDate, periodEnd, periodLabel, periodStart } from '../../domain/dates.ts';
import { formatMAD } from '../../domain/money.ts';
import type { AuditLog, Expense, Payment } from '../../domain/types.ts';
import { Badge, Btn, confirmDialog, Empty, errorMessage, Field, Icon, Seg, Sheet, toast } from '../components/kit.tsx';
import { ExpenseForm, PaymentForm } from '../forms.tsx';

const METHOD: Record<string, string> = { especes: 'Espèces', virement: 'Virement', autre: 'Autre' };

export function OperationRow({ op }: { op: Operation }) {
  const { state: s } = useStore();
  const [open, setOpen] = useState(false);
  const cancelled = op.item.status === 'cancelled';
  let title: string, sub: string;
  if (op.kind === 'payment') {
    const p = op.item;
    const c = s.contributions.find((x) => x.id === p.contributionId);
    title = s.members.find((m) => m.id === p.memberId)?.name ?? '?';
    sub = `Cotisation ${c ? periodLabel(c.period).toLowerCase() : ''}${p.comment ? ' · ' + p.comment : ''}`;
  } else {
    const e = op.item;
    title = e.description;
    sub = `${s.categories.find((c) => c.id === e.categoryId)?.name ?? ''}${e.beneficiary ? ' · ' + e.beneficiary : ''}`;
  }
  return (
    <>
      <button className={cancelled ? 'op cancelled' : 'op'} onClick={() => setOpen(true)}>
        <span className={op.kind === 'payment' ? 'op-ic in' : 'op-ic out'}>
          <Icon name={op.kind === 'payment' ? 'in' : 'out'} size={18} />
        </span>
        <span className="op-t">
          <b>{title}</b>
          <small>
            {fmtDate(op.date)} · {sub}
          </small>
        </span>
        <span className={op.kind === 'payment' ? 'op-a t-pos' : 'op-a'}>
          {op.kind === 'payment' ? '+' : '−'}
          {formatMAD(op.amount)}
          {cancelled && <small>annulé</small>}
        </span>
      </button>
      {open && <OperationDetail op={op} onClose={() => setOpen(false)} />}
    </>
  );
}

function OperationDetail({ op, onClose }: { op: Operation; onClose: () => void }) {
  const { state: s } = useStore();
  const [editing, setEditing] = useState(false);
  // version à jour de l'opération
  const item = (op.kind === 'payment' ? s.payments : s.expenses).find((x) => x.id === op.item.id) ?? op.item;
  const trail = s.audit.filter((a) => a.entityId === item.id).sort((a, b) => b.at.localeCompare(a.at));
  if (editing) return op.kind === 'payment' ? <PaymentForm edit={item as Payment} onDone={() => setEditing(false)} /> : <ExpenseForm edit={item as Expense} onDone={() => setEditing(false)} />;

  const cancel = async () => {
    const reason = await confirmDialog({ title: 'Annuler l’opération ?', message: 'Elle ne sera plus comptée dans les soldes mais restera visible (barrée) dans l’historique.', confirm: 'Annuler l’opération', danger: true, reason: true });
    if (reason === false) return;
    try {
      run((st, k) => (op.kind === 'payment' ? cancelPayment(st, k, item.id, reason) : cancelExpense(st, k, item.id, reason)));
      toast('Opération annulée');
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  const rows: [string, React.ReactNode][] = [];
  if (op.kind === 'payment') {
    const p = item as Payment;
    const c = s.contributions.find((x) => x.id === p.contributionId);
    rows.push(['Type', 'Cotisation (versement)'], ['Membre', s.members.find((m) => m.id === p.memberId)?.name], ['Mois concerné', c ? periodLabel(c.period) : '—'], ['Date d’encaissement', fmtDate(p.date)]);
    if (c) rows.push(['Échéance', fmtDate(c.dueDate)]);
  } else {
    const e = item as Expense;
    rows.push(['Type', 'Dépense'], ['Catégorie', s.categories.find((c) => c.id === e.categoryId)?.name], ['Description', e.description], ['Bénéficiaire', e.beneficiary || '—'], ['Date', fmtDate(e.date)]);
  }
  rows.push(['Montant', <b key="m">{formatMAD(item.amount)}</b>], ['Mode', METHOD[item.method]]);
  if (item.reference) rows.push(['Référence', item.reference]);
  if (item.comment) rows.push(['Commentaire', item.comment]);
  rows.push(['Saisi par', item.createdBy], ['Statut', item.status === 'valid' ? <Badge key="s" tone="ok">Valide</Badge> : <Badge key="s" tone="bad">Annulé — {item.cancelReason}</Badge>], ['Identifiant', <code key="i">{item.id.slice(0, 8)}</code>]);
  const receipt = op.kind === 'expense' ? (item as Expense).receipt : undefined;

  return (
    <Sheet
      title="Détail de l'opération"
      onClose={onClose}
      footer={
        item.status === 'valid' ? (
          <div className="row-gap full">
            <Btn kind="soft" onClick={() => setEditing(true)}>
              <Icon name="edit" /> Corriger
            </Btn>
            <Btn kind="danger" onClick={cancel}>
              <Icon name="ban" /> Annuler
            </Btn>
          </div>
        ) : undefined
      }
    >
      <dl className="dl">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      {receipt?.startsWith('data:image') && <img src={receipt} alt="Justificatif" className="receipt" />}
      {receipt?.startsWith('data:application/pdf') && (
        <a href={receipt} download="justificatif.pdf" className="link">
          Ouvrir le justificatif PDF
        </a>
      )}
      <h4>Historique des modifications</h4>
      <AuditTrail items={trail} />
    </Sheet>
  );
}

const ACTION: Record<string, string> = { create: 'Création', update: 'Correction', cancel: 'Annulation', close: 'Clôture', reopen: 'Réouverture', import: 'Import', reset: 'Réinitialisation', restore: 'Restauration' };
export function AuditTrail({ items }: { items: AuditLog[] }) {
  if (!items.length) return <Empty>Aucune trace.</Empty>;
  const diff = (a: AuditLog) => {
    if (a.action !== 'update' || !a.before || !a.after) return null;
    const b = a.before as Record<string, unknown>,
      f = a.after as Record<string, unknown>;
    return Object.keys(f)
      .filter((k) => k !== 'updatedAt' && JSON.stringify(b[k]) !== JSON.stringify(f[k]))
      .map((k) => {
        const fmt = (v: unknown) => (typeof v === 'number' && ['amount', 'expected', 'defaultAmount', 'openingBalance', 'largeExpenseThreshold'].includes(k) ? formatMAD(v) : String(v ?? '—'));
        return `${k} : ${fmt(b[k])} → ${fmt(f[k])}`;
      })
      .join(' ; ');
  };
  return (
    <ul className="trail">
      {items.map((a) => (
        <li key={a.id}>
          <b>{ACTION[a.action] ?? a.action}</b> par {a.user} le {fmtDate(a.at.slice(0, 10))} à {a.at.slice(11, 16)}
          {a.reason && <div className="small">Motif : {a.reason}</div>}
          {diff(a) && <div className="small muted">{diff(a)}</div>}
        </li>
      ))}
    </ul>
  );
}

export function History() {
  const { state: s } = useStore();
  const [q, setQ] = useState('');
  const [type, setType] = useState<'all' | 'payment' | 'expense'>('all');
  const [member, setMember] = useState('');
  const [cat, setCat] = useState('');
  const [cstatus, setCstatus] = useState('');
  const [opStatus, setOpStatus] = useState<'valid' | 'all' | 'cancelled'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [month, setMonth] = useState('');
  const [filters, setFilters] = useState(false);

  const ops = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const names = new Map(s.members.map((m) => [m.id, m.name.toLowerCase()]));
    const cats = new Map(s.categories.map((c) => [c.id, c.name.toLowerCase()]));
    const f1 = month ? periodStart(month) : from;
    const t1 = month ? periodEnd(month) : to;
    return allOperations(s).filter((o) => {
      if (type !== 'all' && o.kind !== type) return false;
      if (opStatus !== 'all' && o.item.status !== opStatus) return false;
      if (f1 && o.date < f1) return false;
      if (t1 && o.date > t1) return false;
      if (o.kind === 'payment') {
        if (cat) return false;
        if (member && o.item.memberId !== member) return false;
        if (cstatus) {
          const c = s.contributions.find((x) => x.id === (o.item as Payment).contributionId);
          if (!c || contributionStatus(c.expected, paidFor(s, c.id)) !== cstatus) return false;
        }
      } else {
        if (member || cstatus) return false;
        if (cat && o.item.categoryId !== cat) return false;
      }
      if (needle) {
        const hay = [o.item.comment, o.item.reference, formatMAD(o.amount), fmtDate(o.date), o.kind === 'payment' ? names.get(o.item.memberId) : `${(o.item as Expense).description} ${(o.item as Expense).beneficiary} ${cats.get((o.item as Expense).categoryId)}`]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [s, q, type, member, cat, cstatus, opStatus, from, to, month]);

  const active = [member, cat, cstatus, from, to, month].filter(Boolean).length + (opStatus !== 'all' ? 1 : 0);
  const totIn = ops.filter((o) => o.kind === 'payment' && o.item.status === 'valid').reduce((a, o) => a + o.amount, 0);
  const totOut = ops.filter((o) => o.kind === 'expense' && o.item.status === 'valid').reduce((a, o) => a + o.amount, 0);
  const groups: [string, Operation[]][] = [];
  for (const o of ops) (groups.at(-1)?.[0] === o.date ? groups.at(-1)![1] : (groups.push([o.date, []]), groups.at(-1)![1])).push(o);

  return (
    <div className="screen">
      <div className="search">
        <Icon name="search" />
        <input type="search" placeholder="Rechercher (nom, montant, commentaire…)" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={active ? 'chip on' : 'chip'} onClick={() => setFilters(!filters)}>
          Filtres{active ? ` (${active})` : ''}
        </button>
      </div>
      <Seg value={type} onChange={setType} options={[['all', 'Tout'], ['payment', 'Cotisations'], ['expense', 'Dépenses']]} />
      {filters && (
        <div className="filters card">
          <Field label="Mois">
            <input type="month" value={month} onChange={(e) => (setMonth(e.target.value), setFrom(''), setTo(''))} />
          </Field>
          <div className="two">
            <Field label="Du">
              <input type="date" value={from} onChange={(e) => (setFrom(e.target.value), setMonth(''))} />
            </Field>
            <Field label="Au">
              <input type="date" value={to} onChange={(e) => (setTo(e.target.value), setMonth(''))} />
            </Field>
          </div>
          <div className="two">
            <Field label="Membre">
              <select value={member} onChange={(e) => setMember(e.target.value)}>
                <option value="">Tous</option>
                {s.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Catégorie de dépense">
              <select value={cat} onChange={(e) => setCat(e.target.value)}>
                <option value="">Toutes</option>
                {s.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="two">
            <Field label="Statut de cotisation">
              <select value={cstatus} onChange={(e) => setCstatus(e.target.value)}>
                <option value="">Tous</option>
                <option value="paye">Payé</option>
                <option value="partiel">Partiel</option>
                <option value="non_paye">Non payé</option>
              </select>
            </Field>
            <Field label="Opérations">
              <select value={opStatus} onChange={(e) => setOpStatus(e.target.value as typeof opStatus)}>
                <option value="all">Valides et annulées</option>
                <option value="valid">Valides</option>
                <option value="cancelled">Annulées</option>
              </select>
            </Field>
          </div>
          <Btn kind="ghost" onClick={() => (setMember(''), setCat(''), setCstatus(''), setFrom(''), setTo(''), setMonth(''), setOpStatus('all'))}>
            Réinitialiser les filtres
          </Btn>
        </div>
      )}
      <div className="meta-line">
        <span>{ops.length} opération(s)</span>
        <span className="t-pos">+{formatMAD(totIn)}</span>
        <span>−{formatMAD(totOut)}</span>
      </div>
      {groups.map(([d, list]) => (
        <div key={d}>
          <div className="day">{fmtDate(d)}</div>
          <div className="list">
            {list.map((o) => (
              <OperationRow key={o.item.id} op={o} />
            ))}
          </div>
        </div>
      ))}
      {ops.length === 0 && <Empty>Aucune opération ne correspond.</Empty>}
    </div>
  );
}
