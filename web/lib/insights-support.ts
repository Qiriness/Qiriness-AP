/**
 * Pure arithmetic for the Support panel: the percentile the reply section
 * quotes, the treemap geometry, and the unhappiness ramp.
 *
 * Isomorphic and dependency-free on purpose. `support-service.ts` folds and
 * ranks on the server, `TopicMap.tsx` lays out and colours in the browser, and
 * both reach for the same functions — two implementations of "which ramp step
 * is 2.89" would eventually disagree, and the whole point of a legend is that
 * the swatch and the tile were produced by the same rule.
 *
 * No Supabase import, nothing server-only. Mirrors insights-format.ts's role.
 */

// --- percentiles ------------------------------------------------------------

/**
 * The same percentile Postgres computes.
 *
 * Linear interpolation between the two neighbouring samples, because that is
 * what `percentile_cont` does and `support_by_month` already publishes monthly
 * p50s from it. A nearest-rank implementation here would put a whole-corpus
 * median beside monthly medians computed a different way, and the two would
 * disagree by an hour or so with no visible reason — the kind of discrepancy
 * that costs an afternoon before anyone suspects the estimator.
 */
export function percentileCont(values: number[], p: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];

  const position = p * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// --- the unhappiness ramp ---------------------------------------------------

/**
 * Happiness is scored 1 (content) to 4 (angry), so the ramp's domain is the
 * whole scale rather than the observed range.
 *
 * FIXED BINS, NOT QUANTILES. A quantile ramp always paints something at the
 * deep end, which means the map would look identical on a calm inbox and a
 * burning one — the colour would encode rank, not mood, and the legend could
 * not state a number. Equal bins over [1, 4] make a deep tile mean the same
 * thing in June and in December, at the cost of a map that is legitimately pale
 * when nothing is wrong.
 */
export const UNHAPPINESS_BREAKS = [1.6, 2.2, 2.8, 3.4] as const;

/** The number of steps in the ramp; the module CSS defines exactly this many. */
export const RAMP_STEPS = UNHAPPINESS_BREAKS.length + 1;

/** 1 (palest) to 5 (deepest), or null where no ticket under the subject is scored. */
export function unhappinessStep(meanHappiness: number | null): number | null {
  if (meanHappiness === null || !Number.isFinite(meanHappiness)) return null;
  let step = 1;
  for (const brk of UNHAPPINESS_BREAKS) {
    if (meanHappiness >= brk) step += 1;
  }
  return step;
}

/** The bin a step covers, for the legend — so colour is never an unexplained wash. */
export function rampStepRange(step: number): { from: number; to: number } {
  const edges = [1, ...UNHAPPINESS_BREAKS, 4];
  return { from: edges[step - 1], to: edges[step] };
}

// --- treemap geometry -------------------------------------------------------

export interface TreemapInput {
  key: string;
  size: number;
}

export interface TreemapTile<T extends TreemapInput> {
  item: T;
  /** Share of its row's width. Height comes from the row. */
  widthPct: number;
  /** Share of the whole map's area, for deciding whether a tile can carry detail. */
  areaPct: number;
}

export interface TreemapRow<T extends TreemapInput> {
  key: string;
  heightPct: number;
  total: number;
  tiles: TreemapTile<T>[];
}

/**
 * How many rows to slice the map into.
 *
 * Roughly three tiles per row. Measured on the live run (ten subjects, sizes
 * 65/56/21/21/12/10/9/5/2/2): three rows push the whole tail into a band worth
 * 4.4% of the height — 18px in a 416px map, which cannot hold a label, and an
 * unlabelled tile in a treemap is decoration. Four rows give that tail 13.8%,
 * about 57px, which fits a subject and a count. Capped at five because past
 * that the rows themselves get too short.
 */
export function treemapRowCount(itemCount: number): number {
  return Math.max(2, Math.min(5, Math.ceil(itemCount / 3)));
}

/**
 * Slice and dice: rows sized by their share of the total, tiles sized by their
 * share of their row.
 *
 * AREA IS THEN EXACTLY PROPORTIONAL — (rowShare) x (shareOfRow) collapses to
 * (size / total) — which is the one property that makes a treemap readable as a
 * quantity rather than as a mosaic. Squarified layouts give nicer aspect ratios
 * and are much harder to verify; at ten subjects the aspect ratios are already
 * fine, so the simpler layout with the provable area wins.
 *
 * Items are taken largest-first so the big subjects land in the top rows, and a
 * row closes once it has met its share of the total — except that it is held
 * open while there are only just enough items left to start every remaining
 * row, because an empty row would be a gap in the map.
 */
export function sliceAndDice<T extends TreemapInput>(items: T[], rowCount?: number): TreemapRow<T>[] {
  const sorted = [...items]
    .filter((item) => item.size > 0)
    .sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));

  const total = sorted.reduce((sum, item) => sum + item.size, 0);
  if (total === 0) return [];

  const rows = rowCount ?? treemapRowCount(sorted.length);
  const target = total / rows;
  const out: TreemapRow<T>[] = [];

  let current: T[] = [];
  let accumulated = 0;

  const close = () => {
    out.push({
      key: current.map((item) => item.key).join("+"),
      heightPct: (accumulated / total) * 100,
      total: accumulated,
      tiles: current.map((item) => ({
        item,
        widthPct: (item.size / accumulated) * 100,
        areaPct: (item.size / total) * 100,
      })),
    });
    current = [];
    accumulated = 0;
  };

  for (let i = 0; i < sorted.length; i += 1) {
    current.push(sorted[i]);
    accumulated += sorted[i].size;

    const itemsLeft = sorted.length - i - 1;
    const rowsLeft = rows - out.length - 1;
    if (itemsLeft === 0) break;
    // Either this row has earned its share, or the items left over are exactly
    // enough to open each remaining row and no more.
    if ((accumulated >= target && rowsLeft > 0) || itemsLeft <= rowsLeft) close();
  }

  if (current.length > 0) close();
  return out;
}

// --- cluster labels ---------------------------------------------------------

/**
 * Every French support email opens the same way, so the stored excerpt starts
 * with a greeting on essentially every cluster. Left in, the map reads
 * "Bonjour…", "Bonjour…", "Bonjour…" — three labels that distinguish nothing.
 * Stripped, the first useful clause is usually the complaint.
 */
const GREETING =
  /^[\s"'«]*(bonjour|bonsoir|madame|monsieur|mesdames|messieurs|hello|hi|dear)\b[\s,;:!.’'-]*/i;

const TOPIC_OPENERS = [
  /^[\s,;:!.]*(je\s+(?:voudrais|souhaiterais|souhaite|veux|aimerais)\s+(?:savoir|connaitre|connaître|avoir|obtenir)\s*)/i,
  /^[\s,;:!.]*(pouvez[-\s]vous\s+(?:me\s+|nous\s+)?(?:dire|indiquer|confirmer|renseigner|expliquer)\s*)/i,
  /^[\s,;:!.]*(j(?:e|')\s*(?:ai|avais)\s+une\s+question\s+(?:sur|concernant|au\s+sujet\s+de)\s*)/i,
  /^[\s,;:!.]*(je\s+(?:vous\s+)?contacte\s+(?:car|pour|au\s+sujet\s+de|concernant)?\s*)/i,
  /^[\s,;:!.]*(je\s+me\s+permets\s+de\s+vous\s+contacter\s+(?:car|pour|au\s+sujet\s+de|concernant)?\s*)/i,
  /^[\s,;:!.]*(concernant|au\s+sujet\s+de|suite\s+a|suite\s+à)\s*/i,
];

const TOPIC_NOISE = [
  /\bcommande\s*(?:n[°o]\s*)?#?\s*[0-9][a-z0-9-]*\b/gi,
  /\bcommande\s+n[°o]?\s*[a-z0-9-]+\b/gi,
  /\bn[°o]\s*#?\s*[a-z0-9-]+\b/gi,
  /\b#[0-9]{3,}\b/g,
];

export function clusterLabel(excerpt: string | null, clusterIndex: number, maxChars = 52): string {
  let text = (excerpt ?? "").replace(/\s+/g, " ").trim();
  // Up to five passes so "Bonjour Madame, je voudrais savoir..." loses the
  // greeting and the generic query frame before we choose the visible label.
  for (let pass = 0; pass < 5; pass += 1) {
    const before = text;
    text = text.replace(GREETING, "").trim();
    for (const opener of TOPIC_OPENERS) {
      text = text.replace(opener, "").trim();
    }
    if (text === before) break;
  }

  for (const noise of TOPIC_NOISE) {
    text = text.replace(noise, "").trim();
  }
  text = text.replace(/^[\s,;:!.?'-]+/, "").replace(/\s{2,}/g, " ").trim();

  // A number, not a blank: an unnamed topic still has to be referable to when
  // someone asks which tile a message landed in.
  if (text.length === 0) return `Topic ${clusterIndex + 1}`;
  if (text.length <= maxChars) return text;

  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// --- staleness --------------------------------------------------------------

/**
 * How far the live corpus has moved from the one the map was built on.
 *
 * The baseline is `message_count + internal_excluded`, NOT `message_count`
 * alone. The clustering job loads every embedded inbound message on a
 * categorised ticket and only then splits customer mail from our own, so the
 * count a cheap `count=exact` can reproduce is the pre-split figure. Comparing
 * the live 296 against the post-split 248 would report 19% drift on a map built
 * the same minute — an alarm that fires on arithmetic rather than on change.
 */
export function corpusBaseline(messageCount: number, internalExcluded: number): number {
  return messageCount + internalExcluded;
}

/** Twenty per cent: enough new mail that the map is describing a different inbox. */
export const STALE_DRIFT = 0.2;

export function corpusDrift(live: number | null, baseline: number): number | null {
  if (live === null || baseline <= 0) return null;
  return (live - baseline) / baseline;
}

export function hasCorpusDrifted(live: number | null, baseline: number): boolean {
  const drift = corpusDrift(live, baseline);
  // Unknown drift is not drift. A failed count must not raise a staleness
  // warning, because "we could not check" and "it is stale" are different
  // claims and only one of them is actionable.
  return drift !== null && Math.abs(drift) > STALE_DRIFT;
}
