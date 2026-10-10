/**
 * Synchronisation multi-appareils (optionnelle), conçue « hors ligne d'abord » :
 *  - chaque enregistrement porte un identifiant généré côté client (UUID) ;
 *  - toute écriture locale ajoute l'identifiant à une file d'attente (outbox) ;
 *  - push = UPSERT par identifiant (rejouer un push ne crée jamais de doublon) ;
 *  - pull = lignes modifiées depuis le dernier curseur, fusionnées par `updatedAt`
 *    (la plus récente gagne) ; une annulation n'est jamais « dé-annulée » ;
 *  - le journal d'audit est en ajout seul (union par identifiant).
 * Le transport (Supabase REST, serveur de test…) est fourni via RemoteAdapter.
 */
import type { AppState } from './types.ts';

export const SYNC_TABLES = ['members', 'rules', 'contributions', 'payments', 'categories', 'expenses', 'closures', 'audit'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

type Row = { id: string; updatedAt?: string; at?: string; status?: string; reopened?: boolean } & Record<string, unknown>;

export interface OutboxEntry {
  table: SyncTable;
  id: string;
}

export interface SyncMeta {
  outbox: OutboxEntry[];
  cursor: string; // horodatage serveur du dernier pull
  lastSyncAt?: string;
  lastError?: string;
}

export interface RemoteAdapter {
  upsert(table: SyncTable, rows: Row[]): Promise<void>;
  pullSince(table: SyncTable, cursor: string): Promise<{ rows: Row[]; serverTime: string }>;
}

export const emptyMeta = (): SyncMeta => ({ outbox: [], cursor: '1970-01-01T00:00:00.000Z' });

const stamp = (r: Row) => r.updatedAt ?? r.at ?? '';

/** Calcule les entrées outbox à partir de la différence entre deux états. */
export function diffToOutbox(before: AppState, after: AppState): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  for (const t of SYNC_TABLES) {
    const prev = new Map((before[t] as unknown as Row[]).map((r) => [r.id, r]));
    for (const r of after[t] as unknown as Row[]) {
      const p = prev.get(r.id);
      if (p !== r && JSON.stringify(p) !== JSON.stringify(r)) out.push({ table: t, id: r.id });
    }
  }
  return out;
}

export function enqueue(meta: SyncMeta, entries: OutboxEntry[]): SyncMeta {
  const seen = new Set(meta.outbox.map((e) => `${e.table}:${e.id}`));
  const outbox = [...meta.outbox];
  for (const e of entries) if (!seen.has(`${e.table}:${e.id}`)) (seen.add(`${e.table}:${e.id}`), outbox.push(e));
  return { ...meta, outbox };
}

/** Fusionne une ligne distante dans une table locale. */
export function mergeRow(table: SyncTable, local: Row | undefined, remote: Row): Row {
  if (!local) return remote;
  if (table === 'audit') return local; // ajout seul, immuable
  let winner = stamp(remote) > stamp(local) ? remote : local;
  // Une annulation est définitive (pas de « résurrection » par un appareil en retard).
  if ((local.status === 'cancelled' || remote.status === 'cancelled') && winner.status !== 'cancelled')
    winner = local.status === 'cancelled' ? local : remote;
  return winner;
}

export function mergeRemote(state: AppState, table: SyncTable, rows: Row[]): AppState {
  const cur = state[table] as unknown as Row[];
  const byId = new Map(cur.map((r) => [r.id, r]));
  for (const r of rows) byId.set(r.id, mergeRow(table, byId.get(r.id), r));
  return { ...state, [table]: [...byId.values()] } as AppState;
}

/** Un cycle complet : push de l'outbox puis pull. Retourne le nouvel état et les méta. */
export async function syncOnce(state: AppState, meta: SyncMeta, remote: RemoteAdapter): Promise<{ state: AppState; meta: SyncMeta }> {
  // PUSH (idempotent)
  const byTable = new Map<SyncTable, Row[]>();
  for (const e of meta.outbox) {
    const row = (state[e.table] as unknown as Row[]).find((r) => r.id === e.id);
    if (row) byTable.set(e.table, [...(byTable.get(e.table) ?? []), row]);
  }
  for (const t of SYNC_TABLES) {
    const rows = byTable.get(t);
    if (rows?.length) await remote.upsert(t, rows);
  }
  // PULL
  let next = state;
  let serverTime = meta.cursor;
  for (const t of SYNC_TABLES) {
    const res = await remote.pullSince(t, meta.cursor);
    next = mergeRemote(next, t, res.rows);
    if (res.serverTime > serverTime) serverTime = res.serverTime;
  }
  return { state: next, meta: { outbox: [], cursor: serverTime, lastSyncAt: new Date().toISOString() } };
}

/** Serveur en mémoire — sert aux tests et au mode démonstration de la synchro. */
export class MemoryRemote implements RemoteAdapter {
  tables = new Map<SyncTable, Map<string, Row & { _serverAt: string }>>();
  private clock = 0;
  private tick() {
    this.clock++;
    return new Date(Date.UTC(2000, 0, 1) + this.clock * 1000).toISOString();
  }
  async upsert(table: SyncTable, rows: Row[]) {
    const t = this.tables.get(table) ?? new Map();
    for (const r of rows) {
      const merged = mergeRow(table, t.get(r.id), r);
      t.set(r.id, { ...merged, _serverAt: this.tick() });
    }
    this.tables.set(table, t);
  }
  async pullSince(table: SyncTable, cursor: string) {
    const rows = [...(this.tables.get(table)?.values() ?? [])].filter((r) => r._serverAt > cursor);
    return { rows: rows.map(({ _serverAt, ...r }) => r as Row), serverTime: this.clock ? new Date(Date.UTC(2000, 0, 1) + this.clock * 1000).toISOString() : cursor };
  }
  count(table: SyncTable) {
    return this.tables.get(table)?.size ?? 0;
  }
}
