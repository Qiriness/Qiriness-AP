"use client";

import { useState } from "react";
import { CloseIcon } from "@/components/icons";
import styles from "./EditableChipList.module.css";

interface EditableChipListProps {
  label: string;
  items: string[];
  onChange?: (items: string[]) => void;
  placeholder?: string;
  /** "inline" renders wrapped pill chips (Tone); "list" renders vertical bulleted rows (Do's/Don'ts). */
  layout?: "inline" | "list";
  /** Read-only baseline items — no remove control, no add-input row. `onChange` is unused when true. */
  locked?: boolean;
}

/**
 * Minimal editable tag list. Enter (or comma, inline layout only) commits the
 * draft; Backspace on an empty draft removes the last item; each item has its
 * own remove control. No inline-edit or reordering — remove-and-re-add only.
 */
export function EditableChipList({
  label,
  items,
  onChange,
  placeholder,
  layout = "inline",
  locked = false,
}: EditableChipListProps) {
  const [draft, setDraft] = useState("");

  function commit(value: string) {
    const trimmed = value.trim();
    if (!trimmed || items.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange?.([...items, trimmed]);
    setDraft("");
  }

  function remove(index: number) {
    onChange?.(items.filter((_, i) => i !== index));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || (layout === "inline" && e.key === ",")) {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && items.length > 0) {
      remove(items.length - 1);
    }
  }

  return (
    <div className={styles.wrap}>
      <span className={styles.label}>{label}</span>
      <div className={`${styles.items} ${styles[layout]}`}>
        {items.map((item, i) => (
          <span key={`${item}-${i}`} className={layout === "inline" ? styles.chip : styles.row}>
            <span className={styles.text}>{item}</span>
            {!locked && (
              <button
                type="button"
                className={styles.remove}
                onClick={() => remove(i)}
                aria-label={`Remove ${item}`}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </span>
        ))}
        {!locked && (
          <input
            type="text"
            className={styles.input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => commit(draft)}
            placeholder={placeholder}
            aria-label={label}
          />
        )}
      </div>
    </div>
  );
}
