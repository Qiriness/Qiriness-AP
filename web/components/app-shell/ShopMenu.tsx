"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "@/components/icons";
import { useT } from "@/lib/i18n/client";
import type { NavShop } from "@/lib/shop-context";
import styles from "./Sidebar.module.css";

/**
 * A shop's mark: its logo file, or its initial while it has none. The file is
 * checked after hydration as well as by `onError`, because an image that fails
 * before React attaches its handler never reports it.
 */
export function ShopMark({ shop, size = 32, className = "" }: { shop: NavShop; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setBroken(false);
    const img = ref.current;
    if (img?.complete && img.naturalWidth === 0) setBroken(true);
  }, [shop.logo]);

  if (broken) {
    return (
      <span className={`${styles.monogram} ${className}`} style={{ width: size, height: size }} aria-hidden="true">
        {shop.name.trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  }
  return (
    // A plain <img>: the files are tiny and already the size shown, and the
    // optimiser would add a request through /_next/image for nothing.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={shop.logo}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={`${styles.mark} ${className}`}
      onError={() => setBroken(true)}
    />
  );
}

/**
 * The top of the sidebar: the shop on screen, and with two or more shops the
 * switcher. Picking a shop calls `onPick`; where that goes is the sidebar's
 * decision (web/lib/shop-switch.mjs).
 */
export function ShopMenu({
  shops,
  current,
  collapsed,
  onPick,
}: {
  shops: NavShop[];
  current: NavShop;
  collapsed: boolean;
  onPick: (shop: NavShop) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Closed by a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const brand = (
    <>
      <ShopMark shop={current} />
      {!collapsed && (
        <span className={styles.brandText}>
          <span className={styles.brandName}>{current.name}</span>
          <span className={styles.brandSub}>Support&nbsp;OS</span>
        </span>
      )}
    </>
  );

  if (shops.length < 2) return <div className={styles.brand}>{brand}</div>;

  return (
    <div className={styles.shopMenu} ref={root}>
      <button
        type="button"
        className={`${styles.brand} ${styles.brandButton}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t("nav.switchShop", { shop: current.name })}
        title={collapsed ? current.name : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {brand}
        {!collapsed && <ChevronDownIcon size={16} className={styles.brandChevron} />}
      </button>
      {open ? (
        <ul className={`${styles.shopList} ${collapsed ? styles.shopListSide : ""}`} aria-label={t("insights.shell.shopLabel")}>
          {shops.map((shop) => (
            <li key={shop.slug}>
              <button
                type="button"
                className={styles.shopOption}
                aria-current={shop.slug === current.slug ? "true" : undefined}
                onClick={() => {
                  setOpen(false);
                  if (shop.slug !== current.slug) onPick(shop);
                }}
              >
                <ShopMark shop={shop} size={24} />
                <span className={styles.shopOptionName}>{shop.name}</span>
                {shop.slug === current.slug ? <CheckIcon size={16} className={styles.shopCheck} /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
