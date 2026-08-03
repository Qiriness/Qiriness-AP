import type { TicketHappiness } from "@/lib/types";
import { TICKET_HAPPINESS_MEANINGS } from "@/lib/types";
import styles from "./HappinessFace.module.css";

interface HappinessFaceProps {
  happiness: TicketHappiness | null;
}

/**
 * Traffic-light mood face — the first thing in a row, so the queue reads as a
 * column of colour before a single word is read.
 *
 * Three tones over the four-point scale, because the point of a traffic light
 * is to have three states: green is "nothing to feel bad about" (1 happy,
 * 2 neutral), amber is "discontent said out loud" (3), red is "really unhappy"
 * (4). Folding 2 into green rather than amber is deliberate: neutral is the
 * commonest score, and an amber row for every ordinary email would turn the
 * whole column amber and signal nothing.
 *
 * Drawn rather than a Unicode emoji: 🙂/😐/🙁 render as the OS's own artwork,
 * which lands as a different icon set on every machine and ignores the app's
 * palette. This is the same 24×24 grid and 1.6px stroke as `icons.tsx`, tinted
 * with the app's own success/warning/error tokens.
 */
export function HappinessFace({ happiness }: HappinessFaceProps) {
  if (happiness === null) {
    return (
      <span className={`${styles.face} ${styles.none}`} title="Mood not scored yet">
        <FaceIcon mouth="none" />
        <span className={styles.srOnly}>Mood not scored yet</span>
      </span>
    );
  }

  const tone = happiness <= 2 ? "happy" : happiness === 3 ? "medium" : "sad";
  const label = `${TICKET_HAPPINESS_MEANINGS[happiness]} customer`;

  return (
    <span className={`${styles.face} ${styles[tone]}`} title={label}>
      <FaceIcon mouth={tone} />
      <span className={styles.srOnly}>{label}</span>
    </span>
  );
}

/** The circle is shared; only the mouth changes, so the three read as one set. */
function FaceIcon({ mouth }: { mouth: "happy" | "medium" | "sad" | "none" }) {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="8.5" />
      {mouth !== "none" && (
        <>
          <path d="M9 10h.01" />
          <path d="M15 10h.01" />
        </>
      )}
      {mouth === "happy" && <path d="M8.5 14a4 4 0 0 0 7 0" />}
      {mouth === "medium" && <path d="M9 14.5h6" />}
      {mouth === "sad" && <path d="M8.5 15.5a4 4 0 0 1 7 0" />}
      {/* No eyes and no mouth: an unscored ticket should look blank, not calm. */}
      {mouth === "none" && <path d="M9 12.5h6" strokeDasharray="2 2.5" />}
    </svg>
  );
}
