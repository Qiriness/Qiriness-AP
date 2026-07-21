import { Button } from "@/components/ui/Button";
import { KnowledgeIcon, PlusIcon } from "@/components/icons";
import styles from "./EmptyWorkspace.module.css";

/** Shown when no article is selected (e.g. after deleting or on a fresh library). */
export function EmptyWorkspace({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={styles.empty}>
      <span className={styles.icon}>
        <KnowledgeIcon size={30} />
      </span>
      <h2 className={styles.title}>Select an article to edit</h2>
      <p className={styles.text}>
        Choose a knowledge article from the list, or create a new one to shape what
        your agent knows and how it replies.
      </p>
      <Button
        variant="primary"
        leadingIcon={<PlusIcon size={16} />}
        onClick={onCreate}
      >
        Create article
      </Button>
    </div>
  );
}
