import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  importFromClawHub,
  importFromSkillsSh,
  importFromSmithery,
  parseSkillFrontmatter,
  sanitizePackName,
} from "../src/index.js";

const tempDirs: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentshare-import-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

describe("sanitizePackName and frontmatter", () => {
  it("derives pack-safe names", () => {
    expect(sanitizePackName("Weather")).toBe("weather");
    expect(sanitizePackName("@upstash/context7-mcp")).toBe("upstash-context7-mcp");
    expect(() => sanitizePackName("你好")).toThrow("pass --name");
  });

  it("parses skill frontmatter", () => {
    expect(
      parseSkillFrontmatter('---\nname: weather\ndescription: "Get weather"\n---\n# Weather\n'),
    ).toEqual({ name: "weather", description: "Get weather" });
    expect(parseSkillFrontmatter("# no frontmatter")).toEqual({});
  });
});

describe("importFromSmithery", () => {
  it("builds an endpoint pack with a pointer skill", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("registry.smithery.ai/servers/upstash%2Fcontext7-mcp");
      return json({
        qualifiedName: "upstash/context7-mcp",
        displayName: "Context7",
        description: "Up-to-date docs for libraries.",
        deploymentUrl: "https://context7-mcp--upstash.run.tools",
        connections: [{ type: "http", deploymentUrl: "https://context7-mcp--upstash.run.tools" }],
        tools: [{ name: "resolve-library-id" }, { name: "get-library-docs" }],
      });
    });
    const out = await temporaryDirectory();
    const result = await importFromSmithery("upstash/context7-mcp", { out: path.join(out, "pack") });
    expect(result.manifest).toMatchObject({
      name: "context7-mcp",
      mode: "endpoint",
      endpoint: { type: "mcp", url: "https://context7-mcp--upstash.run.tools" },
      skills: ["."],
    });
    const skill = await fs.readFile(path.join(result.dir, "SKILL.md"), "utf8");
    expect(skill).toContain("resolve-library-id");
    const manifest = JSON.parse(await fs.readFile(path.join(result.dir, "agent.json"), "utf8"));
    expect(manifest.metadata.source).toBe("https://smithery.ai/server/upstash/context7-mcp");
  });

  it("fails when the server exposes no http endpoint", async () => {
    vi.stubGlobal("fetch", async () => json({ qualifiedName: "x/y", remote: false }));
    const out = await temporaryDirectory();
    await expect(importFromSmithery("x/y", { out: path.join(out, "pack") })).rejects.toThrow(
      "declares no hosted http endpoint",
    );
  });
});

describe("importFromClawHub", () => {
  it("unpacks the skill zip and maps metadata", async () => {
    const zip = zipSync({
      "SKILL.md": strToU8('---\nname: weather\ndescription: Get weather\n---\n# Weather\n'),
      "references/format.md": strToU8("format codes\n"),
      "_meta.json": strToU8('{"internal":true}'),
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/skills/weather")) {
        return json({
          skill: {
            slug: "weather",
            displayName: "Weather",
            summary: "Get current weather and forecasts.",
            topics: ["Current Weather"],
            tags: { latest: "1.0.0" },
            metadata: { setup: [{ key: "WEATHER_TOKEN", required: true }] },
          },
        });
      }
      if (url.includes("/api/v1/download")) return new Response(zip, { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const out = await temporaryDirectory();
    const result = await importFromClawHub("steipete/weather", { out: path.join(out, "pack") });
    expect(result.manifest).toMatchObject({
      name: "weather",
      version: "1.0.0",
      mode: "offline",
      skills: ["."],
      secrets: ["WEATHER_TOKEN"],
      tags: ["clawhub", "Current Weather"],
    });
    await expect(fs.readFile(path.join(result.dir, "references/format.md"), "utf8")).resolves.toBe(
      "format codes\n",
    );
    await expect(fs.stat(path.join(result.dir, "_meta.json"))).rejects.toThrow();
  });
});

describe("importFromSkillsSh", () => {
  it("imports all skills from a GitHub source as a multi-skill pack", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/vercel-labs/skills") {
        return json({ default_branch: "main" });
      }
      if (url.includes("/git/trees/")) {
        return json({
          tree: [
            { path: "skills/find-skills/SKILL.md", type: "blob" },
            { path: "skills/find-skills/scripts/search.sh", type: "blob" },
            { path: "skills/other/SKILL.md", type: "blob" },
            { path: "README.md", type: "blob" },
            { path: "skills", type: "tree" },
          ],
        });
      }
      if (url.includes("raw.githubusercontent.com")) {
        if (url.endsWith("find-skills/SKILL.md")) {
          return new Response("---\nname: find-skills\ndescription: Find skills.\n---\n", { status: 200 });
        }
        return new Response("content\n", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const out = await temporaryDirectory();
    const result = await importFromSkillsSh("vercel-labs/skills", { out: path.join(out, "pack") });
    expect(result.manifest).toMatchObject({
      name: "skills",
      mode: "offline",
      skills: ["skills/find-skills", "skills/other"],
    });
    await expect(fs.readFile(path.join(result.dir, "skills/find-skills/scripts/search.sh"), "utf8")).resolves.toBe(
      "content\n",
    );
  });

  it("selects one skill and uses its frontmatter", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/vercel-labs/skills") return json({ default_branch: "main" });
      if (url.includes("/git/trees/")) {
        return json({
          tree: [
            { path: "skills/find-skills/SKILL.md", type: "blob" },
            { path: "skills/other/SKILL.md", type: "blob" },
          ],
        });
      }
      if (url.includes("raw.githubusercontent.com")) {
        return new Response("---\nname: find-skills\ndescription: Find skills.\n---\n", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const out = await temporaryDirectory();
    const result = await importFromSkillsSh("vercel-labs/skills", {
      out: path.join(out, "pack"),
      skill: "find-skills",
    });
    expect(result.manifest).toMatchObject({
      name: "find-skills",
      title: "find-skills",
      description: "Find skills.",
      skills: ["skills/find-skills"],
    });
  });

  it("falls back to the contents API when raw.githubusercontent.com is unreachable", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/vercel-labs/skills") return json({ default_branch: "main" });
      if (url.includes("/git/trees/")) {
        return json({ tree: [{ path: "skills/find-skills/SKILL.md", type: "blob" }] });
      }
      if (url.startsWith("https://raw.githubusercontent.com")) throw new TypeError("fetch failed");
      if (url.includes("/contents/skills/find-skills/SKILL.md")) {
        return new Response("---\nname: find-skills\ndescription: via api\n---\n", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const out = await temporaryDirectory();
    const result = await importFromSkillsSh("vercel-labs/skills", {
      out: path.join(out, "pack"),
      skill: "find-skills",
    });
    expect(result.manifest.description).toBe("via api");
    await expect(fs.readFile(path.join(result.dir, "skills/find-skills/SKILL.md"), "utf8")).resolves.toContain(
      "via api",
    );
  });

  it("lists candidates when the requested skill does not exist", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/vercel-labs/skills") return json({ default_branch: "main" });
      return json({ tree: [{ path: "skills/find-skills/SKILL.md", type: "blob" }] });
    });
    const out = await temporaryDirectory();
    await expect(
      importFromSkillsSh("vercel-labs/skills", { out: path.join(out, "pack"), skill: "nope" }),
    ).rejects.toThrow("available: find-skills");
  });
});
