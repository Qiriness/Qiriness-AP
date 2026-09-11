"use client";

import { useState } from "react";
import type { CountrySale } from "@/lib/types";
import { euros } from "@/lib/insights-format";
import { Flag } from "./Flag";
import styles from "./CountrySales.module.css";

/** How many countries show before the list is opened. */
const FOLDED = 5;

/**
 * Net revenue by destination country, as the reference card draws it: a flag,
 * the country, the revenue, and a bar scaled against the largest. The first few
 * rows show; the chevron opens the rest.
 */
export function CountrySales({ countries }: { countries: CountrySale[] }) {
  const [open, setOpen] = useState(false);
  const max = Math.max(1, ...countries.map((c) => c.revenue));
  const shown = open ? countries : countries.slice(0, FOLDED);
  const hidden = countries.length - FOLDED;

  if (countries.length === 0) return <p className={styles.empty}>No orders in this range.</p>;

  return (
    <div>
      <ul className={styles.list}>
        {shown.map((c) => (
          <li key={c.code} className={styles.row} title={`${c.orders.toLocaleString("en-GB")} orders`}>
            <div className={styles.head}>
              <span className={styles.name}>
                <Flag code={c.code} />
                {c.label}
              </span>
              <span className={styles.value}>{euros(c.revenue, { cents: true })}</span>
            </div>
            <span className={styles.track}>
              <span className={styles.fill} style={{ width: `${((c.revenue / max) * 100).toFixed(2)}%` }} />
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Show fewer countries" : `Show ${hidden} more ${hidden === 1 ? "country" : "countries"}`}
        >
          <span className={styles.toggleText}>{open ? "Show fewer" : `${hidden} more`}</span>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className={open ? styles.up : undefined}>
            <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
