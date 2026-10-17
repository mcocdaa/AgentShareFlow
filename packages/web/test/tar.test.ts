import { gzipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { extractManifestFromTarball, readTarEntry } from "../src/tar.js";

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function entry(name: string, content: string, type = 48): Uint8Array {
  const bytes = strToU8(content);
  const header = new Uint8Array(512);
  header.set(strToU8(name), 0);
  header.set(strToU8(bytes.length.toString(8).padStart(11, "0")), 124);
  header[156] = type;
  const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  padded.set(bytes);
  return concat([header, padded]);
}

function tar(entries: Uint8Array[]): Uint8Array {
  return concat([...entries, new Uint8Array(1024)]);
}

const manifest = JSON.stringify({ spec: "agent-pack/v0", name: "demo", version: "0.1.0" });

describe("extractManifestFromTarball", () => {
  it("reads agent.json from a gzipped tarball with mixed entries", () => {
    const bytes = gzipSync(
      tar([
        entry("SKILL.md", "# Demo\n"),
        entry("./agent.json", manifest),
        entry("references/notes.md", "notes\n"),
      ]),
    );
    expect(extractManifestFromTarball(bytes)).toMatchObject({ name: "demo", version: "0.1.0" });
  });

  it("reads an uncompressed tarball and skips directory entries", () => {
    const bytes = tar([entry("references/", "", 53), entry("agent.json", manifest)]);
    expect(extractManifestFromTarball(bytes)).toMatchObject({ name: "demo" });
  });

  it("fails when agent.json is missing or invalid", () => {
    expect(() => extractManifestFromTarball(gzipSync(tar([entry("SKILL.md", "# x\n")])))).toThrow(
      "agent.json not found in the tarball",
    );
    expect(() => extractManifestFromTarball(tar([entry("agent.json", "{oops")]))).toThrow(
      "agent.json is not valid JSON",
    );
  });
});

describe("readTarEntry", () => {
  it("normalizes ./ prefixes and returns raw bytes", () => {
    const value = readTarEntry(tar([entry("./agent.json", manifest)]), "agent.json");
    expect(new TextDecoder().decode(value)).toBe(manifest);
  });

  it("returns undefined when absent", () => {
    expect(readTarEntry(tar([entry("SKILL.md", "x")]), "agent.json")).toBeUndefined();
  });

  it("supports USTAR prefix field (bytes 345..500) for long entry paths", () => {
    const contentBytes = strToU8("# Deep Skill\n");
    const header = new Uint8Array(512);
    header.set(strToU8("SKILL.md"), 0);
    header.set(strToU8(contentBytes.length.toString(8).padStart(11, "0")), 124);
    header[156] = 48;
    header.set(strToU8("skills/deeply/nested/path"), 345);
    const padded = new Uint8Array(512);
    padded.set(contentBytes);
    const archive = tar([concat([header, padded])]);

    const found = readTarEntry(archive, "skills/deeply/nested/path/SKILL.md");
    expect(found).toBeDefined();
    expect(new TextDecoder().decode(found)).toBe("# Deep Skill\n");
  });
});

import {
  authHeaders,
  getSession,
  getStoredToken,
  listFederationPeers,
  listOrgs,
  loginOrRegister,
  runPackPlayground,
  setStoredToken,
  toggleStar,
} from "../src/api.js";

describe("WebUI API token symmetry helpers", () => {
  it("stores and attaches Bearer tokens to getSession, toggleStar, runPackPlayground, listOrgs, and listFederationPeers", async () => {
    const store = new Map<string, string>();
    const origStorage = globalThis.localStorage;
    const origFetch = globalThis.fetch;

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/v1/auth/login") {
        return new Response(
          JSON.stringify({ ok: true, owner: "alice", username: "alice", token: "as_testtoken123" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/v1/me") {
        return new Response(JSON.stringify({ owner: "alice" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/star")) {
        return new Response(JSON.stringify({ starred: true, stars: 5 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/playground")) {
        return new Response(
          JSON.stringify({
            ok: true,
            output: "done",
            logs: [],
            executionTimeMs: 12,
            exitCode: 0,
            sandboxed: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/v1/orgs") {
        return new Response(JSON.stringify({ organizations: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/v1/federation/peers") {
        return new Response(JSON.stringify({ peers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      expect(getStoredToken()).toBeNull();
      expect(authHeaders()).toEqual({});

      const authRes = await loginOrRegister("alice", "pass1234", "login");
      expect(authRes.token).toBe("as_testtoken123");
      expect(getStoredToken()).toBe("as_testtoken123");
      expect(authHeaders()).toEqual({ Authorization: "Bearer as_testtoken123" });

      const session = await getSession();
      expect(session).toEqual({ owner: "alice" });

      await toggleStar("alice", "demo", false);
      await runPackPlayground("alice", "demo", "0.1.0", { query: "hi" });
      await listOrgs();
      await listFederationPeers();

      const meCall = calls.find((c) => c.url === "/api/v1/me");
      expect((meCall?.init?.headers as Record<string, string>)?.Authorization).toBe(
        "Bearer as_testtoken123",
      );

      const starCall = calls.find((c) => c.url.endsWith("/star"));
      expect((starCall?.init?.headers as Record<string, string>)?.Authorization).toBe(
        "Bearer as_testtoken123",
      );

      const playCall = calls.find((c) => c.url.endsWith("/playground"));
      expect((playCall?.init?.headers as Record<string, string>)?.Authorization).toBe(
        "Bearer as_testtoken123",
      );

      setStoredToken(null);
      expect(getStoredToken()).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: origStorage });
    }
  });
});

import { getInitialLocale, translations } from "../src/i18n.js";

describe("Bilingual i18n dictionary and locale defaults", () => {
  it("defaults to 'en' when agentshare_lang is not set and respects 'zh'", () => {
    const store = new Map<string, string>();
    const origWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => store.set(k, v),
        },
      },
    });
    try {
      expect(getInitialLocale()).toBe("en");
      store.set("agentshare_lang", "zh");
      expect(getInitialLocale()).toBe("zh");
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: origWindow });
    }
  });

  it("maintains 100% key parity and non-empty strings between en and zh dictionaries", () => {
    const enKeys = Object.keys(translations.en).sort();
    const zhKeys = Object.keys(translations.zh).sort();
    expect(zhKeys).toEqual(enKeys);
    for (const key of enKeys as Array<keyof typeof translations.en>) {
      expect(translations.en[key].length).toBeGreaterThan(0);
      expect(translations.zh[key].length).toBeGreaterThan(0);
    }
  });

  it("localizes tarball extraction errors when locale is zh", () => {
    expect(() =>
      extractManifestFromTarball(gzipSync(tar([entry("SKILL.md", "# x\n")])), "zh"),
    ).toThrow("归档包中未找到 agent.json");
    expect(() =>
      extractManifestFromTarball(tar([entry("agent.json", "{oops")]), "zh"),
    ).toThrow("agent.json 不是有效的 JSON");
  });
});

