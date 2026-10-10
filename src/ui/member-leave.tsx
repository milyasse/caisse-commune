/** Statut d'un membre : actif, ou inactif à partir d'une date précise (réversible). */
import React, { useState } from 'react';
import { run } from '../store/store.ts';
import { setMemberLeave } from '../domain/commands.ts';
import { isActiveOn } from '../domain/finance.ts';
import { fmtDate, todayISO } from '../domain/dates.ts';
import type { Member } from '../domain/types.ts';
import { Badge, Btn, confirmDialog, DateInput, errorMessage, Field, toast } from './components/kit.tsx';

/** Libellé court du statut (liste des membres, tableaux). */
export function memberStatusLabel(m: Member, today = todayISO()): { text: string; tone: 'ok' | 'muted' | 'warn' } {
  if (m.leftDate) return m.leftDate > today ? { text: `sortie le ${fmtDate(m.leftDate)}`, tone: 'warn' } : { text: `inactif depuis le ${fmtDate(m.leftDate)}`, tone: 'muted' };
  return m.active ? { text: 'actif', tone: 'ok' } : { text: 'inactif', tone: 'muted' };
}

export function MemberStatusBadge({ m }: { m: Member }) {
  const st = memberStatusLabel(m);
  if (st.tone === 'ok') return null;
  return <Badge tone={st.tone}>{st.text}</Badge>;
}

export function MemberLeave({ member }: { member: Member }) {
  const today = todayISO();
  const [date, setDate] = useState(member.leftDate ?? today);
  const activeNow = isActiveOn(member, today);
  const hasDate = !!member.leftDate;
  const legacyInactive = !hasDate && !member.active;

  const apply = async (d: string | null) => {
    const ok = await confirmDialog(
      d
        ? {
            title: hasDate ? 'Modifier la date de sortie ?' : `Désactiver ${member.name} ?`,
            message: `À partir du ${fmtDate(d)}, ${member.name} ne fait plus partie des membres actifs : les mois qui commencent à cette date ou après ne sont plus dus${d.endsWith('-01') ? '' : ' (le mois en cours au ' + fmtDate(d) + ' reste dû)'}. Les versements déjà faits et l'historique sont conservés.`,
            confirm: hasDate ? 'Modifier' : 'Désactiver',
            danger: true,
          }
        : { title: `Réactiver ${member.name} ?`, message: 'Ses cotisations redeviennent dues pour tous les mois, et seront de nouveau générées chaque mois.', confirm: 'Réactiver' },
    );
    if (ok === false) return;
    try {
      run((s, k) => setMemberLeave(s, k, member.id, d));
      toast(d ? (d > today ? `Sortie programmée le ${fmtDate(d)}` : `Membre inactif depuis le ${fmtDate(d)}`) : 'Membre réactivé');
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  return (
    <div className="leave-box">
      <div className="row-between">
        <b>Statut</b>
        {activeNow && !hasDate ? <Badge tone="ok">actif</Badge> : <MemberStatusBadge m={member} />}
      </div>
      <Field label={hasDate || legacyInactive ? 'Inactif à partir du' : 'Désactiver à partir du'} hint="Date précise à partir de laquelle il n'est plus membre actif (passée ou future).">
        <DateInput value={date} onChange={setDate} max="2100-12-31" />
      </Field>
      <div className="row-gap">
        <Btn kind="danger" onClick={() => apply(date)} disabled={!date || date === member.leftDate}>
          {hasDate ? 'Modifier la date' : 'Désactiver à cette date'}
        </Btn>
        {(hasDate || legacyInactive) && (
          <Btn kind="soft" onClick={() => apply(null)}>
            Réactiver
          </Btn>
        )}
      </div>
    </div>
  );
}
