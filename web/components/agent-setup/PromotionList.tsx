"use client";

import { useState } from "react";

import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import type { PromotionChoice } from "@/lib/types";

import styles from "./PromotionList.module.css";

/**
 * Which live codes support may offer a customer.
 *
 * THE LIST IS SHOPIFY'S; THE DECISION IS NOT. Every active code discount appears
 * here and nothing on the row is editable except the switch, because everything
 * else is overwritten by the next sync. `offerable_in_replies` is the one column
 * this app owns.
 *
 * NOTHING IS OFFERABLE UNTIL SOMEBODY SAYS SO, and the reason is on the screen:
 * of the codes active on this shop, one is 100% off a product and others are
 * partner rates. A screen that defaulted to "all active" would put those into a
 * support reply, and the person choosing would never have been asked.
 *
 * THE STACKING LINE IS THE ONE PEOPLE ACTUALLY NEED. It comes from Shopify's
 * `combines_with` rather than from the discount type, and it is the commonest
 * explanation for the ticket that starts "my code does not work" — so it is
 * shown while somebody is choosing, not just quoted afterwards in a reply.
 */
export function PromotionList({
  initial,
  loadError,
}: {
  initial: PromotionChoice[];
  loadError: string | null;
}) {
  const [promotions, setPromotions] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const offerable = promotions.filter((p) => p.offerable).length;

  async function toggle(promotion: PromotionChoice) {
    setBusy(promotion.promotionKey);
    setError(null);
    try {
      const res = await fetch("/api/promotions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promotionKey: promotion.promotionKey,
          offerable: !promotion.offerable,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw body;
      setPromotions((current) =>
        current.map((p) => (p.promotionKey === promotion.promotionKey ? body.promotion : p))
      );
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
          <h2 className={styles.title}>Codes support may offer</h2>
          <p className={styles.lede}>
            Every code discount currently active in Shopify. Switch on the ones a reply may hand to
            a customer — the drafting screen only ever sees these. Nothing else here is editable:
            the next sync overwrites it.
          </p>
        </div>
        <span className={styles.count}>
          {offerable} offerable of {promotions.length}
        </span>
      </header>

      {loadError && <p className={styles.error}>{loadError}</p>}
      {error && <p className={styles.error}>{error}</p>}

      {promotions.length === 0 && !loadError && (
        <p className={styles.empty}>
          No active code discounts in Shopify. Automatic discounts are not listed — there is no code
          to quote — and expired ones are what customers are already writing in about.
        </p>
      )}

      <ul className={styles.list}>
        {promotions.map((promotion) => (
          <li
            key={promotion.promotionKey}
            className={`${styles.row} ${promotion.offerable ? styles.on : ""}`}
          >
            <div className={styles.main}>
              <div className={styles.codeLine}>
                <code className={styles.code}>{promotion.code}</code>
                {promotion.summary && <span className={styles.summary}>{promotion.summary}</span>}
              </div>

              <div className={styles.facts}>
                {/* THE BLOCKED LIST, NOT THE ALLOWED ONE. "Cannot be combined
                    with a product discount" is the sentence that explains a
                    rejected code; "combines with everything" is the quiet case
                    and says so in three words. */}
                {promotion.stacksWith ? (
                  <span className={styles.warn}>
                    Not combinable with {promotion.stacksWith.join(", ")}
                  </span>
                ) : (
                  <span className={styles.muted}>Combines with other discounts</span>
                )}
                {promotion.oncePerCustomer && <span className={styles.muted}>Once per customer</span>}
                <span className={styles.muted}>
                  Used {promotion.usage.used}
                  {promotion.usage.limit === null ? "" : ` of ${promotion.usage.limit}`}
                </span>
                {promotion.endsAt && (
                  <span className={styles.muted}>Ends {promotion.endsAt.slice(0, 10)}</span>
                )}
              </div>
            </div>

            <label className={styles.switch}>
              <input
                type="checkbox"
                checked={promotion.offerable}
                disabled={busy === promotion.promotionKey}
                onChange={() => toggle(promotion)}
                aria-label={`Allow support to offer ${promotion.code}`}
              />
              <span>{promotion.offerable ? "Offerable" : "Internal"}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
