"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ProductCustomerMix } from "@/lib/types";
import { ChevronDownIcon, SearchIcon } from "@/components/icons";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { foldForSearch } from "@/lib/insights-format";
import { countryName } from "@/lib/insights-labels";
import { ColumnChart } from "./ColumnChart";
import { useInsightsFrame } from "./InsightsFrame";
import { GroupSelect, Segmented } from "./Segmented";
import styles from "./ProductCustomerMixCard.module.css";

type Option = ProductCustomerMix["options"][number];
type Who = "all" | "vip";

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
  const t = useT();
  const locale = useLocale();
  const { integer, percent } = useFormat();
  const { navigate, pending } = useInsightsFrame();
  const WHO: { id: Who; label: string }[] = [
    { id: "all", label: t("insights.sales.allCustomers") },
    { id: "vip", label: t("insights.sales.vipOnly") },
  ];

  if (mix.blockedReason) {
    return <p className={styles.empty}>{t(mix.blockedReason)}</p>;
  }
  if (!mix.selected) {
    return <p className={styles.empty}>{t("insights.sales.mix.noProduct")}</p>;
  }

  const { selected, customers } = mix;
  // Its buyers: the two buckets that bought it. The distribution describes them
  // and nobody else, so it is their total the shares divide by.
  const buyers = mix.onlyCustomers + mix.withOtherCustomers;
  const countryEntry = mix.countries.find((c) => c.code === mix.country) ?? null;
  const countryLabel = countryEntry ? countryName(countryEntry.code, countryEntry.label, locale) : null;
  const group = [countryLabel ? t("insights.sales.mix.deliveredTo", { country: countryLabel }) : null, mix.vipOnly ? t("insights.sales.mix.vipOnlyGroup") : null]
    .filter(Boolean)
    .join(", ");

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <span className={styles.selectLabel} id="product-customer-mix-label">
          {t("insights.inventory.product")}
        </span>
        <ProductPicker
          options={mix.options}
          value={selected.productId}
          disabled={pending}
          labelledBy="product-customer-mix-label"
          onPick={(productId) => navigate({ product: productId })}
        />
      </div>

      <div className={styles.filters} aria-label={t("insights.sales.mix.whichCustomers")}>
        <GroupSelect
          label={t("insights.sales.country")}
          value={mix.country ?? ALL_COUNTRIES}
          onChange={(code) => navigate({ mixCountry: code || null })}
          groups={[
            { key: ALL_COUNTRIES, label: t("insights.sales.mix.allCountries") },
            ...mix.countries.map((c) => ({ key: c.code, label: countryName(c.code, c.label, locale) })),
          ]}
        />
        <Segmented
          options={WHO}
          value={mix.vipOnly ? "vip" : "all"}
          label={t("insights.sales.customers")}
          onChange={(next) => navigate({ mixVip: next === "vip" ? "1" : null })}
        />
      </div>

      {mix.notice ? (
        <p className={styles.empty} role="status">
          {t(mix.notice)}
        </p>
      ) : (
        <>
      <div className={styles.stats} aria-label={t("insights.sales.mix.split", { title: selected.title })}>
        <Metric label={t("insights.sales.mix.only")} value={mix.onlyCustomers} total={customers} />
        <Metric label={t("insights.sales.mix.without")} value={mix.withoutCustomers} total={customers} />
        <Metric label={t("insights.sales.mix.withOther")} value={mix.withOtherCustomers} total={customers} />
      </div>

      <div className={styles.chartBlock}>
        <div className={styles.chartHead}>
          <h3>{t("insights.sales.mix.buyersByOrders")}</h3>
          <span>{t("insights.sales.mix.buyers", { count: buyers, n: integer(buyers) })}</span>
        </div>
        {buyers > 0 ? (
          <ColumnChart
            unit="count"
            ariaLabel={t("insights.sales.mix.chartLabel", { title: selected.title })}
            xTitle={t("insights.sales.mix.xTitle")}
            height={220}
            series={[{ label: t("insights.sales.customers"), color: "var(--chart-line)" }]}
            data={mix.ordersPerBuyer.map((b) => ({
              key: String(b.orders),
              label: b.orMore ? `${b.orders}+` : String(b.orders),
              title: b.orMore ? t("insights.sales.mix.orMore", { n: b.orders }) : t("insights.sales.ordersCount", { count: b.orders }),
              segments: [b.customers],
              top:
                b.customers === 0
                  ? undefined
                  : b.customers / buyers < 0.005
                    ? "<1%"
                    : percent(b.customers, buyers, 0),
              note: t("insights.sales.mix.ofBuyers", { pct: percent(b.customers, buyers) }),
            }))}
          />
        ) : (
          <p className={styles.empty}>{t("insights.sales.mix.nobody")}</p>
        )}
      </div>

      <div className={styles.tableBlock}>
        <div className={styles.tableHead}>
          <h3>{t("insights.sales.mix.orderedWith")}</h3>
          <span>{t("insights.sales.customers")}</span>
        </div>
        {mix.alsoBought.length > 0 ? (
          <ol className={styles.rows}>
            {mix.alsoBought.map((product, index) => (
              <li key={product.productId} className={styles.row}>
                <span className={styles.rank}>{index + 1}</span>
                <span className={styles.product} title={product.title}>
                  {product.title}
                </span>
                <span className={styles.count}>{integer(product.customers)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.empty}>{t("insights.sales.mix.noOthers")}</p>
        )}
      </div>

      <p className={styles.caption}>
        {t("insights.sales.mix.caption", { n: integer(customers), group: group ? ` (${group})` : "" })}
        {countryLabel ? ` ${t("insights.sales.mix.captionCountry", { country: countryLabel })}` : ""}
        {mix.vipOnly ? ` ${t("insights.sales.mix.captionVip")}` : ""} {t("insights.sales.mix.captionEnd")}
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
  const t = useT();
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
          {selected?.title ?? t("insights.sales.mix.choose")}
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
              placeholder={t("insights.sales.mix.searchN", { n: options.length })}
              aria-label={t("insights.sales.mix.search")}
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
              {t("insights.sales.noMatchGlobal", { query: query.trim() })}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value, total }: { label: string; value: number; total: number }) {
  const t = useT();
  const { integer, percentOf } = useFormat();
  const share = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <strong>{integer(value)}</strong>
      <span className={styles.metricShare}>{t("insights.sales.mix.ofCustomers", { pct: percentOf(share, 0) })}</span>
    </div>
  );
}
