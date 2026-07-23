import type { SaveState } from "@/lib/types";
import { CheckCircleIcon } from "@/components/icons";
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
        {wordCount} {wordCount === 1 ? "word" : "words"}
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
        Saving…
      </span>
    );
  }
  if (saveState === "unsaved") {
    return (
      <span className={styles.saveState}>
        <span className={styles.saveDot} aria-hidden="true" />
        Unsaved changes
      </span>
    );
  }
  return (
    <span className={`${styles.saveState} ${styles.saved}`}>
      <CheckCircleIcon size={14} />
      Saved {updatedLabel}
    </span>
  );
}
