import type { SaveState } from "@/lib/types";
import { CheckCircleIcon } from "@/components/icons";
import { Tx } from "@/lib/i18n/client";
import styles from "./ArticleWorkspace.module.css";

interface EditorFooterProps {
  id: string;
  wordCount: number;
  saveState: SaveState;
  updatedLabel: string;
}

/** Word count + save-state indicator shown under the rich-text editor, shared by ArticleWorkspace and BrandVoiceWorkspace. */
export function EditorFooter({ id, wordCount, saveState, updatedLabel }: EditorFooterProps) {
  return (
    <div className={styles.editorFooter} id={id}>
      <span className={styles.wordCount}>
        <Tx k="setup.knowledge.words" params={{ count: wordCount }} />
      </span>
      <SaveIndicator saveState={saveState} updatedLabel={updatedLabel} />
    </div>
  );
}

function SaveIndicator({
  saveState,
  updatedLabel,
}: {
  saveState: SaveState;
  updatedLabel: string;
}) {
  if (saveState === "saving") {
    return (
      <span className={styles.saveState}>
        <span className={`${styles.saveDot} ${styles.saveDotBusy}`} aria-hidden="true" />
        <Tx k="tickets.panels.saving" />
      </span>
    );
  }
  if (saveState === "unsaved") {
    return (
      <span className={styles.saveState}>
        <span className={styles.saveDot} aria-hidden="true" />
        <Tx k="setup.knowledge.unsaved" />
      </span>
    );
  }
  return (
    <span className={`${styles.saveState} ${styles.saved}`}>
      <CheckCircleIcon size={14} />
      <Tx k="setup.knowledge.savedAt" params={{ when: updatedLabel }} />
    </span>
  );
}
