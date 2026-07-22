"use client";

import { useRef, useState } from "react";
import {
  BoldIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  OrderedListIcon,
  UnderlineIcon,
} from "@/components/icons";
import styles from "./RichTextEditor.module.css";

interface RichTextEditorProps {
  /** Remount key so switching articles resets the uncontrolled content. */
  articleId: string;
  initialHtml: string;
  placeholder: string;
  onChange: (html: string, wordCount: number) => void;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Dependency-free rich text editor. Uncontrolled contentEditable (no cursor
 * jumps); formatting via execCommand. A Preview toggle renders the same markup
 * read-only. Remount the whole component via `key={articleId}` from the parent.
 */
export function RichTextEditor({
  articleId,
  initialHtml,
  placeholder,
  onChange,
}: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState(false);
  const [empty, setEmpty] = useState(() => countWords(stripHtml(initialHtml)) === 0);
  // Snapshot at mount, stored as the same object reference on every render.
  // React's DOM diff compares dangerouslySetInnerHTML by object identity, not
  // by the inner HTML string — a fresh `{ __html }` literal on every render
  // would make React re-apply this stale snapshot after every keystroke and
  // instantly erase it. Keeping one stable object avoids that. Programmatic
  // replacements remount the component via `key`.
  const [mountHtml] = useState(() => ({ __html: initialHtml }));

  function emit() {
    const el = ref.current;
    if (!el) return;
    const html = el.innerHTML;
    const words = countWords(el.textContent ?? "");
    setEmpty(words === 0);
    onChange(html, words);
  }

  function exec(command: string, value?: string) {
    ref.current?.focus();
    document.execCommand(command, false, value);
    emit();
  }

  function addLink() {
    const url = window.prompt("Link URL", "https://");
    if (url && url !== "https://") exec("createLink", url);
  }

  const tools = [
    { label: "Bold", icon: BoldIcon, run: () => exec("bold") },
    { label: "Italic", icon: ItalicIcon, run: () => exec("italic") },
    { label: "Underline", icon: UnderlineIcon, run: () => exec("underline") },
    { label: "Bulleted list", icon: ListIcon, run: () => exec("insertUnorderedList") },
    { label: "Numbered list", icon: OrderedListIcon, run: () => exec("insertOrderedList") },
    { label: "Insert link", icon: LinkIcon, run: addLink },
  ];

  return (
    <div className={styles.editor} data-preview={preview || undefined}>
      <div className={styles.toolbar} role="toolbar" aria-label="Formatting">
        <span className={styles.blockLabel}>Paragraph</span>
        <span className={styles.divider} aria-hidden="true" />
        <div className={styles.tools}>
          {tools.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.label}
                type="button"
                className={styles.toolBtn}
                title={t.label}
                aria-label={t.label}
                disabled={preview}
                onMouseDown={(e) => e.preventDefault()}
                onClick={t.run}
              >
                <Icon size={17} />
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={`${styles.previewToggle} ${preview ? styles.previewOn : ""}`}
          aria-pressed={preview}
          onClick={() => setPreview((p) => !p)}
        >
          {preview ? "Edit" : "Preview"}
        </button>
      </div>

      <div className={styles.surface}>
        {empty && !preview && (
          <p className={styles.placeholder} aria-hidden="true">
            {placeholder}
          </p>
        )}
        <div
          ref={ref}
          className={styles.content}
          contentEditable={!preview}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Article content"
          spellCheck
          onInput={emit}
          dangerouslySetInnerHTML={mountHtml}
        />
      </div>
    </div>
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}
