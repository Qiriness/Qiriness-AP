"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ProductCustomerMix } from "@/lib/types";
import { ChevronDownIcon, SearchIcon } from "@/components/icons";
import { foldForSearch, percent } from "@/lib/insights-format";
import { ColumnChart } from "./ColumnChart";
import { useInsightsFrame } from "./InsightsFrame";
import { GroupSelect, Segmented } from "./Segmented";
import styles from "./ProductCustomerMixCard.module.css";

type Option = ProductCustomerMix["options"][number];
type Who = "all" | "vip";

const WHO: { id: Who; label: string }[] = [
  { id: "all", label: "All customers" },
  { id: "vip", label: "VIP only" },
];

/** The value the country select uses for "no country filter". */
const ALL_COUNTRIES = "";

/**
 * Pick a product; see how the range's customers split around it — bought only
 * it, did not buy it, bought it with something else — and what else its buyers
 * took.
 *
 * The selection is `?product=` in the URL, like every Insights filter, so the
 * server computes one product at a time and a chosen product survives a range
 * change and a shared link. Choosing re-renders the panel (dimmed meanwhile).
 */
export function ProductCustomerMixCard({ mix }: { mix: ProductCustomerMix }) {
  const { navigate, pending } = useInsightsFrame();

  if (mix.blockedReason) {
    return <p className={styles.empty}>{mix.blockedReason}</p>;
  }
  if (!mix.selected) {
    return <p className={styles.empty}>No paid product was sold in this range.</p>;
  }

  const { selected, customers } = mix;
  // Its buyers: the two buckets that bought it. The distribution describes them
  // and nobody else, so it is their total the shares divide by.
  const buyers = mix.onlyCustomers + mix.withOtherCustomers;
  const countryLabel = mix.countries.find((c) => c.code === mix.country)?.label ?? null;
  const group = [countryLabel ? `delivered to ${countryLabel}` : null, mix.vipOnly ? "VIP customers only" : null]
    .filter(Boolean)
    .join(", ");

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <span className={styles.selectLabel} id="product-customer-mix-label">
          Product
        </span>
        <ProductPicker
          options={mix.options}
          value={selected.productId}
          disabled={pending}
          labelledBy="product-customer-mix-label"
          onPick={(productId) => navigate({ product: productId })}
        />
      </div>

      <div className={styles.filters} aria-label="Which customers to count">
        <GroupSelect
          label="Country"
          value={mix.country ?? ALL_COUNTRIES}
          onChange={(code) => navigate({ mixCountry: code || null })}
          groups={[
            { key: ALL_COUNTRIES, label: "All countries" },
            ...mix.countries.map((c) => ({ key: c.code, label: c.label })),
          ]}
        />
        <Segmented
          options={WHO}
          value={mix.vipOnly ? "vip" : "all"}
          label="Customers"
          onChange={(next) => navigate({ mixVip: next === "vip" ? "1" : null })}
        />
      </div>

      {mix.notice ? (
        <p className={styles.empty} role="status">
          {mix.notice}
        </p>
      ) : (
        <>
      <div className={styles.stats} aria-label={`Customer split for ${selected.title}`}>
        <Metric label="Bought only this product" value={mix.onlyCustomers} total={customers} />
        <Metric label="Did not order it" value={mix.withoutCustomers} total={customers} />
        <Metric label="Ordered it with other products" value={mix.withOtherCustomers} total={customers} />
      </div>

      <div className={styles.chartBlock}>
        <div className={styles.chartHead}>
          <h3>Buyers by number of orders carrying it</h3>
          <span>
            {buyers.toLocaleString("en-GB")} {buyers === 1 ? "buyer" : "buyers"}
          </span>
        </div>
        {buyers > 0 ? (
          <ColumnChart
            unit="count"
            ariaLabel={`Customers who bought ${selected.title} by how many of their orders carried it`}
            xTitle="Orders carrying this product"
            height={220}
            series={[{ label: "Customers", color: "var(--chart-line)" }]}
            data={mix.ordersPerBuyer.map((b) => ({
              key: String(b.orders),
              label: b.orMore ? `${b.orders}+` : String(b.orders),
              title: b.orMore ? `${b.orders} or more orders` : `${b.orders} ${b.orders === 1 ? "order" : "orders"}`,
              segments: [b.customers],
              top:
                b.customers === 0
                  ? undefined
                  : b.customers / buyers < 0.005
                    ? "<1%"
                    : percent(b.customers, buyers, 0),
              note: `${percent(b.customers, buyers)} of its buyers`,
            }))}
          />
        ) : (
          <p className={styles.empty}>Nobody in this group bought it, so there is nothing to count orders over.</p>
        )}
      </div>

      <div className={styles.tableBlock}>
        <div className={styles.tableHead}>
          <h3>Ordered with</h3>
          <span>Customers</span>
        </div>
        {mix.alsoBought.length > 0 ? (
          <ol className={styles.rows}>
            {mix.alsoBought.map((product, index) => (
              <li key={product.productId} className={styles.row}>
                <span className={styles.rank}>{index + 1}</span>
                <span className={styles.product} title={product.title}>
                  {product.title}
                </span>
                <span className={styles.count}>{product.customers.toLocaleString("en-GB")}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.empty}>Nobody who bought this product bought another paid product in this range.</p>
        )}
      </div>

      <p className={styles.caption}>
        Out of {customers.toLocaleString("en-GB")} Shopify customers who ordered in this range
        {group ? ` (${group})` : ""}; Amazon and Yves Rocher orders are not counted.
        {countryLabel ? ` Only orders delivered to ${countryLabel} are counted, including for “ordered with”.` : ""}
        {mix.vipOnly ? " VIP follows the shop’s rule over its own window, not this range." : ""} Free items (samples,
        promotional masques) are ignored, so a sample alongside the product still counts as buying only this product.
        &ldquo;Ordered with&rdquo; covers the whole range, not just the same order. The chart counts its buyers only
        &mdash; everyone else is the &ldquo;did not order it&rdquo; figure above &mdash; and one order carrying two jars
        is one order, as on Customers &rarr; Customers by number of orders.
      </p>
        </>
      )}
    </div>
  );
}

/**
 * A product dropdown with a search box — a native `<select>` cannot hold one.
 *
 * Click or Enter opens it with the search focused; typing filters (case- and
 * accent-insensitive, like Best products); arrows move, Enter picks, Escape or
 * a click outside closes and returns focus to the button. ARIA 1.2 combobox:
 * the input owns the listbox and names the highlighted option through
 * `aria-activedescendant`, so focus never leaves the box while arrowing.
 */
function ProductPicker({
  options,
  value,
  disabled,
  labelledBy,
  onPick,
}: {
  options: Option[];
  value: string;
  disabled: boolean;
  labelledBy: string;
  onPick: (productId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.productId === value) ?? null;
  const needle = foldForSearch(query);
  const matches = useMemo(
    () => (needle ? options.filter((o) => foldForSearch(o.title).includes(needle)) : options),
    [options, needle]
  );

  const openPicker = () => {
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.productId === value)));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const pick = (option: Option) => {
    close(true);
    if (option.productId !== value) onPick(option.productId);
  };

  // Focus the search as it opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // A click anywhere outside closes it, without stealing that click's focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted option in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <div className={styles.picker} ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.pickerButton}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelledBy} ${listId}-value`}
        disabled={disabled}
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openPicker();
          }
        }}
      >
        <span id={`${listId}-value`} className={styles.pickerValue}>
          {selected?.title ?? "Choose a product"}
        </span>
        <ChevronDownIcon size={16} className={open ? styles.chevronOpen : styles.chevron} />
      </button>

      {open ? (
        <div className={styles.pickerPanel}>
          <div className={styles.pickerSearch}>
            <SearchIcon size={15} className={styles.pickerSearchIcon} />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              className={styles.pickerInput}
              placeholder={`Search ${options.length} products`}
              aria-label="Search products"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={matches[active] ? optionId(active) : undefined}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((i) => Math.min(i + 1, matches.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((i) => Math.max(i - 1, 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (matches[active]) pick(matches[active]);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  close(true);
                } else if (event.key === "Tab") {
                  close(false);
                }
              }}
            />
          </div>

          {matches.length > 0 ? (
            <ul id={listId} ref={listRef} role="listbox" aria-labelledby={labelledBy} className={styles.pickerList}>
              {matches.map((option, index) => {
                const isSelected = option.productId === value;
                return (
                  <li
                    key={option.productId}
                    id={optionId(index)}
                    data-index={index}
                    role="option"
                    aria-selected={isSelected}
                    className={[
                      styles.option,
                      index === active ? styles.optionActive : "",
                      isSelected ? styles.optionSelected : "",
                    ].join(" ")}
                    // mousedown would blur the input before the click lands.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(option)}
                  >
                    {option.title}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className={styles.pickerEmpty} role="status">
              No product matching &ldquo;{query.trim()}&rdquo; sold in this range.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value, total }: { label: string; value: number; total: number }) {
  const share = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <strong>{value.toLocaleString("en-GB")}</strong>
      <span className={styles.metricShare}>{share}% of customers</span>
    </div>
  );
}
