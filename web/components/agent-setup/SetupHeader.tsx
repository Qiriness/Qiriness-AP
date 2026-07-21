import { ArrowRightIcon, CheckCircleIcon, DotIcon } from "@/components/icons";
import { CORE_TOPIC_LABELS, type CoreTopic } from "@/lib/types";
import styles from "./SetupHeader.module.css";

interface SetupHeaderProps {
  approved: number;
  total: number;
  coreTopicStatus: Array<{ topic: CoreTopic; isFilled: boolean }>;
}

export function SetupHeader({ approved, total, coreTopicStatus }: SetupHeaderProps) {
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
      <div className={styles.statusRow}>
        <p className={styles.status} data-ready={ready || undefined}>
          <span className={styles.statusIcon}>
            {ready ? <CheckCircleIcon size={17} /> : <DotIcon size={12} />}
          </span>
          {message}
        </p>
        <div className={styles.checklist}>
          {coreTopicStatus.map(({ topic, isFilled }) => (
            <div key={topic} className={styles.checkItem} data-filled={isFilled}>
              <span className={styles.checkIcon}>
                {isFilled ? <CheckCircleIcon size={12} /> : <div className={styles.emptyDot} />}
              </span>
              <span className={styles.checkLabel}>{CORE_TOPIC_LABELS[topic]}</span>
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}
