import { ArrowRightIcon, CheckCircleIcon, DotIcon } from "@/components/icons";
import styles from "./SetupHeader.module.css";

interface SetupHeaderProps {
  approved: number;
  total: number;
}

export function SetupHeader({ approved, total }: SetupHeaderProps) {
  const ready = total > 0 && approved === total;
  const message = ready
    ? "Your agent is ready to answer with approved knowledge."
    : `${approved} of ${total} articles approved for the agent.`;

  return (
    <header className={styles.header}>
      <div className={styles.headingRow}>
        <h1 className={styles.title}>Agent Setup</h1>
        <button type="button" className={styles.preview}>
          View agent preview
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
