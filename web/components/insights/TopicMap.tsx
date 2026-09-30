"use client";

import { useMemo, useState } from "react";
import { useInsightsFrame } from "./InsightsFrame";
import type { SupportCategoryRow, TopicCluster, TopicMap as TopicMapData } from "@/lib/types";
import { useFormat, useT } from "@/lib/i18n/client";
import type { Translate } from "@/lib/i18n/translate";
import {
  RAMP_STEPS,
  clusterLabel,
  corpusBaseline,
  corpusDrift,
  rampStepRange,
  sliceAndDice,
  unhappinessStep,
  type TreemapInput,
} from "@/lib/insights-support";
import { EmptyState } from "./InsightsKit";
import styles from "./TopicMap.module.css";

/**
 * What the inbox is about, drawn to scale. One client component because the
 * table sorts on click and the rebuild button posts; the panel around it stays
 * a Server Component.
 */

interface ClusterNode extends TreemapInput {
  label: string;
  subject: string;
  subjectLabel: string;
  clusterIndex: number;
  meanHappiness: number | null;
  cohesion: number | null;
}

type SortKey = "label" | "subject" | "size" | "cohesion" | "meanHappiness";

export function TopicMap({ map, categories }: { map: TopicMapData; categories: SupportCategoryRow[] }) {
  const t = useT();
  const { integer, percentOf, decimal } = useFormat();
  const clusters = useMemo(() => buildClusterTiles(map.clusters, categories, t), [map.clusters, categories, t]);
  const clustered = clusters.reduce((sum, cluster) => sum + cluster.size, 0);
  const rows = useMemo(() => sliceAndDice(clusters), [clusters]);

  const baseline = corpusBaseline(map.messageCount, map.internalExcluded);
  const drift = corpusDrift(map.liveMessageCount, baseline);

  if (clusters.length === 0) {
    return (
      <div className={styles.wrap}>
        <StalenessBanner map={map} drift={drift} baseline={baseline} />
        <EmptyState>
          {t("insights.support.map.empty", { min: map.minSize, threshold: map.threshold })}
        </EmptyState>
        <RebuildButton />
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <StalenessBanner map={map} drift={drift} baseline={baseline} />

      <figure className={styles.figure}>
        <figcaption className={styles.caption}>
          <span className={styles.capTitle}>{t("insights.support.map.volume")}</span>
        </figcaption>

        <ul className={styles.map}>
          {rows.map((row) => (
            <li key={row.key} className={styles.row} style={{ flex: `${row.heightPct} 1 0%` }}>
              <ul className={styles.rowInner}>
                {row.tiles.map(({ item, widthPct, areaPct }) => {
                  const step = unhappinessStep(item.meanHappiness);
                  // Extra cluster metadata only where it will actually be readable.
                  // Measured against the live run: below roughly a fifth of the
                  // width or a fifth of the height the text wraps to one word
                  // per line and stops being a label. The table carries the
                  // same facts for every cluster regardless.
                  const roomForDetail = widthPct >= 25 && row.heightPct >= 20;
                  return (
                    <li
                      key={item.key}
                      className={styles.tile}
                      data-step={step ?? "none"}
                      style={{ flex: `${widthPct} 1 0%` }}
                      title={t("insights.support.map.tileTitle", {
                        label: item.label,
                        size: item.size,
                        area: percentOf(areaPct, 1),
                        subject: item.subjectLabel,
                        mood:
                          item.meanHappiness === null
                            ? t("insights.support.map.noScore")
                            : t("insights.support.map.meanIs", { value: decimal(item.meanHappiness, 2) }),
                      })}
                    >
                      <span className={styles.tileName}>{item.label}</span>
                      <span className={styles.tileCount}>
                        {t("insights.support.map.msg", { n: item.size })} · {item.subjectLabel}
                      </span>
                      {roomForDetail ? (
                        <span className={styles.tileMeta}>
                          {t("insights.support.map.topic", { n: item.clusterIndex + 1 })}
                          {item.cohesion === null ? "" : ` · ${t("insights.support.map.cohesionIs", { value: decimal(item.cohesion, 2) })}`}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>

        <Legend />
      </figure>

      <p className={styles.coverage}>
        {t("insights.support.map.coverage", { n: integer(clustered), total: integer(map.messageCount), min: map.minSize })}
      </p>

      <ClusterTable clusters={clusters} clustered={clustered} />
      <RebuildButton />
    </div>
  );
}

// --- provenance -------------------------------------------------------------

function StalenessBanner({
  map,
  drift,
  baseline,
}: {
  map: TopicMapData;
  drift: number | null;
  baseline: number;
}) {
  const t = useT();
  const fmt = useFormat();
  return (
    <div className={`${styles.banner} ${map.stale ? styles.bannerStale : ""}`}>
      <span className={styles.bannerMain}>
        {t("insights.support.map.rebuilt", { age: fmt.age(map.builtAt), threshold: map.threshold, n: fmt.integer(map.messageCount) })}
      </span>
      <span className={styles.bannerSub}>
        {t("insights.support.map.topics", { topics: map.topicCount, subjects: map.subjectCount })} ·{" "}
        {drift === null ? (
          // Not "0% drift": the check failed, and saying the corpus has not
          // moved is a claim this component is in no position to make.
          <span className={styles.bannerUnknown}>{t("insights.support.map.unchecked")}</span>
        ) : (
          t("insights.support.map.corpus", {
            now: fmt.integer(map.liveMessageCount ?? 0),
            then: fmt.integer(baseline),
            drift: formatDrift(drift, t, fmt.percentOf),
          })
        )}
      </span>
    </div>
  );
}

function formatDrift(drift: number | null, t: Translate, percentOf: (value: number, digits?: number) => string): string {
  if (drift === null) return t("insights.age.unknown");
  const pct = drift * 100;
  if (Math.abs(pct) < 0.05) return t("insights.support.map.noChange");
  return `${pct > 0 ? "+" : "−"}${percentOf(Math.abs(pct), 1)}`;
}

// --- legend -----------------------------------------------------------------

function Legend() {
  const t = useT();
  const { decimal } = useFormat();
  return (
    <div className={styles.legend}>
      <span className={styles.legendLabel}>{t("insights.support.meanHappiness")}</span>
      <ul className={styles.legendScale}>
        {Array.from({ length: RAMP_STEPS }, (_, i) => {
          const step = i + 1;
          const { from, to } = rampStepRange(step);
          return (
            <li key={step} className={styles.legendItem}>
              <span className={styles.legendSwatch} data-step={step} aria-hidden="true" />
              <span className={styles.legendText}>
                {decimal(from, 1)}–{decimal(to, 1)}
              </span>
            </li>
          );
        })}
        <li className={styles.legendItem}>
          <span className={styles.legendSwatch} data-step="none" aria-hidden="true" />
          <span className={styles.legendText}>{t("insights.support.map.unscored")}</span>
        </li>
      </ul>
      <span className={styles.legendFoot}>{t("insights.support.map.legendFoot")}</span>
    </div>
  );
}

// --- the same numbers, in text ----------------------------------------------

/**
 * The treemap's data as a sortable table.
 *
 * Not a fallback and not an accessibility afterthought — it is the readable
 * form. A treemap answers "what is big" at a glance and answers exact ranking
 * badly, and that second question is the one that gets asked in a meeting.
 */
function ClusterTable({ clusters, clustered }: { clusters: ClusterNode[]; clustered: number }) {
  const t = useT();
  const { integer, percent, decimal } = useFormat();
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [ascending, setAscending] = useState(false);

  const sorted = useMemo(() => {
    const direction = ascending ? 1 : -1;
    return [...clusters].sort((a, b) => {
      if (sortKey === "label") return a.label.localeCompare(b.label) * direction;
      if (sortKey === "subject") return a.subjectLabel.localeCompare(b.subjectLabel) * direction;
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      // Unscored clusters sink to the bottom either way: a null is not a small
      // number, and sorting it as one puts "no data" at the top of "happiest".
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * direction || a.label.localeCompare(b.label);
    });
  }, [clusters, sortKey, ascending]);

  const toggle = (key: SortKey) => {
    if (key === sortKey) {
      setAscending((prev) => !prev);
      return;
    }
    setSortKey(key);
    setAscending(key === "label");
  };

  const columns: { key: SortKey; label: string; numeric: boolean }[] = [
    { key: "label", label: t("insights.support.map.cluster"), numeric: false },
    { key: "subject", label: t("insights.support.map.category"), numeric: false },
    { key: "size", label: t("insights.support.map.messages"), numeric: true },
    { key: "cohesion", label: t("insights.support.map.cohesion"), numeric: true },
    { key: "meanHappiness", label: t("insights.support.meanHappiness"), numeric: true },
  ];

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className={styles.tableCaption}>
          {t("insights.support.map.tableCaption")}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.numeric ? styles.n : undefined}
                aria-sort={sortKey === column.key ? (ascending ? "ascending" : "descending") : "none"}
              >
                <button type="button" className={styles.sortButton} onClick={() => toggle(column.key)}>
                  {column.label}
                  <span aria-hidden="true" className={styles.sortMark}>
                    {sortKey === column.key ? (ascending ? "▲" : "▼") : "↕"}
                  </span>
                </button>
              </th>
            ))}
            <th scope="col" className={styles.n}>
              {t("insights.support.map.share")}
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((cluster) => (
            <tr key={cluster.key}>
              <th scope="row">
                <span className={styles.swatch} data-step={unhappinessStep(cluster.meanHappiness) ?? "none"} aria-hidden="true" />
                {cluster.label}
              </th>
              <td>{cluster.subjectLabel}</td>
              <td className={styles.n}>{integer(cluster.size)}</td>
              <td className={styles.n}>
                {cluster.cohesion === null ? <span className={styles.muted}>—</span> : decimal(cluster.cohesion, 2)}
              </td>
              <td className={styles.n}>
                {cluster.meanHappiness === null ? (
                  <span className={styles.muted} title={t("insights.support.map.noMoodHint")}>
                    —
                  </span>
                ) : (
                  decimal(cluster.meanHappiness, 2)
                )}
              </td>
              <td className={styles.n}>{percent(cluster.size, clustered)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sortValue(cluster: ClusterNode, key: SortKey): number | null {
  switch (key) {
    case "size":
      return cluster.size;
    case "cohesion":
      return cluster.cohesion;
    case "meanHappiness":
      return cluster.meanHappiness;
    default:
      return null;
  }
}

// --- resync -----------------------------------------------------------------

/**
 * Rebuild at the script's own defaults — the button takes no arguments, so the
 * hand-tuned threshold cannot be nudged until the map looks nice. One run at a
 * time on the server; the page re-reads the new run when it lands.
 */
function RebuildButton() {
  const t = useT();
  const { refresh } = useInsightsFrame();
  const [state, setState] = useState<{ busy: boolean; message: string | null; error: boolean }>({
    busy: false,
    message: null,
    error: false,
  });

  const rebuild = async () => {
    setState({ busy: true, message: null, error: false });
    try {
      const response = await fetch("/api/insights/topic-map", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setState({
        busy: false,
        message: `${t("insights.support.map.rebuiltIn", { s: payload.seconds })}${payload.topics !== null ? ` — ${t("insights.support.map.topicsCount", { n: payload.topics })}` : ""}`,
        error: false,
      });
      refresh();
    } catch (error) {
      setState({ busy: false, message: error instanceof Error ? error.message : t("insights.support.map.failed"), error: true });
    }
  };

  return (
    <div className={styles.resync}>
      <button type="button" className={styles.rebuildButton} onClick={rebuild} disabled={state.busy}>
        {state.busy ? t("insights.support.map.rebuilding") : t("insights.support.map.rebuild")}
      </button>
      <span className={state.error ? styles.rebuildError : styles.rebuildNote} role="status">
        {state.busy ? t("insights.support.map.clustering") : state.message}
      </span>
    </div>
  );
}

// --- shaping ----------------------------------------------------------------

/**
 * Clusters are the tiles. The subject remains only contextual metadata because
 * the persisted run stores one row per actual cluster; grouping those rows by
 * subject hides the thing the clustering job discovered.
 *
 * Mean happiness comes from the ticket rows rather than from the clusters,
 * because a cluster is a bag of messages and has no mood of its own. That makes
 * the colour a statement about the parent subject's tickets, which the caption
 * says.
 */
function buildClusterTiles(clusters: TopicCluster[], categories: SupportCategoryRow[], t: Translate): ClusterNode[] {
  const mood = new Map(categories.map((row) => [row.category ?? "", row]));

  return clusters.map((cluster) => ({
    key: cluster.id,
    size: cluster.size,
    label: clusterLabel(cluster.excerpt, cluster.clusterIndex),
    subject: cluster.subject,
    subjectLabel: (() => { const key = `category.${cluster.subject}`; const text = t(key); return text === key ? cluster.subject : text; })(),
    clusterIndex: cluster.clusterIndex,
    meanHappiness: mood.get(cluster.subject)?.meanHappiness ?? null,
    cohesion: cluster.cohesion,
  }));
}
