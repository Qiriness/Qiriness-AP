import type { InventoryExceptions, InventoryStatus } from "@/lib/types";
import { INVENTORY_STATUS_LABELS } from "../../../scripts/lib/sales-overview.mjs";
import t from "./tables.module.css";
import styles from "./OverviewView.module.css";

const STATUS_CLASS: Record<InventoryStatus, string> = {
  out: styles.pillBad,
  critical: styles.pillBad,
  low: styles.pillWarn,
  watch: styles.pillNeutral,
};

/**
 * Active products out of stock or running low, at the rate units left over the
 * last `windowDays`. A snapshot, like the orders waiting to ship: the range
 * does not cut it. There is no replenishment column — no purchase orders
 * reach this app — so nothing claims stock is on its way.
 */
export function InventoryTable({ inventory, limit }: { inventory: InventoryExceptions; limit?: number }) {
  if (inventory.items.length === 0) {
    return <p className={t.muted}>No active product is out of stock or under {inventory.windowDays} days of cover.</p>;
  }
  const rows = limit ? inventory.items.slice(0, limit) : inventory.items;
  return (
    <div className={t.wrap}>
      <table className={t.table}>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col" className={t.n}>Stock</th>
            <th scope="col" className={t.n} title={`Units that left in the last ${inventory.windowDays} days, samples and gifts included`}>
              Out, {inventory.windowDays} d
            </th>
            <th scope="col" className={t.n}>Days of cover</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.productId}>
              <th scope="row" className={styles.productCell} title={item.title}>
                {item.title}
              </th>
              <td className={t.n}>{item.stock.toLocaleString("en-GB")}</td>
              <td className={t.n}>{item.unitsOut.toLocaleString("en-GB")}</td>
              <td className={t.n}>
                {item.coverDays === null ? <span className={t.muted}>not moving</span> : Math.floor(item.coverDays)}
              </td>
              <td>
                <span className={`${styles.pill} ${STATUS_CLASS[item.status]}`}>{INVENTORY_STATUS_LABELS[item.status]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The card's aside: what "now" means for stock. */
export function inventoryAside(inventory: InventoryExceptions): string {
  const synced = inventory.syncedAt ? new Date(inventory.syncedAt).toUTCString().slice(5, 22) : "never";
  return `Now, as of the product sync (${synced} UTC) — not cut by the date range`;
}
