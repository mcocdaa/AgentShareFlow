import { describe, expect, it } from "vitest";
import {
  isSafeExternalHref,
  parseMarkdownBlocks,
} from "../src/components/MarkdownView";
import {
  extractActiveMentionQuery,
  filterMentionCandidates,
  type MentionCandidate,
} from "../src/components/RoomChat";
import { TRANSLATIONS, translate } from "../src/i18n";

describe("isSafeExternalHref", () => {
  it("allows http and https external URLs", () => {
    expect(isSafeExternalHref("https://example.com")).toBe(true);
    expect(isSafeExternalHref("https://agentshare.dev/docs?v=2#intro")).toBe(true);
    expect(isSafeExternalHref("http://127.0.0.1:8787/healthz")).toBe(true);
    expect(isSafeExternalHref("  https://openai.com/  ")).toBe(true);
  });

  it("blocks javascript:, data:, vbscript:, file:, and root-relative CSRF URLs", () => {
    expect(isSafeExternalHref("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalHref("JAVASCRIPT:alert(1)")).toBe(false);
    expect(isSafeExternalHref("  javascript:void(0)")).toBe(false);
    expect(isSafeExternalHref("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeExternalHref("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeExternalHref("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalHref("/api/v2/auth/logout")).toBe(false);
    expect(isSafeExternalHref("//evil.example/phish")).toBe(false);
    expect(isSafeExternalHref("./relative/path")).toBe(false);
    expect(isSafeExternalHref("../parent")).toBe(false);
    expect(isSafeExternalHref("#section")).toBe(false);
    expect(isSafeExternalHref("")).toBe(false);
    expect(isSafeExternalHref("https://example.com/\u0000bad")).toBe(false);
  });
});

describe("parseMarkdownBlocks", () => {
  it("matches strict horizontal rules without eating ***bold-italic*** text", () => {
    const md = [
      "***bold-italic***",
      "",
      "---",
      "",
      "***",
      "",
      "___",
      "",
      "**just bold** and *italic*",
    ].join("\n");

    const blocks = parseMarkdownBlocks(md);
    expect(blocks).toEqual([
      { type: "paragraph", text: "***bold-italic***" },
      { type: "hr" },
      { type: "hr" },
      { type: "hr" },
      { type: "paragraph", text: "**just bold** and *italic*" },
    ]);
  });

  it("parses Markdown tables cleanly with alignments and escaped pipes", () => {
    const md = [
      "| Agent | Mode | Latency |",
      "| :--- | :---: | ---: |",
      "| @helper-bot | Direct P2P | 12ms |",
      "| @code\\|bot | Relay | 48ms |",
    ].join("\n");

    const blocks = parseMarkdownBlocks(md);
    expect(blocks).toEqual([
      {
        type: "table",
        headers: ["Agent", "Mode", "Latency"],
        alignments: ["left", "center", "right"],
        rows: [
          ["@helper-bot", "Direct P2P", "12ms"],
          ["@code|bot", "Relay", "48ms"],
        ],
      },
    ]);
  });

  it("parses fenced code blocks verbatim alongside headings, lists, and blockquotes", () => {
    const md = [
      "## Summary",
      "> Important note",
      "- first item",
      "- second item",
      "```ts",
      "---",
      "const x = 1;",
      "```",
    ].join("\n");

    const blocks = parseMarkdownBlocks(md);
    expect(blocks).toEqual([
      { type: "heading", level: 2, text: "Summary" },
      { type: "blockquote", lines: ["Important note"] },
      { type: "list", ordered: false, items: ["first item", "second item"] },
      { type: "code", lang: "ts", content: "---\nconst x = 1;" },
    ]);
  });
});

describe("mention autocomplete helpers", () => {
  const candidates: MentionCandidate[] = [
    { handle: "helper-bot", displayName: "Helper Bot", kind: "http", online: true },
    { handle: "alice", displayName: "Alice Chen", kind: "human", online: true },
    { handle: "archivist", displayName: "Archive Agent", kind: "mcp", online: false },
    { handle: "helper-bot", displayName: "Duplicate", kind: "cli", online: false },
    { handle: "bob-cli", displayName: "Bob CLI Runner", kind: "cli", online: true },
  ];

  it("deduplicates and ranks exact/prefix handle matches and online peers first", () => {
    const filtered = filterMentionCandidates(candidates, "a");
    expect(filtered.map((c) => c.handle)).toEqual(["alice", "archivist"]);

    const all = filterMentionCandidates(candidates, "");
    expect(all.map((c) => c.handle)).toEqual([
      "alice",
      "bob-cli",
      "helper-bot",
      "archivist",
    ]);

    const byDisplay = filterMentionCandidates(candidates, "runner");
    expect(byDisplay.map((c) => c.handle)).toEqual(["bob-cli"]);
  });

  it("extracts active @mention query at cursor and ignores email addresses", () => {
    expect(extractActiveMentionQuery("Hello @hel", 10)).toEqual({
      query: "hel",
      startIndex: 6,
    });
    expect(extractActiveMentionQuery("@", 1)).toEqual({
      query: "",
      startIndex: 0,
    });
    expect(extractActiveMentionQuery("mail alice@example", 18)).toBeNull();
    expect(extractActiveMentionQuery("hi @bot next", 12)).toBeNull();
  });
});

describe("i18n en/zh dictionary parity", () => {
  it("has identical keys, non-empty values, and matching interpolation placeholders", () => {
    const enKeys = Object.keys(TRANSLATIONS.en).sort();
    const zhKeys = Object.keys(TRANSLATIONS.zh).sort();

    expect(enKeys).toEqual(zhKeys);
    expect(enKeys.length).toBeGreaterThanOrEqual(120);

    const placeholderRegex = /\{([a-zA-Z0-9_]+)\}/g;
    for (const key of enKeys as Array<keyof typeof TRANSLATIONS.en>) {
      const enVal = TRANSLATIONS.en[key];
      const zhVal = TRANSLATIONS.zh[key];
      expect(enVal.trim().length, `empty en value for ${key}`).toBeGreaterThan(0);
      expect(zhVal.trim().length, `empty zh value for ${key}`).toBeGreaterThan(0);

      const enVars = [...enVal.matchAll(placeholderRegex)].map((m) => m[1]).sort();
      const zhVars = [...zhVal.matchAll(placeholderRegex)].map((m) => m[1]).sort();
      expect(zhVars, `placeholder mismatch on ${key}`).toEqual(enVars);
    }

    expect(translate("en", "room.maxHopsTag", { hops: 5 })).toBe("Loop limit: 5 hops");
    expect(translate("zh", "room.maxHopsTag", { hops: 5 })).toBe("防循环上限：5 跳");
  });
});
