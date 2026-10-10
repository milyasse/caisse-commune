/**
 * Magasin d'état de l'application (hors ligne d'abord).
 * - Persistance locale : IndexedDB (repli localStorage), écrite après chaque opération.
 * - Chaque commande métier est appliquée ici ; la différence d'état alimente l'outbox de synchro.
 * - Synchronisation Supabase optionnelle : déclenchée après chaque opération et au retour du réseau.
 */
import { useSyncExternalStore } from 'react';
import type { AppState } from '../domain/types.ts';
import { demoState, emptyState } from '../domain/seed.ts';
import { diffToOutbox, emptyMeta, enqueue, syncOnce, type SyncMeta } from '../domain/sync.ts';
import { DomainError, generateMonth, type Ctx } from '../domain/commands.ts';
import { periodOf, todayISO } from '../domain/dates.ts';
import { SupabaseRemote, refresh, type Session, type SupabaseConfig } from './supabase.ts';

const DB = 'caisse-commune';
const KEY = 'state-v1';

// ---------------------------------------------------------------- IndexedDB minimal
function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function kvGet<T>(k: string): Promise<T | undefined> {
  const db = await idb();
  if (db)
    return new Promise((res) => {
      const r = db.transaction('kv').objectStore('kv').get(k);
      r.onsuccess = () => res(r.result as T);
      r.onerror = () => res(undefined);
    });
  try {
    const v = localStorage.getItem(`${DB}:${k}`);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}
async function kvSet(k: string, v: unknown): Promise<void> {
  const db = await idb();
  if (db)
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  try {
    localStorage.setItem(`${DB}:${k}`, JSON.stringify(v));
  } catch {
    /* stockage indisponible : l'état reste en mémoire */
  }
}

// ---------------------------------------------------------------- Store
export interface Persisted {
  state: AppState;
  sync: SyncMeta;
  supabase?: SupabaseConfig;
  session?: Session | null;
  lastBackupAt?: string;
}

interface Snapshot extends Persisted {
  ready: boolean;
  syncing: boolean;
  online: boolean;
  persistError?: string;
}

let snap: Snapshot = { ready: false, syncing: false, online: typeof navigator === 'undefined' ? true : navigator.onLine, state: emptyState(), sync: emptyMeta() };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (patch: Partial<Snapshot>) => {
  snap = { ...snap, ...patch };
  emit();
};

async function persist() {
  try {
    await kvSet(KEY, { state: snap.state, sync: snap.sync, supabase: snap.supabase, session: snap.session, lastBackupAt: snap.lastBackupAt } satisfies Persisted);
    if (snap.persistError) set({ persistError: undefined });
  } catch (e) {
    set({ persistError: 'Enregistrement local impossible : ' + String(e) });
  }
}

export const ctx = (): Ctx => ({ user: snap.state.settings.currentUser, role: snap.state.settings.currentRole });

/** Génère automatiquement les cotisations du mois courant (idempotent). */
function autoGenerate(s: AppState): AppState {
  if (!s.members.length) return s;
  return generateMonth(s, { user: 'Système', role: 'admin' }, periodOf(todayISO())).state;
}

export async function init() {
  const saved = await kvGet<Persisted>(KEY);
  const state = saved?.state ?? demoState();
  const generated = autoGenerate(state);
  const sync = enqueue(saved?.sync ?? emptyMeta(), diffToOutbox(state, generated));
  set({ ...saved, state: generated, sync, ready: true });
  await persist();
  // Demande au navigateur de ne pas effacer les données (important sur iPhone)
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* non pris en charge */
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => (set({ online: true }), void syncNow()));
    window.addEventListener('offline', () => set({ online: false }));
  }
  void syncNow();
}

/** Applique une commande métier. Lève DomainError en cas de refus (message affichable). */
export function run(fn: (s: AppState, c: Ctx) => AppState): void {
  const before = snap.state;
  const after = fn(before, ctx());
  if (after === before) return;
  set({ state: after, sync: enqueue(snap.sync, diffToOutbox(before, after)) });
  void persist().then(() => syncNow());
}

/** Remplace tout l'état (restauration, réinitialisation démo). */
export function replaceState(next: AppState, reason: 'reset' | 'restore') {
  const now = new Date().toISOString();
  next = structuredClone(next);
  // Le code de protection et l'utilisateur de l'appareil survivent à une réinitialisation
  if (reason === 'reset') {
    next.settings.pinHash = snap.state.settings.pinHash;
    next.settings.currentUser = snap.state.settings.currentUser;
  }
  next.audit.push({ id: crypto.randomUUID(), at: now, user: snap.state.settings.currentUser, action: reason, entity: 'state', entityId: 'all', reason: reason === 'reset' ? 'Réinitialisation' : 'Restauration de sauvegarde' });
  set({ state: autoGenerate(next), sync: emptyMeta() });
  void persist();
}

export function resetDemo() {
  replaceState(demoState(), 'reset');
}
/** Vide toutes les données de l'appareil (caisse réelle vide, sans démonstration). */
export function clearAll() {
  const s = emptyState();
  s.settings.groupName = snap.state.settings.isDemo ? 'Caisse commune' : snap.state.settings.groupName;
  replaceState(s, 'reset');
}

/** Empreinte du code de protection (SHA-256, jamais stocké en clair). */
export async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`caisse-commune:${pin.trim()}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function startReal(groupName: string, openingBalance: number, openingDate: string) {
  const s = emptyState();
  s.settings.groupName = groupName || 'Caisse commune';
  s.settings.openingBalance = openingBalance;
  s.settings.openingDate = openingDate;
  replaceState(s, 'reset');
}

export function backupJson(): string {
  set({ lastBackupAt: new Date().toISOString() });
  void persist();
  return JSON.stringify({ app: 'caisse-commune', exportedAt: new Date().toISOString(), state: snap.state }, null, 1);
}
export function restoreJson(text: string) {
  const j = JSON.parse(text);
  const s = j?.state as AppState;
  if (!s || s.schemaVersion !== 1 || !Array.isArray(s.payments) || !Array.isArray(s.expenses)) throw new DomainError('backup', 'Fichier de sauvegarde invalide.');
  replaceState(s, 'restore');
}

// ---------------------------------------------------------------- Synchronisation
export function configureSupabase(cfg: SupabaseConfig | undefined, session: Session | null) {
  set({ supabase: cfg, session, sync: session ? enqueue(snap.sync, diffToOutbox(emptyState(), snap.state)) : snap.sync });
  void persist().then(() => syncNow());
}

let syncing: Promise<void> | null = null;
export function syncNow(): Promise<void> {
  if (!snap.supabase || !snap.session || !snap.online) return Promise.resolve();
  if (syncing) return syncing;
  syncing = (async () => {
    set({ syncing: true });
    try {
      let session = snap.session!;
      if (session.expiresAt - Date.now() < 60_000) set({ session: (session = await refresh(snap.supabase!, session)) });
      const remote = new SupabaseRemote(snap.supabase!, () => snap.session ?? null);
      const startState = snap.state;
      const res = await syncOnce(startState, snap.sync, remote);
      // des opérations ont pu être saisies pendant la synchro : on les conserve dans l'outbox
      const pendingNow = diffToOutbox(startState, snap.state);
      let merged = res.state;
      if (pendingNow.length) {
        merged = structuredClone(res.state);
        for (const e of pendingNow) {
          const local = (snap.state[e.table] as unknown as { id: string }[]).find((r) => r.id === e.id);
          const arr = merged[e.table] as unknown as { id: string }[];
          const i = arr.findIndex((r) => r.id === e.id);
          if (local) i >= 0 ? (arr[i] = local) : arr.push(local);
        }
        merged.settings = snap.state.settings;
      }
      set({ state: merged, sync: enqueue(res.meta, pendingNow) });
      await remote.pushSettings(snap.state.settings).catch(() => undefined);
    } catch (e) {
      set({ sync: { ...snap.sync, lastError: e instanceof Error ? e.message : String(e) } });
    } finally {
      set({ syncing: false });
      syncing = null;
      void persist();
    }
  })();
  return syncing;
}

// ---------------------------------------------------------------- Hook React
export function useStore(): Snapshot {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snap,
    () => snap,
  );
}
export const getSnapshot = () => snap;
