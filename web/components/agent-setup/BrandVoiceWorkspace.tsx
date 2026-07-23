"use client";

import type { Article, SaveState } from "@/lib/types";
import {
  EMPTY_VOICE_PROFILE,
  GUIDELINES_AND_GUARDRAILS_PLACEHOLDER,
  RESPONSE_FRAMEWORK_PLACEHOLDER,
} from "@/lib/types";
import { RichTextEditor } from "./RichTextEditor";
import { ChipList } from "./ChipList";
import { WorkspaceActions } from "./WorkspaceActions";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { EditorFooter } from "./EditorFooter";
import { LockIcon } from "@/components/icons";
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
  onRoleDescriptionChange: (roleDescription: string) => void;
  onToneAndVoiceChange: (toneAndVoice: string) => void;
  onGeneralContextChange: (html: string, wordCount: number) => void;
  onSave: () => void;
  onOptimize: () => void;
  onApprove: () => void;
  onUnapprove: () => void;
  onDelete: () => void;
}

/**
 * Editor for the singleton Brand Voice article (coreTopic === "brand"): the
 * always-included context every email the drafting agent writes inherits,
 * regardless of subject. Category-specific guidance (e.g. how to write a
 * returns email) belongs in a regular knowledge article instead — never
 * here. Five sections: Agent role description, Agent tone and voice,
 * Response framework and Guidelines and guardrails (both fixed placeholder
 * content for now, not yet editable or stored), and General context.
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
  onRoleDescriptionChange,
  onToneAndVoiceChange,
  onGeneralContextChange,
  onSave,
  onOptimize,
  onApprove,
  onUnapprove,
  onDelete,
}: BrandVoiceWorkspaceProps) {
  const voiceProfile = article.voiceProfile ?? EMPTY_VOICE_PROFILE;

  return (
    <div className={styles.workspace}>
      <div className={styles.editorCol}>
        <WorkspaceHeader
          article={article}
          placeholder="Brand voice"
          focusTitleNonce={focusTitleNonce}
          onBack={onBack}
          onTitleChange={onTitleChange}
        />

        <section className={voiceStyles.section}>
          <h3 className={voiceStyles.sectionTitle}>Agent role description</h3>
          <textarea
            className={voiceStyles.voiceTextarea}
            value={voiceProfile.roleDescription}
            onChange={(e) => onRoleDescriptionChange(e.target.value)}
            placeholder="Describe who the agent is and what it's responsible for…"
            rows={3}
            aria-label="Agent role description"
          />
        </section>

        <section className={voiceStyles.section}>
          <h3 className={voiceStyles.sectionTitle}>Agent tone and voice</h3>
          <textarea
            className={voiceStyles.voiceTextarea}
            value={voiceProfile.toneAndVoice}
            onChange={(e) => onToneAndVoiceChange(e.target.value)}
            placeholder="Describe how the agent should sound — tone, personality, style…"
            rows={3}
            aria-label="Agent tone and voice"
          />
        </section>

        <section className={voiceStyles.section}>
          <h3 className={voiceStyles.sectionTitle}>Response framework</h3>
          <p className={voiceStyles.hint}>Placeholder — not yet editable.</p>
          <ChipList
            label="Response framework"
            items={RESPONSE_FRAMEWORK_PLACEHOLDER}
            layout="list"
          />
        </section>

        <section className={voiceStyles.section}>
          <h3 className={voiceStyles.sectionTitle}>Guidelines and guardrails</h3>
          <p className={voiceStyles.hint}>Placeholder — not yet editable.</p>
          <ChipList
            label="Guidelines and guardrails"
            items={GUIDELINES_AND_GUARDRAILS_PLACEHOLDER}
            layout="list"
          />
        </section>

        <section className={voiceStyles.section}>
          <h3 className={voiceStyles.sectionTitle}>General context</h3>
          <p className={voiceStyles.hint}>
            Anything else that should apply to every email, no matter the category — category-specific
            guidance (e.g. how to word a returns email) belongs in a regular knowledge article instead.
          </p>
          <RichTextEditor
            key={`${article.id}:${editorVersion}`}
            articleId={article.id}
            initialHtml={article.content}
            placeholder="Any other context that should apply to every email, regardless of subject…"
            onChange={onGeneralContextChange}
          />
          <EditorFooter
            id="brand-voice-content-hint"
            wordCount={wordCount}
            saveState={saveState}
            updatedLabel={article.updatedLabel}
          />
        </section>
      </div>

      <div className={styles.rail}>
        <div className={voiceStyles.railHint}>
          <LockIcon size={15} />
          <p>
            This context is always included in full for every drafted email — it isn&apos;t retrieved
            by search like other knowledge articles.
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
