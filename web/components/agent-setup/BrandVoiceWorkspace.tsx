"use client";

import { useEffect, useRef } from "react";
import type { Article, SaveState } from "@/lib/types";
import { EMPTY_VOICE_PROFILE } from "@/lib/types";
import { StatusChip } from "@/components/ui/StatusChip";
import { RichTextEditor } from "./RichTextEditor";
import { EditableChipList } from "./EditableChipList";
import { WorkspaceActions } from "./WorkspaceActions";
import { CheckCircleIcon, ChevronLeftIcon } from "@/components/icons";
import styles from "./ArticleWorkspace.module.css";
import voiceStyles from "./BrandVoiceWorkspace.module.css";

interface BrandVoiceWorkspaceProps {
  article: Article;
  saveState: SaveState;
  optimizing: boolean;
  deleting: boolean;
  wordCount: number;
  editorVersion: number;
  focusTitleNonce: number;
  onBack: () => void;
  onTitleChange: (title: string) => void;
  onToneChange: (tone: string[]) => void;
  onVoiceChange: (voice: string) => void;
  onDosChange: (dos: string[]) => void;
  onDontsChange: (donts: string[]) => void;
  onGeneralContextChange: (html: string, wordCount: number) => void;
  onSave: () => void;
  onOptimize: () => void;
  onApprove: () => void;
  onUnapprove: () => void;
  onDelete: () => void;
}

/**
 * Structured editor for the singleton Brand Voice article (coreTopic ===
 * "brand"). Unlike ArticleWorkspace, there's no Shopify source picker or
 * category selector here — brand voice is never Shopify-sourced and its
 * category is fixed at creation. Tone/Voice/Do's/Don'ts are always-included
 * context for every email the drafting agent writes; General context is the
 * one freeform catch-all field, reusing the same RichTextEditor as any
 * other article.
 */
export function BrandVoiceWorkspace({
  article,
  saveState,
  optimizing,
  deleting,
  wordCount,
  editorVersion,
  focusTitleNonce,
  onBack,
  onTitleChange,
  onToneChange,
  onVoiceChange,
  onDosChange,
  onDontsChange,
  onGeneralContextChange,
  onSave,
  onOptimize,
  onApprove,
  onUnapprove,
  onDelete,
}: BrandVoiceWorkspaceProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  const voiceProfile = article.voiceProfile ?? EMPTY_VOICE_PROFILE;

  useEffect(() => {
    if (focusTitleNonce > 0) titleRef.current?.focus();
  }, [focusTitleNonce]);

  return (
    <div className={styles.workspace}>
      <div className={styles.editorCol}>
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
              placeholder="Brand voice"
              onChange={(e) => onTitleChange(e.target.value)}
              maxLength={120}
            />
          </label>
          <StatusChip status={article.status} size="md" />
        </div>

        <EditableChipList
          label="Tone"
          items={voiceProfile.tone}
          onChange={onToneChange}
          layout="inline"
          placeholder="Add a tone word…"
        />

        <div className={styles.field}>
          <label className={styles.label} htmlFor="brand-voice-description">
            Voice
          </label>
          <textarea
            id="brand-voice-description"
            className={voiceStyles.voiceTextarea}
            value={voiceProfile.voice}
            onChange={(e) => onVoiceChange(e.target.value)}
            placeholder="Describe the brand's personality in a few sentences…"
            rows={3}
          />
        </div>

        <div className={voiceStyles.dosDontsRow}>
          <EditableChipList
            label="Do's"
            items={voiceProfile.dos}
            onChange={onDosChange}
            layout="list"
            placeholder="Add a do…"
          />
          <EditableChipList
            label="Don'ts"
            items={voiceProfile.donts}
            onChange={onDontsChange}
            layout="list"
            placeholder="Add a don't…"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="brand-voice-content-hint">
            General context
          </label>
          <p className={voiceStyles.hint}>
            Anything here is included in every email the drafting agent writes, no matter the
            category — category-specific guidance belongs in a regular knowledge article instead.
          </p>
          <RichTextEditor
            key={`${article.id}:${editorVersion}`}
            articleId={article.id}
            initialHtml={article.content}
            placeholder="Any other context that should apply to every email, regardless of subject…"
            onChange={onGeneralContextChange}
          />
          <div className={styles.editorFooter} id="brand-voice-content-hint">
            <span className={styles.wordCount}>
              {wordCount} {wordCount === 1 ? "word" : "words"}
            </span>
            <SaveIndicator saveState={saveState} updatedLabel={article.updatedLabel} />
          </div>
        </div>
      </div>

      <div className={styles.rail}>
        <div className={voiceStyles.railHint}>
          <p>
            This context is always included in full for every drafted email — it isn&apos;t
            retrieved by search like other knowledge articles.
          </p>
        </div>
        <WorkspaceActions
          saveState={saveState}
          optimizing={optimizing}
          deleting={deleting}
          status={article.status}
          onSave={onSave}
          onOptimize={onOptimize}
          onApprove={onApprove}
          onUnapprove={onUnapprove}
          onDelete={onDelete}
        />
      </div>
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
