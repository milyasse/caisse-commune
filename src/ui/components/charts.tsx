/**
 * Graphiques interactifs en SVG (sans bibliothèque) :
 *  - MonthBars      : encaissé / dépenses par mois — toucher un mois le sélectionne, la légende masque une série ;
 *  - BalanceLine    : solde de fin de mois — glisser le doigt pour lire chaque point ;
 *  - Donut          : répartition par catégorie — toucher une part (ou la légende) la met en avant ;
 *  - MemberProgress : versé / attendu par membre — toucher une ligne affiche le détail.
 */
import React, { useMemo, useRef, useState } from 'react';
import { formatMAD } from '../../domain/money.ts';
import type { Cents, Period } from '../../domain/types.ts';
import { cx } from './kit.tsx';

const short = (c: Cents) => {
  const v = c / 100;
  return Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k` : v.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
};

/** Graduations « rondes » couvrant [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (max === min) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(Math.round(v));
  if (ticks[ticks.length - 1] < max) ticks.push(Math.round(ticks[ticks.length - 1] + step));
  return ticks;
}

// ---------------------------------------------------------------- Barres mensuelles
export interface MonthDatum {
  period: Period;
  label: string;
  title?: string; // libellé long pour l'info-bulle (« Octobre 2026 »)
  a: Cents; // encaissé
  b: Cents; // dépenses
}

export function MonthBars({ data, selected, onSelect, colors = ['#0f6b3e', '#e8780c'], names = ['Encaissé', 'Dépenses'] }: { data: MonthDatum[]; selected?: Period; onSelect?: (p: Period) => void; colors?: [string, string]; names?: [string, string] }) {
  const [show, setShow] = useState<[boolean, boolean]>([true, true]);
  const W = 340, H = 170, L = 34, T = 8, B = 22;
  const max = Math.max(1, ...data.flatMap((d) => [show[0] ? d.a : 0, show[1] ? d.b : 0]));
  const ticks = niceTicks(0, max);
  const top = ticks[ticks.length - 1];
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const gw = (W - L) / data.length;
  const visible = [show[0], show[1]].filter(Boolean).length || 1;
  const bw = Math.min(14, (gw * 0.7) / visible);
  const sel = data.find((d) => d.period === selected) ?? data[data.length - 1];
  const bar = (x: number, v: number, color: string, faded: boolean, key: string) => {
    const h = Math.max(0, H - B - y(v));
    const r = Math.min(4, bw / 2, h);
    return (
      <path
        key={key}
        className="bar"
        d={`M${x},${H - B} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z`}
        fill={color}
        opacity={faded ? 0.35 : 1}
      />
    );
  };
  return (
    <div>
      {sel && (
        <div className="chart-tip" aria-live="polite">
          <span className="tip-title">{sel.title ?? sel.label}</span>
          <span>
            <i style={{ color: colors[0] }}>●</i> {names[0]} <b>{formatMAD(sel.a)}</b>
          </span>
          <span>
            <i style={{ color: colors[1] }}>●</i> {names[1]} <b>{formatMAD(sel.b)}</b>
          </span>
          <span>
            Solde du mois <b className={sel.a - sel.b < 0 ? 't-neg' : 't-pos'}>{(sel.a - sel.b >= 0 ? '+' : '') + formatMAD(sel.a - sel.b)}</b>
          </span>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`${names[0]} et ${names[1]} par mois`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W} y1={y(t)} y2={y(t)} className="grid-l" />
            <text x={L - 6} y={y(t) + 3.5} className="tick" textAnchor="end">
              {short(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x0 = L + i * gw;
          const on = d.period === sel?.period;
          let x = x0 + (gw - bw * visible - (visible - 1) * 2) / 2;
          const bars: React.ReactNode[] = [];
          if (show[0]) (bars.push(bar(x, d.a, colors[0], !on, 'a')), (x += bw + 2));
          if (show[1]) bars.push(bar(x, d.b, colors[1], !on, 'b'));
          return (
            <g
              key={d.period}
              role="button"
              tabIndex={0}
              aria-label={`${d.label} : ${names[0]} ${formatMAD(d.a)}, ${names[1]} ${formatMAD(d.b)}`}
              onClick={() => onSelect?.(d.period)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect?.(d.period)}
            >
              {on && <rect x={x0 + 1} y={T} width={gw - 2} height={H - B - T} rx={8} className="sel-band" />}
              {bars}
              <text x={x0 + gw / 2} y={H - 6} className={cx('tick', on && 'on')} textAnchor="middle">
                {d.label}
              </text>
              <rect x={x0} y={0} width={gw} height={H} className="hit" />
            </g>
          );
        })}
        <line x1={L} x2={W} y1={H - B} y2={H - B} className="axis" />
      </svg>
      <div className="legend" style={{ marginTop: 8 }}>
        {names.map((n, i) => (
          <button key={n} className={show[i] ? '' : 'off'} aria-pressed={show[i]} onClick={() => setShow((s) => (i === 0 ? [!s[0], s[1]] : [s[0], !s[1]]))}>
            <i style={{ background: colors[i] }} /> {n}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Courbe du solde
export function BalanceLine({ data, selected, onSelect, color = '#2f6fed' }: { data: { period: Period; label: string; title?: string; v: Cents }[]; selected?: Period; onSelect?: (p: Period) => void; color?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 340, H = 160, L = 38, R = 10, T = 14, B = 22;
  const vals = data.map((d) => d.v);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(1, ...vals));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, data.length - 1);
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1));
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.v).toFixed(1)}`).join('');
  const selIdx = hover ?? Math.max(0, data.findIndex((d) => d.period === selected));
  const idx = selIdx < 0 ? data.length - 1 : selIdx;
  const cur = data[idx];
  const pick = (clientX: number) => {
    const svg = ref.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - L) / (W - L - R)) * (data.length - 1))));
    setHover(i);
    return i;
  };
  const gid = useMemo(() => `g${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div>
      {cur && (
        <div className="chart-tip" aria-live="polite">
          <span className="tip-title">Fin {cur.title ?? cur.label}</span>
          <span>
            Solde <b className={cur.v < 0 ? 't-neg' : 't-pos'}>{formatMAD(cur.v)}</b>
          </span>
          {idx > 0 && (
            <span>
              Variation <b className={cur.v - data[idx - 1].v < 0 ? 't-neg' : 't-pos'}>{(cur.v - data[idx - 1].v >= 0 ? '+' : '') + formatMAD(cur.v - data[idx - 1].v)}</b>
            </span>
          )}
        </div>
      )}
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label="Évolution du solde de fin de mois"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const i = pick(e.clientX);
          if (i !== undefined) onSelect?.(data[i].period);
        }}
        onPointerMove={(e) => {
          if (e.buttons || e.pointerType === 'mouse') {
            const i = pick(e.clientX);
            if (i !== undefined && e.buttons) onSelect?.(data[i].period);
          }
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 && lo < 0 ? 'zero' : 'grid-l'} />
            <text x={L - 6} y={y(t) + 3.5} className="tick" textAnchor="end">
              {short(t)}
            </text>
          </g>
        ))}
        <path d={`${path}L${x(data.length - 1)},${y(Math.max(lo, 0))}L${x(0)},${y(Math.max(lo, 0))}Z`} fill={`url(#${gid})`} />
        <path d={path} fill="none" stroke={color} strokeWidth={2.6} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle key={d.period} cx={x(i)} cy={y(d.v)} r={i === idx ? 0 : 2.5} fill={d.v < 0 ? '#d93a30' : color} />
        ))}
        {cur && (
          <g>
            <line x1={x(idx)} x2={x(idx)} y1={T} y2={H - B} stroke={color} strokeDasharray="3 3" opacity={0.6} />
            <circle cx={x(idx)} cy={y(cur.v)} r={6.5} fill="#fff" stroke={cur.v < 0 ? '#d93a30' : color} strokeWidth={3} />
          </g>
        )}
        {data.map((d, i) =>
          i % Math.ceil(data.length / 6) === 0 || i === data.length - 1 ? (
            <text key={d.period} x={x(i)} y={H - 6} className={cx('tick', i === idx && 'on')} textAnchor="middle">
              {d.label}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- Anneau
export interface Slice {
  key: string;
  label: string;
  value: Cents;
  color: string;
}

export function Donut({ slices, title = 'Total' }: { slices: Slice[]; title?: string }) {
  const [sel, setSel] = useState<string | null>(null);
  const total = slices.reduce((a, s) => a + s.value, 0);
  const R = 62, r = 42, C = 75;
  let angle = -Math.PI / 2;
  const arcs = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const frac = s.value / (total || 1);
      const a0 = angle;
      const a1 = angle + frac * Math.PI * 2 - (frac === 1 ? 0.0001 : 0);
      angle += frac * Math.PI * 2;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const on = sel === s.key;
      const off = on ? 5 : 0;
      const mid = (a0 + a1) / 2;
      const dx = Math.cos(mid) * off, dy = Math.sin(mid) * off;
      const RR = R + (on ? 4 : 0);
      const p = (rad: number, a: number) => `${C + dx + rad * Math.cos(a)},${C + dy + rad * Math.sin(a)}`;
      return { s, frac, d: `M${p(RR, a0)} A${RR},${RR} 0 ${big} 1 ${p(RR, a1)} L${p(r, a1)} A${r},${r} 0 ${big} 0 ${p(r, a0)} Z`, on };
    });
  const cur = slices.find((s) => s.key === sel);
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 150 150" className="chart" style={{ maxWidth: 128 }} role="img" aria-label="Répartition par catégorie">
        {total === 0 && <circle cx={C} cy={C} r={(R + r) / 2} fill="none" stroke="#edf1ee" strokeWidth={R - r} />}
        {arcs.map(({ s, d, on }) => (
          <path key={s.key} d={d} fill={s.color} opacity={sel && !on ? 0.35 : 1} style={{ cursor: 'pointer', transition: 'opacity .15s' }} onClick={() => setSel(on ? null : s.key)}>
            <title>{`${s.label} : ${formatMAD(s.value)}`}</title>
          </path>
        ))}
        <text x={C} y={C - 6} textAnchor="middle" style={{ fontSize: 9.5, fill: '#5f6f66', fontWeight: 700 }}>
          {cur ? (cur.label.length > 16 ? cur.label.slice(0, 15) + '…' : cur.label) : title.length > 16 ? title.slice(0, 15) + '…' : title}
        </text>
        <text x={C} y={C + 10} textAnchor="middle" style={{ fontSize: 13, fontWeight: 850, fill: cur?.color ?? '#10251a' }}>
          {formatMAD(cur ? cur.value : total, false)}
        </text>
        <text x={C} y={C + 23} textAnchor="middle" style={{ fontSize: 9.5, fill: '#5f6f66', fontWeight: 700 }}>
          {cur ? `${Math.round((cur.value / (total || 1)) * 100)} %` : 'MAD'}
        </text>
      </svg>
      <div className="donut-legend">
        {slices.map((s) => (
          <button key={s.key} className={sel === s.key ? 'on' : ''} onClick={() => setSel(sel === s.key ? null : s.key)} aria-pressed={sel === s.key}>
            <i style={{ background: s.color }} />
            <span>{s.label}</span>
            <b>{total ? Math.round((s.value / total) * 100) : 0} %</b>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Progression par membre
export interface MemberRow {
  id: string;
  name: string;
  color: string;
  paid: Cents;
  expected: Cents;
  late: number;
}

export function MemberProgress({ rows }: { rows: MemberRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="member-bars">
      {rows.map((m) => {
        const pct = m.expected ? Math.min(100, (m.paid / m.expected) * 100) : 0;
        const on = open === m.id;
        return (
          <button key={m.id} className={cx('mbar', on && 'on')} onClick={() => setOpen(on ? null : m.id)} aria-expanded={on}>
            <span className="avatar sm" style={{ background: `${m.color}1f`, color: m.color }}>
              {m.name.slice(0, 1)}
            </span>
            <span>
              <span className="mbar-t">
                <b dir="auto">{m.name}</b>
                <span>{Math.round(pct)} %</span>
              </span>
              <span className="mbar-track">
                <i style={{ width: `${pct}%`, background: m.color }} />
              </span>
            </span>
            {on && (
              <span className="mbar-detail">
                <span>
                  Versé <b className="t-pos">{formatMAD(m.paid)}</b>
                </span>
                <span>
                  Attendu <b>{formatMAD(m.expected)}</b>
                </span>
                <span>
                  Reste <b className={m.expected - m.paid > 0 ? 't-warn' : ''}>{formatMAD(Math.max(0, m.expected - m.paid))}</b>
                </span>
                {m.late > 0 && <span className="t-neg">{m.late} mois en retard</span>}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
