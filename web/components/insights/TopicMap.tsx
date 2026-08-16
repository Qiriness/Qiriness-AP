"use client";

import { useEffect, useMemo, useState } from "react";
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
import { EmptyState, Note, percent } from "./InsightsKit";
import styles from "./TopicMap.module.css";

/**
 * What the inbox is about, drawn to scale.
 *
 * WHY THIS IS ONE CLIENT COMPONENT. The treemap itself is static and would
 * render happily on the server, but the two controls beside it cannot: copying
 * the resync command needs `navigator.clipboard`, and the table underneath
 * sorts on click. Splitting the static half out would mean three files and a
 * prop-drilled boundary to save the client a few hundred bytes of markup it is
 * already downloading as data. The panel around this stays a Server Component,
 * which is where the saving actually is.
 */

/**
 * The rebuild is a COMMAND, NOT A BUTTON, and that is a deliberate constraint
 * rather than an unfinished feature.
 *
 * Clustering is an all-pairs cosine comparison over the whole embedded corpus,
 * and this app has no job queue — a route handler that started it would hold
 * the request open for the entire run, past any serverless timeout, with no
 * progress and no way to cancel. Worse, the similarity threshold is hand-tuned
 * and corpus-specific; a one-click rebuild invites re-running it until the map
 * looks nice, which is how a measurement turns into a drawing. So the panel
 * hands over the command and lets a human run it in a terminal where the output
 * is visible and the arguments can be changed.
 */
const RESYNC_COMMAND = "npm run cluster:tickets:save";

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
        <Resync />
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <StalenessBanner map={map} drift={drift} baseline={baseline} />

      {map.stale ? (
        <Note tone="warn" title="The corpus has moved on">
          The mailbox now holds {map.liveMessageCount?.toLocaleString()} embedded messages against the{" "}
          {baseline.toLocaleString()} this map was built from — {formatDrift(drift)}. Topics found below
          are still real, but their relative sizes are describing an older inbox. Rebuild before drawing a
          conclusion about what is growing.
        </Note>
      ) : null}

      <figure className={styles.figure}>
        <figcaption className={styles.caption}>
          <span className={styles.capTitle}>Message volume by cluster</span>
          <span className={styles.capSub}>
            Each tile is one saved cluster from the latest run. Area is exactly proportional to the
            messages in that cluster. Colour still uses the parent subject&apos;s mean happiness, because
            the cluster row is a bag of messages and has no ticket mood of its own.
          </span>
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
        {clustered.toLocaleString()} of the run&apos;s {map.messageCount.toLocaleString()} customer
        messages fell into a topic of at least {map.minSize}; the remaining{" "}
        {(map.messageCount - clustered).toLocaleString()} matched nothing else closely enough at
        threshold {map.threshold} and are deliberately absent rather than pooled into an
        &ldquo;other&rdquo; tile. A further {map.internalExcluded.toLocaleString()} were our own mail and
        never entered the run.
      </p>

      <ClusterTable clusters={clusters} clustered={clustered} />
      <Resync />
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

function Resync() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(RESYNC_COMMAND);
      setCopied(true);
    } catch {
      // Clipboard access is refused outside a secure context and on some
      // locked-down browsers. The command is rendered as selectable text beside
      // the button for exactly this case, so a failed copy costs a manual
      // selection rather than the ability to rebuild.
      setCopied(false);
    }
  };

  return (
    <div className={styles.resync}>
      <div className={styles.resyncText}>
        <span className={styles.resyncTitle}>Rebuilding the map</span>
        <p className={styles.resyncBody}>
          Run it from the repository root. It compares every embedded message against every other, so it
          takes minutes and belongs in a terminal rather than behind a button on this page.
        </p>
      </div>
      <div className={styles.resyncControl}>
        <code className={styles.command}>{RESYNC_COMMAND}</code>
        <button type="button" className={styles.copyButton} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
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
