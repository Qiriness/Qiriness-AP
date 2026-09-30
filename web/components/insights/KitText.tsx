"use client";

import { useFormat } from "@/lib/i18n/client";
import { Tx } from "@/lib/i18n/client";

/**
 * The bits of the Insights kit that print a number or a word in the reader's
 * language. Client components so the kit itself — rendered by Server and Client
 * Components alike — needs no locale of its own.
 */

/** The magnitude of a change: `3,2 pts` or `12,5 %`. The arrow and the sign carry the direction. */
export function DeltaFigure({ diff, points }: { diff: number; points: boolean }) {
  const f = useFormat();
  if (points) {
    return (
      <>
        {f.decimal(Math.abs(diff), 1)} <Tx k="insights.kit.pts" />
      </>
    );
  }
  return <>{f.percentOf(Math.abs(diff * 100), 1)}</>;
}

/** A plain quantity in the reader's grouping. */
export function NumText({ value }: { value: number }) {
  const f = useFormat();
  return <>{f.integer(value)}</>;
}

/** A percentage in the reader's format: `12,5 %` / `12.5%`. */
export function PercentText({ value, digits = 1 }: { value: number; digits?: number }) {
  const f = useFormat();
  return <>{f.percentOf(value, digits)}</>;
}
