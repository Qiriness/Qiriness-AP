"use client";

import { useEffect, useMemo, useState } from "react";
import { SearchIcon } from "@/components/icons";
import styles from "./ProductAttachSelect.module.css";

/**
 * Attaches an article to the products it is ABOUT.
 *
 * WHY AN ARTICLE NEEDS TO KNOW THIS. The agent identifies a product from the
 * customer's words by matching product TITLES, and the words people use about a
 * device are in no title: « la batterie de mon masque ne tient pas », « la
 * télécommande ne fonctionne plus ». Retrieval finds the right article easily —
 * those words are distinctive precisely because they appear nowhere else — so
 * the article says which product the question was about when the matcher cannot.
 *
 * SEVERAL PRODUCTS IS HOW A RANGE IS SAID. There is no "range" to pick: ranges
 * are computed from the words products share, so they have no stable identity to
 * store. Ticking every member of a family says the same thing and survives the
 * next catalogue sync.
 *
 * Attaching NEVER overrides a product the customer named, and never decides
 * which product caused a reaction — that has to come from the customer.
 */

interface CatalogueProduct {
  id: string;
  title: string;
  summary?: string | null;
  productType?: string | null;
}

interface ProductAttachSelectProps {
  value: string[];
  onChange: (productIds: string[]) => void;
  disabled?: boolean;
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** How many matches to render before asking for a narrower search. */
const VISIBLE_LIMIT = 40;

/**
 * The catalogue, fetched once per page load and shared by every article.
 *
 * MEASURED: 105 products, 44 KB, 600 ms-1.9 s warm. Per-component state meant
 * that cost was paid again for every article somebody clicked into, and — worse
 * — it was paid at the moment they ticked the checkbox, so the control they had
 * just asked for opened onto a spinner.
 *
 * The promise itself is cached rather than the result, so two mounts in the same
 * tick share one request instead of racing. A failure is not cached: it clears
 * the slot, so reopening retries rather than being permanently broken by one
 * blip.
 */
let cataloguePromise: Promise<CatalogueProduct[]> | null = null;

function loadCatalogue(): Promise<CatalogueProduct[]> {
  if (!cataloguePromise) {
    cataloguePromise = fetch("/api/recommendations")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((body) => (Array.isArray(body.products) ? (body.products as CatalogueProduct[]) : []))
      .catch((error) => {
        cataloguePromise = null;
        throw error;
      });
  }
  return cataloguePromise;
}

export function ProductAttachSelect({ value, onChange, disabled = false }: ProductAttachSelectProps) {
  // The checkbox is a VIEW OF THE VALUE, not a second source of truth: an
  // article with products attached is by definition product-specific, and one
  // with none is not. It carries local state only to stay open while the list
  // is still empty — the moment somebody is about to pick the first product.
  //
  // Nothing persists that in-between state, and nothing should: the parent
  // keys this component by article id, so a new article always starts
  // unchecked and a checked-but-empty one comes back unchecked.
  const [open, setOpen] = useState(value.length > 0);
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<CatalogueProduct[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  // A one-way latch for products arriving after mount. It never closes the
  // panel — the key handles that per article — so ticking the box and picking
  // nothing stays open while you are still on the article.
  useEffect(() => {
    if (value.length > 0) setOpen(true);
  }, [value.length]);

  // FETCHED ON MOUNT, NOT ON OPEN, and shared across articles by `loadCatalogue`.
  //
  // Loading lazily looked frugal and was the wrong trade: it moved a 600 ms-1.9 s
  // request onto the click that opens the picker, so the list appeared as a
  // spinner precisely when it was wanted. Starting it while somebody is still
  // reading the article hides the whole cost, and the shared promise means it
  // happens once per page load rather than once per article.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);

    loadCatalogue()
      .then((loaded) => {
        if (!cancelled) setProducts(loaded);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const selected = useMemo(() => new Set(value), [value]);

  // ATTACHED PRODUCTS ARE PINNED, above the search and outside the scroll area.
  // What this article is attached to is the answer the control exists to give,
  // and leaving it inline meant it scrolled out of sight the moment somebody
  // looked for the next one — in a 105-row list, "what did I already tick?"
  // then costs a scroll back through the alphabet.
  const attached = useMemo(
    () => (products ?? []).filter((product) => selected.has(product.id)),
    [products, selected]
  );

  // An id that resolves to no product: the column carries no foreign key (an
  // array element cannot), so a product deleted or unpublished since it was
  // attached leaves one behind. Counted rather than hidden, because silently
  // showing fewer chips than the count reads as having lost a selection.
  const unresolved = products ? value.length - attached.length : 0;

  // The list below offers only what is NOT attached yet. Rendering a product in
  // both places would read as two different things.
  const shown = useMemo(() => {
    if (!products) return [];
    const needle = fold(query);
    return products.filter((product) => {
      if (selected.has(product.id)) return false;
      return needle ? fold(`${product.title} ${product.summary ?? ""}`).includes(needle) : true;
    });
  }, [products, query, selected]);

  function toggle(id: string) {
    onChange(selected.has(id) ? value.filter((current) => current !== id) : [...value, id]);
  }

  function handleToggleSection(checked: boolean) {
    setOpen(checked);
    // Unticking is the only way to say "this is not about a product", so it has
    // to actually clear the attachments rather than just hide them.
    if (!checked && value.length > 0) onChange([]);
  }

  return (
    <div className={styles.wrap}>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={open}
          disabled={disabled}
          onChange={(event) => handleToggleSection(event.target.checked)}
        />
        <span>
          This article is about specific products
          {value.length > 0 && <span className={styles.count}> · {value.length} attached</span>}
        </span>
      </label>

      {open && (
        <div className={styles.panel}>
          <p className={styles.hint}>
            Lets the agent tell which product a question is about when the wording never names one — « la
            batterie de mon masque ne tient pas ». Tick every member of a range to attach the whole family.
          </p>

          {attached.length > 0 && (
            <div className={styles.attached}>
              <ul className={styles.chips}>
                {attached.map((product) => (
                  <li key={product.id} className={styles.chip}>
                    <span className={styles.chipName}>{product.title}</span>
                    <button
                      type="button"
                      className={styles.chipRemove}
                      disabled={disabled}
                      aria-label={`Detach ${product.title}`}
                      title={`Detach ${product.title}`}
                      onClick={() => toggle(product.id)}
                    >
                      &times;
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {unresolved > 0 && (
            <p className={styles.stale}>
              {unresolved} attached {unresolved === 1 ? "product is" : "products are"} no longer in the
              catalogue. Untick and re-attach to clear {unresolved === 1 ? "it" : "them"}.
            </p>
          )}

          <div className={styles.searchWrap}>
            <SearchIcon size={15} />
            <input
              type="search"
              className={styles.searchInput}
              placeholder="Search the catalogue…"
              aria-label="Search products by name or description"
              value={query}
              disabled={disabled || !products}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {loadError && (
            <p className={styles.empty}>
              The catalogue could not be loaded.{" "}
              <button type="button" className={styles.retry} onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </p>
          )}
          {!loadError && !products && <p className={styles.empty}>Loading the catalogue…</p>}

          {products && shown.length === 0 && (
            <p className={styles.empty}>
              {query
                ? `No other product matches “${query}”.`
                : "Every product in the catalogue is already attached."}
            </p>
          )}

          {products && shown.length > 0 && (
            <>
              <ul className={styles.list}>
                {shown.slice(0, VISIBLE_LIMIT).map((product) => (
                  <li key={product.id} className={selected.has(product.id) ? styles.on : undefined}>
                    <label className={styles.pick}>
                      <input
                        type="checkbox"
                        checked={selected.has(product.id)}
                        disabled={disabled}
                        onChange={() => toggle(product.id)}
                      />
                      <span className={styles.main}>
                        <span className={styles.name}>{product.title}</span>
                        {product.summary && <span className={styles.summary}>{product.summary}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {shown.length > VISIBLE_LIMIT && (
                <p className={styles.empty}>
                  {shown.length - VISIBLE_LIMIT} more match — keep typing to narrow the list.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
