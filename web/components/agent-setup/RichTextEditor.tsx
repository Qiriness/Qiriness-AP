"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

interface ActiveFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  unorderedList: boolean;
  orderedList: boolean;
  /** Lowercase tag of the block the caret is in: "p", "h1", "h2", "h3"... */
  block: string;
}

const EMPTY_FORMAT: ActiveFormat = {
  bold: false,
  italic: false,
  underline: false,
  unorderedList: false,
  orderedList: false,
  block: "p"
};

/**
 * H1-H3 only.
 *
 * Not because deeper levels are unsupported, but because the chunker treats
 * EVERY heading level as an equal section break — an h4 splits a section exactly
 * as an h2 does. Offering six levels would suggest a hierarchy that retrieval
 * does not read, and invite someone to nest a sub-point that silently becomes a
 * separate chunk with its own heading.
 */
const BLOCKS = [
  { tag: "h1", label: "H1", title: "Heading 1" },
  { tag: "h2", label: "H2", title: "Heading 2" },
  { tag: "h3", label: "H3", title: "Heading 3" }
];

function commandState(command: string): boolean {
  try {
    return document.queryCommandState(command);
  } catch {
    // queryCommandState throws rather than returning false in some browsers
    // when there is no usable selection.
    return false;
  }
}

/**
 * The block element the caret sits in, as a lowercase tag name.
 *
 * Walks up from the selection to the nearest block, stopping AT the editor:
 * going further would report the surrounding page layout as the article’s
 * formatting. Anything unrecognised reads as a paragraph, which is what
 * contentEditable produces by default.
 */
function blockTagAt(node: Node, root: HTMLElement): string {
  let current: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;

  while (current && current !== root) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const tag = (current as HTMLElement).tagName.toLowerCase();
      if (/^(h[1-6]|p|div|li|blockquote|pre)$/.test(tag)) {
        return /^h[1-6]$/.test(tag) ? tag : "p";
      }
    }
    current = current.parentNode;
  }

  return "p";
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

  // WHAT THE CURSOR IS SITTING IN, so the toolbar can show it the way every
  // other editor does. Without this the buttons are write-only: you can press
  // Bold but nothing ever tells you the text you are in IS bold, and a heading
  // button that does not light up gives no way to see why an article chunked as
  // one section instead of six.
  const [active, setActive] = useState<ActiveFormat>(EMPTY_FORMAT);

  const syncActive = useCallback(() => {
    const el = ref.current;
    if (!el || preview) return;

    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    // Only when the caret is genuinely inside this editor: `queryCommandState`
    // answers about the document, so clicking into another field would
    // otherwise leave the toolbar describing something else.
    if (!anchor || !el.contains(anchor)) return;

    setActive({
      bold: commandState("bold"),
      italic: commandState("italic"),
      underline: commandState("underline"),
      unorderedList: commandState("insertUnorderedList"),
      orderedList: commandState("insertOrderedList"),
      block: blockTagAt(anchor, el)
    });
  }, [preview]);

  // `selectionchange` fires on the document, not the element, and is the only
  // event that catches every way a caret moves — arrow keys, click, drag,
  // undo, and a programmatic format that collapses the selection afterwards.
  useEffect(() => {
    document.addEventListener("selectionchange", syncActive);
    return () => document.removeEventListener("selectionchange", syncActive);
  }, [syncActive]);

  useEffect(() => {
    if (preview) setActive(EMPTY_FORMAT);
  }, [preview]);

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
    syncActive();
  }

  /**
   * Headings toggle rather than only apply, which is what a person expects
   * from a style button: pressing H2 inside an H2 returns the block to a
   * paragraph instead of doing nothing.
   */
  function toggleBlock(tag: string) {
    exec("formatBlock", active.block === tag ? "<p>" : `<${tag}>`);
  }

  function addLink() {
    const url = window.prompt("Link URL", "https://");
    if (url && url !== "https://") exec("createLink", url);
  }

  const tools = [
    { label: "Bold", icon: BoldIcon, run: () => exec("bold"), on: active.bold },
    { label: "Italic", icon: ItalicIcon, run: () => exec("italic"), on: active.italic },
    { label: "Underline", icon: UnderlineIcon, run: () => exec("underline"), on: active.underline },
    { label: "Bulleted list", icon: ListIcon, run: () => exec("insertUnorderedList"), on: active.unorderedList },
    { label: "Numbered list", icon: OrderedListIcon, run: () => exec("insertOrderedList"), on: active.orderedList },
    // A link is an action, not a state the caret can be "in" for toolbar
    // purposes, so it never lights up.
    { label: "Insert link", icon: LinkIcon, run: addLink, on: false },
  ];

  return (
    <div className={styles.editor} data-preview={preview || undefined}>
      <div className={styles.toolbar} role="toolbar" aria-label="Formatting">
        {/* HEADINGS ARE NOT DECORATION HERE. `htmlToSections` cuts an article
            into sections on h1-h6, and each section is chunked separately for
            retrieval — so an article typed without headings becomes ONE chunk,
            and the toolbar previously offered no way to make one. */}
        <div className={styles.tools}>
          {BLOCKS.map((block) => (
            <button
              key={block.tag}
              type="button"
              className={`${styles.toolBtn} ${styles.blockBtn} ${active.block === block.tag ? styles.toolOn : ""}`}
              title={block.title}
              aria-label={block.title}
              aria-pressed={active.block === block.tag}
              disabled={preview}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggleBlock(block.tag)}
            >
              {block.label}
            </button>
          ))}
        </div>
        <span className={styles.divider} aria-hidden="true" />
        <div className={styles.tools}>
          {tools.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.label}
                type="button"
                className={`${styles.toolBtn} ${t.on ? styles.toolOn : ""}`}
                title={t.label}
                aria-label={t.label}
                aria-pressed={t.on}
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
          // `selectionchange` covers almost everything, but these fire first on
          // a click or an arrow key and keep the toolbar from lagging a frame.
          onKeyUp={syncActive}
          onMouseUp={syncActive}
          onFocus={syncActive}
          dangerouslySetInnerHTML={mountHtml}
        />
      </div>
    </div>
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}
