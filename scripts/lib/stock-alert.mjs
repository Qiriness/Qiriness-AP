import { fromKey, toKey, wallClock } from './insights-range.mjs';
import { brandSlug } from './sales-report.mjs';
import {
  INVENTORY_CRITICAL_COVER_DAYS,
  INVENTORY_CRITICAL_UNITS,
  INVENTORY_WINDOW_DAYS,
  inventoryStatus,
  isAlertStatus,
  rankInventoryByRisk
} from './sales-overview.mjs';
import { supabaseRpc } from './supabase-rest-client.mjs';
import { RPC } from './tables.mjs';
import { writeXlsx } from './xlsx-writer.mjs';

/**
 * THE STOCK ALERT (owner, 2026-10-27): when a product NEWLY becomes out of
 * stock or critical, mail an Excel file of every product that is out of stock
 * or critical now. Critical is under INVENTORY_CRITICAL_COVER_DAYS of cover or
 * under INVENTORY_CRITICAL_UNITS (sales-overview.mjs), the same word the
 * dashboard shows. The worker runs it (agent/src/reports/stock-alert-mail.mjs);
 * everything here is the measurement and the wording.
 * docs/decisions/insights.md § The stock alert.
 */

/**
 * The shop's out-of-stock and critical products, most at risk first, with the
 * cover read over the last INVENTORY_WINDOW_DAYS on the shop clock — the window
 * the dashboard uses (web/lib/server/insights/inventory.ts).
 */
export async function readAlertProducts(supabase, { shopId, tz, now = new Date() }) {
  const to = toKey(wallClock(now, tz));
  const from = toKey(new Date(fromKey(to).getTime() - INVENTORY_WINDOW_DAYS * 86_400_000));
  // The SQL's own filter is a superset (cover ≤ 14 days or under 40 units);
  // the status decides.
  const rows = await supabaseRpc(supabase, RPC.INSIGHTS_INVENTORY_EXCEPTIONS, {
    p_shop: shopId,
    p_from: from,
    p_to: to,
    p_tz: tz,
    p_max_cover_days: INVENTORY_CRITICAL_COVER_DAYS,
    p_max_stock_units: INVENTORY_CRITICAL_UNITS
  });
  const items = (rows ?? [])
    .map((row) => {
      const stock = Number(row.stock);
      const coverDays = row.cover_days === null || row.cover_days === undefined ? null : Number(row.cover_days);
      return {
        productId: String(row.product_id),
        title: String(row.title ?? 'Produit sans nom'),
        productType: row.product_type || null,
        stock,
        unitsOut: Number(row.units_out) || 0,
        coverDays,
        status: inventoryStatus(stock, coverDays)
      };
    })
    .filter((item) => isAlertStatus(item.status));
  return rankInventoryByRisk(items);
}

/** The ids out of stock and critical, sorted: what a `stock_alerts` row records. */
export function alertState(items) {
  const ids = (status) => items.filter((i) => i.status === status).map((i) => i.productId).sort();
  return { out: ids('out'), critical: ids('critical') };
}

/**
 * The products that make this check send: in the set now and not at the last
 * check, or critical then and out of stock now (the worse news). A product that
 * recovers and later falls back in counts as new again.
 */
export function newlyAlerting(previous, current) {
  const before = new Set([...previous.out, ...previous.critical]);
  const outBefore = new Set(previous.out);
  return [...current.out, ...current.critical].filter((id) => !before.has(id) || (current.out.includes(id) && !outBefore.has(id)));
}

/** Whether two states hold the same products in the same groups. */
export function sameState(a, b) {
  const same = (x, y) => x.length === y.length && x.every((id, i) => id === y[i]);
  return same([...a.out].sort(), [...b.out].sort()) && same([...a.critical].sort(), [...b.critical].sort());
}

const STATUS_FR = { out: 'En rupture', critical: 'Critique' };

/** The attachment: every product out of stock or critical, the new ones marked. */
export function stockAlertWorkbook(items, newIds) {
  const fresh = new Set(newIds);
  return writeXlsx({
    sheetName: 'Stock',
    columns: [
      { header: 'Produit', width: 48 },
      { header: 'Statut', width: 13 },
      { header: 'Nouveau', width: 10 },
      { header: 'Stock', width: 9 },
      { header: `Vendus (${INVENTORY_WINDOW_DAYS} j)`, width: 13 },
      { header: 'Couverture (jours)', width: 18 },
      { header: 'Type', width: 22 }
    ],
    rows: items.map((item) => [
      item.title,
      STATUS_FR[item.status] ?? item.status,
      fresh.has(item.productId) ? 'Oui' : '',
      item.stock,
      item.unitsOut,
      item.coverDays === null ? 'Ne se vend pas' : Math.floor(item.coverDays),
      item.productType ?? ''
    ])
  });
}

export function stockAlertFileName(brand, now = new Date()) {
  return `${brandSlug(brand)}-alerte-stock-${now.toISOString().slice(0, 10)}.xlsx`;
}

/** Subject and body, in French like the monthly report: the team reads French. */
export function stockAlertMail({ brand, items, newIds }) {
  const fresh = items.filter((item) => newIds.includes(item.productId));
  const n = fresh.length;
  const lines = fresh.map((item) =>
    item.status === 'out'
      ? `- ${item.title} : en rupture`
      : `- ${item.title} : critique, ${item.stock} unité${item.stock > 1 ? 's' : ''}${item.coverDays === null ? '' : `, ${Math.floor(item.coverDays)} jours de couverture`}`
  );
  return {
    subject: `Alerte stock ${brand} : ${n} produit${n > 1 ? 's' : ''} en rupture ou critique${n > 1 ? 's' : ''}`,
    text: [
      'Bonjour,',
      '',
      `${n > 1 ? `${n} produits viennent` : 'Un produit vient'} de passer en rupture ou en stock critique :`,
      ...lines,
      '',
      `Le fichier joint liste les ${items.length} produit${items.length > 1 ? 's' : ''} actuellement en rupture ou critique${items.length > 1 ? 's' : ''}.`,
      `Critique : moins de ${INVENTORY_CRITICAL_COVER_DAYS} jours de couverture au rythme des ${INVENTORY_WINDOW_DAYS} derniers jours, ou moins de ${INVENTORY_CRITICAL_UNITS} unités.`,
      '',
      'Bien cordialement,',
      `Agent Contact ${brand}`
    ].join('\n')
  };
}
