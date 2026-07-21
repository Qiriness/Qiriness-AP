"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KnowledgeCategory } from "@/lib/types";
import { CATEGORY_LABELS, KNOWLEDGE_CATEGORIES } from "@/lib/types";
import { ChevronDownIcon } from "@/components/icons";
import styles from "./CategorySelect.module.css";

interface CategorySelectProps {
  value: KnowledgeCategory;
  onChange: (category: KnowledgeCategory) => void;
}

/** Accessible listbox for the knowledge-base category. Same interaction as SourcePageSelect. */
export function CategorySelect({ value, onChange }: CategorySelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selectedIndex = KNOWLEDGE_CATEGORIES.indexOf(value);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, selectedIndex]);

  function choose(category: KnowledgeCategory) {
    onChange(category);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, KNOWLEDGE_CATEGORIES.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(KNOWLEDGE_CATEGORIES[activeIndex]);
    }
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className={styles.triggerText}>{CATEGORY_LABELS[value]}</span>
        <ChevronDownIcon
          size={17}
          className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
        />
      </button>

      {open && (
        <ul className={styles.menu} role="listbox" id={listId} tabIndex={-1}>
          {KNOWLEDGE_CATEGORIES.map((category, i) => {
            const isSelected = category === value;
            const isActive = i === activeIndex;
            return (
              <li
                key={category}
                role="option"
                aria-selected={isSelected}
                className={`${styles.option} ${isActive ? styles.active : ""} ${
                  isSelected ? styles.selected : ""
                }`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => choose(category)}
              >
                {CATEGORY_LABELS[category]}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
