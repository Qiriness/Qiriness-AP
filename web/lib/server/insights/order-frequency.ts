/**
 * One shape, read by two panels: customers by how many orders they placed.
 *
 * Customers → "Customers by number of orders" counts every order in the range;
 * Sales → "Who buys this product" counts the orders carrying one product. The
 * two charts are read against each other, so the long tail has to be folded the
 * same way in both — hence one function rather than a copy per service, for the
 * reason `foldForSearch` is shared by the two product searches.
 */

import { count } from "./shared";

/**
 * The last column: this many orders or more. Ten keeps a year's long tail on
 * one axis without a dozen one-person columns.
 */
export const OR_MORE = 10;

export interface OrderCountBucket {
  orders: number;
  orMore: boolean;
  customers: number;
}

/**
 * `(order_count, customers)` rows into the chart's columns.
 *
 * Always 1 to 5, so a quiet range still reads as a distribution rather than a
 * single bar; beyond five, only as far as someone actually got.
 */
export function foldOrdersPerCustomer(rows: Record<string, unknown>[]): OrderCountBucket[] {
  const byCount = new Map<number, number>();
  for (const row of rows) {
    const n = Math.min(count(row.order_count), OR_MORE);
    byCount.set(n, (byCount.get(n) ?? 0) + count(row.customers));
  }
  const highest = Math.max(5, ...byCount.keys());
  return Array.from({ length: highest }, (_, i) => i + 1).map((orders) => ({
    orders,
    orMore: orders === OR_MORE,
    customers: byCount.get(orders) ?? 0,
  }));
}
