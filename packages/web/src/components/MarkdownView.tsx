import { Fragment, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { CopyButton } from "./CopyButton";

export type TableAlignment = "left" | "center" | "right" | null;

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "hr" }
  | { type: "code"; lang: string; content: string }
  | { type: "blockquote"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | {
      type: "table";
      headers: string[];
      alignments: TableAlignment[];
      rows: string[][];
    }
  | { type: "paragraph"; text: string };

const HR_REGEX = /^(?:---+|\*\*\*+|___+)$/;
const HEADING_REGEX = /^(#{1,6})\s+(.+?)\s*#*$/;
const FENCE_OPEN_REGEX = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`~]*)\s*$/;
const TABLE_SEPARATOR_REGEX =
  /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/;
const UNORDERED_ITEM_REGEX = /^\s*[-*+]\s+(.+)$/;
const ORDERED_ITEM_REGEX = /^\s*\d+[.)]\s+(.+)$/;
const BLOCKQUOTE_REGEX = /^\s*>\s?(.*)$/;

export function isSafeExternalHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) {
    trimmed = trimmed.slice(0, -1);
  }
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTableAlignments(separatorLine: string, colCount: number): TableAlignment[] {
  const raw = splitTableRow(separatorLine);
  const alignments: TableAlignment[] = [];
  for (let i = 0; i < colCount; i += 1) {
    const token = (raw[i] ?? "").trim();
    const startsColon = token.startsWith(":");
    const endsColon = token.endsWith(":");
    if (startsColon && endsColon) {
      alignments.push("center");
    } else if (endsColon) {
      alignments.push("right");
    } else if (startsColon) {
      alignments.push("left");
    } else {
      alignments.push(null);
    }
  }
  return alignments;
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  if (header === undefined || separator === undefined) return false;
  if (!header.includes("|")) return false;
  const trimmedSep = separator.trim();
  if (!trimmedSep || !TABLE_SEPARATOR_REGEX.test(trimmedSep)) return false;
  const headerCells = splitTableRow(header);
  const sepCells = splitTableRow(separator);
  return headerCells.length > 0 && headerCells.length === sepCells.length;
}

function isBlockBoundary(lines: string[], index: number): boolean {
  const line = lines[index];
  if (line === undefined) return true;
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (FENCE_OPEN_REGEX.test(line)) return true;
  if (HR_REGEX.test(trimmed)) return true;
  if (HEADING_REGEX.test(trimmed)) return true;
  if (BLOCKQUOTE_REGEX.test(line)) return true;
  if (UNORDERED_ITEM_REGEX.test(line)) return true;
  if (ORDERED_ITEM_REGEX.test(line)) return true;
  if (isTableStart(lines, index)) return true;
  return false;
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    const fenceMatch = line.match(FENCE_OPEN_REGEX);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "```";
      const fenceChar = marker[0] ?? "`";
      const lang = fenceMatch[2] ?? "";
      const closeRegex = new RegExp(`^\\s{0,3}${fenceChar}{${marker.length},}\\s*$`);
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const inner = lines[i] ?? "";
        if (closeRegex.test(inner)) {
          i += 1;
          break;
        }
        codeLines.push(inner);
        i += 1;
      }
      blocks.push({ type: "code", lang, content: codeLines.join("\n") });
      continue;
    }

    if (HR_REGEX.test(trimmed)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const headingMatch = trimmed.match(HEADING_REGEX);
    if (headingMatch) {
      const hashes = headingMatch[1] ?? "#";
      const text = headingMatch[2] ?? "";
      const level = Math.min(6, Math.max(1, hashes.length)) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, text });
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i] ?? "");
      const alignments = parseTableAlignments(lines[i + 1] ?? "", headers.length);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const rowLine = lines[i] ?? "";
        const rowTrimmed = rowLine.trim();
        if (!rowTrimmed || !rowTrimmed.includes("|")) break;
        if (
          FENCE_OPEN_REGEX.test(rowLine) ||
          HR_REGEX.test(rowTrimmed) ||
          HEADING_REGEX.test(rowTrimmed)
        ) {
          break;
        }
        const rawCells = splitTableRow(rowLine);
        const normalized: string[] = [];
        for (let c = 0; c < headers.length; c += 1) {
          normalized.push(rawCells[c] ?? "");
        }
        rows.push(normalized);
        i += 1;
      }
      blocks.push({ type: "table", headers, alignments, rows });
      continue;
    }

    if (BLOCKQUOTE_REGEX.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const qMatch = (lines[i] ?? "").match(BLOCKQUOTE_REGEX);
        if (!qMatch) break;
        quoteLines.push(qMatch[1] ?? "");
        i += 1;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    const unorderedMatch = line.match(UNORDERED_ITEM_REGEX);
    if (unorderedMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const currentLine = lines[i] ?? "";
        if (HR_REGEX.test(currentLine.trim())) break;
        const m = currentLine.match(UNORDERED_ITEM_REGEX);
        if (!m) break;
        items.push(m[1] ?? "");
        i += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    const orderedMatch = line.match(ORDERED_ITEM_REGEX);
    if (orderedMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = (lines[i] ?? "").match(ORDERED_ITEM_REGEX);
        if (!m) break;
        items.push(m[1] ?? "");
        i += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length && !isBlockBoundary(lines, i)) {
      paraLines.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paraLines.join("\n") });
  }

  return blocks;
}

const INLINE_TOKEN_REGEX =
  /(`[^`\n]+`)|(\[([^\]\n]+)\]\(([^)\s]+)\))|(\*\*\*([^*\n]+)\*\*\*)|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)|(~~([^~\n]+)~~)|(https?:\/\/[^\s<>()]+)|((?:^|(?<=[^\w@.]))@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?![a-zA-Z0-9_-]))/g;

function renderInline(
  text: string,
  highlightHandles?: ReadonlySet<string>,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let keyCounter = 0;

  for (const match of text.matchAll(INLINE_TOKEN_REGEX)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }

    const full = match[0];
    const key = `inl-${keyCounter++}`;

    if (match[1]) {
      nodes.push(
        <code key={key} className="md-inline-code">
          {match[1].slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      const label = match[3] ?? "";
      const href = match[4] ?? "";
      if (isSafeExternalHref(href)) {
        nodes.push(
          <a
            key={key}
            href={href.trim()}
            target="_blank"
            rel="noopener noreferrer"
            className="md-link"
          >
            {label}
          </a>,
        );
      } else {
        nodes.push(
          <span key={key} className="md-blocked-link">
            {label}
          </span>,
        );
      }
    } else if (match[5]) {
      nodes.push(
        <strong key={key}>
          <em>{match[6]}</em>
        </strong>,
      );
    } else if (match[7]) {
      nodes.push(<strong key={key}>{match[8]}</strong>);
    } else if (match[9]) {
      nodes.push(<em key={key}>{match[10]}</em>);
    } else if (match[11]) {
      nodes.push(<del key={key}>{match[12]}</del>);
    } else if (match[13]) {
      const rawUrl = match[13];
      const cleaned = rawUrl.replace(/[.,!?;:]+$/, "");
      const trailing = rawUrl.slice(cleaned.length);
      if (isSafeExternalHref(cleaned)) {
        nodes.push(
          <Fragment key={key}>
            <a
              href={cleaned}
              target="_blank"
              rel="noopener noreferrer"
              className="md-link"
            >
              {cleaned}
            </a>
            {trailing}
          </Fragment>,
        );
      } else {
        nodes.push(rawUrl);
      }
    } else if (match[14] && match[15]) {
      const handle = match[15];
      const isSelf = highlightHandles?.has(handle.toLowerCase()) ?? false;
      nodes.push(
        <span
          key={key}
          className={isSelf ? "md-mention md-mention-self" : "md-mention"}
        >
          @{handle}
        </span>,
      );
    } else {
      nodes.push(full);
    }

    lastIndex = start + full.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderMultilineInline(
  text: string,
  highlightHandles?: ReadonlySet<string>,
): ReactNode[] {
  const lines = text.split("\n");
  return lines.map((line, idx) => (
    <Fragment key={`ln-${idx}`}>
      {idx > 0 ? <br /> : null}
      {renderInline(line, highlightHandles)}
    </Fragment>
  ));
}

interface MarkdownViewProps {
  content: string;
  highlightHandles?: ReadonlySet<string>;
}

export function MarkdownView({ content, highlightHandles }: MarkdownViewProps) {
  const { t } = useI18n();
  const blocks = parseMarkdownBlocks(content);

  return (
    <div className="md-root">
      {blocks.map((block, index) => {
        const key = `blk-${index}`;
        switch (block.type) {
          case "heading": {
            const Tag = `h${Math.min(6, block.level + 1)}` as
              | "h2"
              | "h3"
              | "h4"
              | "h5"
              | "h6";
            return (
              <Tag key={key} className={`md-heading md-h${block.level}`}>
                {renderInline(block.text, highlightHandles)}
              </Tag>
            );
          }

          case "hr":
            return <hr key={key} className="md-hr" />;

          case "code":
            return (
              <div key={key} className="md-code-block copyable">
                <div className="md-code-header">
                  <span className="md-code-lang">{block.lang || "text"}</span>
                  <CopyButton
                    text={block.content}
                    ariaLabel={t("md.copyCode")}
                  />
                </div>
                <pre tabIndex={0} className="md-pre">
                  <code>{block.content}</code>
                </pre>
              </div>
            );

          case "blockquote":
            return (
              <blockquote key={key} className="md-blockquote">
                {renderMultilineInline(block.lines.join("\n"), highlightHandles)}
              </blockquote>
            );

          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag key={key} className="md-list">
                {block.items.map((item, itemIdx) => (
                  <li key={`${key}-${itemIdx}`}>
                    {renderInline(item, highlightHandles)}
                  </li>
                ))}
              </ListTag>
            );
          }

          case "table":
            return (
              <div
                key={key}
                tabIndex={0}
                role="region"
                aria-label={t("md.tableRegion")}
                className="md-table-wrapper"
              >
                <table className="md-table">
                  <thead>
                    <tr>
                      {block.headers.map((header, colIdx) => (
                        <th
                          key={`${key}-h-${colIdx}`}
                          scope="col"
                          style={
                            block.alignments[colIdx]
                              ? { textAlign: block.alignments[colIdx] ?? undefined }
                              : undefined
                          }
                        >
                          {renderInline(header, highlightHandles)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIdx) => (
                      <tr key={`${key}-r-${rowIdx}`}>
                        {row.map((cell, colIdx) => (
                          <td
                            key={`${key}-c-${rowIdx}-${colIdx}`}
                            style={
                              block.alignments[colIdx]
                                ? { textAlign: block.alignments[colIdx] ?? undefined }
                                : undefined
                            }
                          >
                            {renderInline(cell, highlightHandles)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

          case "paragraph":
            return (
              <p key={key} className="md-paragraph">
                {renderMultilineInline(block.text, highlightHandles)}
              </p>
            );
        }
      })}
    </div>
  );
}
