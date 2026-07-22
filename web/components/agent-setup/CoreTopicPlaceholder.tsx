import type { CoreTopic } from "@/lib/types";
import { CORE_TOPIC_LABELS } from "@/lib/types";
import { PlusIcon } from "@/components/icons";
import styles from "./CoreTopicPlaceholder.module.css";

interface CoreTopicPlaceholderProps {
  topic: CoreTopic;
  onCreate: (topic: CoreTopic) => void;
}

/** A not-yet-started core-knowledge slot. Clicking starts a draft pre-filled for this topic. */
export function CoreTopicPlaceholder({ topic, onCreate }: CoreTopicPlaceholderProps) {
  return (
    <button type="button" className={styles.item} onClick={() => onCreate(topic)}>
      <span className={styles.icon}>
        <PlusIcon size={15} />
      </span>
      <span className={styles.body}>
        <span className={styles.title}>{CORE_TOPIC_LABELS[topic]}</span>
        <span className={styles.hint}>Not started</span>
      </span>
    </button>
  );
}
