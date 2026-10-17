import React, { useState } from "react";
import { useI18n } from "./i18n.js";

interface CodeBlockProps {
  language?: string;
  code: string;
}

export function CodeBlock({ language, code }: CodeBlockProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-lang">{language || "text"}</span>
        <button
          className={`copy-btn ${copied ? "copied" : ""}`}
          onClick={copy}
          title={t("copyCodeTitle")}
        >
          {copied ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span>{t("copiedBtn")}</span>
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>{t("copyBtn")}</span>
            </>
          )}
        </button>
      </div>
      <pre className="code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function isSafeLinkHref(rawHref: string): boolean {
  const trimmed = rawHref.trim();
  const normalized = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, "").toLowerCase();
  return (
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("mailto:") ||
    normalized.startsWith("#") ||
    (normalized.startsWith("/") && !normalized.startsWith("//"))
  );
}

function renderInline(text: string): React.ReactNode[] {
  // Regex parsing for inline elements: `code`, **bold**, *italic*, [link](url)
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(regex);

  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code key={i} className="inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (linkMatch) {
      const label = linkMatch[1]!;
      const rawUrl = linkMatch[2]!.trim();
      if (!isSafeLinkHref(rawUrl)) {
        return <span key={i}>{label}</span>;
      }
      return (
        <a key={i} href={rawUrl} target="_blank" rel="noreferrer" className="md-link">
          {label}
        </a>
      );
    }
    return part;
  });
}

export function MarkdownView({ content }: { content: string }) {
  if (!content) return null;

  const normalized = content.replace(/\r\n/g, "\n");
  const strippedFrontmatter = normalized.replace(/^---\n[\s\S]*?\n---\n+/, "");
  const effectiveContent = strippedFrontmatter.trim().length > 0 ? strippedFrontmatter : normalized;
  const lines = effectiveContent.split("\n");
  const nodes: React.ReactNode[] = [];

  let inCode = false;
  let codeLang = "";
  let codeBuffer: string[] = [];

  let listItems: React.ReactNode[] = [];
  let isNumberedList = false;

  const flushList = () => {
    if (listItems.length > 0) {
      if (isNumberedList) {
        nodes.push(<ol key={`ol-${nodes.length}`} className="md-list">{listItems}</ol>);
      } else {
        nodes.push(<ul key={`ul-${nodes.length}`} className="md-list">{listItems}</ul>);
      }
      listItems = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Code block fences
    if (line.startsWith("```")) {
      if (!inCode) {
        flushList();
        inCode = true;
        codeLang = line.slice(3).trim();
        codeBuffer = [];
      } else {
        inCode = false;
        nodes.push(
          <CodeBlock
            key={`code-${nodes.length}`}
            language={codeLang}
            code={codeBuffer.join("\n")}
          />,
        );
        codeBuffer = [];
        codeLang = "";
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    // Headings
    if (line.startsWith("# ")) {
      flushList();
      nodes.push(<h1 key={`h1-${nodes.length}`} className="md-h1">{renderInline(line.slice(2))}</h1>);
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      nodes.push(<h2 key={`h2-${nodes.length}`} className="md-h2">{renderInline(line.slice(3))}</h2>);
      continue;
    }
    if (line.startsWith("### ")) {
      flushList();
      nodes.push(<h3 key={`h3-${nodes.length}`} className="md-h3">{renderInline(line.slice(4))}</h3>);
      continue;
    }
    if (line.startsWith("#### ")) {
      flushList();
      nodes.push(<h4 key={`h4-${nodes.length}`} className="md-h4">{renderInline(line.slice(5))}</h4>);
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      flushList();
      const quoteText = line.slice(2);
      nodes.push(
        <blockquote key={`quote-${nodes.length}`} className="md-quote">
          {renderInline(quoteText)}
        </blockquote>,
      );
      continue;
    }

    // Horizontal rule
    if (/^---|\*\*\*|___$/.test(line.trim())) {
      flushList();
      nodes.push(<hr key={`hr-${nodes.length}`} className="md-hr" />);
      continue;
    }

    // Unordered List
    if (/^[-*]\s+/.test(line)) {
      if (isNumberedList && listItems.length > 0) flushList();
      isNumberedList = false;
      const text = line.replace(/^[-*]\s+/, "");
      // Checkbox
      if (text.startsWith("[ ] ") || text.startsWith("[x] ")) {
        const checked = text.startsWith("[x] ");
        listItems.push(
          <li key={`li-${listItems.length}`} className="md-checkbox-item">
            <input type="checkbox" readOnly checked={checked} className="md-checkbox" />
            <span>{renderInline(text.slice(4))}</span>
          </li>,
        );
      } else {
        listItems.push(
          <li key={`li-${listItems.length}`}>{renderInline(text)}</li>,
        );
      }
      continue;
    }

    // Ordered List
    const numMatch = /^(\d+)\.\s+(.*)$/.exec(line);
    if (numMatch) {
      if (!isNumberedList && listItems.length > 0) flushList();
      isNumberedList = true;
      listItems.push(
        <li key={`li-${listItems.length}`}>{renderInline(numMatch[2]!)}</li>,
      );
      continue;
    }

    // Empty line
    if (!line.trim()) {
      flushList();
      continue;
    }

    // Regular paragraph
    flushList();
    nodes.push(<p key={`p-${nodes.length}`} className="md-p">{renderInline(line)}</p>);
  }

  // Flush remaining code or list
  if (inCode && codeBuffer.length > 0) {
    nodes.push(
      <CodeBlock
        key={`code-${nodes.length}`}
        language={codeLang}
        code={codeBuffer.join("\n")}
      />,
    );
  }
  flushList();

  return <div className="markdown-body">{nodes}</div>;
}
