/** Couleurs attribuées aux catégories de dépenses et aux membres. */
import type { AppState } from '../domain/types.ts';
import { memberColor } from './components/kit.tsx';

const CATEGORY_COLORS: Record<string, string> = {
  'Paiement du personnel': '#0f6b3e',
  'Charges communes': '#e8780c',
  'Achat de matériel': '#2f6fed',
  'Entretien et réparation': '#6c4cd8',
  'Autres dépenses': '#0e8c8c',
};
const EXTRA = ['#d63a7c', '#d99a00', '#8b5e34', '#3a7d44', '#d93a30'];

export function categoryColor(s: AppState, categoryId: string): string {
  const c = s.categories.find((x) => x.id === categoryId);
  if (c && CATEGORY_COLORS[c.name]) return CATEGORY_COLORS[c.name];
  const i = s.categories.findIndex((x) => x.id === categoryId);
  return EXTRA[Math.max(0, i) % EXTRA.length];
}

/** Couleur d'un membre, stable selon son ordre d'ajout. */
export function colorOfMember(s: AppState, memberId: string): string {
  return memberColor(Math.max(0, s.members.findIndex((m) => m.id === memberId)));
}
