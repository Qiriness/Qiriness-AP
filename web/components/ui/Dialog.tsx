"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { CloseIcon } from "@/components/icons";
import styles from "./Dialog.module.css";

interface DialogProps {
  /** Rendered as the heading and used as the dialog's accessible name. */
  title: string;
  /** One quiet line under the title: who, when, how many. */
  meta?: ReactNode;
  /** Screen-reader label for the close button, e.g. "Close the conversation". */
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The modal overlay shell: backdrop, panel, header, and the one scroller.
 *
 * Extracted when the second consumer arrived (the ticket thread and the dropped
 * mail record), not before — the behaviour that has to be identical is the part
 * that is easy to get subtly wrong per copy: Escape closing, the page behind
 * being frozen, focus landing inside, and a backdrop click that does not fire
 * when the drag started on the panel.
 *
 * Content is entirely the caller's. This owns no layout below the header, so a
 * conversation and a one-screen record can share it without either bending to
 * the other's shape.
 */
export function Dialog({ title, meta, closeLabel, onClose, children }: DialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus moves into the dialog on open, so the next Tab lands inside it rather
  // than continuing down the page behind.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    // The page behind must not scroll while the overlay is up: the body has its
    // own scroller, and two nested ones fight over the wheel.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className={styles.backdrop}
      // Clicking the backdrop closes; a click that started inside the panel and
      // ended out here must not, which is why this is on the backdrop element
      // and the panel stops propagation rather than the reverse.
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        className={styles.dialog}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.headerText}>
            <h2 id="app-dialog-title" className={styles.title}>
              {title}
            </h2>
            {meta && <p className={styles.meta}>{meta}</p>}
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label={closeLabel}
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
