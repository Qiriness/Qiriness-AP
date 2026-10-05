"use client";

import { useMemo, useState } from "react";
import { foldForSearch } from "@/lib/insights-format";
import { formatMoney } from "@/lib/i18n/format";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import type { PaidCampaign } from "@/lib/social-types";
import t from "./tables.module.css";
import styles from "./SocialView.module.css";

type SortKey = "spend" | "impressions" | "clicks" | "ctr" | "conversions" | "conversionValue" | "roas" | "cpa";
const SORTS: SortKey[] = ["spend", "impressions", "clicks", "ctr", "conversions", "conversionValue", "roas", "cpa"];
const ACTIVE = new Set(["ACTIVE", "ENABLED"]);

/**
 * Every campaign that delivered in the range, Meta and Google side by side,
 * each opening in its own ads interface. Money is printed in each campaign's
 * own currency and never summed here. Rank is the place in the current sort,
 * so a search keeps it. A rate whose denominator is zero is a dash and sorts
 * last whichever way the column runs.
 */
export function PaidCampaignsTable({ campaigns, capped }: { campaigns: PaidCampaign[]; capped: boolean }) {
  const tr = useT();
  const locale = useLocale();
  const { integer, decimal, percentOf } = useFormat();
  const [query, setQuery] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("spend");
  const [desc, setDesc] = useState(true);

  const ranked = useMemo(() => {
    const sorted = [...campaigns].sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return desc ? bv - av : av - bv;
    });
    return sorted.map((campaign, i) => ({ campaign, rank: i + 1 }));
  }, [campaigns, sort, desc]);
  const needle = foldForSearch(query.trim());
  const shown = ranked.filter(
    ({ campaign }) =>
      (!activeOnly || ACTIVE.has(campaign.status ?? "")) &&
      (!needle || foldForSearch(`${campaign.name ?? ""} ${campaign.accountName ?? ""}`).includes(needle))
  );

  const money = (value: number | null, currency: string) =>
    value === null ? "—" : formatMoney(value, currency, locale, { maximumFractionDigits: 2 });
  const header = (key: SortKey) => (
    <th key={key} className={t.n} aria-sort={sort === key ? (desc ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        className={styles.sortButton}
        onClick={() => {
          if (sort === key) setDesc(!desc);
          else {
            setSort(key);
            // A cost reads best lowest first; everything else highest first.
            setDesc(key !== "cpa");
          }
        }}
      >
        {tr(`insights.social.campaigns.col.${key}`)} {sort === key ? (desc ? "↓" : "↑") : "↕"}
      </button>
    </th>
  );

  if (campaigns.length === 0) return <p className={t.muted}>{tr("insights.social.campaigns.none")}</p>;

  return (
    <>
      <div className={styles.tableTools}>
        <input
          className={styles.search}
          type="search"
          placeholder={tr("insights.social.campaigns.search")}
          aria-label={tr("insights.social.campaigns.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          {tr("insights.social.campaigns.activeOnly")}
        </label>
      </div>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th className={t.n}>#</th>
              <th>{tr("insights.social.campaigns.col.campaign")}</th>
              <th>{tr("insights.social.campaigns.col.platform")}</th>
              {SORTS.map(header)}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ campaign: c, rank }) => (
              <tr key={c.key}>
                <td className={t.n}>{rank}</td>
                <th>
                  <span className={styles.linkCell}>
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer" title={tr(`insights.social.campaigns.open.${c.kind}`)}>
                        {c.name ?? c.campaignId}
                        <span className={styles.external} aria-hidden="true">
                          ↗
                        </span>
                        <span className={t.srOnly}> ({tr(`insights.social.campaigns.open.${c.kind}`)})</span>
                      </a>
                    ) : (
                      <strong>{c.name ?? c.campaignId}</strong>
                    )}
                  </span>
                  <span className={t.sub}>
                    {[c.status ? tr(`insights.social.campaigns.status.${statusKey(c.status)}`) : null, c.objective ? prettify(c.objective) : null, c.accountName]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </th>
                <td>
                  <span className={styles.badge}>{tr(`insights.social.kind.${c.kind}`)}</span>
                </td>
                <td className={t.n}>{money(c.spend, c.currency)}</td>
                <td className={t.n}>{integer(c.impressions)}</td>
                <td className={t.n}>{integer(c.clicks)}</td>
                <td className={t.n}>{c.ctr === null ? "—" : percentOf(c.ctr, 2)}</td>
                <td className={t.n}>{decimal(c.conversions, c.conversions % 1 ? 1 : 0)}</td>
                <td className={t.n}>{money(c.conversionValue, c.currency)}</td>
                <td className={t.n}>{c.roas === null ? "—" : `${decimal(c.roas, 2)}×`}</td>
                <td className={t.n}>{money(c.cpa, c.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {capped ? <p className={t.muted}>{tr("insights.social.campaigns.capped", { n: campaigns.length })}</p> : null}
    </>
  );
}

/** Meta's effective statuses and Google's statuses, folded into four words. */
function statusKey(status: string): "active" | "paused" | "removed" | "other" {
  if (ACTIVE.has(status)) return "active";
  if (/PAUSED/.test(status)) return "paused";
  if (/DELETED|ARCHIVED|REMOVED/.test(status)) return "removed";
  return "other";
}

/** OUTCOME_SALES -> Sales, PERFORMANCE_MAX -> Performance max. */
function prettify(value: string): string {
  const words = value.replace(/^OUTCOME_/, "").toLowerCase().split("_");
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
