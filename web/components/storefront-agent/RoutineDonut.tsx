import { getFormat, getT } from "@/lib/i18n/server";
import type { StorefrontAgentDashboard } from "@/lib/storefront-agent-types";
import styles from "./RoutineDonut.module.css";

type Slice = StorefrontAgentDashboard["routineProfile"]["charts"][number]["slices"][number];

/** The app's four chart hues (CollectionMix's order); the rest fold into « Others ». */
const HUES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];
const OTHER = "var(--mist)";
const NOT_ASKED = "var(--border-strong)";
const R = 15.9155; // circumference 100: a slice's dash is its share in percent
const GAP = 0.6;

/**
 * One builder answer as a donut: the four most given answers in colour, the
 * rest as « Others », an answer not asked last in grey. The legend beside it
 * names every answer with its count and share, so nothing is read from colour
 * alone; each slice's tooltip says the same.
 */
export function RoutineDonut({ title, slices }: { title: string; slices: Slice[] }) {
  const t = getT();
  const f = getFormat();
  const total = slices.reduce((sum, s) => sum + s.routines, 0);
  const name = (s: Slice) => (s.code === null ? t("storefrontAgent.profile.notAsked") : s.label ?? s.code);

  const answered = slices.filter((s) => s.code !== null);
  const notAsked = slices.filter((s) => s.code === null).reduce((sum, s) => sum + s.routines, 0);
  const shown = answered.slice(0, HUES.length).map((s, i) => ({ key: s.code as string, label: name(s), value: s.routines, color: HUES[i], detail: null as string | null }));
  const rest = answered.slice(HUES.length);
  const marks = [
    ...shown,
    ...(rest.length
      ? [{ key: "_other", label: t("storefrontAgent.profile.other"), value: rest.reduce((sum, s) => sum + s.routines, 0), color: OTHER, detail: rest.map(name).join(", ") }]
      : []),
    ...(notAsked ? [{ key: "_none", label: t("storefrontAgent.profile.notAsked"), value: notAsked, color: NOT_ASKED, detail: null }] : []),
  ];
  const share = (value: number) => f.percent(value, total, 0);

  let offset = 0;
  return (
    <figure className={styles.figure}>
      <figcaption className={styles.title}>{title}</figcaption>
      {total === 0 ? (
        <p className={styles.empty}>{t("storefrontAgent.profile.none")}</p>
      ) : (
        <div className={styles.body}>
          <svg viewBox="0 0 42 42" className={styles.donut} role="img" aria-label={t("storefrontAgent.profile.aria", { title, n: f.integer(total) })}>
            <circle cx="21" cy="21" r={R} className={styles.track} />
            {marks.map((m) => {
              const pct = (m.value / total) * 100;
              const dash = marks.length > 1 ? Math.max(pct - GAP, 0.01) : pct;
              const el = (
                <circle
                  key={m.key}
                  cx="21"
                  cy="21"
                  r={R}
                  className={styles.slice}
                  stroke={m.color}
                  strokeDasharray={`${dash} ${100 - dash}`}
                  strokeDashoffset={25 - offset}
                >
                  <title>{`${m.label}: ${f.integer(m.value)} (${share(m.value)})${m.detail ? ` · ${m.detail}` : ""}`}</title>
                </circle>
              );
              offset += pct;
              return el;
            })}
            <text x="21" y="21" className={styles.total}>{f.integer(total)}</text>
            <text x="21" y="26.5" className={styles.unit}>{t("storefrontAgent.profile.unit")}</text>
          </svg>
          <ul className={styles.legend}>
            {marks.map((m) => (
              <li key={m.key} title={m.detail ?? undefined}>
                <i style={{ background: m.color }} aria-hidden="true" />
                <span className={styles.label}>{m.label}</span>
                <span className={styles.value}>
                  {f.integer(m.value)} <span className={styles.share}>{share(m.value)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </figure>
  );
}
