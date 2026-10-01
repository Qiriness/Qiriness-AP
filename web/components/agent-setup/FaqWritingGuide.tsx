"use client";

import { useId, useState } from "react";
import { HelpIcon } from "@/components/icons";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/lib/i18n/client";
import styles from "./FaqWritingGuide.module.css";

const STEPS = [
  "setup.knowledge.guide.step1",
  "setup.knowledge.guide.step2",
  "setup.knowledge.guide.step3",
  "setup.knowledge.guide.step4",
  "setup.knowledge.guide.step5",
  "setup.knowledge.guide.step6",
] as const;

/**
 * How to write an FAQ article, behind a toggle beside « Article content ».
 * The format follows how articles are embedded: each heading starts its own
 * chunk, embedded as title + heading + body, so the question and its rewordings
 * travel with the answer (DECISIONS.md § Knowledge).
 */
export function FaqWritingGuide() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className={styles.guide}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <HelpIcon size={14} />
        {open ? t("setup.knowledge.guide.close") : t("setup.knowledge.guide.open")}
      </button>

      {open && (
        <section id={panelId} className={styles.panel} aria-label={t("setup.knowledge.guide.title")}>
          <h3 className={styles.title}>{t("setup.knowledge.guide.title")}</h3>
          <FaqGuideContent />
        </section>
      )}
    </div>
  );
}

/** The guide itself, shared by the inline panel and the page-header popup. */
export function FaqGuideContent() {
  const t = useT();
  return (
    <div className={styles.content}>
      <p className={styles.intro}>{t("setup.knowledge.guide.intro")}</p>
      <ol className={styles.steps}>
        {STEPS.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ol>

      <p className={styles.exampleLabel}>{t("setup.knowledge.guide.example")}</p>
      <div className={styles.example}>
        <div className={styles.exampleRow}>
          <span className={styles.tag}>{t("setup.knowledge.guide.headingTag")}</span>
          <p className={styles.exampleHeading}>{t("setup.knowledge.guide.exampleHeading")}</p>
        </div>
        <div className={styles.exampleRow}>
          <span className={styles.tag}>{t("setup.knowledge.guide.variantsTag")}</span>
          <p className={styles.exampleVariants}>{t("setup.knowledge.guide.exampleVariants")}</p>
        </div>
        <div className={styles.exampleRow}>
          <span className={styles.tag}>{t("setup.knowledge.guide.answerTag")}</span>
          <p className={styles.exampleAnswer}>{t("setup.knowledge.guide.exampleAnswer")}</p>
        </div>
      </div>
    </div>
  );
}

/** The same guide as a popup, opened from the top right of the Knowledge page. */
export function FaqGuideDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Dialog
      title={t("setup.knowledge.guide.title")}
      closeLabel={t("setup.knowledge.guide.closeDialog")}
      onClose={onClose}
      size="compact"
    >
      <FaqGuideContent />
    </Dialog>
  );
}
