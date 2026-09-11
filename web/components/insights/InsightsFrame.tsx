"use client";

import { createContext, useCallback, useContext, useMemo, useTransition, type ReactNode } from "react";
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
 */

interface FrameApi {
  pending: boolean;
  /** Merge into the query string; a null removes the key. */
  navigate: (patch: Record<string, string | null>) => void;
  /** Re-read the database for the same URL. */
  refresh: () => void;
}

const FrameContext = createContext<FrameApi>({ pending: false, navigate: () => {}, refresh: () => {} });

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

  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);
  const api = useMemo(() => ({ pending, navigate, refresh }), [pending, navigate, refresh]);

  return (
    <FrameContext.Provider value={api}>
      <div className={styles.page}>
        {header}
        <div className={`${styles.body} ${pending ? styles.pending : ""}`} aria-busy={pending}>
          <PinBoard panel={panel}>{children}</PinBoard>
        </div>
      </div>
    </FrameContext.Provider>
  );
}
