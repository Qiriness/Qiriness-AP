import type { ReactNode } from "react";
import styles from "./Flag.module.css";

/**
 * A small country flag, drawn inline.
 *
 * NOT AN EMOJI: Windows ships no flag emoji, so `🇫🇷` renders as the letters
 * "FR" on the machine this dashboard is read on. Nor an image: nothing external
 * is fetched for a decoration. The designs are simplified to what survives at
 * 20x14 — stripes, crosses — and a country without one gets its code in a
 * neutral badge rather than a wrong flag.
 */

type Design = ReactNode;

const W = 24;
const H = 16;

const vertical = (...colors: string[]): Design =>
  colors.map((color, i) => (
    <rect key={i} x={(W / colors.length) * i} y={0} width={W / colors.length + 0.5} height={H} fill={color} />
  ));

const horizontal = (...colors: string[]): Design =>
  colors.map((color, i) => (
    <rect key={i} x={0} y={(H / colors.length) * i} width={W} height={H / colors.length + 0.5} fill={color} />
  ));

const nordic = (field: string, cross: string, inner?: string): Design => (
  <>
    <rect width={W} height={H} fill={field} />
    <rect x={7} y={0} width={4} height={H} fill={cross} />
    <rect x={0} y={6} width={W} height={4} fill={cross} />
    {inner ? (
      <>
        <rect x={8} y={0} width={2} height={H} fill={inner} />
        <rect x={0} y={7} width={W} height={2} fill={inner} />
      </>
    ) : null}
  </>
);

const DESIGNS: Record<string, Design> = {
  FR: vertical("#0055a4", "#ffffff", "#ef4135"),
  BE: vertical("#000000", "#fdda24", "#ef3340"),
  IT: vertical("#009246", "#ffffff", "#ce2b37"),
  IE: vertical("#169b62", "#ffffff", "#ff883e"),
  RO: vertical("#002b7f", "#fcd116", "#ce1126"),
  NL: horizontal("#ae1c28", "#ffffff", "#21468b"),
  DE: horizontal("#000000", "#dd0000", "#ffce00"),
  LU: horizontal("#ed2939", "#ffffff", "#00a1de"),
  AT: horizontal("#ed2939", "#ffffff", "#ed2939"),
  HU: horizontal("#ce2939", "#ffffff", "#477050"),
  BG: horizontal("#ffffff", "#00966e", "#d62612"),
  PL: horizontal("#ffffff", "#dc143c"),
  MC: horizontal("#ce1126", "#ffffff"),
  ES: (
    <>
      <rect width={W} height={H} fill="#aa151b" />
      <rect y={4} width={W} height={8} fill="#f1bf00" />
    </>
  ),
  PT: (
    <>
      <rect width={W} height={H} fill="#da291c" />
      <rect width={9.6} height={H} fill="#046a38" />
    </>
  ),
  CH: (
    <>
      <rect width={W} height={H} fill="#da291c" />
      <rect x={10.5} y={3.5} width={3} height={9} fill="#ffffff" />
      <rect x={7.5} y={6.5} width={9} height={3} fill="#ffffff" />
    </>
  ),
  DK: nordic("#c8102e", "#ffffff"),
  SE: nordic("#006aa7", "#fecc00"),
  FI: nordic("#ffffff", "#002f6c"),
  NO: nordic("#ba0c2f", "#ffffff", "#00205b"),
  GB: (
    <>
      <rect width={W} height={H} fill="#012169" />
      <path d={`M0,0 L${W},${H} M${W},0 L0,${H}`} stroke="#ffffff" strokeWidth={3.2} />
      <path d={`M0,0 L${W},${H} M${W},0 L0,${H}`} stroke="#c8102e" strokeWidth={1.2} />
      <rect x={9.5} y={0} width={5} height={H} fill="#ffffff" />
      <rect x={0} y={5.5} width={W} height={5} fill="#ffffff" />
      <rect x={10.5} y={0} width={3} height={H} fill="#c8102e" />
      <rect x={0} y={6.5} width={W} height={3} fill="#c8102e" />
    </>
  ),
  US: (
    <>
      <rect width={W} height={H} fill="#ffffff" />
      {Array.from({ length: 13 }, (_, i) =>
        i % 2 === 0 ? <rect key={i} y={(H / 13) * i} width={W} height={H / 13 + 0.1} fill="#b22234" /> : null
      )}
      <rect width={10} height={H * (7 / 13)} fill="#3c3b6e" />
    </>
  ),
  CA: (
    <>
      <rect width={W} height={H} fill="#ffffff" />
      <rect width={6} height={H} fill="#d80621" />
      <rect x={18} width={6} height={H} fill="#d80621" />
      <rect x={10.5} y={5} width={3} height={6} fill="#d80621" />
    </>
  ),
};

export function Flag({ code }: { code: string }) {
  const design = DESIGNS[code.toUpperCase()];
  if (!design) {
    return (
      <span className={styles.badge} aria-hidden="true">
        {/^[A-Z]{2}$/i.test(code) ? code.toUpperCase() : "?"}
      </span>
    );
  }
  return (
    <svg className={styles.flag} viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
      {design}
    </svg>
  );
}
