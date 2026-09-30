import Link from "next/link";
import type { ReactNode } from "react";
import { CrownIcon, ExternalLinkIcon } from "@/components/icons";
import { Card } from "@/components/insights/InsightsKit";
import { Flag } from "@/components/insights/Flag";
import { getFormat, getT } from "@/lib/i18n/server";
import { enumText } from "@/lib/order-enums";
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
export function OrderDetailView({
  order,
  loadError,
  backToTicketId = null,
}: {
  order: OrderDetail | null;
  loadError: string | null;
  /** Set when a ticket sent the reader here: the way back to that ticket. */
  backToTicketId?: string | null;
}) {
  const t = getT();
  return (
    <div className={styles.page}>
      {backToTicketId ? (
        // The ticket first, because it is where the reader came from and where
        // the work is. `/tickets?ticket=` reopens that ticket, not just the queue.
        <span className={styles.backRow}>
          <Link href={`/tickets?ticket=${backToTicketId}`} className={styles.back}>
            ← {t("orders.detail.backToTicket")}
          </Link>
          <Link href="/orders" className={styles.backMuted}>
            {t("nav.orders")}
          </Link>
        </span>
      ) : (
        <Link href="/orders" className={styles.back}>
          ← {t("nav.orders")}
        </Link>
      )}

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
              {order.financialLabel ? <span className={styles.chip}>{enumText(t, order.financialLabel)}</span> : null}
              {/* An emptied order's pill would only repeat the Cancelled chip or
                  the Refunded payment chip beside it. */}
              {order.fulfillmentStatus !== "CANCELLED" && order.fulfillmentStatus !== "REFUNDED" ? (
                <span className={styles.chip} data-status={order.fulfillmentStatus}>
                  {enumText(t, order.fulfillmentLabel)}
                </span>
              ) : null}
              {order.cancelledLabel ? <span className={`${styles.chip} ${styles.chipAlert}`}>{t("orderEnum.CANCELLED")}</span> : null}
              {order.returnLabel ? <span className={styles.chip}>{enumText(t, order.returnLabel)}</span> : null}
              {order.adminUrl ? (
                <a className={styles.shopify} href={order.adminUrl} target="_blank" rel="noreferrer">
                  {t("orders.detail.openShopify")} <ExternalLinkIcon size={14} />
                </a>
              ) : null}
            </div>
            <p className={styles.meta}>
              {order.placedLabel} · {order.platformLabel}
              {order.channelLabel && order.channelLabel !== order.platformLabel ? ` (${order.channelLabel})` : ""}
              {order.cancelledLabel
                ? ` · ${t("orders.detail.cancelledOn", { when: order.cancelledLabel })}${order.cancelReason ? ` — ${enumText(t, order.cancelReason)}` : ""}`
                : ""}
            </p>
          </header>

          <div className={styles.layout}>
            <div className={styles.column}>
              <ArticlesCard order={order} />
              <PromotionsCard order={order} />
              <FulfilmentCard order={order} />
              <PaymentCard order={order} />
            </div>
            <div className={styles.column}>
              <TicketsCard order={order} />
              <CustomerCard order={order} />
              <DestinationCard order={order} />
              {order.tags.length > 0 ? (
                <Card title={t("orders.detail.tags")}>
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
  const t = getT();
  return (
    <Card title={t("orders.articles")} aside={t("insights.fulfilment.open.items", { count: order.units })}>
      {order.lineItems.length === 0 ? (
        <p className={styles.empty}>{t("orders.detail.noLines")}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t("insights.inventory.product")}</th>
                <th scope="col" className={styles.n}>
                  {t("orders.detail.qty")}
                </th>
                <th scope="col" className={styles.n}>
                  {t("orders.total")}
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
                        {[item.variantTitle, item.sku ? `${t("orders.detail.sku")} ${item.sku}` : null].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </td>
                  <td className={styles.n}>
                    {item.currentQuantity}
                    {item.currentQuantity < item.quantity ? (
                      <span className={styles.sub}>{t("orders.detail.removed", { n: item.quantity - item.currentQuantity })}</span>
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

/**
 * What was applied to this order, and what merely came with it.
 *
 * SAMPLES ARE LISTED APART, never as gifts. Both are lines at 0,00 €, and the
 * question this card exists to answer — « mon cadeau a-t-il été appliqué ? » —
 * is answered wrongly by pointing at an échantillon. A gift is a line whose
 * price went to zero because of a named promotion.
 *
 * "No promotion" is an answer too, so the card renders either way rather than
 * disappearing: a support agent needs to see that nothing was applied.
 */
function PromotionsCard({ order }: { order: OrderDetail }) {
  const t = getT();
  const { applied, gifts, reductions, samples, codes, totalLabel } = order.promotions;
  const nothing = applied.length === 0 && gifts.length === 0 && reductions.length === 0;

  return (
    <Card title={t("setup.tabs.promotions.label")} aside={totalLabel ? t("orders.detail.off", { amount: totalLabel }) : undefined}>
      {nothing ? (
        <p className={styles.empty}>{t("orders.detail.noPromo")}</p>
      ) : (
        <ul className={styles.stack}>
          {applied.map((promotion, index) => (
            <li key={`applied-${index}`} className={styles.shipment}>
              <div className={styles.shipmentHead}>
                <strong>{promotion.name ?? t("orders.detail.promotion")}</strong>
                {promotion.valueLabel ? <span className={styles.chip}>{promotion.valueLabel}</span> : null}
                {promotion.kind ? <span className={styles.sub}>{promotion.kind}</span> : null}
              </div>
            </li>
          ))}
          {gifts.map((gift, index) => (
            <li key={`gift-${index}`} className={styles.shipment}>
              <div className={styles.shipmentHead}>
                <strong>{t("orders.detail.gift")} · {gift.title}</strong>
                {gift.valueLabel ? <span className={styles.chip}>{t("orders.detail.worth", { amount: gift.valueLabel })}</span> : null}
              </div>
              {gift.promotion ? <p className={styles.sub}>{gift.promotion}</p> : null}
            </li>
          ))}
          {reductions.map((reduction, index) => (
            <li key={`reduction-${index}`} className={styles.shipment}>
              <div className={styles.shipmentHead}>
                <strong>{reduction.title}</strong>
                {reduction.offLabel ? <span className={styles.chip}>−{reduction.offLabel}</span> : null}
              </div>
              {reduction.promotion ? <p className={styles.sub}>{reduction.promotion}</p> : null}
            </li>
          ))}
        </ul>
      )}

      <Facts
        rows={[
          [t("orders.detail.codesUsed"), codes.length > 0 ? codes.join(", ") : null],
          // Never counted as a gift: these were never priced.
          [t("orders.detail.samples"), samples.length > 0 ? samples.join(", ") : null],
        ]}
      />
    </Card>
  );
}

function FulfilmentCard({ order }: { order: OrderDetail }) {
  const t = getT();
  return (
    <Card title={t("insights.panel.fulfilment")} aside={enumText(t, order.fulfillmentLabel)}>
      {order.fulfilments.length === 0 ? (
        <p className={styles.empty}>
          {order.cancelledLabel
            ? t("orders.detail.cancelledBefore")
            : order.fulfillmentStatus === "REFUNDED"
              ? t("orders.detail.refundedBefore")
              : t("insights.fulfilment.notShipped")}
        </p>
      ) : (
        <ul className={styles.stack}>
          {order.fulfilments.map((f) => (
            <li key={f.id} className={styles.shipment}>
              <div className={styles.shipmentHead}>
                <strong>{f.name ?? t("orders.detail.shipment")}</strong>
                <span className={styles.chip}>{enumText(t, f.statusLabel)}</span>
              </div>
              <Facts
                rows={[
                  [t("insights.fulfilment.shipped"), f.createdLabel],
                  [t("orderEnum.DELIVERED"), f.deliveredLabel],
                ]}
              />
              {f.tracking.length > 0 ? (
                <ul className={styles.tracking}>
                  {f.tracking.map((tk, i) => (
                    <li key={`${tk.number ?? "tracking"}-${i}`}>
                      <span className={styles.carrier}>{tk.company ?? t("insights.fulfilment.carrier")}</span>
                      {tk.number ? (
                        tk.url ? (
                          <a href={tk.url} target="_blank" rel="noreferrer" className={styles.trackingNumber}>
                            {tk.number}
                          </a>
                        ) : (
                          <span className={styles.trackingNumber}>{tk.number}</span>
                        )
                      ) : (
                        <span className={styles.muted}>{t("orders.detail.noTrackingNumber")}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.muted}>{t("orders.detail.noTracking")}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {order.returns.length > 0 ? (
        <div className={styles.subsection}>
          <h3 className={styles.subTitle}>{t("orders.detail.returns")}</h3>
          <ul className={styles.stack}>
            {order.returns.map((r) => (
              <li key={r.id} className={styles.line}>
                <span>{r.name ?? t("orders.detail.return")}</span>
                <span className={styles.muted}>
                  {enumText(t, r.statusLabel)}
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
  const t = getT();
  return (
    <Card title={t("orders.detail.payment")} aside={order.financialLabel ? enumText(t, order.financialLabel) : undefined}>
      <dl className={styles.money}>
        {order.money.map((line) => (
          <div key={line.label} className={line.strong ? styles.moneyStrong : styles.moneyRow}>
            <dt>{enumText(t, line.label, "orderMoney")}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      {order.refunds.length > 0 ? (
        <div className={styles.subsection}>
          <h3 className={styles.subTitle}>{t("orders.detail.refunds")}</h3>
          <ul className={styles.stack}>
            {order.refunds.map((r) => (
              <li key={r.id} className={styles.line}>
                <span className={styles.muted}>{r.createdLabel ?? t("orders.detail.dateUnknown")}</span>
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
  const t = getT();
  const open = order.tickets.filter((ticket) => ticket.open).length;
  return (
    <Card title={t("nav.tickets")} aside={order.tickets.length > 0 ? t("orders.detail.openN", { n: open }) : undefined}>
      {order.tickets.length === 0 ? (
        <p className={styles.empty}>{t("orders.detail.noTickets")}</p>
      ) : (
        <ul className={styles.stack}>
          {order.tickets.map((ticket) => (
            <li key={ticket.id} className={styles.ticket} data-band={ticket.open ? ticket.band : undefined}>
              <Link href="/tickets" className={styles.ticketSubject}>
                {ticket.subject || t("tickets.view.noSubject")}
              </Link>
              <span className={styles.sub}>
                {enumText(t, ticket.statusLabel)}
                {ticket.level ? ` · ${t(`level.${ticket.level}`)}` : ""}
                {ticket.open ? ` · ${t("orders.detail.priorityScore", { band: t(`tickets.view.priority.${ticket.band}`).toLowerCase(), score: ticket.score })}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CustomerCard({ order }: { order: OrderDetail }) {
  const t = getT();
  const { integer } = getFormat();
  const customer = order.customer;
  return (
    <Card title={t("insights.fulfilment.open.customer")}>
      {customer ? (
        <>
          <p className={styles.customerName}>
            {customer.name ?? <span className={styles.muted}>{t("insights.fulfilment.open.noName")}</span>}
            {customer.isVip ? (
              <span className={styles.vip} title={t("tickets.panels.vip")}>
                <CrownIcon size={14} /> VIP
              </span>
            ) : null}
          </p>
          {customer.email ? (
            <p className={styles.email}>{customer.email}</p>
          ) : (
            <p className={styles.muted}>{t("orders.detail.marketplaceBuyer")}</p>
          )}
          <Facts
            rows={[
              [t("insights.overview.orders"), customer.ordersCount === null ? null : integer(customer.ordersCount)],
              [t("insights.customers.totalSpent"), customer.spentLabel],
            ]}
          />
        </>
      ) : (
        <>
          <p className={styles.muted}>{t("orders.detail.noAccount")}</p>
          {order.maskedEmail ? <p className={styles.email}>{order.maskedEmail}</p> : null}
        </>
      )}
    </Card>
  );
}

function DestinationCard({ order }: { order: OrderDetail }) {
  const t = getT();
  const d = order.destination;
  return (
    <Card title={t("orders.destination")}>
      {d ? (
        <div className={styles.destination}>
          {d.countryCode ? <Flag code={d.countryCode} /> : null}
          <div>
            <p className={styles.place}>{[d.city, d.province].filter(Boolean).join(", ") || "—"}</p>
            <p className={styles.muted}>{d.country ?? d.countryCode}</p>
          </div>
        </div>
      ) : (
        <p className={styles.empty}>{t("orders.detail.noAddress")}</p>
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
