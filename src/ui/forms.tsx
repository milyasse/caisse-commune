/** Formulaires de saisie rapide : versement, dépense, choix d'opération. */
import React, { useMemo, useState } from 'react';
import { run, useStore } from '../store/store.ts';
import { addExpense, addPayment, DomainError, updateExpense, updatePayment, type ExpenseInput } from '../domain/commands.ts';
import { contributionRows, isActiveOn, isWaived, paidFor } from '../domain/finance.ts';
import { fmtDate, periodLabel, periodOf, todayISO } from '../domain/dates.ts';
import { formatMAD } from '../domain/money.ts';
import type { AppState, Expense, Payment, PayMethod } from '../domain/types.ts';
import { Btn, confirmDialog, DateInput, errorMessage, Field, Icon, MoneyInput, Seg, Sheet, toast } from './components/kit.tsx';

const METHODS: [PayMethod, string][] = [
  ['especes', 'Espèces'],
  ['virement', 'Virement'],
  ['autre', 'Autre'],
];

/** Exécute une commande ; si un doublon potentiel est détecté, demande confirmation puis réessaie. */
export async function attempt(fn: (allowDuplicate: boolean) => (s: AppState) => AppState, okMsg: string): Promise<boolean> {
  try {
    run(fn(false));
    toast(okMsg);
    return true;
  } catch (e) {
    if (e instanceof DomainError && e.code === 'duplicate') {
      const ok = await confirmDialog({ title: 'Doublon possible', message: `${e.message} Voulez-vous vraiment l’enregistrer une seconde fois ?`, confirm: 'Enregistrer quand même' });
      if (ok === false) return false;
      try {
        run(fn(true));
        toast(okMsg);
        return true;
      } catch (e2) {
        toast(errorMessage(e2), 'bad');
        return false;
      }
    }
    toast(errorMessage(e), 'bad');
    return false;
  }
}

/** Mois non soldés d'un membre (le plus ancien d'abord) — proposé par défaut. */
function openContributions(s: AppState, memberId: string) {
  return s.contributions
    .filter((c) => c.memberId === memberId && paidFor(s, c.id) < c.expected && !isWaived(s, c))
    .sort((a, b) => a.period.localeCompare(b.period));
}

export function PaymentForm({ contributionId, memberId: initialMember, edit, onDone }: { contributionId?: string; memberId?: string; edit?: Payment; onDone: () => void }) {
  const { state: s } = useStore();
  const active = s.members.filter((m) => isActiveOn(m) || m.id === initialMember);
  const pre = contributionId ? s.contributions.find((c) => c.id === contributionId) : undefined;
  const [memberId, setMemberId] = useState(edit?.memberId ?? pre?.memberId ?? initialMember ?? active[0]?.id ?? '');
  const open = useMemo(() => openContributions(s, memberId), [s, memberId]);
  const [cid, setCid] = useState(edit?.contributionId ?? pre?.id ?? open[0]?.id ?? '');
  const c = s.contributions.find((x) => x.id === cid);
  const remaining = c ? c.expected - paidFor(s, c.id) + (edit?.amount ?? 0) : 0;
  const [amount, setAmount] = useState<number | null>(edit?.amount ?? (remaining > 0 ? remaining : null));
  const [date, setDate] = useState(edit?.date ?? todayISO());
  const [method, setMethod] = useState<PayMethod>(edit?.method ?? 'especes');
  const [comment, setComment] = useState(edit?.comment ?? '');
  const [reference, setReference] = useState(edit?.reference ?? '');

  const choices = c && !open.some((o) => o.id === c.id) ? [c, ...open] : open;
  const onMember = (id: string) => {
    setMemberId(id);
    const first = openContributions(s, id)[0];
    setCid(first?.id ?? '');
    setAmount(first ? first.expected - paidFor(s, first.id) : null);
  };
  const onContribution = (id: string) => {
    setCid(id);
    const x = s.contributions.find((k) => k.id === id);
    if (x) setAmount(x.expected - paidFor(s, x.id));
  };

  const submit = async () => {
    if (!c || !amount) return toast('Choisissez un mois et un montant.', 'bad');
    if (edit) {
      const reason = await confirmDialog({ title: 'Corriger le versement', message: 'La correction sera tracée dans l’historique.', confirm: 'Corriger', reason: true });
      if (reason === false) return;
      try {
        run((st, k) => updatePayment(st, k, edit.id, { amount, date, method, comment, reference }, reason));
        toast('Versement corrigé');
        onDone();
      } catch (e) {
        toast(errorMessage(e), 'bad');
      }
      return;
    }
    const id = crypto.randomUUID(); // identifiant client : un double appui ne crée pas de doublon
    if (await attempt((dup) => (st) => addPayment(st, { user: st.settings.currentUser, role: st.settings.currentRole }, { id, contributionId: c.id, date, amount, method, comment, reference }, { allowDuplicate: dup }), 'Versement enregistré')) onDone();
  };

  return (
    <Sheet title={edit ? 'Corriger un versement' : 'Enregistrer un versement'} onClose={onDone} footer={<Btn full onClick={submit}>{edit ? 'Enregistrer la correction' : 'Enregistrer le versement'}</Btn>}>
      <Field label="Membre">
        <select value={memberId} onChange={(e) => onMember(e.target.value)} disabled={!!edit || !!pre}>
          {active.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Mois concerné" hint={c ? `Attendu ${formatMAD(c.expected)} · reste ${formatMAD(Math.max(0, remaining))} · échéance ${fmtDate(c.dueDate)}` : 'Aucune cotisation en attente pour ce membre'}>
        <select value={cid} onChange={(e) => onContribution(e.target.value)} disabled={!!edit || !!pre}>
          {choices.length === 0 && <option value="">—</option>}
          {choices.map((o) => (
            <option key={o.id} value={o.id}>
              {periodLabel(o.period)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Montant versé">
        <MoneyInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      {c && remaining > 0 && amount !== remaining && (
        <div className="chips">
          <button className="chip" onClick={() => setAmount(remaining)}>
            Solde {formatMAD(remaining)}
          </button>
          {remaining >= 200_00 && (
            <button className="chip" onClick={() => setAmount(Math.round(remaining / 2))}>
              Moitié
            </button>
          )}
        </div>
      )}
      <Field label="Date réelle du versement" hint={c && periodOf(date) !== c.period ? `Encaissé en ${periodLabel(periodOf(date))}, imputé à ${periodLabel(c.period)}` : undefined}>
        <DateInput value={date} onChange={setDate} />
      </Field>
      <Field label="Mode de paiement">
        <Seg value={method} options={METHODS} onChange={setMethod} />
      </Field>
      <Field label="Référence (facultatif)">
        <input value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <Field label="Commentaire (facultatif)">
        <input value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
    </Sheet>
  );
}

/** Réduit une photo (justificatif) avant stockage local. */
async function compressImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    if (file.size > 3_000_000) throw new Error('Fichier trop lourd (3 Mo max).');
    return await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale);
  cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.72);
}

export function ExpenseForm({ edit, onDone }: { edit?: Expense; onDone: () => void }) {
  const { state: s } = useStore();
  const cats = s.categories.filter((c) => c.active || c.id === edit?.categoryId);
  const [f, setF] = useState<ExpenseInput>(
    edit
      ? { date: edit.date, categoryId: edit.categoryId, description: edit.description, beneficiary: edit.beneficiary, amount: edit.amount, method: edit.method, reference: edit.reference, comment: edit.comment, receipt: edit.receipt }
      : { date: todayISO(), categoryId: cats[0]?.id ?? '', description: '', beneficiary: '', amount: 0, method: 'especes' },
  );
  const up = (p: Partial<ExpenseInput>) => setF((x) => ({ ...x, ...p }));
  const beneficiaries = useMemo(() => [...new Set(s.expenses.map((e) => e.beneficiary).filter(Boolean))].slice(-30), [s.expenses]);
  const big = f.amount >= s.settings.largeExpenseThreshold;

  const submit = async () => {
    if (!f.amount) return toast('Indiquez le montant.', 'bad');
    if (edit) {
      const reason = await confirmDialog({ title: 'Corriger la dépense', message: 'La correction sera tracée dans l’historique.', confirm: 'Corriger', reason: true });
      if (reason === false) return;
      try {
        run((st, k) => updateExpense(st, k, edit.id, f, reason));
        toast('Dépense corrigée');
        onDone();
      } catch (e) {
        toast(errorMessage(e), 'bad');
      }
      return;
    }
    if (big && (await confirmDialog({ title: 'Dépense importante', message: `Confirmer une dépense de ${formatMAD(f.amount)} ?`, confirm: 'Confirmer' })) === false) return;
    const id = crypto.randomUUID();
    if (await attempt((dup) => (st) => addExpense(st, { user: st.settings.currentUser, role: st.settings.currentRole }, { ...f, id }, { allowDuplicate: dup }), 'Dépense enregistrée')) onDone();
  };

  return (
    <Sheet title={edit ? 'Corriger une dépense' : 'Nouvelle dépense'} onClose={onDone} footer={<Btn full onClick={submit}>{edit ? 'Enregistrer la correction' : 'Enregistrer la dépense'}</Btn>}>
      <Field label="Montant">
        <MoneyInput value={f.amount || null} onChange={(v) => up({ amount: v ?? 0 })} autoFocus />
      </Field>
      <Field label="Date de la dépense">
        <DateInput value={f.date} onChange={(date) => up({ date })} />
      </Field>
      <Field label="Catégorie">
        <div className="chips wrap">
          {cats.map((c) => (
            <button key={c.id} className={c.id === f.categoryId ? 'chip on' : 'chip'} onClick={() => up({ categoryId: c.id })}>
              {c.name}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Description">
        <input value={f.description} onChange={(e) => up({ description: e.target.value })} placeholder="Ex. : salaire du mois" />
      </Field>
      <Field label="Bénéficiaire / personne payée">
        <input list="benef" value={f.beneficiary} onChange={(e) => up({ beneficiary: e.target.value })} />
        <datalist id="benef">
          {beneficiaries.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </Field>
      <Field label="Mode de paiement">
        <Seg value={f.method} options={METHODS} onChange={(method) => up({ method })} />
      </Field>
      <Field label="Référence / n° de justificatif (facultatif)">
        <input value={f.reference ?? ''} onChange={(e) => up({ reference: e.target.value })} />
      </Field>
      <Field label="Commentaire (facultatif)">
        <input value={f.comment ?? ''} onChange={(e) => up({ comment: e.target.value })} />
      </Field>
      <Field label="Photo du justificatif (facultatif)">
        <div className="receipt-row">
          {f.receipt?.startsWith('data:image') && <img src={f.receipt} alt="Justificatif" className="thumb" />}
          <label className="btn btn-soft">
            <Icon name="camera" /> {f.receipt ? 'Remplacer' : 'Ajouter'}
            <input
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                  try {
                    up({ receipt: await compressImage(file) });
                  } catch (err) {
                    toast(errorMessage(err), 'bad');
                  }
                }
              }}
            />
          </label>
        </div>
      </Field>
    </Sheet>
  );
}

export function QuickAdd({ onClose, onPick }: { onClose: () => void; onPick: (k: 'payment' | 'expense') => void }) {
  const { state: s } = useStore();
  const late = contributionRows(s, periodOf(todayISO())).filter((r) => r.status !== 'paye').length;
  return (
    <Sheet title="Ajouter une opération" onClose={onClose}>
      <div className="pick">
        <button className="pick-btn in" onClick={() => onPick('payment')}>
          <Icon name="in" size={26} />
          <b>Cotisation</b>
          <span>{late ? `${late} membre(s) à encaisser ce mois` : 'Versement d’un membre'}</span>
        </button>
        <button className="pick-btn out" onClick={() => onPick('expense')}>
          <Icon name="out" size={26} />
          <b>Dépense</b>
          <span>Personnel, charges, achats…</span>
        </button>
      </div>
    </Sheet>
  );
}
