"use client";

import { useMemo, useState } from "react";
import { useInsightsFrame } from "./InsightsFrame";
import type { SupportCategoryRow, TopicCluster, TopicMap as TopicMapData } from "@/lib/types";
import { CATEGORY_LABELS } from "@/lib/types";
import { formatAge } from "@/lib/insights-format";
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
import { EmptyState, percent } from "./InsightsKit";
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
  const clusters = useMemo(() => buildClusterTiles(map.clusters, categories), [map.clusters, categories]);
  const clustered = clusters.reduce((sum, cluster) => sum + cluster.size, 0);
  const rows = useMemo(() => sliceAndDice(clusters), [clusters]);

  const baseline = corpusBaseline(map.messageCount, map.internalExcluded);
  const drift = corpusDrift(map.liveMessageCount, baseline);

  if (clusters.length === 0) {
    return (
      <div className={styles.wrap}>
        <StalenessBanner map={map} drift={drift} baseline={baseline} />
        <EmptyState>
          This saved run did not find any repeated customer topics of at least {map.minSize} messages at
          threshold {map.threshold}. That is a measured empty map, not a missing rebuild.
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
          <span className={styles.capTitle}>Message volume by cluster</span>
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
                      title={`${item.label}: ${item.size} message(s), ${areaPct.toFixed(
                        1
                      )}% of the map, subject ${item.subjectLabel}${
                        item.meanHappiness === null
                          ? " — no happiness score"
                          : `, mean happiness ${item.meanHappiness.toFixed(2)}`
                      }`}
                    >
                      <span className={styles.tileName}>{item.label}</span>
                      <span className={styles.tileCount}>
                        {item.size} msg · {item.subjectLabel}
                      </span>
                      {roomForDetail ? (
                        <span className={styles.tileMeta}>
                          Topic {item.clusterIndex + 1}
                          {item.cohesion === null ? "" : ` · cohesion ${item.cohesion.toFixed(2)}`}
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
        {clustered.toLocaleString()} of {map.messageCount.toLocaleString()} customer messages fall into a topic of at
        least {map.minSize}.
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
  return (
    <div className={`${styles.banner} ${map.stale ? styles.bannerStale : ""}`}>
      <span className={styles.bannerMain}>
        Rebuilt {formatAge(map.builtAt)} · threshold {map.threshold} ·{" "}
        {map.messageCount.toLocaleString()} messages
      </span>
      <span className={styles.bannerSub}>
        {map.topicCount} topics across {map.subjectCount} subjects ·{" "}
        {drift === null ? (
          // Not "0% drift": the check failed, and saying the corpus has not
          // moved is a claim this component is in no position to make.
          <span className={styles.bannerUnknown}>corpus size could not be checked just now</span>
        ) : (
          `corpus now ${map.liveMessageCount?.toLocaleString()} against ${baseline.toLocaleString()} at build time (${formatDrift(
            drift
          )})`
        )}
      </span>
    </div>
  );
}

function formatDrift(drift: number | null): string {
  if (drift === null) return "unknown";
  const pct = drift * 100;
  if (Math.abs(pct) < 0.05) return "no change";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

// --- legend -----------------------------------------------------------------

function Legend() {
  return (
    <div className={styles.legend}>
      <span className={styles.legendLabel}>Mean happiness</span>
      <ul className={styles.legendScale}>
        {Array.from({ length: RAMP_STEPS }, (_, i) => {
          const step = i + 1;
          const { from, to } = rampStepRange(step);
          return (
            <li key={step} className={styles.legendItem}>
              <span className={styles.legendSwatch} data-step={step} aria-hidden="true" />
              <span className={styles.legendText}>
                {from.toFixed(1)}–{to.toFixed(1)}
              </span>
            </li>
          );
        })}
        <li className={styles.legendItem}>
          <span className={styles.legendSwatch} data-step="none" aria-hidden="true" />
          <span className={styles.legendText}>unscored</span>
        </li>
      </ul>
      <span className={styles.legendFoot}>1 is content, 4 is angry. Bins are fixed, not relative.</span>
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
    { key: "label", label: "Cluster", numeric: false },
    { key: "subject", label: "Category", numeric: false },
    { key: "size", label: "Messages", numeric: true },
    { key: "cohesion", label: "Cohesion", numeric: true },
    { key: "meanHappiness", label: "Mean happiness", numeric: true },
  ];

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className={styles.tableCaption}>
          Every cluster on the map, in text. Click a heading to sort.
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
              Share of map
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
              <td className={styles.n}>{cluster.size.toLocaleString()}</td>
              <td className={styles.n}>
                {cluster.cohesion === null ? <span className={styles.muted}>—</span> : cluster.cohesion.toFixed(2)}
              </td>
              <td className={styles.n}>
                {cluster.meanHappiness === null ? (
                  <span className={styles.muted} title="No ticket under this cluster's subject carries a happiness score">
                    —
                  </span>
                ) : (
                  cluster.meanHappiness.toFixed(2)
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
        message: `Rebuilt in ${payload.seconds}s${payload.topics !== null ? ` — ${payload.topics} topics` : ""}`,
        error: false,
      });
      refresh();
    } catch (error) {
      setState({ busy: false, message: error instanceof Error ? error.message : "The rebuild failed.", error: true });
    }
  };

  return (
    <div className={styles.resync}>
      <button type="button" className={styles.rebuildButton} onClick={rebuild} disabled={state.busy}>
        {state.busy ? "Rebuilding…" : "Rebuild map"}
      </button>
      <span className={state.error ? styles.rebuildError : styles.rebuildNote} role="status">
        {state.busy ? "Clustering every embedded customer message — about ten seconds." : state.message}
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
function buildClusterTiles(clusters: TopicCluster[], categories: SupportCategoryRow[]): ClusterNode[] {
  const mood = new Map(categories.map((row) => [row.category ?? "", row]));

  return clusters.map((cluster) => ({
    key: cluster.id,
    size: cluster.size,
    label: clusterLabel(cluster.excerpt, cluster.clusterIndex),
    subject: cluster.subject,
    subjectLabel: CATEGORY_LABELS[cluster.subject as keyof typeof CATEGORY_LABELS] ?? cluster.subject,
    clusterIndex: cluster.clusterIndex,
    meanHappiness: mood.get(cluster.subject)?.meanHappiness ?? null,
    cohesion: cluster.cohesion,
  }));
}
