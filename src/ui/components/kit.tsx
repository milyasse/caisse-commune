/** Composants d'interface réutilisables (mobile d'abord). */
import React, { useEffect, useState, type ReactNode } from 'react';
import { formatMAD, parseMAD } from '../../domain/money.ts';
import { addMonths, periodLabel, todayISO } from '../../domain/dates.ts';
import type { ContributionStatus, Period } from '../../domain/types.ts';
import { DomainError } from '../../domain/commands.ts';

export const cx = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(' ');

export function Money({ c, tone, big }: { c: number; tone?: 'auto' | 'pos' | 'neg' | 'muted'; big?: boolean }) {
  const t = tone === 'auto' ? (c < 0 ? 'neg' : 'pos') : tone;
  return <span className={cx('money', t && `t-${t}`, big && 'big')}>{formatMAD(c)}</span>;
}

export function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div className={cx('card', onClick && 'tap', className)} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}>
      {children}
    </div>
  );
}

export function Kpi({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'pos' | 'warn' | 'neg'; hint?: string }) {
  return (
    <div className={cx('kpi', tone && `k-${tone}`)}>
      <div className="kpi-l">{label}</div>
      <div className="kpi-v">{value}</div>
      {hint && <div className="kpi-h">{hint}</div>}
    </div>
  );
}

const ST: Record<ContributionStatus, [string, string]> = { paye: ['Payé', 'ok'], partiel: ['Partiel', 'warn'], non_paye: ['Non payé', 'bad'] };
export function StatusBadge({ status, late }: { status: ContributionStatus; late?: boolean }) {
  const [l, t] = ST[status];
  return (
    <span className={cx('badge', `b-${late && status !== 'paye' ? 'bad' : t}`)}>
      {l}
      {late && status !== 'paye' ? ' · retard' : ''}
    </span>
  );
}
export const Badge = ({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'muted' | 'info'; children: ReactNode }) => <span className={cx('badge', `b-${tone}`)}>{children}</span>;

export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="pp">
      <button className="icon-btn" aria-label="Mois précédent" onClick={() => onChange(addMonths(value, -1))}>
        <Icon name="left" />
      </button>
      <label className="pp-label">
        {periodLabel(value)}
        <input type="month" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label="Choisir le mois" />
      </label>
      <button className="icon-btn" aria-label="Mois suivant" onClick={() => onChange(addMonths(value, 1))}>
        <Icon name="right" />
      </button>
    </div>
  );
}

export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    document.body.classList.add('noscroll');
    return () => (window.removeEventListener('keydown', k), document.body.classList.remove('noscroll'));
  }, [onClose]);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-h">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer">
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet-b">{children}</div>
        {footer && <div className="sheet-f">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string }) {
  return (
    <label className="field">
      <span className="field-l">{label}</span>
      {children}
      {error ? <span className="field-e">{error}</span> : hint ? <span className="field-h">{hint}</span> : null}
    </label>
  );
}

/** Saisie de montant : clavier numérique, virgule acceptée, valeur en centimes. */
export function MoneyInput({ value, onChange, autoFocus }: { value: number | null; onChange: (c: number | null) => void; autoFocus?: boolean }) {
  const [txt, setTxt] = useState(value === null ? '' : (value / 100).toFixed(2).replace('.', ','));
  useEffect(() => {
    const cur = parseMAD(txt);
    if (cur !== value) setTxt(value === null ? '' : (value / 100).toFixed(2).replace('.', ','));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="money-in">
      <input inputMode="decimal" autoFocus={autoFocus} placeholder="0,00" value={txt} onChange={(e) => (setTxt(e.target.value), onChange(parseMAD(e.target.value)))} onFocus={(e) => e.target.select()} />
      <span>MAD</span>
    </div>
  );
}

export const DateInput = ({ value, onChange, max = todayISO() }: { value: string; onChange: (d: string) => void; max?: string }) => (
  <input type="date" value={value} max={max} onChange={(e) => onChange(e.target.value)} />
);

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map(([v, l]) => (
        <button key={v} role="tab" aria-selected={v === value} className={cx(v === value && 'on')} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Btn({ children, onClick, kind = 'primary', disabled, full, type = 'button' }: { children: ReactNode; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger' | 'soft'; disabled?: boolean; full?: boolean; type?: 'button' | 'submit' }) {
  return (
    <button type={type} className={cx('btn', `btn-${kind}`, full && 'full')} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

// ---------------------------------------------------------------- Toasts & dialogues
type ToastT = { id: number; msg: string; tone: 'ok' | 'bad' };
let toastFn: (t: Omit<ToastT, 'id'>) => void = () => {};
export const toast = (msg: string, tone: 'ok' | 'bad' = 'ok') => toastFn({ msg, tone });
export function errorMessage(e: unknown) {
  return e instanceof DomainError ? e.message : e instanceof Error ? e.message : String(e);
}
export function Toasts() {
  const [items, setItems] = useState<ToastT[]>([]);
  useEffect(() => {
    toastFn = (t) => {
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { ...t, id }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 3500);
    };
  }, []);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={cx('toast', `toast-${t.tone}`)}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

type Ask = { title: string; message: string; confirm: string; danger?: boolean; reason?: boolean; resolve: (r: string | false) => void };
let askFn: (a: Ask) => void = () => {};
/** Confirmation (avec motif facultatif). Résout le motif saisi, '' si pas de motif, false si annulé. */
export const confirmDialog = (o: Omit<Ask, 'resolve'>) => new Promise<string | false>((resolve) => askFn({ ...o, resolve }));
export function Dialogs() {
  const [a, setA] = useState<Ask | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    askFn = (x) => (setReason(''), setA(x));
  }, []);
  if (!a) return null;
  const close = (r: string | false) => (a.resolve(r), setA(null));
  return (
    <div className="sheet-bg center" onClick={() => close(false)}>
      <div className="dialog" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{a.title}</h2>
        <p>{a.message}</p>
        {a.reason && (
          <Field label="Motif (obligatoire)">
            <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. : erreur de saisie" />
          </Field>
        )}
        <div className="row-end">
          <Btn kind="ghost" onClick={() => close(false)}>
            Annuler
          </Btn>
          <Btn kind={a.danger ? 'danger' : 'primary'} disabled={a.reason && reason.trim().length < 3} onClick={() => close(a.reason ? reason.trim() : '')}>
            {a.confirm}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Icônes (traits simples, 24px)
const PATHS: Record<string, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  users: 'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  out: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  in: 'M12 15V3M7 8l5-5 5 5M4 21h16',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14h.01',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6L6 18M6 6l12 12',
  left: 'M15 18l-6-6 6-6',
  right: 'M9 18l6-6-6-6',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  check: 'M20 6L9 17l-5-5',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  sync: 'M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M3 21v-5h5',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
};
export const Icon = ({ name, size = 20 }: { name: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={PATHS[name]} />
  </svg>
);

// ---------------------------------------------------------------- Graphiques SVG
export function BarChart({ data }: { data: { label: string; a: number; b: number }[] }) {
  const W = 340,
    H = 150,
    pad = 22;
  const max = Math.max(1, ...data.flatMap((d) => [d.a, d.b]));
  const bw = (W - pad) / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} className="chart" role="img" aria-label="Cotisations encaissées et dépenses par mois">
      <line x1={pad} x2={W} y1={H} y2={H} className="axis" />
      {data.map((d, i) => {
        const x = pad + i * bw;
        const ha = (d.a / max) * (H - 8);
        const hb = (d.b / max) * (H - 8);
        return (
          <g key={i}>
            <rect x={x + bw * 0.14} y={H - ha} width={bw * 0.34} height={ha} rx={2} className="bar-a">
              <title>{`${d.label} — encaissé ${formatMAD(d.a)}`}</title>
            </rect>
            <rect x={x + bw * 0.52} y={H - hb} width={bw * 0.34} height={hb} rx={2} className="bar-b">
              <title>{`${d.label} — dépenses ${formatMAD(d.b)}`}</title>
            </rect>
            <text x={x + bw / 2} y={H + 13} className="tick" textAnchor="middle">
              {d.label}
            </text>
          </g>
        );
      })}
      <text x={0} y={10} className="tick">
        max {formatMAD(max)}
      </text>
    </svg>
  );
}

export function LineChart({ data }: { data: { label: string; v: number }[] }) {
  const W = 340,
    H = 130,
    pad = 14;
  const vals = data.map((d) => d.v);
  const min = Math.min(0, ...vals),
    max = Math.max(1, ...vals);
  const x = (i: number) => pad + (i * (W - 2 * pad)) / Math.max(1, data.length - 1);
  const y = (v: number) => pad + (H - 2 * pad) * (1 - (v - min) / (max - min || 1));
  const d = data.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} className="chart" role="img" aria-label="Évolution du solde de fin de mois">
      {min < 0 && <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="zero" />}
      <path d={`${d}L${x(data.length - 1)},${y(min)}L${x(0)},${y(min)}Z`} className="area" />
      <path d={d} className="line" />
      {data.map((p, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(p.v)} r={3} className={p.v < 0 ? 'dot neg' : 'dot'}>
            <title>{`${p.label} : ${formatMAD(p.v)}`}</title>
          </circle>
          <text x={x(i)} y={H + 13} className="tick" textAnchor="middle">
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
