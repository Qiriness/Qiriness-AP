"use client";

/**
 * A toolbar filter that shows the queue's own marks: each option carries the
 * icon and colour the cards use (category colour and icon, the robot / person /
 * alert for the level), which a native <select> cannot draw. A swatch takes its
 * colours from `--cat-color` / `--cat-bg`, so `categoryVars` styles it directly.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "@/components/icons";
import styles from "./FilterMenu.module.css";

export interface FilterOption<V extends string> {
  value: V;
  label: string;
  count?: number;
  icon?: ReactNode;
  /** `--cat-color` and `--cat-bg` for the swatch behind the icon. */
  swatch?: CSSProperties;
}

export function FilterMenu<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: FilterOption<V>[];
  onChange: (value: V) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  // A menu with icons keeps their column on every row, so the labels line up.
  const withIcons = options.some((option) => option.icon);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    list.current?.focus();
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function openMenu() {
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  }

  function choose(next: V) {
    onChange(next);
    setOpen(false);
    root.current?.querySelector("button")?.focus();
  }

  function onListKey(event: KeyboardEvent) {
    if (event.key === "Escape" || event.key === "Tab") {
      setOpen(false);
      if (event.key === "Escape") root.current?.querySelector("button")?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(options[active].value);
    }
  }

  return (
    <div className={styles.root} ref={root}>
      <span className={styles.caption}>{label}</span>
      <button
        type="button"
        className={`${styles.trigger} ${selected.swatch ? styles.triggerTinted : ""}`}
        style={selected.swatch}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected.label}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        {selected.icon && <span className={styles.triggerIcon}>{selected.icon}</span>}
        <span className={styles.triggerLabel}>{selected.label}</span>
        {selected.count !== undefined && <span className={styles.count}>{selected.count}</span>}
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <ul
          ref={list}
          className={styles.menu}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${uid}-${options[active]?.value}`}
          onKeyDown={onListKey}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${uid}-${option.value}`}
              role="option"
              aria-selected={option.value === value}
              className={`${styles.option} ${index === active ? styles.optionActive : ""} ${option.count === 0 ? styles.optionEmpty : ""}`}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(option.value)}
            >
              {withIcons && (
                <span className={styles.swatch} style={option.swatch}>
                  {option.icon}
                </span>
              )}
              <span className={styles.optionLabel}>{option.label}</span>
              {option.count !== undefined && <span className={styles.count}>{option.count}</span>}
              <span className={styles.check}>{option.value === value && <CheckIcon size={14} />}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
