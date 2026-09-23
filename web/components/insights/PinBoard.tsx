"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import styles from "./InsightsKit.module.css";

/**
 * Pinning a row of cards to the top of a panel.
 *
 * MOVED, NOT RE-ORDERED. A pinned row is portalled into the Pinned section, so
 * the DOM order — what a screen reader reads and Tab walks — matches what is on
 * screen. CSS `order` would have been less code and put the two out of step.
 *
 * TWO AT MOST. A third pin is refused with its reason rather than silently
 * bumping the oldest: a row that vanishes from the top without being unpinned
 * reads as a bug.
 *
 * PER VIEWER, PER PANEL, IN THE BROWSER. Which rows someone keeps at the top is
 * a personal view, not a shared setting, so it lives in localStorage keyed by
 * panel — and every read and write is guarded, because storage can be blocked
 * or cleared and the dashboard must render without it.
 */

export const MAX_PINS = 2;

interface PinApi {
  pins: string[];
  toggle: (id: string) => void;
  slotFor: (id: string) => HTMLElement | null;
  register: (id: string, label: string) => () => void;
}

const PinContext = createContext<PinApi | null>(null);

const storageKey = (panel: string) => `qiriness.insights.pins.${panel}`;

function readPins(panel: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey(panel));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string").slice(0, MAX_PINS) : [];
  } catch {
    return [];
  }
}

function writePins(panel: string, pins: string[]) {
  try {
    window.localStorage.setItem(storageKey(panel), JSON.stringify(pins));
  } catch {
    // A blocked store costs the pin surviving a reload, nothing more.
  }
}

export function PinBoard({ panel, children }: { panel: string; children: ReactNode }) {
  const [pins, setPins] = useState<string[]>([]);
  const [slots, setSlots] = useState<Record<string, HTMLElement | null>>({});
  const [present, setPresent] = useState<Record<string, string>>({});

  // Read after mount, so the first client render matches the server's (no pins).
  useEffect(() => setPins(readPins(panel)), [panel]);

  const toggle = useCallback(
    (id: string) => {
      setPins((current) => {
        const next = current.includes(id)
          ? current.filter((p) => p !== id)
          : current.length >= MAX_PINS
            ? current
            : [...current, id];
        writePins(panel, next);
        return next;
      });
    },
    [panel]
  );

  const register = useCallback((id: string, label: string) => {
    setPresent((p) => (p[id] === label ? p : { ...p, [id]: label }));
    return () =>
      setPresent((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
  }, []);

  const slotFor = useCallback((id: string) => slots[id] ?? null, [slots]);

  // Stable across renders: an inline ref callback is re-run on every render,
  // and one that sets state from it loops.
  const onSlot = useCallback((id: string, el: HTMLElement | null) => {
    setSlots((s) => (s[id] === el ? s : { ...s, [id]: el }));
  }, []);

  // Only pins whose row is on this page right now: a row that is not rendered
  // (no data today) leaves no empty band at the top.
  const shown = pins.filter((id) => id in present);

  const api = useMemo(() => ({ pins, toggle, slotFor, register }), [pins, toggle, slotFor, register]);

  return (
    <PinContext.Provider value={api}>
      <section
        className={`${styles.pinned} ${shown.length === 0 ? styles.pinnedEmpty : ""}`}
        aria-label="Pinned rows"
      >
        <div className={styles.pinnedHead}>
          <h2>Pinned</h2>
          <span>
            {shown.length} of {MAX_PINS}
          </span>
        </div>
        {pins.map((id) => (
          <Slot key={id} id={id} onSlot={onSlot} />
        ))}
      </section>
      {children}
    </PinContext.Provider>
  );
}

/** Where one pinned row is portalled to, in pin order. */
function Slot({ id, onSlot }: { id: string; onSlot: (id: string, el: HTMLElement | null) => void }) {
  const ref = useCallback((el: HTMLDivElement | null) => onSlot(id, el), [id, onSlot]);
  return <div ref={ref} />;
}

/**
 * A row of cards that can be pinned. The button sits in the top-right corner of
 * the row — inside its rightmost card — and the kit reserves room for it in
 * that card's header.
 */
export function PinnableRow({
  id,
  label,
  style,
  className,
  children,
}: {
  id: string;
  label: string;
  style?: CSSProperties;
  /** The grid class the row is laid out with, so a fixed-column row keeps its steps when pinned. */
  className?: string;
  children: ReactNode;
}) {
  const api = useContext(PinContext);
  const register = api?.register;

  useEffect(() => (register ? register(id, label) : undefined), [register, id, label]);

  if (!api) {
    return (
      <div className={className ?? styles.grid} style={style}>
        {children}
      </div>
    );
  }

  const pinned = api.pins.includes(id);
  const full = !pinned && api.pins.length >= MAX_PINS;
  const row = (
    <div className={`${className ?? styles.grid} ${styles.pinRow} ${pinned ? styles.isPinned : ""}`} style={style}>
      {children}
      <button
        type="button"
        className={`${styles.pinButton} ${pinned ? styles.pinOn : ""}`}
        onClick={() => api.toggle(id)}
        disabled={full}
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${label}` : `Pin ${label} to the top`}
        title={full ? `Two rows are pinned — unpin one first` : pinned ? "Unpin this row" : "Pin this row to the top"}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M9 3h6l-1 6 4 4v2h-5v6l-1 1-1-1v-6H6v-2l4-4-1-6z"
            fill={pinned ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );

  const slot = pinned ? api.slotFor(id) : null;
  return slot ? createPortal(row, slot) : row;
}
