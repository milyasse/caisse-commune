import React, { useMemo, useState } from 'react';
import { backupJson, configureSupabase, resetDemo, restoreJson, run, startReal, syncNow, useStore } from '../../store/store.ts';
import { addCategory, addMember, closeMonth, reopenMonth, setMemberAmount, updateMember, updateSettings } from '../../domain/commands.ts';
import { amountFor, contributionRows, memberStats, monthSummary } from '../../domain/finance.ts';
import { addMonths, fmtDate, periodLabel, periodOf, periodStart, periodYear, todayISO } from '../../domain/dates.ts';
import { formatMAD } from '../../domain/money.ts';
import type { Member, Period } from '../../domain/types.ts';
import { annualReportHtml, monthlyReportHtml, operationsCsv, workbookFor } from '../../io/exports.ts';
import { applyImport, buildPreview, earliestDate, guessMapping, norm, type Grid, type Mapping } from '../../io/importer.ts';
import { emptyState } from '../../domain/seed.ts';
import { readCsv, readXlsx } from '../../io/xlsx.ts';
import { signIn } from '../../store/supabase.ts';
import { PREVIEW, printHtml, saveFile } from '../download.ts';
import { Badge, Btn, Card, confirmDialog, DateInput, Empty, errorMessage, Field, Icon, MoneyInput, Sheet, StatusBadge, toast } from '../components/kit.tsx';
import { AuditTrail } from './History.tsx';

type Panel = null | 'groupe' | 'membres' | 'categories' | 'cloture' | 'exports' | 'import' | 'sauvegarde' | 'sync' | 'utilisateur' | 'audit';

export function Settings({ period }: { period: Period }) {
  const { state: s, sync, session, supabase } = useStore();
  const [panel, setPanel] = useState<Panel>(null);
  const items: [Panel, string, string, string][] = [
    ['membres', 'users', 'Membres', `${s.members.filter((m) => m.active).length} actif(s) sur ${s.members.length}`],
    ['groupe', 'wallet', 'Caisse et solde initial', `${formatMAD(s.settings.openingBalance)} au ${fmtDate(s.settings.openingDate)}`],
    ['cloture', 'lock', 'Clôture mensuelle', `${s.closures.filter((c) => !c.reopened).length} mois clôturé(s)`],
    ['exports', 'file', 'Rapports et exports', 'Excel, PDF, CSV'],
    ['import', 'in', 'Importer l’ancien fichier Excel', 'Aperçu et validation avant import'],
    ['categories', 'out', 'Catégories de dépenses', `${s.categories.length} catégories`],
    ['sauvegarde', 'check', 'Sauvegarde et données', s.settings.isDemo ? 'Données de démonstration' : 'Données réelles'],
    ['sync', 'sync', 'Synchronisation multi-appareils', session ? `Connecté · ${sync.outbox.length} en attente` : supabase ? 'Configurée, non connectée' : 'Désactivée (données sur cet appareil)'],
    ['utilisateur', 'users', 'Utilisateur', `${s.settings.currentUser} · ${s.settings.currentRole === 'admin' ? 'administrateur' : 'utilisateur autorisé'}`],
    ['audit', 'clock', 'Journal des modifications', `${s.audit.length} entrées`],
  ];
  return (
    <div className="screen">
      <div className="list">
        {items.map(([k, ic, t, sub]) => (
          <button key={k} className="op" onClick={() => setPanel(k)}>
            <span className="op-ic neutral">
              <Icon name={ic} size={18} />
            </span>
            <span className="op-t">
              <b>{t}</b>
              <small>{sub}</small>
            </span>
            <Icon name="right" />
          </button>
        ))}
      </div>
      <p className="note">Caisse commune · version 0.4 · montants en MAD · dates JJ/MM/AAAA</p>
      {panel === 'membres' && <MembersPanel onClose={() => setPanel(null)} period={period} />}
      {panel === 'groupe' && <GroupPanel onClose={() => setPanel(null)} />}
      {panel === 'cloture' && <ClosurePanel onClose={() => setPanel(null)} />}
      {panel === 'exports' && <ExportPanel onClose={() => setPanel(null)} period={period} />}
      {panel === 'import' && <ImportPanel onClose={() => setPanel(null)} />}
      {panel === 'categories' && <CategoryPanel onClose={() => setPanel(null)} />}
      {panel === 'sauvegarde' && <BackupPanel onClose={() => setPanel(null)} />}
      {panel === 'sync' && <SyncPanel onClose={() => setPanel(null)} />}
      {panel === 'utilisateur' && <UserPanel onClose={() => setPanel(null)} />}
      {panel === 'audit' && (
        <Sheet title="Journal des modifications" onClose={() => setPanel(null)}>
          <AuditTrail items={[...s.audit].reverse().slice(0, 150)} />
        </Sheet>
      )}
    </div>
  );
}

const tryRun = (fn: Parameters<typeof run>[0], ok: string) => {
  try {
    run(fn);
    toast(ok);
    return true;
  } catch (e) {
    toast(errorMessage(e), 'bad');
    return false;
  }
};

// ---------------------------------------------------------------- Membres
function MembersPanel({ onClose, period }: { onClose: () => void; period: Period }) {
  const { state: s } = useStore();
  const [edit, setEdit] = useState<Member | 'new' | null>(null);
  const year = periodYear(period);
  if (edit) return <MemberSheet member={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} year={year} />;
  return (
    <Sheet title="Membres" onClose={onClose} footer={<Btn full onClick={() => setEdit('new')}>+ Ajouter un membre</Btn>}>
      {s.members.length === 0 && <Empty>Aucun membre.</Empty>}
      {[...s.members]
        .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'fr'))
        .map((m) => {
          const st = memberStats(s, m.id, `${year}-01`, periodOf(todayISO()));
          return (
            <button key={m.id} className="op" onClick={() => setEdit(m)}>
              <span className="avatar">{m.name.slice(0, 1)}</span>
              <span className="op-t">
                <b>
                  {m.name} {!m.active && <Badge tone="muted">inactif</Badge>}
                </b>
                <small>
                  {formatMAD(amountFor(s, m.id, periodOf(todayISO())))}/mois · reste {year} : {formatMAD(st.remainingInRange)}
                </small>
              </span>
              <Icon name="right" />
            </button>
          );
        })}
    </Sheet>
  );
}

function MemberSheet({ member, onClose, year }: { member?: Member; onClose: () => void; year: number }) {
  const { state: s } = useStore();
  const [name, setName] = useState(member?.name ?? '');
  const [joinDate, setJoinDate] = useState(member?.joinDate ?? todayISO());
  const [amount, setAmount] = useState<number | null>(member ? null : 400_00);
  const [from, setFrom] = useState(periodOf(todayISO()));

  if (!member)
    return (
      <Sheet
        title="Nouveau membre"
        onClose={onClose}
        footer={
          <Btn full onClick={() => amount !== null && tryRun((st, k) => addMember(st, k, { name, joinDate, defaultAmount: amount }), 'Membre ajouté') && onClose()}>
            Ajouter
          </Btn>
        }
      >
        <Field label="Nom complet">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Date d'adhésion">
          <DateInput value={joinDate} onChange={setJoinDate} max="2100-12-31" />
        </Field>
        <Field label="Cotisation mensuelle par défaut">
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
        <p className="note">Les cotisations du mois en cours seront générées automatiquement à l'ouverture suivante, ou depuis l'écran Cotisations.</p>
      </Sheet>
    );

  const st = memberStats(s, member.id, `${year}-01`, `${year}-12`);
  const all = memberStats(s, member.id, '0000-01', '9999-12');
  const rules = s.rules.filter((r) => r.memberId === member.id).sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  const history = s.contributions.filter((c) => c.memberId === member.id).sort((a, b) => b.period.localeCompare(a.period));
  const toggle = async () => {
    const ok = await confirmDialog({ title: member.active ? 'Désactiver ce membre ?' : 'Réactiver ce membre ?', message: member.active ? 'Plus aucune cotisation ne sera générée pour lui. Son historique est conservé.' : 'Ses cotisations seront de nouveau générées.', confirm: member.active ? 'Désactiver' : 'Réactiver', danger: member.active });
    if (ok !== false) tryRun((x, k) => updateMember(x, k, member.id, { active: !member.active }), member.active ? 'Membre désactivé' : 'Membre réactivé');
  };

  return (
    <Sheet title={member.name} onClose={onClose}>
      <div className="trio">
        <div>
          <span>Total cotisé</span>
          <b className="t-pos">{formatMAD(all.totalPaid)}</b>
        </div>
        <div>
          <span>Attendu {year}</span>
          {formatMAD(st.expectedInRange)}
        </div>
        <div>
          <span>Reste {year}</span>
          <b className={st.remainingInRange ? 't-warn' : ''}>{formatMAD(st.remainingInRange)}</b>
        </div>
      </div>
      <h4>Informations</h4>
      <Field label="Nom complet">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Date d'adhésion">
        <DateInput value={joinDate} onChange={setJoinDate} max="2100-12-31" />
      </Field>
      <div className="row-gap">
        <Btn kind="soft" onClick={() => tryRun((x, k) => updateMember(x, k, member.id, { name, joinDate }), 'Membre mis à jour')}>
          Enregistrer
        </Btn>
        <Btn kind={member.active ? 'danger' : 'soft'} onClick={toggle}>
          {member.active ? 'Désactiver' : 'Réactiver'}
        </Btn>
      </div>

      <h4>Montant mensuel</h4>
      <ul className="trail">
        {rules.map((r) => (
          <li key={r.id}>
            <b>{formatMAD(r.amount)}</b> à partir de {periodLabel(r.validFrom).toLowerCase()}
          </li>
        ))}
      </ul>
      <div className="two">
        <Field label="Nouveau montant">
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
        <Field label="À partir de">
          <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
      </div>
      <p className="note">Les mois précédents ne sont pas modifiés. Les mois suivants déjà générés, sans versement, sont alignés.</p>
      <Btn kind="soft" disabled={amount === null} onClick={() => amount !== null && tryRun((x, k) => setMemberAmount(x, k, member.id, amount, from), 'Montant mis à jour')}>
        Appliquer le nouveau montant
      </Btn>

      <h4>Historique des cotisations</h4>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Mois</th>
              <th className="n">Attendu</th>
              <th className="n">Versé</th>
              <th>Statut</th>
            </tr>
          </thead>
          <tbody>
            {history.map((c) => {
              const r = contributionRows(s, c.period).find((x) => x.contribution.id === c.id)!;
              return (
                <tr key={c.id}>
                  <td>{periodLabel(c.period)}</td>
                  <td className="n">{formatMAD(c.expected, false)}</td>
                  <td className="n">{formatMAD(r.paid, false)}</td>
                  <td>
                    <StatusBadge status={r.status} late={r.late} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Caisse
function GroupPanel({ onClose }: { onClose: () => void }) {
  const { state: s } = useStore();
  const [f, setF] = useState({ ...s.settings });
  return (
    <Sheet title="Caisse et solde initial" onClose={onClose} footer={<Btn full onClick={() => tryRun((x, k) => updateSettings(x, k, { groupName: f.groupName, openingBalance: f.openingBalance, openingDate: f.openingDate, dueDay: f.dueDay, largeExpenseThreshold: f.largeExpenseThreshold }), 'Paramètres enregistrés') && onClose()}>Enregistrer</Btn>}>
      <Field label="Nom de la caisse">
        <input value={f.groupName} onChange={(e) => setF({ ...f, groupName: e.target.value })} />
      </Field>
      <div className="two">
        <Field label="Solde initial">
          <MoneyInput value={f.openingBalance} onChange={(v) => setF({ ...f, openingBalance: v ?? 0 })} />
        </Field>
        <Field label="À la date du">
          <DateInput value={f.openingDate} onChange={(d) => setF({ ...f, openingDate: d })} />
        </Field>
      </div>
      <Field label="Date limite de cotisation" hint="0 = dernier jour du mois">
        <input type="number" inputMode="numeric" min={0} max={28} value={f.dueDay} onChange={(e) => setF({ ...f, dueDay: Math.max(0, Math.min(28, Number(e.target.value) || 0)) })} />
      </Field>
      <Field label="Seuil d'alerte « dépense importante »">
        <MoneyInput value={f.largeExpenseThreshold} onChange={(v) => setF({ ...f, largeExpenseThreshold: v ?? 0 })} />
      </Field>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Clôture
function ClosurePanel({ onClose }: { onClose: () => void }) {
  const { state: s } = useStore();
  const first = periodOf(s.settings.openingDate);
  const cur = periodOf(todayISO());
  const months: Period[] = [];
  for (let p = first; p < cur; p = addMonths(p, 1)) months.push(p);
  const next = months.find((p) => !s.closures.some((c) => c.period === p && !c.reopened));
  const close = async (p: Period) => {
    const m = monthSummary(s, p);
    const ok = await confirmDialog({ title: `Clôturer ${periodLabel(p)} ?`, message: `Solde de clôture : ${formatMAD(m.closing)}. Il deviendra le solde d'ouverture de ${periodLabel(addMonths(p, 1)).toLowerCase()} et les opérations datées de ce mois seront verrouillées.${m.remaining ? ` Il reste ${formatMAD(m.remaining)} à encaisser : les versements tardifs resteront possibles, datés du mois où ils sont reçus.` : ''}`, confirm: 'Clôturer' });
    if (ok !== false) tryRun((x, k) => closeMonth(x, k, p), `${periodLabel(p)} clôturé`);
  };
  const reopen = async (p: Period) => {
    const reason = await confirmDialog({ title: `Rouvrir ${periodLabel(p)} ?`, message: 'Les mois suivants clôturés seront aussi rouverts. Action tracée.', confirm: 'Rouvrir', danger: true, reason: true });
    if (reason !== false) tryRun((x, k) => reopenMonth(x, k, p, reason), 'Mois rouvert');
  };
  return (
    <Sheet title="Clôture mensuelle" onClose={onClose} footer={next ? <Btn full onClick={() => close(next)}>Clôturer {periodLabel(next)}</Btn> : undefined}>
      <p className="note">Les mois se clôturent dans l'ordre. Le solde de clôture est figé et reporté comme solde d'ouverture du mois suivant.</p>
      {[...months].reverse().map((p) => {
        const c = s.closures.find((x) => x.period === p && !x.reopened);
        const m = monthSummary(s, p);
        return (
          <div key={p} className="pay-line">
            <div>
              <b>{periodLabel(p)}</b>
              <div className="small muted">
                Ouverture {formatMAD(m.opening)} → clôture {formatMAD(m.closing)}
              </div>
            </div>
            {c ? (
              <div className="row-gap">
                <Badge tone={c.closingBalance === m.closing ? 'ok' : 'bad'}>
                  <Icon name="lock" size={12} /> {c.closingBalance === m.closing ? 'clôturé' : 'écart !'}
                </Badge>
                {s.closures.filter((x) => !x.reopened).at(-1)?.period === p && (
                  <button className="link" onClick={() => reopen(p)}>
                    Rouvrir
                  </button>
                )}
              </div>
            ) : (
              <Badge tone="muted">ouvert</Badge>
            )}
          </div>
        );
      })}
      {months.length === 0 && <Empty>Aucun mois terminé depuis le solde initial.</Empty>}
    </Sheet>
  );
}

// ---------------------------------------------------------------- Exports
function ExportPanel({ onClose, period }: { onClose: () => void; period: Period }) {
  const { state: s } = useStore();
  const [month, setMonth] = useState(period);
  const year = periodYear(month);
  const slug = s.settings.isDemo ? '-DEMO' : '';
  const wrap = (fn: () => unknown) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };
  return (
    <Sheet title="Rapports et exports" onClose={onClose}>
      {PREVIEW && <p className="note t-warn">Dans cet aperçu en ligne, les fichiers ne peuvent pas être téléchargés. Ces boutons fonctionnent dans l'application installée.</p>}
      <Field label="Période">
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </Field>
      <div className="export-grid">
        <button className="pick-btn" onClick={wrap(() => saveFile(`caisse-${year}${slug}.xlsx`, workbookFor(s, year, month), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))}>
          <Icon name="file" size={24} />
          <b>Excel {year}</b>
          <span>Tableau annuel avec formules, rapport mensuel, versements, dépenses</span>
        </button>
        <button className="pick-btn" onClick={wrap(() => printHtml(monthlyReportHtml(s, month)))}>
          <Icon name="file" size={24} />
          <b>PDF mensuel</b>
          <span>{periodLabel(month)} — via « Enregistrer en PDF »</span>
        </button>
        <button className="pick-btn" onClick={wrap(() => printHtml(annualReportHtml(s, year)))}>
          <Icon name="file" size={24} />
          <b>PDF annuel</b>
          <span>Rapport {year}</span>
        </button>
        <button className="pick-btn" onClick={wrap(() => saveFile(`operations${slug}.csv`, operationsCsv(s), 'text/csv;charset=utf-8'))}>
          <Icon name="file" size={24} />
          <b>CSV</b>
          <span>Toutes les opérations</span>
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Import
function ImportPanel({ onClose }: { onClose: () => void }) {
  const { state: s } = useStore();
  const [sheets, setSheets] = useState<{ name: string; grid: Grid }[]>([]);
  const [idx, setIdx] = useState(0);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [checked, setChecked] = useState(false);
  const [withDupes, setWithDupes] = useState(false);
  const [replaceDemo, setReplaceDemo] = useState(s.settings.isDemo);
  const [groupName, setGroupName] = useState('Caisse commune');
  const grid = sheets[idx]?.grid ?? [];
  const today = todayISO();

  /** État sur lequel l'import s'applique : la caisse actuelle, ou une caisse vide qui démarre au 1er mois du fichier. */
  const base = useMemo(() => {
    if (!mapping || !replaceDemo) return s;
    const e = emptyState(today);
    e.settings.openingDate = '1900-01-01';
    const first = earliestDate(buildPreview(grid, mapping, e, today));
    e.settings.openingDate = first ? periodStart(periodOf(first)) : `${today.slice(0, 4)}-01-01`;
    e.settings.isDemo = false;
    return e;
  }, [s, mapping, replaceDemo, grid, today]);
  const lines = useMemo(() => (checked && mapping ? buildPreview(grid, mapping, base, today) : null), [checked, mapping, grid, base, today]);

  const load = async (file: File) => {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const sh = /\.(csv|tsv|txt)$/i.test(file.name) ? [{ name: file.name, grid: readCsv(new TextDecoder().decode(buf)) }] : (await readXlsx(buf)).filter((x) => x.grid.some((r) => r?.some((c) => c !== null && c !== undefined && c !== '')));
      if (!sh.length) throw new Error('Le fichier ne contient aucune feuille remplie.');
      setSheets(sh);
      setIdx(0);
      setMapping(guessMapping(sh[0].grid, s));
      setChecked(false);
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };
  const remap = (m: Mapping) => (setMapping(m), setChecked(false));
  const header = (mapping ? grid[mapping.headerRow] : []) ?? [];
  const width = Math.max(header.length, ...grid.slice(0, 20).map((r) => r?.length ?? 0));
  const colLabel = (i: number) => `${String.fromCharCode(65 + (i % 26))} · ${String(header[i] ?? '').slice(0, 26) || '(sans titre)'}`;
  const colSelect = (value: number | undefined, on: (v: number | undefined) => void) => (
    <select value={value ?? ''} onChange={(e) => on(e.target.value === '' ? undefined : Number(e.target.value))}>
      <option value="">— aucune —</option>
      {Array.from({ length: width }, (_, i) => (
        <option key={i} value={i}>
          {colLabel(i)}
        </option>
      ))}
    </select>
  );
  const ok = lines?.filter((l) => !l.errors.length && (withDupes || !l.duplicate)) ?? [];
  const newMembers = [...new Set(ok.filter((l) => l.newMember).map((l) => l.memberName!))];
  const first = lines ? earliestDate(lines) : undefined;
  const beforeOpening = !replaceDemo && lines?.some((l) => l.errors.some((e) => e.startsWith('Date antérieure')));

  const doImport = async () => {
    if (!lines || !mapping) return;
    const msg = `${ok.length} opération(s) seront ajoutées${newMembers.length ? ` et ${newMembers.length} membre(s) créé(s) (${newMembers.join(', ')})` : ''}.` + (replaceDemo ? ' Les données de démonstration seront remplacées.' : ' Les données existantes ne sont ni modifiées ni supprimées.');
    if ((await confirmDialog({ title: 'Importer ?', message: msg, confirm: 'Importer', danger: replaceDemo })) === false) return;
    try {
      if (replaceDemo) startReal(groupName, 0, base.settings.openingDate);
      let res: ReturnType<typeof applyImport> | undefined;
      run((st, k) => (res = applyImport(st, k, lines, { includeDuplicates: withDupes })).state);
      toast(`${res!.imported} opération(s) importée(s)${res!.membersCreated.length ? `, ${res!.membersCreated.length} membre(s) créé(s)` : ''}`);
      if (res!.errors.length) toast(`Lignes refusées : ${res!.errors.map((e) => e.row).join(', ')}`, 'bad');
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  const gridMembers = mapping?.layout === 'grid' ? Object.entries(mapping.memberCols) : [];
  return (
    <Sheet title="Importer l'ancien fichier Excel" onClose={onClose} footer={lines ? <Btn full disabled={!ok.length} onClick={doImport}>Importer {ok.length} opération(s)</Btn> : undefined}>
      <label className="btn btn-soft full">
        <Icon name="in" /> Choisir un fichier (.xlsx ou .csv)
        <input type="file" hidden accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
      </label>
      {!sheets.length && (
        <div className="note">
          <p>
            Formats reconnus, en-têtes en français ou en arabe : <b>une ligne par mois</b> avec une colonne par membre (feuille « المساهمات »), <b>une ligne par dépense</b> (ex. feuille « المصاريف » avec les colonnes « شهر 3, شهر 4… »), ou une ligne par versement.
          </p>
          <p>Depuis Google Sheets sur iPhone : ⋮ › Partager et exporter › Enregistrer sous › Excel (.xlsx), puis choisissez le fichier ici.</p>
        </div>
      )}
      {sheets.length > 1 && (
        <Field label="Feuille">
          <select value={idx} onChange={(e) => (setIdx(+e.target.value), remap(guessMapping(sheets[+e.target.value].grid, s)))}>
            {sheets.map((sh, i) => (
              <option key={i} value={i}>
                {sh.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {mapping && (
        <>
          {s.settings.isDemo && (
            <Card className="callout">
              <label className="check">
                <input type="checkbox" checked={replaceDemo} onChange={(e) => (setReplaceDemo(e.target.checked), setChecked(false))} /> Remplacer les données de démonstration par ce fichier
              </label>
              {replaceDemo && (
                <Field label="Nom de la caisse">
                  <input value={groupName} onChange={(e) => setGroupName(e.target.value)} />
                </Field>
              )}
            </Card>
          )}
          <h4>Aperçu du fichier</h4>
          <div className="table-wrap" dir="auto">
            <table className="grid small">
              <tbody>
                {grid.slice(mapping.headerRow, mapping.headerRow + 7).map((r, i) => (
                  <tr key={i} className={i === 0 ? 'tot' : ''}>
                    {Array.from({ length: Math.min(12, width) }, (_, j) => (
                      <td key={j}>{String(r?.[j] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4>Correspondance des colonnes</h4>
          <Field label="Disposition">
            <select
              value={mapping.layout}
              onChange={(e) => {
                const g = guessMapping(grid, s);
                const v = e.target.value as Mapping['layout'];
                remap(g.layout === v ? g : v === 'grid' ? { layout: 'grid', headerRow: g.headerRow, periodCol: 0, memberCols: {} } : ({ layout: v, headerRow: g.headerRow, columns: {} } as Mapping));
              }}
            >
              <option value="grid">Une ligne par mois, une colonne par membre</option>
              <option value="payments">Une ligne par versement</option>
              <option value="expenses">Une ligne par dépense</option>
            </select>
          </Field>
          <Field label="Ligne des titres de colonnes">
            <input type="number" inputMode="numeric" min={1} value={mapping.headerRow + 1} onChange={(e) => remap({ ...mapping, headerRow: Math.max(0, +e.target.value - 1) })} />
          </Field>
          {mapping.layout === 'grid' && (
            <>
              <div className="two">
                <Field label="Année">{colSelect(mapping.yearCol, (v) => remap({ ...mapping, yearCol: v }))}</Field>
                <Field label="Mois">{colSelect(mapping.periodCol, (v) => remap({ ...mapping, periodCol: v ?? 0 }))}</Field>
              </div>
              <Field label="Date de versement (sinon fin du mois)">{colSelect(mapping.dateCol, (v) => remap({ ...mapping, dateCol: v }))}</Field>
              <Field label="Dépenses du mois" hint="Laissez « aucune » si vous importez la feuille détaillée des dépenses, pour ne pas compter deux fois.">
                {colSelect(mapping.expenseCol, (v) => remap({ ...mapping, expenseCol: v }))}
              </Field>
              <h4>Membres</h4>
              {gridMembers.map(([col, name]) => {
                const existing = base.members.find((m) => norm(m.name) === norm(name));
                const headerName = String(header[+col] ?? '').trim() || name;
                return (
                  <Field key={col} label={`Colonne ${colLabel(+col)}`}>
                    <select
                      value={existing ? existing.name : '__new__'}
                      onChange={(e) => {
                        const mc = { ...mapping.memberCols };
                        if (e.target.value === '__skip__') delete mc[+col];
                        else mc[+col] = e.target.value === '__new__' ? headerName : e.target.value;
                        remap({ ...mapping, memberCols: mc });
                      }}
                    >
                      <option value="__new__">Nouveau membre « {headerName} »</option>
                      {base.members.map((m) => (
                        <option key={m.id} value={m.name}>
                          {m.name}
                        </option>
                      ))}
                      <option value="__skip__">Ignorer cette colonne</option>
                    </select>
                  </Field>
                );
              })}
              <Field label="Ajouter une colonne membre">
                <select
                  value=""
                  onChange={(e) => e.target.value !== '' && remap({ ...mapping, memberCols: { ...mapping.memberCols, [+e.target.value]: String(header[+e.target.value] ?? '').trim() || `Membre ${+e.target.value + 1}` } })}
                >
                  <option value="">—</option>
                  {Array.from({ length: width }, (_, i) => i)
                    .filter((i) => mapping.memberCols[i] === undefined)
                    .map((i) => (
                      <option key={i} value={i}>
                        {colLabel(i)}
                      </option>
                    ))}
                </select>
              </Field>
            </>
          )}
          {mapping.layout === 'payments' &&
            (['date', 'member', 'period', 'amount', 'comment'] as const).map((k) => (
              <Field key={k} label={{ date: 'Date du versement', member: 'Membre', period: 'Mois concerné', amount: 'Montant', comment: 'Commentaire' }[k]}>
                {colSelect(mapping.columns[k], (v) => remap({ ...mapping, columns: { ...mapping.columns, [k]: v } }))}
              </Field>
            ))}
          {mapping.layout === 'expenses' && (
            <>
              {mapping.amountCols?.length ? <p className="note">Montant lu dans les colonnes {mapping.amountCols.map((c) => String(header[c] ?? '')).join(', ')}.</p> : null}
              {(['date', 'description', 'payer', 'category', 'beneficiary', ...(mapping.amountCols?.length ? [] : ['amount']), 'comment'] as const).map((k) => (
                <Field key={k} label={{ date: 'Date du paiement', category: 'Catégorie', description: 'Description', beneficiary: 'Bénéficiaire', amount: 'Montant', comment: 'Commentaire', payer: 'Payé par' }[k as string] ?? k}>
                  {colSelect(mapping.columns[k as keyof typeof mapping.columns], (v) => remap({ ...mapping, columns: { ...mapping.columns, [k]: v } }))}
                </Field>
              ))}
            </>
          )}
          <Btn kind="soft" full onClick={() => setChecked(true)}>
            Contrôler les données
          </Btn>
        </>
      )}
      {lines && (
        <>
          <h4>Contrôle</h4>
          <div className="kpis three">
            <div className="mini">
              <span>Valides</span>
              <b className="t-pos">{lines.filter((l) => !l.errors.length && !l.duplicate).length}</b>
            </div>
            <div className="mini">
              <span>Doublons</span>
              <b className="t-warn">{lines.filter((l) => l.duplicate).length}</b>
            </div>
            <div className="mini">
              <span>Erreurs</span>
              <b className="t-neg">{lines.filter((l) => l.errors.length).length}</b>
            </div>
          </div>
          {replaceDemo && first && <p className="note">Nouvelle caisse « {groupName} » : solde initial 0,00 MAD au {fmtDate(base.settings.openingDate)}. Vous pourrez le modifier dans Paramètres › Caisse et solde initial.</p>}
          {newMembers.length > 0 && <p className="note">Membres créés : {newMembers.join(', ')}. Vous pourrez les renommer ensuite sans perdre l'historique.</p>}
          {beforeOpening && first && (
            <Card className="callout">
              <p>Le fichier commence le {fmtDate(first)}, avant le solde initial de la caisse ({fmtDate(s.settings.openingDate)}).</p>
              <Btn kind="soft" onClick={() => tryRun((x, k) => updateSettings(x, k, { openingDate: periodStart(periodOf(first)) }), 'Date du solde initial déplacée')}>
                Démarrer la caisse au {fmtDate(periodStart(periodOf(first)))}
              </Btn>
            </Card>
          )}
          <label className="check">
            <input type="checkbox" checked={withDupes} onChange={(e) => setWithDupes(e.target.checked)} /> Importer aussi les doublons potentiels
          </label>
          <div className="table-wrap">
            <table className="grid small">
              <thead>
                <tr>
                  <th>Ligne</th>
                  <th>Type</th>
                  <th>Date</th>
                  <th>Qui / quoi</th>
                  <th className="n">Montant</th>
                  <th>Contrôle</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className={l.errors.length ? 'row-bad' : l.duplicate ? 'row-warn' : ''}>
                    <td>{l.row}</td>
                    <td>{l.kind === 'payment' ? 'Cotis.' : 'Dépense'}</td>
                    <td>{fmtDate(l.date)}</td>
                    <td dir="auto">{l.kind === 'payment' ? `${l.memberName ?? ''} ${l.period ? '· ' + l.period : ''}` : l.description}</td>
                    <td className="n">{l.amount !== undefined ? formatMAD(l.amount, false) : ''}</td>
                    <td className="wrap">{[...l.errors, ...l.warnings.filter((w) => !w.startsWith('Nouveau membre'))].join(' ; ') || 'OK'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- Catégories
function CategoryPanel({ onClose }: { onClose: () => void }) {
  const { state: s } = useStore();
  const [name, setName] = useState('');
  return (
    <Sheet title="Catégories de dépenses" onClose={onClose}>
      <ul className="trail">
        {s.categories.map((c) => (
          <li key={c.id}>{c.name}</li>
        ))}
      </ul>
      <Field label="Nouvelle catégorie">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Btn kind="soft" disabled={!name.trim()} onClick={() => tryRun((x, k) => addCategory(x, k, name), 'Catégorie ajoutée') && setName('')}>
        Ajouter
      </Btn>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Sauvegarde
function BackupPanel({ onClose }: { onClose: () => void }) {
  const { state: s } = useStore();
  const [name, setName] = useState('Caisse commune');
  const [bal, setBal] = useState<number | null>(0);
  const [date, setDate] = useState(todayISO().slice(0, 8) + '01');
  const restore = async (file: File) => {
    const ok = await confirmDialog({ title: 'Restaurer cette sauvegarde ?', message: 'Les données actuelles de cet appareil seront remplacées par celles du fichier. Pensez à sauvegarder avant.', confirm: 'Restaurer', danger: true });
    if (ok === false) return;
    try {
      restoreJson(await file.text());
      toast('Sauvegarde restaurée');
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };
  const real = async () => {
    const ok = await confirmDialog({ title: 'Commencer avec des données réelles ?', message: 'Les données de démonstration seront effacées de cet appareil. Vous pourrez ensuite ajouter vos membres ou importer votre fichier Excel.', confirm: 'Commencer', danger: true });
    if (ok !== false) startReal(name, bal ?? 0, date), toast('Caisse réelle créée'), onClose();
  };
  return (
    <Sheet title="Sauvegarde et données" onClose={onClose}>
      <p>
        Données actuelles : {s.settings.isDemo ? <Badge tone="warn">démonstration (fictives)</Badge> : <Badge tone="ok">réelles</Badge>}
      </p>
      <h4>Sauvegarde</h4>
      <div className="row-gap wrap">
        <Btn kind="soft" onClick={() => saveFile(`sauvegarde-caisse-${todayISO()}${s.settings.isDemo ? '-DEMO' : ''}.json`, backupJson(), 'application/json').catch((e) => toast(errorMessage(e), 'bad'))}>
          Télécharger une sauvegarde
        </Btn>
        <label className="btn btn-ghost">
          Restaurer…
          <input type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
        </label>
      </div>
      <p className="note">La sauvegarde contient toutes les opérations, membres, justificatifs et le journal. Conservez-la hors du téléphone (Drive, e-mail…).</p>
      {s.settings.isDemo ? (
        <>
          <h4>Passer aux données réelles</h4>
          <Field label="Nom de la caisse">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="two">
            <Field label="Solde initial en caisse">
              <MoneyInput value={bal} onChange={setBal} />
            </Field>
            <Field label="À la date du">
              <DateInput value={date} onChange={setDate} />
            </Field>
          </div>
          <Btn onClick={real}>Commencer avec mes données</Btn>
        </>
      ) : null}
      <h4>Démonstration</h4>
      <Btn
        kind="ghost"
        onClick={async () => {
          const ok = await confirmDialog({ title: 'Recharger la démonstration ?', message: 'Toutes les données de cet appareil seront remplacées par les données fictives.', confirm: 'Recharger', danger: true });
          if (ok !== false) resetDemo(), toast('Démonstration réinitialisée'), onClose();
        }}
      >
        Réinitialiser les données de démonstration
      </Btn>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Synchronisation
function SyncPanel({ onClose }: { onClose: () => void }) {
  const { supabase, session, sync, syncing, online } = useStore();
  const [url, setUrl] = useState(supabase?.url ?? '');
  const [key, setKey] = useState(supabase?.anonKey ?? '');
  const [email, setEmail] = useState(session?.email ?? '');
  const [pwd, setPwd] = useState('');
  const connect = async () => {
    try {
      const cfg = { url: url.replace(/\/$/, ''), anonKey: key.trim() };
      const sess = await signIn(cfg, email, pwd);
      configureSupabase(cfg, sess);
      toast('Connecté — synchronisation en cours');
      setPwd('');
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };
  return (
    <Sheet title="Synchronisation multi-appareils" onClose={onClose}>
      <p className="note">
        Sans synchronisation, les données restent uniquement sur cet appareil (pensez aux sauvegardes). Avec un projet Supabase (gratuit), plusieurs téléphones partagent les mêmes données ; les saisies hors ligne sont envoyées au retour du réseau, sans doublon.
      </p>
      <div className="row-gap wrap">
        <Badge tone={online ? 'ok' : 'warn'}>{online ? 'En ligne' : 'Hors ligne'}</Badge>
        <Badge tone={session ? 'ok' : 'muted'}>{session ? `Connecté : ${session.email}` : 'Non connecté'}</Badge>
        <Badge tone={sync.outbox.length ? 'warn' : 'muted'}>{sync.outbox.length} en attente</Badge>
      </div>
      {sync.lastSyncAt && <p className="small muted">Dernière synchro : {fmtDate(sync.lastSyncAt.slice(0, 10))} {sync.lastSyncAt.slice(11, 16)} UTC</p>}
      {sync.lastError && <p className="small t-neg">Erreur : {sync.lastError}</p>}
      {session ? (
        <div className="row-gap">
          <Btn kind="soft" disabled={syncing} onClick={() => syncNow()}>
            {syncing ? 'Synchronisation…' : 'Synchroniser maintenant'}
          </Btn>
          <Btn kind="ghost" onClick={() => configureSupabase(supabase, null)}>
            Se déconnecter
          </Btn>
        </div>
      ) : (
        <>
          <Field label="URL du projet Supabase">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
          </Field>
          <Field label="Clé publique (anon key)">
            <input value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Field label="E-mail">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Mot de passe">
            <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
          </Field>
          <Btn onClick={connect} disabled={!url || !key || !email || !pwd}>
            Se connecter et synchroniser
          </Btn>
          <p className="note">⚠️ Fonction livrée mais pas encore testée sur un vrai projet Supabase : faites un premier essai avec les données de démonstration.</p>
        </>
      )}
    </Sheet>
  );
}

function UserPanel({ onClose }: { onClose: () => void }) {
  const { state: s, session } = useStore();
  const [name, setName] = useState(s.settings.currentUser);
  return (
    <Sheet title="Utilisateur" onClose={onClose} footer={<Btn full onClick={() => tryRun((x, k) => updateSettings(x, k, { currentUser: name.trim() || 'Utilisateur' }), 'Enregistré') && onClose()}>Enregistrer</Btn>}>
      <Field label="Nom affiché dans l'historique">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Rôle sur cet appareil" hint={session ? 'Avec la synchronisation, les droits réels sont imposés par le serveur.' : 'Sans synchronisation, ce réglage local limite les actions (il ne remplace pas une authentification).'}>
        <select value={s.settings.currentRole} onChange={(e) => tryRun((x, k) => updateSettings(x, k, { currentRole: e.target.value as 'admin' | 'user' }), 'Rôle modifié')}>
          <option value="admin">Administrateur</option>
          <option value="user">Utilisateur autorisé (saisie uniquement)</option>
        </select>
      </Field>
    </Sheet>
  );
}
