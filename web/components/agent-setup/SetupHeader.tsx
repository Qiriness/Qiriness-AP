import { ArrowRightIcon, CheckCircleIcon, DotIcon } from "@/components/icons";
import { useT } from "@/lib/i18n/client";
import styles from "./SetupHeader.module.css";

interface SetupHeaderProps {
  approved: number;
  total: number;
  /** Opens the test chat: a message you write, put through the real pipeline. */
  onTest: () => void;
}

export function SetupHeader({ approved, total, onTest }: SetupHeaderProps) {
  const t = useT();
  const ready = total > 0 && approved === total;
  const message = ready ? t("setup.header.ready") : t("setup.header.progress", { approved, total });

  return (
    <header className={styles.header}>
      <div className={styles.headingRow}>
        <h1 className={styles.title}>{t("nav.agentSetup")}</h1>
        {/* Navigation moved to the tab bar in the layout. This stays a button
            because it IS an action: it opens a dialog and goes nowhere. */}
        <button type="button" className={styles.preview} onClick={onTest}>
          {t("setup.header.test")}
          <ArrowRightIcon size={16} />
        </button>
      </div>
      <p className={styles.status} data-ready={ready || undefined}>
        <span className={styles.statusIcon}>
          {ready ? <CheckCircleIcon size={17} /> : <DotIcon size={12} />}
        </span>
        {message}
      </p>
    </header>
  );
}
