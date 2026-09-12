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
  /** Go to another panel, keeping the spinner and the dim. */
  go: (href: string, label?: string) => void;
  /** Re-read the database for the same URL. */
  refresh: () => void;
}

const FrameContext = createContext<FrameApi>({
  pending: false,
  navigate: () => {},
  go: () => {},
  refresh: () => {},
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

  const navigate = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params?.toString() ?? "");
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      startTransition(() => router.push(query ? `${pathname}?${query}` : pathname, { scroll: false }));
    },
    [params, pathname, router]
  );

  const go = useCallback(
    (href: string, nextLabel?: string) => {
      setLabel(nextLabel ?? null);
      startTransition(() => router.push(href, { scroll: false }));
    },
    [router]
  );

  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);
  const api = useMemo(() => ({ pending, navigate, go, refresh }), [pending, navigate, go, refresh]);

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
                {label ? `Loading ${label}…` : "Loading…"}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </FrameContext.Provider>
  );
}
