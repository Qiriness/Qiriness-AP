"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CrownIcon, SearchIcon } from "@/components/icons";
import { fulfillmentStatusLabel, normaliseSearch } from "../../../scripts/lib/order-list-query.mjs";
import { Flag } from "@/components/insights/Flag";
import { GroupSelect, Segmented } from "@/components/insights/Segmented";
import { useFormat, useT } from "@/lib/i18n/client";
import { enumText } from "@/lib/order-enums";
import type { OrderListPage, OrderListRow } from "@/lib/types";
import styles from "./OrdersView.module.css";

type Scope = "global" | "country";
type Who = "all" | "vip";

/**
 * Every order, newest first, as the Shopify admin lists them.
 *
 * Filters write the URL and the server re-renders; while it does, the current
 * page stays on screen dimmed rather than flashing empty. A row opens the order.
 *
 * THE RING ON THE NAME says an open ticket is confirmed against that order, in
 * the colour of its queue band. No ring means no open ticket — which is also
 * what an order looks like whose ticket never quoted an order number, so the
 * ring can be trusted when present and says nothing when absent.
 */
export function OrdersView({ page, loadError }: { page: OrderListPage | null; loadError: string | null }) {
  const t = useT();
  const { integer } = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const navigate = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params?.toString() ?? "");
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      // A filter change starts again at the first page; only the pager moves it.
      if (!("page" in patch)) next.delete("page");
      const query = next.toString();
      startTransition(() => router.push(query ? `${pathname}?${query}` : pathname, { scroll: false }));
    },
    [params, pathname, router]
  );

  const openOrder = (orderId: string) => startTransition(() => router.push(`/orders/${orderId}`));

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t("nav.orders")}</h1>
        {page ? (
          <p className={styles.subtitle}>
            {isFiltered(page)
              ? t("orders.matchFilters", { count: page.total, n: integer(page.total) })
              : t("orders.count", { count: page.total, n: integer(page.total) })}{" "}
            · {t("orders.asOfSync")}
          </p>
        ) : null}
      </header>

      {loadError ? (
        <p className={styles.error} role="alert">
          {loadError}
        </p>
      ) : null}

      {page ? (
        <>
          <Filters page={page} navigate={navigate} pending={pending} />

          <section className={styles.card} aria-busy={pending}>
            <div className={pending ? styles.pending : undefined}>
              {page.query.vip && !page.vipRuleSet ? (
                <p className={styles.empty}>
                  {t("insights.fulfilment.open.noRule")}{" "}
                  <Link href="/insights/customers">{t("insights.fulfilment.open.setOne")}</Link>.
                </p>
              ) : page.rows.length === 0 ? (
                <p className={styles.empty}>
                  {page.query.search ? t("orders.noMatchQuery", { query: page.query.search }) : t("orders.noMatch")}
                </p>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">{t("insights.sales.mix.orderShort")}</th>
                        <th scope="col">{t("orders.date")}</th>
                        <th scope="col">{t("orders.name")}</th>
                        <th scope="col" className={styles.n}>
                          {t("orders.total")}
                        </th>
                        <th scope="col">{t("orders.fulfilmentStatus")}</th>
                        <th scope="col" className={styles.n} title={t("orders.delayHint")}>
                          {t("orders.delay")}
                        </th>
                        <th scope="col" className={styles.n}>
                          {t("orders.articles")}
                        </th>
                        <th scope="col">{t("insights.fulfilment.carrier")}</th>
                        <th scope="col">{t("orders.destination")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.rows.map((row) => (
                        <OrderRow key={row.orderId} row={row} onOpen={openOrder} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <footer className={styles.footer}>
              <p className={styles.legend}>
                <span className={styles.legendSwatches} aria-hidden="true">
                  <span className={styles.ring} data-band="high" />
                  <span className={styles.ring} data-band="medium" />
                  <span className={styles.ring} data-band="low" />
                </span>
                {t("orders.ringLegend")}
              </p>
              <Pager page={page} navigate={navigate} pending={pending} />
            </footer>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Filters({
  page,
  navigate,
  pending,
}: {
  page: OrderListPage;
  navigate: (patch: Record<string, string | null>) => void;
  pending: boolean;
}) {
  const t = useT();
  const { integer } = useFormat();
  const SCOPES: { id: Scope; label: string }[] = [
    { id: "global", label: t("insights.sales.global") },
    { id: "country", label: t("insights.sales.byCountryTab") },
  ];
  const WHO: { id: Who; label: string }[] = [
    { id: "all", label: t("insights.sales.allCustomers") },
    { id: "vip", label: t("insights.sales.vipOnly") },
  ];
  const { query, facets } = page;
  const scope: Scope = query.country ? "country" : "global";
  // THE ACTIVE STATUS IS ALWAYS AN OPTION. Facets list only statuses some order
  // has, so a link to one that has emptied (`?status=UNFULFILLED` once every
  // such order read Cancelled or Refunded) left the select with no matching
  // option: it displayed "All fulfilment statuses" over an empty list, and
  // choosing "All" fired no change, because it already looked chosen.
  const statuses =
    query.status && !facets.statuses.some((f) => f.value === query.status)
      ? [...facets.statuses, { value: query.status, label: fulfillmentStatusLabel(query.status), orders: 0 }]
      : facets.statuses;

  return (
    <div className={styles.filters} data-pending={pending || undefined}>
      <SearchBox value={query.search} onSearch={(text) => navigate({ q: text })} />

      <label className={styles.field}>
        <span className={styles.srOnly}>{t("orders.fulfilmentStatus")}</span>
        <select
          className={styles.select}
          value={query.status ?? ""}
          onChange={(event) => navigate({ status: event.target.value || null })}
        >
          <option value="">{t("orders.allStatuses")}</option>
          {statuses.map((f) => (
            <option key={f.value} value={f.value}>
              {enumText(t, f.label)} — {integer(f.orders)}
            </option>
          ))}
        </select>
      </label>

      <div className={styles.group}>
        <Segmented
          options={SCOPES}
          value={scope}
          label={t("orders.destination")}
          onChange={(next) =>
            navigate({ country: next === "global" ? null : query.country ?? facets.countries[0]?.value ?? null })
          }
        />
        {scope === "country" ? (
          <GroupSelect
            label={t("insights.sales.country")}
            value={query.country ?? ""}
            onChange={(value) => navigate({ country: value })}
            groups={facets.countries.map((c) => ({
              key: c.value,
              label: c.label,
              hint: t("insights.sales.ordersCount", { count: c.orders }),
            }))}
          />
        ) : null}
      </div>

      <Segmented
        options={WHO}
        value={query.vip ? "vip" : "all"}
        label={t("insights.sales.customers")}
        onChange={(next) => navigate({ vip: next === "vip" ? "true" : null })}
      />
    </div>
  );
}

/** How long typing pauses before the list re-reads — long enough not to query per keystroke. */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * Searches as you type, after a pause; Enter searches at once, Escape clears.
 *
 * THE BOX OWNS ITS TEXT WHILE YOU TYPE. The URL is the state, but a server
 * render for "mar" landing after you have typed "martin" must not put "mar"
 * back in the box — so the URL only overwrites the text when it changed for a
 * reason other than this box's own last search (a Back button, a shared link).
 */
function SearchBox({ value, onSearch }: { value: string | null; onSearch: (text: string | null) => void }) {
  const t = useT();
  const [text, setText] = useState(value ?? "");
  const lastSent = useRef<string | null>(value);

  useEffect(() => {
    if (value !== lastSent.current) {
      lastSent.current = value;
      setText(value ?? "");
    }
  }, [value]);

  const submit = useCallback(
    (raw: string) => {
      const next = normaliseSearch(raw) as string | null;
      if (next === lastSent.current) return;
      lastSent.current = next;
      onSearch(next);
    },
    [onSearch]
  );

  useEffect(() => {
    const timer = setTimeout(() => submit(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, submit]);

  return (
    <div className={styles.search} role="search">
      <SearchIcon size={16} className={styles.searchIcon} />
      <input
        type="search"
        className={styles.searchInput}
        value={text}
        placeholder={t("orders.searchPlaceholder")}
        aria-label={t("orders.search")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit(text);
          if (event.key === "Escape") {
            setText("");
            submit("");
          }
        }}
      />
    </div>
  );
}

function OrderRow({ row, onOpen }: { row: OrderListRow; onOpen: (orderId: string) => void }) {
  const t = useT();
  return (
    <tr
      className={styles.row}
      onClick={(event) => {
        // The order number is a real link (keyboard, middle-click, new tab);
        // let it do its own navigation rather than firing twice.
        if ((event.target as HTMLElement).closest("a")) return;
        onOpen(row.orderId);
      }}
    >
      <th scope="row">
        <Link href={`/orders/${row.orderId}`} className={styles.orderLink}>
          {row.name}
        </Link>
        {row.cancelled ? <span className={styles.cancelled}>{t("orderEnum.CANCELLED")}</span> : null}
      </th>
      <td className={styles.date}>{row.placedLabel}</td>
      <td>
        <span className={`${styles.name} ${styles.ring}`} data-band={row.ticket?.band} title={ticketNote(row, t)}>
          <span className={styles.nameText}>{row.customerName ?? <span className={styles.muted}>{t("orders.noCustomer")}</span>}</span>
          {row.ticket ? <span className={styles.srOnly}>{ticketNote(row, t)}</span> : null}
          {row.isVip ? (
            <span className={styles.crown} title={t("tickets.panels.vip")}>
              <CrownIcon size={14} />
              <span className={styles.srOnly}>{t("tickets.panels.vip")}</span>
            </span>
          ) : null}
        </span>
      </td>
      <td className={styles.n}>{row.totalLabel}</td>
      <td>
        <span className={styles.status} data-status={row.fulfillmentStatus}>
          <span className={styles.statusDot} aria-hidden="true" />
          {enumText(t, row.fulfillmentLabel)}
        </span>
      </td>
      <td className={styles.n}>
        {row.delayDays === null ? (
          <span className={styles.muted}>—</span>
        ) : (
          <span className={row.late ? styles.late : styles.delay} title={row.late ? t("orders.lateHint") : undefined}>
            {t("insights.fulfilment.open.days", { count: row.delayDays })}
          </span>
        )}
      </td>
      <td className={styles.n}>
        {t("insights.fulfilment.open.items", { count: row.units })}
      </td>
      <td>{row.carrier ?? <span className={styles.muted}>—</span>}</td>
      <td>
        <Destination row={row} />
      </td>
    </tr>
  );
}

function Destination({ row }: { row: OrderListRow }) {
  const t = useT();
  const place = [row.city, row.country].filter(Boolean).join(", ");
  return (
    <span className={styles.destination}>
      {row.countryCode ? <Flag code={row.countryCode} /> : null}
      <span className={styles.place}>{place || <span className={styles.muted}>{t("orders.noDestination")}</span>}</span>
    </span>
  );
}

/** The ring's tooltip and screen-reader text, or undefined when there is no open ticket. */
function ticketNote(row: OrderListRow, t: (key: string, params?: Record<string, string | number>) => string): string | undefined {
  const mark = row.ticket;
  if (!mark) return undefined;
  return t("orders.ticketNote", { count: mark.openTickets, band: t(`tickets.view.priority.${mark.band}`).toLowerCase() });
}

function Pager({
  page,
  navigate,
  pending,
}: {
  page: OrderListPage;
  navigate: (patch: Record<string, string | null>) => void;
  pending: boolean;
}) {
  const t = useT();
  const { integer } = useFormat();
  const { total, pageSize, query } = page;
  const last = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (query.page - 1) * pageSize + 1;
  const to = Math.min(total, query.page * pageSize);
  const goTo = (n: number) => navigate({ page: n > 1 ? String(n) : null });

  return (
    <nav className={styles.pager} aria-label={t("orders.pages")}>
      <span className={styles.range}>
        {t("orders.range", { from: integer(from), to: integer(to), total: integer(total) })}
      </span>
      <button type="button" className={styles.pageBtn} disabled={pending || query.page <= 1} onClick={() => goTo(query.page - 1)}>
        {t("orders.previous")}
      </button>
      <span className={styles.pageOf}>
        {t("orders.pageOf", { page: query.page, last })}
      </span>
      <button type="button" className={styles.pageBtn} disabled={pending || query.page >= last} onClick={() => goTo(query.page + 1)}>
        {t("orders.next")}
      </button>
    </nav>
  );
}

function isFiltered(page: OrderListPage): boolean {
  return Boolean(page.query.status || page.query.country || page.query.vip || page.query.search);
}
