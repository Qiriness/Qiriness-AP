import type { ReactElement } from "react";

/**
 * A platform's glyph in its colour (tokens `--social-*` in globals.css:
 * Instagram pink, Facebook blue, TikTok yellow). Decorative unless given a
 * `label`, which makes it an image for a screen reader; a card beside it should
 * then not repeat the name. Plain SVG, no hooks, so server and client render it.
 */
const GLYPHS: Record<string, ReactElement> = {
  instagram: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" />
    </>
  ),
  facebook: <path fill="currentColor" d="M13.5 21v-7.5h2.5l.5-3h-3V8.6c0-.9.3-1.5 1.6-1.5h1.5V4.4c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.4H8.2v3h2.5V21h2.8z" />,
  tiktok: <path fill="currentColor" d="M16.6 3c.3 2 1.5 3.4 3.4 3.6v2.6c-1.2 0-2.3-.4-3.3-1v6.1c0 3-2.4 5.3-5.3 5.3S6 17.3 6 14.3c0-3.1 2.7-5.5 5.8-5.2v2.7c-1.6-.4-3 .7-3 2.4 0 1.4 1.1 2.5 2.5 2.5s2.5-1.1 2.5-2.5V3h2.8z" />,
};

export function PlatformIcon({ kind, size = 20, label }: { kind: string; size?: number; label?: string }) {
  const glyph = GLYPHS[kind];
  if (!glyph) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={{ color: `var(--social-${kind})`, flex: "none" }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {glyph}
    </svg>
  );
}

/** Small line glyphs for a card's figures; always decorative, the figure beside them is the text. */
export function MetricIcon({ name }: { name: "views" | "likes" | "comments" | "open" }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" focusable="false" style={{ flex: "none" }}>
      {name === "views" ? (
        <>
          <path {...common} d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
          <circle {...common} cx="12" cy="12" r="3" />
        </>
      ) : name === "likes" ? (
        <path {...common} d="M12 20s-8-4.9-8-10.6C4 6.5 6 5 8 5c1.7 0 3 .9 4 2.3C13 5.9 14.3 5 16 5c2 0 4 1.5 4 4.4C20 15.100 12 20 12 20z" />
      ) : name === "comments" ? (
        <path {...common} d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />
      ) : (
        <>
          <path {...common} d="M14 4h6v6" />
          <path {...common} d="M20 4l-9 9" />
          <path {...common} d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
        </>
      )}
    </svg>
  );
}
