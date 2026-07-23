"use client";

import { useEffect, useRef } from "react";
import type { Article } from "@/lib/types";
import { StatusChip } from "@/components/ui/StatusChip";
import { ChevronLeftIcon } from "@/components/icons";
import styles from "./ArticleWorkspace.module.css";

interface WorkspaceHeaderProps {
  article: Article;
  placeholder: string;
  /** Bumped when a new article is created, to move focus into the title field. */
  focusTitleNonce: number;
  onBack: () => void;
  onTitleChange: (title: string) => void;
}

/** Back button + title input + status chip, shared by ArticleWorkspace and BrandVoiceWorkspace. */
export function WorkspaceHeader({
  article,
  placeholder,
  focusTitleNonce,
  onBack,
  onTitleChange,
}: WorkspaceHeaderProps) {
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusTitleNonce > 0) titleRef.current?.focus();
  }, [focusTitleNonce]);

  return (
    <div className={styles.topRow}>
      <button
        type="button"
        className={styles.back}
        onClick={onBack}
        aria-label="Back to article list"
      >
        <ChevronLeftIcon size={18} />
      </button>
      <label className={styles.titleField}>
        <span className="sr-only">Article title</span>
        <input
          ref={titleRef}
          type="text"
          className={styles.titleInput}
          value={article.title}
          placeholder={placeholder}
          onChange={(e) => onTitleChange(e.target.value)}
          maxLength={120}
        />
      </label>
      <StatusChip status={article.status} size="md" />
    </div>
  );
}
