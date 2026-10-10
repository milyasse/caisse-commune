/**
 * Adaptateur Supabase (API REST PostgREST + Auth), sans dépendance externe.
 * ⚠️ Écrit selon l'API publique Supabase mais NON testé contre une instance réelle
 * dans cette version (voir docs/ANALYSE.md §9). La logique de synchronisation elle-même
 * (outbox, idempotence, fusion) est testée avec un serveur en mémoire.
 */
import type { RemoteAdapter, SyncTable } from '../domain/sync.ts';
import type { Settings } from '../domain/types.ts';

export interface SupabaseConfig {
  url: string; // https://xxxx.supabase.co
  anonKey: string;
}
export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
}

type Map_ = { table: string; fields: [app: string, db: string, kind?: 'money' | 'period'][]; cursorCol: string };
const MAPS: Record<SyncTable, Map_> = {
  members: { table: 'members', cursorCol: 'updated_at', fields: [['id', 'id'], ['name', 'name'], ['joinDate', 'join_date'], ['active', 'active'], ['leftDate', 'left_date'], ['defaultAmount', 'default_amount', 'money'], ['phone', 'phone'], ['updatedAt', 'updated_at']] },
  rules: { table: 'contribution_rules', cursorCol: 'updated_at', fields: [['id', 'id'], ['memberId', 'member_id'], ['amount', 'amount', 'money'], ['validFrom', 'valid_from', 'period'], ['updatedAt', 'updated_at']] },
  contributions: { table: 'monthly_contributions', cursorCol: 'updated_at', fields: [['id', 'id'], ['memberId', 'member_id'], ['period', 'period', 'period'], ['expected', 'expected', 'money'], ['dueDate', 'due_date'], ['overridden', 'overridden'], ['note', 'note'], ['updatedAt', 'updated_at']] },
  payments: { table: 'contribution_payments', cursorCol: 'updated_at', fields: [['id', 'id'], ['contributionId', 'contribution_id'], ['memberId', 'member_id'], ['date', 'paid_on'], ['amount', 'amount', 'money'], ['method', 'method'], ['reference', 'reference'], ['comment', 'comment'], ['status', 'status'], ['cancelReason', 'cancel_reason'], ['createdBy', 'created_by'], ['updatedAt', 'updated_at']] },
  categories: { table: 'expense_categories', cursorCol: 'updated_at', fields: [['id', 'id'], ['name', 'name'], ['active', 'active'], ['updatedAt', 'updated_at']] },
  expenses: { table: 'expenses', cursorCol: 'updated_at', fields: [['id', 'id'], ['date', 'spent_on'], ['categoryId', 'category_id'], ['description', 'description'], ['beneficiary', 'beneficiary'], ['amount', 'amount', 'money'], ['method', 'method'], ['reference', 'reference'], ['comment', 'comment'], ['status', 'status'], ['cancelReason', 'cancel_reason'], ['createdBy', 'created_by'], ['updatedAt', 'updated_at']] },
  closures: { table: 'month_closures', cursorCol: 'updated_at', fields: [['id', 'id'], ['period', 'period', 'period'], ['closingBalance', 'closing_balance', 'money'], ['closedAt', 'closed_at'], ['closedBy', 'closed_by'], ['reopened', 'reopened'], ['updatedAt', 'updated_at']] },
  audit: { table: 'audit_logs', cursorCol: 'at', fields: [['id', 'id'], ['at', 'at'], ['user', 'user_name'], ['action', 'action'], ['entity', 'entity'], ['entityId', 'entity_id'], ['before', 'before'], ['after', 'after'], ['reason', 'reason']] },
};

const toDb = (kind: string | undefined, v: unknown) => {
  if (v === undefined) return null;
  if (kind === 'money') return ((v as number) / 100).toFixed(2);
  if (kind === 'period') return `${v}-01`;
  return v;
};
const fromDb = (kind: string | undefined, v: unknown) => {
  if (v === null) return undefined;
  if (kind === 'money') {
    const [i, d = ''] = String(v).split('.');
    const neg = i.startsWith('-');
    return (neg ? -1 : 1) * (Math.abs(Number(i)) * 100 + Number(d.padEnd(2, '0').slice(0, 2)));
  }
  if (kind === 'period') return String(v).slice(0, 7);
  return v;
};

export class SupabaseRemote implements RemoteAdapter {
  constructor(private cfg: SupabaseConfig, private session: () => Session | null) {}

  private headers(extra: Record<string, string> = {}) {
    const s = this.session();
    if (!s) throw new Error('Non connecté.');
    return { apikey: this.cfg.anonKey, Authorization: `Bearer ${s.accessToken}`, 'Content-Type': 'application/json', ...extra };
  }

  async upsert(t: SyncTable, rows: Record<string, unknown>[]) {
    const m = MAPS[t];
    const body = rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const [a, d, k] of m.fields) if (!(t === 'expenses' && a === 'receipt')) o[d] = toDb(k, r[a]);
      if (t === 'audit') o.source = 'app';
      return o;
    });
    // Rejouer un envoi est sans effet : conflit sur la clé primaire => mise à jour (ou ignoré pour l'audit)
    const prefer = t === 'audit' ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates';
    const res = await fetch(`${this.cfg.url}/rest/v1/${m.table}?on_conflict=id`, { method: 'POST', headers: this.headers({ Prefer: `${prefer},return=minimal` }), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${m.table} : ${(await res.text()).slice(0, 300)}`);
  }

  async pullSince(t: SyncTable, cursor: string) {
    const m = MAPS[t];
    // marge de 2 min (horloges / transactions concurrentes) ; la fusion est idempotente
    const since = new Date(Date.parse(cursor) - 120_000).toISOString();
    const res = await fetch(`${this.cfg.url}/rest/v1/${m.table}?${m.cursorCol}=gt.${encodeURIComponent(since)}&order=${m.cursorCol}.asc&limit=5000`, { headers: this.headers() });
    if (!res.ok) throw new Error(`${m.table} : ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as Record<string, unknown>[];
    let serverTime = cursor;
    const rows = data.map((d) => {
      const o: Record<string, unknown> = {};
      for (const [a, db, k] of m.fields) o[a] = fromDb(k, d[db]);
      const ts = String(d[m.cursorCol] ?? '');
      if (ts > serverTime) serverTime = new Date(ts).toISOString();
      return o as { id: string };
    });
    return { rows, serverTime };
  }

  async pushSettings(s: Settings) {
    const h = this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' });
    await fetch(`${this.cfg.url}/rest/v1/app_settings?on_conflict=id`, { method: 'POST', headers: h, body: JSON.stringify([{ id: 1, group_name: s.groupName, due_day: s.dueDay, large_expense_threshold: (s.largeExpenseThreshold / 100).toFixed(2), is_demo: s.isDemo }]) });
    const acc = await fetch(`${this.cfg.url}/rest/v1/cash_accounts?is_default=eq.true&select=id`, { headers: this.headers() }).then((r) => r.json());
    if (acc[0]) await fetch(`${this.cfg.url}/rest/v1/opening_balances?on_conflict=cash_account_id`, { method: 'POST', headers: h, body: JSON.stringify([{ cash_account_id: acc[0].id, balance_date: s.openingDate, amount: (s.openingBalance / 100).toFixed(2) }]) });
  }

  async fetchRole(): Promise<'admin' | 'user' | null> {
    const res = await fetch(`${this.cfg.url}/rest/v1/rpc/current_app_role`, { method: 'POST', headers: this.headers(), body: '{}' });
    return res.ok ? ((await res.json()) as 'admin' | 'user' | null) : null;
  }
}

export async function signIn(cfg: SupabaseConfig, email: string, password: string): Promise<Session> {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description ?? j.msg ?? 'Connexion refusée');
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000, email };
}

export async function refresh(cfg: SupabaseConfig, s: Session): Promise<Session> {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refreshToken }) });
  const j = await res.json();
  if (!res.ok) throw new Error('Session expirée, reconnectez-vous.');
  return { ...s, accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000 };
}
