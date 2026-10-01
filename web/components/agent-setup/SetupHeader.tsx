import { useState } from "react";
import { ArrowRightIcon, CheckCircleIcon, DotIcon, HelpIcon } from "@/components/icons";
import { useT } from "@/lib/i18n/client";
import { FaqGuideDialog } from "./FaqWritingGuide";
import styles from "./SetupHeader.module.css";

interface SetupHeaderProps {
  approved: number;
  total: number;
  /** Opens the test chat: a message you write, put through the real pipeline. */
  onTest: () => void;
}

export function SetupHeader({ approved, total, onTest }: SetupHeaderProps) {
  const t = useT();
  const [guideOpen, setGuideOpen] = useState(false);
  const ready = total > 0 && approved === total;
  const message = ready ? t("setup.header.ready") : t("setup.header.progress", { approved, total });

  return (
    <header className={styles.header}>
      <div className={styles.headingRow}>
        <h1 className={styles.title}>{t("nav.agentSetup")}</h1>
        {/* Navigation moved to the tab bar in the layout. This stays a button
            because it IS an action: it opens a dialog and goes nowhere. */}
        <div className={styles.headingActions}>
          <button type="button" className={styles.guide} onClick={() => setGuideOpen(true)}>
            <HelpIcon size={16} />
            {t("setup.knowledge.guide.open")}
          </button>
          <button type="button" className={styles.preview} onClick={onTest}>
            {t("setup.header.test")}
            <ArrowRightIcon size={16} />
          </button>
        </div>
      </div>
      {guideOpen && <FaqGuideDialog onClose={() => setGuideOpen(false)} />}
      <p className={styles.status} data-ready={ready || undefined}>
        <span className={styles.statusIcon}>
          {ready ? <CheckCircleIcon size={17} /> : <DotIcon size={12} />}
        </span>
        {message}
      </p>
    </header>
  );
}
