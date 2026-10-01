"use client";

import { useState } from "react";

import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { useT } from "@/lib/i18n/client";
import type { AutomaticOffer, PromotionMechanic } from "@/lib/types";

import styles from "./PromotionList.module.css";

const MECHANIC_LABEL = {
  free_shipping: "setup.offers.mechanic.free_shipping",
  gift: "setup.offers.mechanic.gift",
  multi_buy: "setup.offers.mechanic.multi_buy",
  order_discount: "setup.offers.mechanic.order_discount",
  product_discount: "setup.offers.mechanic.product_discount",
  app: "setup.offers.mechanic.app",
  unknown: "setup.offers.mechanic.unknown",
} as const satisfies Record<PromotionMechanic, string>;

/**
 * Which automatic offers support may describe to a customer.
 *
 * THE MIRROR IMAGE OF THE CODE LIST ABOVE IT. A code is a key and nothing is
 * offerable until somebody says so; an automatic offer is advertised on the
 * site and applies itself, so every one is described unless somebody switches
 * it off. The marked row is therefore the exception here too — the hidden one.
 *
 * THE LABEL IS SHOPIFY'S STRUCTURE, NOT THE TITLE (scripts/lib/promotion-mechanic.mjs),
 * so nothing on a row needs maintaining: the next sync relabels a changed offer.
 */
export function AutomaticOfferList({
  initial,
  loadError,
}: {
  initial: AutomaticOffer[];
  loadError: string | null;
}) {
  const t = useT();
  const [offers, setOffers] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const described = offers.filter((o) => o.describable).length;

  async function toggle(offer: AutomaticOffer) {
    setBusy(offer.promotionKey);
    setError(null);
    try {
      const res = await fetch("/api/promotions/automatic", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promotionKey: offer.promotionKey, describable: !offer.describable }),
      });
      const body = await res.json();
      if (!res.ok) throw body;
      setOffers((current) =>
        current.map((o) => (o.promotionKey === offer.promotionKey ? body.offer : o))
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
          <h2 className={styles.title}>{t("setup.offers.title")}</h2>
          <p className={styles.lede}>{t("setup.offers.lede")}</p>
        </div>
        <span className={styles.count}>
          {t("setup.offers.count", { n: described, total: offers.length })}
        </span>
      </header>

      {loadError && <p className={styles.error}>{loadError}</p>}
      {error && <p className={styles.error}>{error}</p>}

      {offers.length === 0 && !loadError && <p className={styles.empty}>{t("setup.offers.empty")}</p>}

      <ul className={styles.list}>
        {offers.map((offer) => (
          <li
            key={offer.promotionKey}
            className={`${styles.row} ${offer.describable ? "" : styles.off}`}
          >
            <div className={styles.main}>
              <div className={styles.codeLine}>
                <span className={styles.badge}>{t(MECHANIC_LABEL[offer.mechanic])}</span>
                <span className={styles.offerTitle}>{offer.title}</span>
              </div>

              <div className={styles.facts}>
                {offer.summary && <span className={styles.muted}>{offer.summary}</span>}
                {offer.stacksWith && (
                  <span className={styles.warn}>
                    {t("setup.promotions.notCombinable", { with: offer.stacksWith.join(", ") })}
                  </span>
                )}
                {offer.endsAt && (
                  <span className={styles.muted}>{t("setup.promotions.ends", { date: offer.endsAt.slice(0, 10) })}</span>
                )}
              </div>
            </div>

            <label className={styles.switch}>
              <input
                type="checkbox"
                checked={offer.describable}
                disabled={busy === offer.promotionKey}
                onChange={() => toggle(offer)}
                aria-label={t("setup.offers.allow", { title: offer.title })}
              />
              <span>{offer.describable ? t("setup.offers.describable") : t("setup.offers.hidden")}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
