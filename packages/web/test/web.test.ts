import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_URL_STORAGE_KEY,
  getEnvServerUrl,
  loadStoredServerUrl,
  normalizeServerBaseUrl,
  readServerUrlFromQuery,
  resolveApiUrl,
  resolveWsUrl,
  saveStoredServerUrl,
  validateServerBaseUrl,
} from "../src/api";
import { transportBadgeMeta } from "../src/components/DmPanel";
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

describe("transportBadgeMeta", () => {
  it("returns distinct labels, classes, and non-color glyphs for direct, webrtc, and relay", () => {
    const direct = transportBadgeMeta("direct");
    const webrtc = transportBadgeMeta("webrtc");
    const relay = transportBadgeMeta("relay");

    expect(direct).toEqual({
      mode: "direct",
      labelKey: "dm.transportDirect",
      pillClass: "status-pill status-pill-ok",
      miniPillClass: "mini-pill mini-pill-ok",
      indicator: "⚡",
    });
    expect(webrtc).toEqual({
      mode: "webrtc",
      labelKey: "dm.transportWebrtc",
      pillClass: "status-pill status-pill-webrtc",
      miniPillClass: "mini-pill mini-pill-webrtc",
      indicator: "⇄",
    });
    expect(relay).toEqual({
      mode: "relay",
      labelKey: "dm.transportRelay",
      pillClass: "status-pill status-pill-warn",
      miniPillClass: "mini-pill mini-pill-warn",
      indicator: "⤴",
    });

    expect(new Set([direct.pillClass, webrtc.pillClass, relay.pillClass]).size).toBe(3);
    expect(new Set([direct.miniPillClass, webrtc.miniPillClass, relay.miniPillClass]).size).toBe(3);
    expect(new Set([direct.indicator, webrtc.indicator, relay.indicator]).size).toBe(3);

    expect(translate("en", direct.labelKey)).toBe("P2P Direct");
    expect(translate("zh", direct.labelKey)).toBe("P2P 直连");
    expect(translate("en", webrtc.labelKey)).toBe("WebRTC P2P");
    expect(translate("zh", webrtc.labelKey)).toBe("WebRTC 直连");
    expect(translate("en", relay.labelKey)).toBe("Relay Encrypted");
    expect(translate("zh", relay.labelKey)).toBe("加密中继");
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
    expect(translate("en", "dm.localNodeWebrtcOn")).toBe("WebRTC NAT");
    expect(translate("zh", "dm.localNodeWebrtcOn")).toBe("WebRTC NAT 穿透");
    expect(translate("en", "dm.localNodeWebrtcOff")).toBe("WebRTC Off");
    expect(translate("zh", "dm.localNodeWebrtcOff")).toBe("WebRTC 已关闭");
    expect(translate("en", "auth.serverUrl")).toBe("Backend Server URL");
    expect(translate("zh", "auth.serverUrl")).toBe("后端服务器地址");
    expect(translate("en", "auth.serverUrlSameOrigin")).toBe("Same-origin");
    expect(translate("zh", "auth.serverUrlSameOrigin")).toBe("同源默认");
  });
});

describe("standalone backend server URL helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes whitespace and trailing slashes", () => {
    expect(normalizeServerBaseUrl("  http://127.0.0.1:8787///  ")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(normalizeServerBaseUrl("https://api.example.com/v2/")).toBe(
      "https://api.example.com/v2",
    );
    expect(normalizeServerBaseUrl("   ")).toBe("");
  });

  it("validates http, https, and empty same-origin URLs while rejecting unsafe schemes", () => {
    expect(validateServerBaseUrl("")).toEqual({ ok: true, url: "" });
    expect(validateServerBaseUrl("   ")).toEqual({ ok: true, url: "" });
    expect(validateServerBaseUrl("http://127.0.0.1:8787/")).toEqual({
      ok: true,
      url: "http://127.0.0.1:8787",
    });
    expect(validateServerBaseUrl("https://chat.example.com/agentshare///")).toEqual({
      ok: true,
      url: "https://chat.example.com/agentshare",
    });

    expect(validateServerBaseUrl("ftp://example.com")).toEqual({ ok: false });
    expect(validateServerBaseUrl("javascript:alert(1)")).toEqual({ ok: false });
    expect(validateServerBaseUrl("ws://127.0.0.1:8787")).toEqual({ ok: false });
    expect(validateServerBaseUrl("not-a-valid-url")).toEqual({ ok: false });
  });

  it("resolves API URLs for standalone bases, path prefixes, and same-origin mode", () => {
    expect(resolveApiUrl("/api/v2/rooms", "http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787/api/v2/rooms",
    );
    expect(resolveApiUrl("healthz", "https://api.example.com/sub/")).toBe(
      "https://api.example.com/sub/healthz",
    );
    expect(resolveApiUrl("/api/v2/server/info", "")).toBe("/api/v2/server/info");
    expect(resolveApiUrl("api/v2/me", "")).toBe("/api/v2/me");
  });

  it("resolves WebSocket URLs across http/https, path prefixes, trailing slashes, and fallbackLocation", () => {
    expect(resolveWsUrl("tok+1/2", "http://127.0.0.1:8787")).toBe(
      "ws://127.0.0.1:8787/ws?token=tok%2B1%2F2",
    );
    expect(resolveWsUrl("abc", "https://chat.example.com/")).toBe(
      "wss://chat.example.com/ws?token=abc",
    );
    expect(resolveWsUrl("abc", "https://chat.example.com/agentshare///")).toBe(
      "wss://chat.example.com/agentshare/ws?token=abc",
    );
    expect(
      resolveWsUrl("abc", "", { protocol: "http:", host: "localhost:5173" }),
    ).toBe("ws://localhost:5173/ws?token=abc");
    expect(
      resolveWsUrl("abc", "", { protocol: "https:", host: "ui.example.com:8443" }),
    ).toBe("wss://ui.example.com:8443/ws?token=abc");
  });

  it("handles missing window safely in Node and respects query > localStorage > env priority", () => {
    expect(getEnvServerUrl()).toBe("");
    expect(readServerUrlFromQuery()).toBeNull();
    expect(loadStoredServerUrl()).toBe("");
    expect(() => saveStoredServerUrl("http://127.0.0.1:8787")).not.toThrow();

    const store = new Map<string, string>();
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "http://127.0.0.1:5173/?server=http%3A%2F%2F127.0.0.1%3A8787%2F",
        search: "?server=http%3A%2F%2F127.0.0.1%3A8787%2F",
        protocol: "http:",
        host: "127.0.0.1:5173",
      },
      history: { replaceState },
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });

    expect(readServerUrlFromQuery()).toBe("http://127.0.0.1:8787");
    expect(loadStoredServerUrl()).toBe("http://127.0.0.1:8787");
    expect(store.get(SERVER_URL_STORAGE_KEY)).toBe("http://127.0.0.1:8787");

    saveStoredServerUrl("https://remote.example.com/");
    expect(store.get(SERVER_URL_STORAGE_KEY)).toBe("https://remote.example.com");
    expect(replaceState).toHaveBeenCalledTimes(1);

    (window.location as { search: string }).search = "";
    expect(loadStoredServerUrl()).toBe("https://remote.example.com");
    expect(resolveApiUrl("/healthz")).toBe("https://remote.example.com/healthz");

    saveStoredServerUrl(null);
    expect(store.has(SERVER_URL_STORAGE_KEY)).toBe(false);
    expect(loadStoredServerUrl()).toBe("");
  });
});
