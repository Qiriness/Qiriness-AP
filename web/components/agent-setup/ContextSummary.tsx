import { CheckCircleIcon } from "@/components/icons";
import styles from "./ContextSummary.module.css";

interface ContextSummaryProps {
  brandVoiceTitle: string | null;
  brandVoiceApproved: boolean;
  tone: string[];
}

/** Compact reminder of the shared context every reply inherits. Kept light. */
export function ContextSummary({
  brandVoiceTitle,
  brandVoiceApproved,
  tone,
}: ContextSummaryProps) {
  return (
    <aside className={styles.panel} aria-label="Agent context">
      <div className={styles.head}>
        <h3 className={styles.title}>Context</h3>
        <button type="button" className={styles.edit}>
          Edit
        </button>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Brand voice</span>
        <div className={styles.voiceRow}>
          <span className={brandVoiceTitle ? styles.voiceName : styles.voiceUnset}>
            {brandVoiceTitle ?? "Not set"}
          </span>
          {brandVoiceApproved && (
            <span className={styles.approved}>
              <CheckCircleIcon size={13} />
              Approved
            </span>
          )}
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Tone</span>
        <ul className={styles.tone}>
          {tone.map((t) => (
            <li key={t} className={styles.toneChip}>
              {t}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
