/**
 * Types métier. Tous les montants sont des ENTIERS en centimes de MAD
 * (jamais de flottants). 1 600,00 MAD = 160000.
 * Dates : chaînes ISO "AAAA-MM-JJ". Périodes : "AAAA-MM".
 */
export type ID = string;
export type Cents = number;
export type ISODate = string; // 2026-10-10
export type Period = string; // 2026-10

export type Role = 'admin' | 'user';
export type OpStatus = 'valid' | 'cancelled';
export type PayMethod = 'especes' | 'virement' | 'autre';
export type ContributionStatus = 'paye' | 'partiel' | 'non_paye';

export interface Member {
  id: ID;
  name: string;
  joinDate: ISODate;
  active: boolean;
  /** Date à partir de laquelle le membre ne fait plus partie des membres actifs (plus de cotisation due). */
  leftDate?: ISODate;
  defaultAmount: Cents;
  phone?: string;
  updatedAt: string;
}

/** Montant applicable à un membre à partir d'une période (historique des montants). */
export interface ContributionRule {
  id: ID;
  memberId: ID;
  amount: Cents;
  validFrom: Period;
  updatedAt: string;
}

/** Cotisation attendue : 1 par membre et par mois (unicité membre+période). */
export interface MonthlyContribution {
  id: ID;
  memberId: ID;
  period: Period;
  expected: Cents;
  dueDate: ISODate;
  overridden: boolean; // montant modifié exceptionnellement pour ce mois
  note?: string;
  updatedAt: string;
}

/** Versement réel, toujours imputé à UNE cotisation (mois concerné). */
export interface Payment {
  id: ID;
  contributionId: ID;
  memberId: ID;
  date: ISODate; // date réelle d'encaissement
  amount: Cents;
  method: PayMethod;
  reference?: string;
  comment?: string;
  status: OpStatus;
  cancelReason?: string;
  createdBy: string;
  updatedAt: string;
}

export interface ExpenseCategory {
  id: ID;
  name: string;
  active: boolean;
  updatedAt: string;
}

export interface Expense {
  id: ID;
  date: ISODate;
  categoryId: ID;
  description: string;
  beneficiary: string;
  amount: Cents;
  method: PayMethod;
  reference?: string;
  comment?: string;
  receipt?: string; // data URL (local) ou chemin storage (Supabase)
  status: OpStatus;
  cancelReason?: string;
  createdBy: string;
  updatedAt: string;
}

export interface MonthClosure {
  id: ID;
  period: Period;
  closingBalance: Cents;
  closedAt: string;
  closedBy: string;
  reopened: boolean;
  updatedAt: string;
}

export interface AuditLog {
  id: ID;
  at: string;
  user: string;
  action: 'create' | 'update' | 'cancel' | 'close' | 'reopen' | 'import' | 'reset' | 'restore';
  entity: string;
  entityId: ID;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export interface Settings {
  groupName: string;
  openingBalance: Cents;
  openingDate: ISODate; // date du solde initial
  dueDay: number; // 0 = dernier jour du mois, sinon jour N
  largeExpenseThreshold: Cents;
  isDemo: boolean;
  currentUser: string;
  currentRole: Role;
  /** Empreinte SHA-256 du code qui protège les actions destructrices (vider, réinitialiser). */
  pinHash?: string;
  updatedAt: string;
}

export interface AppState {
  schemaVersion: 1;
  settings: Settings;
  members: Member[];
  rules: ContributionRule[];
  contributions: MonthlyContribution[];
  payments: Payment[];
  categories: ExpenseCategory[];
  expenses: Expense[];
  closures: MonthClosure[];
  audit: AuditLog[];
}
