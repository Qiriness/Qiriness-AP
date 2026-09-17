"use client";

import { useMemo, useState } from "react";

import { SearchIcon } from "@/components/icons";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { setCollectionActive, setCollectionDetails, syncCollections } from "@/lib/api/collections";
import type { AdviceCollection, CollectionAxis } from "@/lib/types";

import styles from "./CollectionList.module.css";

/**
 * Which Shopify collections support may answer advice from.
 *
 * THE LIST IS SHOPIFY'S; THE DECISION IS NOT. All 175 collections appear here
 * and nothing on a row is editable except the switch, the axis and the note —
 * everything else is refreshed by the next sync.
 *
 * NOTHING IS ACTIVE UNTIL SOMEBODY SAYS SO, and the reason is on the screen: the
 * shop's collections include Black Friday (92 products), Singles day, a plugin's
 * recommendation index and sixty-two numbered buckets belonging to the site's
 * diagnostic quiz. A product sits in 18 to 30 of them, so a screen that defaulted
 * to "all" would put the sale list into a skincare recommendation.
 *
 * THE AXIS IS NOT OPTIONAL ONCE LIVE. The agent gives up a concern before a type
 * of care when nothing satisfies both, so a collection in the intersection with
 * no axis is one the intersection cannot reason about. The server refuses it
 * from both directions; the screen makes it the obvious first thing to set.
 */
export function CollectionList({
  initial,
  loadError,
}: {
  initial: AdviceCollection[];
  loadError: string | null;
}) {
  const [collections, setCollections] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState<string | null>(null);

  const active = collections.filter((c) => c.active).length;
  const needle = fold(query);

  const shown = useMemo(
    () =>
      collections.filter((c) => {
        if (activeOnly && !c.active) return false;
        if (!needle) return true;
        return fold(c.title).includes(needle) || fold(c.handle).includes(needle);
      }),
    [collections, needle, activeOnly]
  );

  function replace(updated: AdviceCollection) {
    setCollections((current) => current.map((c) => (c.id === updated.id ? updated : c)));
  }

  async function run(id: string, work: () => Promise<AdviceCollection>) {
    setBusy(id);
    setError(null);
    try {
      replace(await work());
    } catch (caught) {
      setError(knowledgeErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Pulls Shopify's collections now, rather than waiting for the nightly.
   *
   * It cannot switch anything on — the sync never writes `is_active` — so the
   * worst this does is take a few seconds and change nothing. The result says
   * what it found, because "nothing happened" and "nothing has changed since
   * last night" look identical otherwise.
   */
  async function sync() {
    setSyncing(true);
    setError(null);
    setSynced(null);
    try {
      const result = await syncCollections();
      setCollections(result.collections);
      setSynced(
        `${result.synced.total} collections checked, ${result.synced.refreshed} live ones refreshed.`
      );
    } catch (caught) {
      setError(knowledgeErrorMessage(caught));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className={styles.wrap}>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Collections support may advise from</h2>
          <p className={styles.lede}>
            Every collection in Shopify. Switch on the ones that describe something a customer
            asks for — a concern like « rides et ridules », or a type of care like « sérums ». The
            agent answers advice by finding the products that sit in <em>all</em> the collections a
            customer&apos;s message names, so a collection like Black Friday would match everything
            and mean nothing.
          </p>
        </div>
        <div className={styles.headSide}>
          <span className={styles.count}>
            {active} live of {collections.length}
          </span>
          <button type="button" className={styles.sync} onClick={sync} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync from Shopify"}
          </button>
        </div>
      </header>

      <div className={styles.controls}>
        <div className={styles.search}>
          <SearchIcon size={15} className={styles.searchIcon} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
            placeholder={`Search ${collections.length} collections`}
            aria-label="Search collections"
          />
        </div>
        <label className={styles.filter}>
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(event) => setActiveOnly(event.target.checked)}
          />
          <span>Live only</span>
        </label>
      </div>

      {loadError && <p className={styles.error}>{loadError}</p>}
      {error && <p className={styles.error} role="status">{error}</p>}
      {synced && (
        <p className={styles.synced} role="status">
          {synced} A collection new to Shopify arrives switched off — the sync never
          switches anything on.
        </p>
      )}

      {/* WHICH FILTER IS HIDING IT, because two are stacked and the wrong guess
          costs somebody the belief that the collection does not exist. */}
      {shown.length === 0 && !loadError && (
        <p className={styles.empty}>
          {activeOnly && needle
            ? `No live collection matches “${query.trim()}”. Untick “Live only” to search all ${collections.length}.`
            : activeOnly
              ? "Nothing is live yet. Search below and switch on the collections that describe what customers ask for."
              : needle
                ? `No collection matches “${query.trim()}”.`
                : "No collections synced yet — use “Sync from Shopify” above."}
        </p>
      )}

      <ul className={styles.list}>
        {shown.map((collection) => (
          <li key={collection.id} className={`${styles.row} ${collection.active ? styles.on : ""}`}>
            <div className={styles.main}>
              <div className={styles.titleLine}>
                <span className={styles.name}>{collection.title}</span>
                <code className={styles.handle}>{collection.handle}</code>
              </div>

              <div className={styles.facts}>
                {/* TWO COUNTS, TWO QUESTIONS. Shopify's includes products that
                    are not live and is what tells somebody whether a collection
                    is worth switching on; the live count is what the agent can
                    actually put forward, and it does not exist until the
                    membership has been fetched. */}
                <span className={styles.muted}>
                  {collection.productsCount === null
                    ? "Count unknown"
                    : `${collection.productsCount} in Shopify`}
                </span>
                {collection.active && (
                  <span className={collection.liveProducts ? styles.muted : styles.warn}>
                    {collection.liveProducts === null
                      ? "Membership not fetched yet — run the collections sync"
                      : `${collection.liveProducts} live for advice`}
                  </span>
                )}
                {collection.note && <span className={styles.note}>{collection.note}</span>}
              </div>
            </div>

            <div className={styles.actions}>
              <div className={styles.axis} role="group" aria-label={`What ${collection.title} is`}>
                {(["concern", "category"] as CollectionAxis[]).map((axis) => (
                  <button
                    key={axis}
                    type="button"
                    className={collection.axis === axis ? styles.axisOn : styles.axisOff}
                    disabled={busy === collection.id}
                    aria-pressed={collection.axis === axis}
                    onClick={() =>
                      run(collection.id, () =>
                        setCollectionDetails(collection.id, {
                          // Clicking the axis it already has clears it — the only
                          // way back to "undecided" without a third button.
                          axis: collection.axis === axis ? null : axis,
                          note: collection.note,
                        })
                      )
                    }
                  >
                    {axis === "concern" ? "Concern" : "Type of care"}
                  </button>
                ))}
              </div>

              <label className={styles.switch}>
                <input
                  type="checkbox"
                  checked={collection.active}
                  disabled={busy === collection.id}
                  onChange={() =>
                    run(collection.id, () => setCollectionActive(collection.id, !collection.active))
                  }
                  aria-label={`Let the agent advise from ${collection.title}`}
                />
                <span>{collection.active ? "Live" : "Off"}</span>
              </label>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * « Crème » and « creme » are the same word to somebody typing quickly.
 *
 * Accent-folded rather than accent-stripped from the data: the titles keep their
 * accents everywhere they are shown, and only the comparison is relaxed. Same
 * fold `RecommendationList` and the Insights product searches use.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
