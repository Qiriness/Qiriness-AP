"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ClipboardEvent as ReactClipboardEvent } from "react";
import { BoldIcon, ItalicIcon, LinkIcon, ListIcon, OrderedListIcon, UnderlineIcon } from "@/components/icons";
import { useT } from "@/lib/i18n/client";
import { isSafeReplyHref, sanitiseReplyHtml } from "@/lib/reply-html";
import styles from "./ReplyEditor.module.css";

/**
 * The box a customer reply is written or edited in: bold, italics, underline,
 * lists and links, and nothing else — exactly the subset
 * `scripts/lib/reply-html.mjs` lets through to the mailbox, so the toolbar can
 * never produce formatting that disappears on sending.
 *
 * NOT THE ARTICLE EDITOR (agent-setup/RichTextEditor). That one offers
 * headings because they cut an article into retrieval chunks; a reply has no
 * sections, and a heading in an email reads as shouting. Same mechanics:
 * uncontrolled contentEditable, formatting through execCommand, the mount HTML
 * held as one object so a keystroke never re-applies it. Remount with `key`.
 *
 * A LINK IS ADDED ON THE WORDS IT COVERS. Select them, press the link button
 * (or Ctrl+K), type the address. Only https and mailto are accepted.
 *
 * PASTE IS SANITISED on the way in, so what the box shows after a paste from
 * Word or a web page is what will be sent.
 */
export function ReplyEditor({
  initialHtml,
  onChange,
  label,
  disabled = false,
}: {
  initialHtml: string;
  onChange: (html: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [mountHtml] = useState(() => ({ __html: initialHtml }));
  const [active, setActive] = useState({ bold: false, italic: false, underline: false, ul: false, ol: false, link: false });
  // The link field: the selection it applies to is saved when it opens,
  // because typing the address moves the focus out of the editor.
  const [linking, setLinking] = useState<null | { range: Range; href: string; error: string | null }>(null);
  const [linkHint, setLinkHint] = useState<string | null>(null);

  const syncActive = useCallback(() => {
    const el = ref.current;
    const anchor = window.getSelection()?.anchorNode ?? null;
    if (!el || !anchor || !el.contains(anchor)) return;
    setActive({
      bold: commandState("bold"),
      italic: commandState("italic"),
      underline: commandState("underline"),
      ul: commandState("insertUnorderedList"),
      ol: commandState("insertOrderedList"),
      link: Boolean(linkAt(anchor, el)),
    });
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", syncActive);
    return () => document.removeEventListener("selectionchange", syncActive);
  }, [syncActive]);

  function emit() {
    if (ref.current) onChange(ref.current.innerHTML);
  }

  function exec(command: string, value?: string) {
    ref.current?.focus();
    document.execCommand(command, false, value);
    emit();
    syncActive();
  }

  function openLink() {
    const el = ref.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.rangeCount === 0 || !el.contains(selection.anchorNode)) {
      setLinkHint(t("tickets.panels.editor.linkNeedsText"));
      return;
    }
    const range = selection.getRangeAt(0);
    const existing = linkAt(selection.anchorNode as Node, el);
    // Inside a link with nothing selected: edit that link, over its words.
    if (range.collapsed && existing) range.selectNodeContents(existing);
    if (range.collapsed) {
      setLinkHint(t("tickets.panels.editor.linkNeedsText"));
      return;
    }
    setLinkHint(null);
    setLinking({ range: range.cloneRange(), href: existing?.getAttribute("href") ?? "https://", error: null });
  }

  function applyLink() {
    if (!linking) return;
    const href = linking.href.trim();
    if (!isSafeReplyHref(href)) {
      setLinking({ ...linking, error: t("tickets.panels.editor.linkInvalid") });
      return;
    }
    restore(linking.range);
    exec("createLink", href);
    setLinking(null);
  }

  function cancelLink() {
    if (linking) restore(linking.range);
    setLinking(null);
  }

  function removeLink() {
    const el = ref.current;
    const selection = window.getSelection();
    const existing = el && selection?.anchorNode ? linkAt(selection.anchorNode, el) : null;
    if (existing && selection && selection.getRangeAt(0).collapsed) {
      const range = document.createRange();
      range.selectNodeContents(existing);
      restore(range);
    }
    exec("unlink");
  }

  function restore(range: Range) {
    ref.current?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openLink();
    }
  }

  function onPaste(event: ReactClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const html = event.clipboardData.getData("text/html");
    if (html) document.execCommand("insertHTML", false, sanitiseReplyHtml(html));
    else document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    emit();
  }

  const tools = [
    { key: "bold", label: t("tickets.panels.editor.bold"), icon: BoldIcon, run: () => exec("bold"), on: active.bold },
    { key: "italic", label: t("tickets.panels.editor.italic"), icon: ItalicIcon, run: () => exec("italic"), on: active.italic },
    { key: "underline", label: t("tickets.panels.editor.underline"), icon: UnderlineIcon, run: () => exec("underline"), on: active.underline },
    { key: "ul", label: t("tickets.panels.editor.bullets"), icon: ListIcon, run: () => exec("insertUnorderedList"), on: active.ul },
    { key: "ol", label: t("tickets.panels.editor.numbers"), icon: OrderedListIcon, run: () => exec("insertOrderedList"), on: active.ol },
    { key: "link", label: t("tickets.panels.editor.link"), icon: LinkIcon, run: openLink, on: active.link },
  ];

  return (
    <div className={styles.editor} data-disabled={disabled || undefined}>
      <div className={styles.toolbar} role="toolbar" aria-label={t("tickets.panels.editor.toolbar")}>
        {tools.map((tool) => {
          const Icon = tool.icon;
          return (
            <button
              key={tool.key}
              type="button"
              className={`${styles.toolBtn} ${tool.on ? styles.toolOn : ""}`}
              title={tool.label}
              aria-label={tool.label}
              aria-pressed={tool.on}
              disabled={disabled}
              // Keep the selection in the editor: a click would otherwise move
              // the focus to the button and format nothing.
              onMouseDown={(event) => event.preventDefault()}
              onClick={tool.run}
            >
              <Icon size={16} />
            </button>
          );
        })}
        {active.link && (
          <button
            type="button"
            className={styles.textBtn}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={removeLink}
          >
            {t("tickets.panels.editor.unlink")}
          </button>
        )}
        {linkHint && !linking && <span className={styles.hint}>{linkHint}</span>}
      </div>

      {linking && (
        <div className={styles.linkRow}>
          <input
            className={styles.linkInput}
            type="url"
            autoFocus
            value={linking.href}
            placeholder={t("tickets.panels.editor.linkPlaceholder")}
            aria-label={t("tickets.panels.editor.link")}
            aria-invalid={Boolean(linking.error)}
            onChange={(event) => setLinking({ ...linking, href: event.target.value, error: null })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyLink();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelLink();
              }
            }}
          />
          <button type="button" className={styles.linkApply} onClick={applyLink}>
            {t("tickets.panels.editor.linkApply")}
          </button>
          <button type="button" className={styles.textBtn} onClick={cancelLink}>
            {t("tickets.panels.draft.cancel")}
          </button>
          {linking.error && <span className={styles.linkError} role="alert">{linking.error}</span>}
        </div>
      )}

      <div
        ref={ref}
        className={styles.content}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        spellCheck
        onInput={emit}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onKeyUp={syncActive}
        onMouseUp={syncActive}
        onFocus={() => setLinkHint(null)}
        dangerouslySetInnerHTML={mountHtml}
      />
    </div>
  );
}

function commandState(command: string): boolean {
  try {
    return document.queryCommandState(command);
  } catch {
    return false;
  }
}

/** The link the node sits in, stopping at the editor. */
function linkAt(node: Node, root: HTMLElement): HTMLAnchorElement | null {
  let current: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (current && current !== root) {
    if (current instanceof HTMLAnchorElement) return current;
    current = current.parentNode;
  }
  return null;
}

/**
 * A reply's HTML, read-only: a formatted rewrite, or a reply a person wrote.
 * Sanitised again here, by the same rule that cut it, so nothing the browser
 * renders can be more than what the customer is sent.
 */
export function ReplyHtmlView({ html }: { html: string }) {
  return <div className={styles.view} dangerouslySetInnerHTML={{ __html: sanitiseReplyHtml(html) }} />;
}
