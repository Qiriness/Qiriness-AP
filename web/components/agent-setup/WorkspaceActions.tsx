import type { ArticleStatus, SaveState } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { CheckCircleIcon, SparkleIcon } from "@/components/icons";
import styles from "./WorkspaceActions.module.css";

interface WorkspaceActionsProps {
  saveState: SaveState;
  optimizing: boolean;
  status: ArticleStatus;
  onSave: () => void;
  onOptimize: () => void;
  onApprove: () => void;
}

export function WorkspaceActions({
  saveState,
  optimizing,
  status,
  onSave,
  onOptimize,
  onApprove,
}: WorkspaceActionsProps) {
  const approved = status === "approved";
  const busy = optimizing || saveState === "saving";

  return (
    <div className={styles.actions}>
      <Button
        variant="secondary"
        block
        onClick={onSave}
        loading={saveState === "saving"}
        disabled={saveState === "saved" || optimizing}
      >
        {saveState === "saved" ? "Saved" : "Save draft"}
      </Button>

      <Button
        variant="secondary"
        block
        leadingIcon={<SparkleIcon size={16} />}
        onClick={onOptimize}
        loading={optimizing}
        disabled={saveState === "saving"}
      >
        {optimizing ? "Optimizing" : "Optimize draft"}
      </Button>

      <Button
        variant="primary"
        block
        leadingIcon={approved ? <CheckCircleIcon size={16} /> : undefined}
        onClick={onApprove}
        disabled={approved || busy}
      >
        {approved ? "Approved for agent" : "Approve for agent"}
      </Button>

      <p className={styles.hint}>
        Approved articles become trusted sources your agent can answer from.
      </p>
    </div>
  );
}
