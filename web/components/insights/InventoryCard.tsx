import type { InventoryExceptions, InventoryStatus } from "@/lib/types";
import { getFormat, getT } from "@/lib/i18n/server";
import type { Translate } from "@/lib/i18n/translate";
import t from "./tables.module.css";
import styles from "./OverviewView.module.css";

const STATUS_CLASS: Record<InventoryStatus, string> = {
  out: styles.pillBad,
  critical: styles.pillBad,
  low: styles.pillWarn,
  watch: styles.pillNeutral,
};

/**
 * Active products out of stock, running low at the rate units left over the
 * last `windowDays`, or under `minStockUnits` units whatever that rate. A
 * snapshot, like the orders waiting to ship: the range does not cut it. There
 * is no replenishment column — no purchase orders reach this app — so nothing
 * claims stock is on its way.
 */
export function InventoryTable({ inventory, limit }: { inventory: InventoryExceptions; limit?: number }) {
  const tr = getT();
  const { integer } = getFormat();
  if (inventory.items.length === 0) {
    return <p className={t.muted}>{tr("insights.inventory.none", { days: inventory.windowDays, units: inventory.minStockUnits })}</p>;
  }
  const rows = limit ? inventory.items.slice(0, limit) : inventory.items;
  return (
    <div className={t.wrap}>
      <table className={t.table}>
        <thead>
          <tr>
            <th scope="col">{tr("insights.inventory.product")}</th>
            <th scope="col" className={t.n}>{tr("insights.inventory.stock")}</th>
            <th scope="col" className={t.n} title={tr("insights.inventory.outHint", { days: inventory.windowDays })}>
              {tr("insights.inventory.out", { days: inventory.windowDays })}
            </th>
            <th scope="col" className={t.n}>{tr("insights.inventory.cover")}</th>
            <th scope="col">{tr("insights.inventory.status")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.productId}>
              <th scope="row" className={styles.productCell} title={item.title}>
                {item.title}
              </th>
              <td className={t.n}>{integer(item.stock)}</td>
              <td className={t.n}>{integer(item.unitsOut)}</td>
              <td className={t.n}>
                {item.coverDays === null ? <span className={t.muted}>{tr("insights.inventory.notMoving")}</span> : Math.floor(item.coverDays)}
              </td>
              <td>
                <span className={`${styles.pill} ${STATUS_CLASS[item.status]}`}>{tr(`insights.inventory.status.${item.status}`)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The card's aside: what "now" means for stock. */
export function inventoryAside(inventory: InventoryExceptions, tr: Translate): string {
  const synced = inventory.syncedAt ? new Date(inventory.syncedAt).toUTCString().slice(5, 22) : tr("insights.ago.never");
  return tr("insights.inventory.aside", { synced });
}
