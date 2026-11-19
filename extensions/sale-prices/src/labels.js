/** French copy for the admin page (the team works in French) + money formatting. */
import { fromCents } from '../../../scripts/lib/sale-prices/pricing.mjs';

export const SKIP_LABELS = {
  not_active: 'Produit en brouillon ou archivé',
  invalid_price: 'Prix illisible',
  zero_price: 'Prix à 0',
  already_reduced: 'Déjà remisé (prix barré au-dessus du prix)',
  on_this_sale: 'Déjà dans cette promotion',
  on_other_sale: 'Déjà dans une autre promotion',
  unreadable_marker: 'Marqueur de promotion illisible : à vérifier à la main',
  no_change: 'Trop bas pour que la remise change le prix'
};

/** 11490 -> "114,90 €"; null -> "—". */
export function euro(cents) {
  if (cents === null || cents === undefined) return '—';
  return `${fromCents(cents).replace('.', ',')} €`;
}

/** "114.90" -> "114,90 €" (prices as Shopify sends them). */
export function euroFromString(price) {
  if (price === null || price === undefined || price === '') return '—';
  return `${Number(price).toFixed(2).replace('.', ',')} €`;
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}
