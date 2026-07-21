"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ShopifyPage } from "@/lib/types";
import { ChevronDownIcon, PageIcon } from "@/components/icons";
import styles from "./SourcePageSelect.module.css";

interface SourcePageSelectProps {
  pages: ShopifyPage[];
  value: string | null;
  disabled?: boolean;
  onChange: (pageId: string | null) => void;
}

const NONE = "__none__";

export function SourcePageSelect({
  pages,
  value,
  disabled,
  onChange,
}: SourcePageSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const options = [
    { id: NONE, title: "No source page", handle: "Standalone article" },
    ...pages,
  ];
  const selected = pages.find((p) => p.id === value) ?? null;
  const selectedIndex = value ? options.findIndex((o) => o.id === value) : 0;

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

  function choose(id: string) {
    onChange(id === NONE ? null : id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
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
      setActiveIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(options[activeIndex].id);
    }
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <PageIcon size={17} className={styles.leadingIcon} />
        <span className={styles.triggerText}>
          {selected ? selected.title : "No source page"}
        </span>
        <ChevronDownIcon
          size={17}
          className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
        />
      </button>

      {open && (
        <ul className={styles.menu} role="listbox" id={listId} tabIndex={-1}>
          {options.map((opt, i) => {
            const isSelected = opt.id === (value ?? NONE);
            const isActive = i === activeIndex;
            return (
              <li
                key={opt.id}
                role="option"
                aria-selected={isSelected}
                className={`${styles.option} ${isActive ? styles.active : ""} ${
                  isSelected ? styles.selected : ""
                }`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => choose(opt.id)}
              >
                <PageIcon size={16} className={styles.optionIcon} />
                <span className={styles.optionText}>
                  <span className={styles.optionTitle}>{opt.title}</span>
                  <span className={styles.optionHandle}>{opt.handle}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
