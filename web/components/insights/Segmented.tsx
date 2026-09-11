"use client";

import styles from "./Segmented.module.css";

/**
 * A small set of mutually exclusive views — Global / By country, Revenue /
 * Orders. `aria-pressed` carries the selection, not only the colour.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`${styles.segment} ${value === option.id ? styles.active : ""}`}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The country picker beside a Segmented, in the same chrome. */
export function GroupSelect({
  groups,
  value,
  onChange,
  label,
}: {
  groups: { key: string; label: string; hint?: string }[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <select className={styles.select} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {groups.map((g) => (
        <option key={g.key} value={g.key}>
          {g.hint ? `${g.label} — ${g.hint}` : g.label}
        </option>
      ))}
    </select>
  );
}
