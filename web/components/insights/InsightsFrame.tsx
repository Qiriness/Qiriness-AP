"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { PinBoard } from "./PinBoard";
import styles from "./InsightsHeader.module.css";

/**
 * The one place a panel changes what it shows: the URL.
 *
 * Filters write the query string and the server re-renders the page against it,
 * so a filtered panel is linkable and nothing is aggregated in the browser.
 * While the new render is on its way the old one stays on screen, dimmed — the
 * frame holds rather than flashing empty cards.
 *
 * A PANEL TAKES A MOMENT, SO IT SAYS SO. These renders read the database, which
 * on the wider ranges is a second or two; with nothing on screen to say so, a
 * click reads as a click that missed. The dim says "this is the old view", and
 * the spinner over it says "the new one is coming" — and the nav switches its
 * tab the instant it is clicked, rather than when the server answers.
 */

interface FrameApi {
  pending: boolean;
  /** Merge into the query string; a null removes the key. */
  navigate: (patch: Record<string, string | null>) => void;
  /**
   * Render that same address in the background, so a click on it finds the
   * page already there (Next keeps a full prefetch for 5 minutes). For the
   * moment a pointer reaches a filter: the 100–300 ms before the click.
   */
  prefetch: (patch: Record<string, string | null>) => void;
  /** Go to another panel, keeping the spinner and the dim. */
  go: (href: string, label?: string) => void;
  /** Re-read the database for the same URL. */
  refresh: () => void;
  /**
   * An Insights API path for THIS page's shop (its `?shop=`). Every call from
   * a panel goes through it: the server takes the shop from the request, so two
   * tabs on two shops each read and write their own.
   */
  api: (path: string) => string;
}

const FrameContext = createContext<FrameApi>({
  pending: false,
  navigate: () => {},
  prefetch: () => {},
  go: () => {},
  refresh: () => {},
  api: (path) => path,
});

export function useInsightsFrame() {
  return useContext(FrameContext);
}

export function InsightsFrame({
  panel,
  header,
  children,
}: {
  /** Which panel this is — pins are kept per panel. */
  panel: string;
  header: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState<string | null>(null);

  // The label belongs to one transition; it goes when that transition ends,
  // otherwise the next spinner would open with the last panel's name.
  useEffect(() => {
    if (!pending) setLabel(null);
  }, [pending]);

  // One address for a patch, so what is prefetched is exactly what a click opens.
  const hrefFor = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params?.toString() ?? "");
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [params, pathname]
  );

  const navigate = useCallback(
    (patch: Record<string, string | null>) => {
      const href = hrefFor(patch);
      startTransition(() => router.push(href, { scroll: false }));
    },
    [hrefFor, router]
  );

  const prefetch = useCallback(
    (patch: Record<string, string | null>) => {
      const href = hrefFor(patch);
      if (href !== hrefFor({})) router.prefetch(href);
    },
    [hrefFor, router]
  );

  const go = useCallback(
    (href: string, nextLabel?: string) => {
      setLabel(nextLabel ?? null);
      startTransition(() => router.push(href, { scroll: false }));
    },
    [router]
  );

  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);
  const shop = params?.get("shop") ?? null;
  const apiPath = useCallback(
    (path: string) => (shop ? `${path}${path.includes("?") ? "&" : "?"}shop=${encodeURIComponent(shop)}` : path),
    [shop]
  );
  const api = useMemo(
    () => ({ pending, navigate, prefetch, go, refresh, api: apiPath }),
    [pending, navigate, prefetch, go, refresh, apiPath]
  );

  return (
    <FrameContext.Provider value={api}>
      <div className={styles.page}>
        {header}
        <div className={styles.bodyWrap}>
          <div className={`${styles.body} ${pending ? styles.pending : ""}`} aria-busy={pending}>
            <PinBoard panel={panel}>{children}</PinBoard>
          </div>
          {pending ? (
            <div className={styles.loadingLayer}>
              <p className={styles.loadingPill} role="status">
                <span className={styles.spinner} aria-hidden="true" />
                {label ? t("nav.loading", { label }) : t("insights.shell.loading")}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </FrameContext.Provider>
  );
}
