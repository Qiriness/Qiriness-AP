"use client";

import { useMemo, useState } from "react";

import { SearchIcon } from "@/components/icons";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import type { ConcernOption, RecommendableProduct } from "@/lib/types";

import styles from "./RecommendationList.module.css";

/**
 * Which products support puts forward, per skin concern.
 *
 * THE TAGS ARE THE STARTING POINT AND NOT THE ANSWER, which is the whole reason
 * this screen exists. The merchandising tags most products as suiting most skin
 * — correct on a product page, useless in a reply, where "for sensitive skin we
 * suggest these 64" is not a recommendation. The tag match is shown as a hint so
 * curating is a matter of narrowing rather than starting from nothing.
 *
 * FILTERED BY CONCERN, because that is the question somebody sits down to
 * answer: not "what is this product for" but "what do we suggest for sensitive
 * skin". The counts in the tabs are the outstanding work.
 *
 * AN EMPTY CONCERN IS A REAL ANSWER. Nothing curated means the agent says a
 * colleague will advise, rather than picking three products out of sixty — so a
 * concern left at zero is a decision, not an omission, and the screen does not
 * nag about it.
 */
/**
 * « Crème » and « creme » are the same word to somebody typing quickly.
 *
 * Accent-folded rather than accent-stripped from the data: the titles keep
 * their accents everywhere they are shown, and only the comparison is relaxed.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function RecommendationList({
  initialProducts,
  initialConcerns,
  loadError,
}: {
  initialProducts: RecommendableProduct[];
  initialConcerns: ConcernOption[];
  loadError: string | null;
}) {
  const [products, setProducts] = useState(initialProducts);
  const [concern, setConcern] = useState(initialConcerns[0]?.key ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyCompatible, setOnlyCompatible] = useState(true);
  const [query, setQuery] = useState("");

  const counts = useMemo(
    () =>
      initialConcerns.map((option) => ({
        ...option,
        curated: products.filter((p) => p.concerns.includes(option.key)).length,
      })),
    [products, initialConcerns]
  );

  // The tag hint decides the default view: starting from the whole catalogue
  // means scrolling past body oils to curate a face concern.
  //
  // SEARCH IS APPLIED AFTER THE TAG FILTER AND SAYS SO IN THE COUNT, because the
  // two together can hide a product for a reason nobody chose: typing a title
  // that exists but is not tagged for this skin type would otherwise return
  // nothing, and read as "we do not sell that". The empty state below names
  // which of the two filters is responsible.
  const shown = useMemo(() => {
    const needle = fold(query);
    return products.filter((p) => {
      const compatible =
        !onlyCompatible || p.compatibleWith.includes(concern) || p.concerns.includes(concern);
      if (!compatible) return false;
      if (!needle) return true;
      // Title and summary both: half these products are found by what they do
      // ("contour des yeux") rather than by the name on the box.
      return fold(`${p.title} ${p.summary ?? ""}`).includes(needle);
    });
  }, [products, concern, onlyCompatible, query]);

  // How many the search alone would have shown, so the empty state can tell a
  // missing product from one the tag filter is hiding.
  const matchesQuery = useMemo(() => {
    const needle = fold(query);
    if (!needle) return products.length;
    return products.filter((p) => fold(`${p.title} ${p.summary ?? ""}`).includes(needle)).length;
  }, [products, query]);

  async function toggle(product: RecommendableProduct) {
    const next = product.concerns.includes(concern)
      ? product.concerns.filter((c) => c !== concern)
      : [...product.concerns, concern];

    setBusy(product.id);
    setError(null);
    try {
      const res = await fetch("/api/recommendations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product.id, concerns: next }),
      });
      const body = await res.json();
      if (!res.ok) throw body;
      setProducts((current) => current.map((p) => (p.id === product.id ? body.product : p)));
    } catch (caught) {
      setError(knowledgeErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.wrap}>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>What we suggest, by skin type</h2>
          <p className={styles.lede}>
            The agent recommends only what is ticked here. The catalogue tags most products as
            suiting most skin, which is right on a product page and no use in a reply — so this is
            the shorter list somebody stands behind. A skin type with nothing ticked makes the
            agent hand the ticket to a person, which is a fine answer.
          </p>
        </div>
      </header>

      {loadError && <p className={styles.error}>{loadError}</p>}
      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.concerns} role="tablist" aria-label="Skin type">
        {counts.map((option) => (
          <button
            key={option.key}
            type="button"
            role="tab"
            aria-selected={option.key === concern}
            className={option.key === concern ? styles.concernOn : styles.concernOff}
            onClick={() => setConcern(option.key)}
          >
            {option.label}
            <span className={styles.concernCount}>{option.curated}</span>
          </button>
        ))}
      </div>

      <div className={styles.controls}>
        {/* THE CATALOGUE IS 90 ROWS, so curating one concern means scrolling past
            most of it to find the product somebody has in mind. Searching title
            AND summary because half these products are looked for by what they
            do — "contour des yeux" — rather than by the name on the box. */}
        <div className={styles.searchWrap}>
          <SearchIcon size={15} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search the catalogue…"
            aria-label="Search products by name or description"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <label className={styles.filter}>
          <input
            type="checkbox"
            checked={onlyCompatible}
            onChange={(event) => setOnlyCompatible(event.target.checked)}
          />
          <span>
            Only products the catalogue already tags for this skin type ({shown.length} of{" "}
            {products.length})
          </span>
        </label>
      </div>

      <ul className={styles.list}>
        {shown.map((product) => {
          const picked = product.concerns.includes(concern);
          return (
            <li key={product.id} className={`${styles.row} ${picked ? styles.on : ""}`}>
              <label className={styles.pick}>
                <input
                  type="checkbox"
                  checked={picked}
                  disabled={busy === product.id}
                  onChange={() => toggle(product)}
                  aria-label={`Suggest ${product.title} for this skin type`}
                />
                <span className={styles.main}>
                  <span className={styles.name}>{product.title}</span>
                  {product.summary && <span className={styles.summary}>{product.summary}</span>}
                  <span className={styles.facts}>
                    {product.productType && (
                      <span className={styles.muted}>{product.productType}</span>
                    )}
                    {/* Where else this product is already put forward, so
                        curating one concern does not happen blind to the rest. */}
                    {product.concerns.length > 0 && (
                      <span className={styles.muted}>
                        suggested for {product.concerns.length} skin type
                        {product.concerns.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {!product.compatibleWith.includes(concern) && (
                      <span className={styles.warn}>not tagged for this skin type</span>
                    )}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {/* WHICH FILTER IS HIDING IT, because two are stacked and the wrong guess
          costs somebody the belief that the product is not in the catalogue at
          all. `matchesQuery` is what the search alone would have shown, so the
          three cases are told apart rather than merged into one shrug. */}
      {shown.length === 0 && !loadError && (
        <p className={styles.empty}>
          {query && matchesQuery > 0 ? (
            <>
              {matchesQuery} product{matchesQuery === 1 ? "" : "s"} match “{query}”, but{" "}
              {matchesQuery === 1 ? "it is" : "none is"} tagged for this skin type. Untick the
              filter above to curate {matchesQuery === 1 ? "it" : "them"} anyway.
            </>
          ) : query ? (
            <>Nothing in the catalogue matches “{query}”.</>
          ) : (
            <>
              No product is tagged for this skin type. Untick the filter above to curate from the
              whole catalogue.
            </>
          )}
        </p>
      )}
    </section>
  );
}
