import Link from "next/link";
import type { ReactNode } from "react";
import { CrownIcon, ExternalLinkIcon } from "@/components/icons";
import { Card } from "@/components/insights/InsightsKit";
import { Flag } from "@/components/insights/Flag";
import type { OrderDetail } from "@/lib/types";
import styles from "./OrderDetailView.module.css";

/**
 * One order, on cards, in the shape of Shopify's order page: what was bought,
 * how it shipped and what was paid on the left; who wrote about it, who bought
 * it and where it went on the right.
 *
 * Tickets lead the right-hand column because they are the reason this page
 * exists inside a support app rather than a link out to Shopify.
 */
export function OrderDetailView({ order, loadError }: { order: OrderDetail | null; loadError: string | null }) {
  return (
    <div className={styles.page}>
      <Link href="/orders" className={styles.back}>
        ← Orders
      </Link>

      {loadError ? (
        <p className={styles.error} role="alert">
          {loadError}
        </p>
      ) : null}

      {order ? (
        <>
          <header className={styles.header}>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{order.name}</h1>
              {order.financialLabel ? <span className={styles.chip}>{order.financialLabel}</span> : null}
              <span className={styles.chip} data-status={order.fulfillmentStatus ?? "UNKNOWN"}>
                {order.fulfillmentLabel}
              </span>
              {order.cancelledLabel ? <span className={`${styles.chip} ${styles.chipAlert}`}>Cancelled</span> : null}
              {order.returnLabel ? <span className={styles.chip}>{order.returnLabel}</span> : null}
              {order.adminUrl ? (
                <a className={styles.shopify} href={order.adminUrl} target="_blank" rel="noreferrer">
                  Open in Shopify <ExternalLinkIcon size={14} />
                </a>
              ) : null}
            </div>
            <p className={styles.meta}>
              {order.placedLabel} · {order.platformLabel}
              {order.channelLabel && order.channelLabel !== order.platformLabel ? ` (${order.channelLabel})` : ""}
              {order.cancelledLabel
                ? ` · Cancelled ${order.cancelledLabel}${order.cancelReason ? ` — ${order.cancelReason}` : ""}`
                : ""}
            </p>
          </header>

          <div className={styles.layout}>
            <div className={styles.column}>
              <ArticlesCard order={order} />
              <FulfilmentCard order={order} />
              <PaymentCard order={order} />
            </div>
            <div className={styles.column}>
              <TicketsCard order={order} />
              <CustomerCard order={order} />
              <DestinationCard order={order} />
              {order.tags.length > 0 ? (
                <Card title="Tags">
                  <ul className={styles.tags}>
                    {order.tags.map((tag) => (
                      <li key={tag} className={styles.tag}>
                        {tag}
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ArticlesCard({ order }: { order: OrderDetail }) {
  return (
    <Card title="Articles" aside={`${order.units} ${order.units === 1 ? "item" : "items"}`}>
      {order.lineItems.length === 0 ? (
        <p className={styles.empty}>This order holds no line items.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className={styles.n}>
                  Qty
                </th>
                <th scope="col" className={styles.n}>
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {order.lineItems.map((item) => (
                <tr key={item.id}>
                  <td className={styles.product}>
                    <span className={styles.productTitle}>{item.title}</span>
                    {item.variantTitle || item.sku ? (
                      <span className={styles.sub}>
                        {[item.variantTitle, item.sku ? `SKU ${item.sku}` : null].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </td>
                  <td className={styles.n}>
                    {item.currentQuantity}
                    {item.currentQuantity < item.quantity ? (
                      <span className={styles.sub}>{item.quantity - item.currentQuantity} removed</span>
                    ) : null}
                  </td>
                  <td className={styles.n}>
                    {item.totalLabel ?? "—"}
                    {item.originalTotalLabel ? <s className={styles.sub}>{item.originalTotalLabel}</s> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function FulfilmentCard({ order }: { order: OrderDetail }) {
  return (
    <Card title="Fulfilment" aside={order.fulfillmentLabel}>
      {order.fulfilments.length === 0 ? (
        <p className={styles.empty}>{order.cancelledLabel ? "Cancelled before it shipped." : "Not shipped yet."}</p>
      ) : (
        <ul className={styles.stack}>
          {order.fulfilments.map((f) => (
            <li key={f.id} className={styles.shipment}>
              <div className={styles.shipmentHead}>
                <strong>{f.name ?? "Shipment"}</strong>
                <span className={styles.chip}>{f.statusLabel}</span>
              </div>
              <Facts
                rows={[
                  ["Shipped", f.createdLabel],
                  ["Delivered", f.deliveredLabel],
                ]}
              />
              {f.tracking.length > 0 ? (
                <ul className={styles.tracking}>
                  {f.tracking.map((t, i) => (
                    <li key={`${t.number ?? "tracking"}-${i}`}>
                      <span className={styles.carrier}>{t.company ?? "Carrier"}</span>
                      {t.number ? (
                        t.url ? (
                          <a href={t.url} target="_blank" rel="noreferrer" className={styles.trackingNumber}>
                            {t.number}
                          </a>
                        ) : (
                          <span className={styles.trackingNumber}>{t.number}</span>
                        )
                      ) : (
                        <span className={styles.muted}>No tracking number</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.muted}>No tracking on this shipment.</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {order.returns.length > 0 ? (
        <div className={styles.subsection}>
          <h3 className={styles.subTitle}>Returns</h3>
          <ul className={styles.stack}>
            {order.returns.map((r) => (
              <li key={r.id} className={styles.line}>
                <span>{r.name ?? "Return"}</span>
                <span className={styles.muted}>
                  {r.statusLabel}
                  {r.createdLabel ? ` · ${r.createdLabel}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function PaymentCard({ order }: { order: OrderDetail }) {
  return (
    <Card title="Payment" aside={order.financialLabel ?? undefined}>
      <dl className={styles.money}>
        {order.money.map((line) => (
          <div key={line.label} className={line.strong ? styles.moneyStrong : styles.moneyRow}>
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      {order.refunds.length > 0 ? (
        <div className={styles.subsection}>
          <h3 className={styles.subTitle}>Refunds</h3>
          <ul className={styles.stack}>
            {order.refunds.map((r) => (
              <li key={r.id} className={styles.line}>
                <span className={styles.muted}>{r.createdLabel ?? "Date unknown"}</span>
                <span>{r.amountLabel ?? "—"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function TicketsCard({ order }: { order: OrderDetail }) {
  const open = order.tickets.filter((t) => t.open).length;
  return (
    <Card title="Tickets" aside={order.tickets.length > 0 ? `${open} open` : undefined}>
      {order.tickets.length === 0 ? (
        <p className={styles.empty}>
          No ticket is linked to this order. A ticket links once the agent confirms the order number it quotes.
        </p>
      ) : (
        <ul className={styles.stack}>
          {order.tickets.map((t) => (
            <li key={t.id} className={styles.ticket} data-band={t.open ? t.band : undefined}>
              <Link href="/tickets" className={styles.ticketSubject}>
                {t.subject || "(no subject)"}
              </Link>
              <span className={styles.sub}>
                {t.statusLabel}
                {t.level ? ` · Level ${t.level}` : ""}
                {t.open ? ` · ${t.band} priority (${t.score})` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CustomerCard({ order }: { order: OrderDetail }) {
  const customer = order.customer;
  return (
    <Card title="Customer">
      {customer ? (
        <>
          <p className={styles.customerName}>
            {customer.name ?? <span className={styles.muted}>No name on file</span>}
            {customer.isVip ? (
              <span className={styles.vip} title="VIP customer">
                <CrownIcon size={14} /> VIP
              </span>
            ) : null}
          </p>
          {customer.email ? (
            <p className={styles.email}>{customer.email}</p>
          ) : (
            <p className={styles.muted}>Marketplace buyer — no real address on file.</p>
          )}
          <Facts
            rows={[
              ["Orders", customer.ordersCount === null ? null : customer.ordersCount.toLocaleString("en-GB")],
              ["Total spent", customer.spentLabel],
            ]}
          />
        </>
      ) : (
        <>
          <p className={styles.muted}>No customer account is linked to this order.</p>
          {order.maskedEmail ? <p className={styles.email}>{order.maskedEmail}</p> : null}
        </>
      )}
    </Card>
  );
}

function DestinationCard({ order }: { order: OrderDetail }) {
  const d = order.destination;
  return (
    <Card title="Destination">
      {d ? (
        <div className={styles.destination}>
          {d.countryCode ? <Flag code={d.countryCode} /> : null}
          <div>
            <p className={styles.place}>{[d.city, d.province].filter(Boolean).join(", ") || "—"}</p>
            <p className={styles.muted}>{d.country ?? d.countryCode}</p>
          </div>
        </div>
      ) : (
        <p className={styles.empty}>No shipping address on this order.</p>
      )}
    </Card>
  );
}

function Facts({ rows }: { rows: [string, ReactNode | null][] }) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (shown.length === 0) return null;
  return (
    <dl className={styles.facts}>
      {shown.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
