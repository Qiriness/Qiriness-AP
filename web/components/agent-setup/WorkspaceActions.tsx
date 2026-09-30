import { useEffect, useRef, useState } from "react";
import type { ArticleStatus, SaveState } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { CheckCircleIcon, SparkleIcon } from "@/components/icons";
import { useT } from "@/lib/i18n/client";
import styles from "./WorkspaceActions.module.css";

interface WorkspaceActionsProps {
  saveState: SaveState;
  optimizing: boolean;
  deleting: boolean;
  status: ArticleStatus;
  onSave: () => void;
  onOptimize: () => void;
  onApprove: () => void;
  onUnapprove: () => void;
  onDelete: () => void;
  /**
   * Opens the test chat with this article as the one being checked for.
   *
   * Optional, and absent on the brand voice: that article is the drafting system
   * prompt, never chunked and never embedded, so "was it retrieved" is a
   * question it can only answer no to. Offering the button there would be
   * offering a test that cannot pass.
   */
  onTest?: () => void;
}

const CONFIRM_WINDOW_MS = 3000;

export function WorkspaceActions({
  saveState,
  optimizing,
  deleting,
  status,
  onSave,
  onOptimize,
  onApprove,
  onUnapprove,
  onDelete,
  onTest,
}: WorkspaceActionsProps) {
  const t = useT();
  const approved = status === "approved";
  const busy = optimizing || saveState === "saving";
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const revertTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(revertTimer.current), []);

  function handleDeleteClick() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      revertTimer.current = setTimeout(() => setConfirmingDelete(false), CONFIRM_WINDOW_MS);
      return;
    }
    clearTimeout(revertTimer.current);
    setConfirmingDelete(false);
    onDelete();
  }

  return (
    <div className={styles.actions}>
      <Button
        variant="secondary"
        block
        onClick={onSave}
        loading={saveState === "saving"}
        disabled={saveState === "saved" || optimizing}
      >
        {saveState === "saved" ? t("setup.knowledge.saved") : t("setup.knowledge.saveDraft")}
      </Button>

      <Button
        variant="secondary"
        block
        leadingIcon={<SparkleIcon size={16} />}
        onClick={onOptimize}
        loading={optimizing}
        disabled={saveState === "saving"}
      >
        {optimizing ? t("setup.knowledge.optimizing") : t("setup.knowledge.optimize")}
      </Button>

      <Button
        variant="primary"
        block
        leadingIcon={approved ? <CheckCircleIcon size={16} /> : undefined}
        onClick={onApprove}
        disabled={approved || busy}
      >
        {approved ? t("setup.knowledge.approvedForAgent") : t("setup.knowledge.approveForAgent")}
      </Button>

      {approved && (
        <Button variant="secondary" block onClick={onUnapprove} disabled={busy}>
          {t("setup.knowledge.unapprove")}
        </Button>
      )}

      <p className={styles.hint}>
        {t("setup.knowledge.approvedHint")}
      </p>

      {/* Directly under the approval, because that is when the question arises:
          approving an article says it MAY be used, and only a run says whether
          it actually is. Enabled while unapproved too — the test's first answer
          is then "this article carries no vector and cannot be reached", which
          is worth knowing without approving it first to find out. */}
      {onTest && (
        <>
          <Button variant="secondary" block onClick={onTest} disabled={busy}>
            {t("setup.knowledge.testArticle")}
          </Button>
          <p className={styles.hint}>
            {t("setup.knowledge.testHint")}
          </p>
        </>
      )}

      <Button
        variant="danger"
        block
        onClick={handleDeleteClick}
        loading={deleting}
        disabled={busy}
        className={styles.deleteButton}
      >
        {confirmingDelete ? t("setup.knowledge.confirmDelete") : t("setup.knowledge.deleteArticle")}
      </Button>
    </div>
  );
}
