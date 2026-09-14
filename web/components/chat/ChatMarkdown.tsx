import type { ReactNode } from "react";
import styles from "./ChatMarkdown.module.css";

/**
 * The small slice of markdown the chat's answers use: headings, paragraphs,
 * bullet and numbered lists, tables, code fences, **bold** and `code`.
 *
 * Rendered as React elements, never as HTML: an answer is model output, and
 * model output is not markup this page should trust.
 */

type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "code"; text: string };

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^#{1,6}\s+/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r/g, "").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const startsBlock = (line: string, next?: string) =>
    line.trim() === "" ||
    line.trim().startsWith("```") ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    (line.trim().startsWith("|") && next !== undefined && TABLE_SEPARATOR.test(next));

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
    } else if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
    } else if (HEADING.test(line)) {
      blocks.push({ kind: "heading", text: line.replace(HEADING, "").trim() });
      i += 1;
    } else if (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      blocks.push({ kind: "table", header, rows });
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const marker = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && marker.test(lines[i])) items.push(lines[i++].replace(marker, "").trim());
      blocks.push({ kind: "list", ordered, items });
    } else {
      const text: string[] = [];
      while (i < lines.length && (text.length === 0 || !startsBlock(lines[i], lines[i + 1]))) text.push(lines[i++].trim());
      blocks.push({ kind: "paragraph", text: text.join(" ") });
    }
  }
  return blocks;
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    return part;
  });
}

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className={styles.markdown}>
      {parseMarkdown(text).map((block, index) => {
        switch (block.kind) {
          case "heading":
            return <h3 key={index}>{inline(block.text)}</h3>;
          case "paragraph":
            return <p key={index}>{inline(block.text)}</p>;
          case "code":
            return <pre key={index}>{block.text}</pre>;
          case "list": {
            const items = block.items.map((item, j) => <li key={j}>{inline(item)}</li>);
            return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
          }
          case "table":
            return (
              <div key={index} className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, j) => (
                        <th key={j}>{inline(cell)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, j) => (
                          <td key={j}>{inline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
