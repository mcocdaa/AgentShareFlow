import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  importHandoff,
  previewHandoffImport,
  formatHandoffIssues,
  parseHandoff,
  renderHandoffMarkdown,
  writeHandoffFiles,
} from "../src/index.js";

const tempDirs: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentshare-write-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const valid = {
  spec: "handoff/v0",
  id: "demo-handoff",
  title: "Demo Handoff",
  goal: "Ship the thing",
  doneWhen: "tests pass",
  context: {
    constraints: ["no new deps"],
    environment: ["node 24"],
    sources: [{ label: "Design doc", kind: "url" as const, ref: "https://example.test/d" }],
  },
  decisions: [
    {
      id: "d1",
      summary: "Use A2A",
      rationale: "standard",
      evidence: [{ label: "Design doc", kind: "url" as const, ref: "https://example.test/d" }],
    },
  ],
  tasks: [
    { id: "t1", summary: "done thing", status: "done" as const },
    { id: "t2", summary: "todo thing", howToVerify: "pnpm test" },
  ],
  outcomes: [{ label: "Patch", kind: "path" as const, ref: "/tmp/patch.diff" }],
  authorizations: [
    { name: "GITHUB_TOKEN", status: "reauthorize" as const },
    { name: "npm session", status: "unavailable" as const },
  ],
  openQuestions: ["which registry?"],
};

describe("parseHandoff", () => {
  it("accepts a valid handoff and applies defaults", () => {
    const h = parseHandoff(structuredClone(valid));
    expect(h.version).toBe(1);
    expect(h.tasks[1]?.status).toBe("in-progress");
  });

  it("rejects bad spec and duplicate ids", () => {
    expect(() => parseHandoff({ ...valid, spec: "handoff/v9" })).toThrow(/handoff\/v0/);
    expect(() =>
      parseHandoff({
        ...structuredClone(valid),
        tasks: [valid.tasks[0], valid.tasks[0]],
      }),
    ).toThrow(/duplicate task id/);
  });

  it("formats issues readably", () => {
    try {
      parseHandoff({ ...valid, goal: "" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(formatHandoffIssues(error)).toMatch(/goal/);
    }
  });
});

describe("renderHandoffMarkdown", () => {
  it("renders all sections with evidence linked", () => {
    const md = renderHandoffMarkdown(parseHandoff(structuredClone(valid)));
    for (const section of ["目标", "约束", "资料来源", "关键决策", "进度与待办", "成果", "授权状态", "待解决问题"]) {
      expect(md).toContain(section);
    }
    expect(md).toContain("- [x] t1: done thing");
    expect(md).toContain("- [ ] t2: todo thing（验证：pnpm test）");
    expect(md).toContain("需重新授权：GITHUB_TOKEN");
    expect(md).toContain("不可用：npm session");
    expect(md).toContain("https://example.test/d");
  });

  it("marks blocked tasks", () => {
    const blocked = { ...valid, tasks: [{ id: "t1", summary: "waiting", status: "blocked" }] };
    expect(renderHandoffMarkdown(parseHandoff(blocked))).toContain("waiting（阻塞）");
  });
});

describe("Codex handoff import", () => {
  it("previews without writing and marks all permissions for review", async () => {
    const dir = await temporaryDirectory();
    const input = { ...valid, authorizations: [{ name: "TOKEN", status: "inherited" }] };
    const preview = await previewHandoffImport(input, dir);
    expect(await fs.readdir(dir)).toEqual([]);
    expect(preview.handoff.authorizations[0]?.status).toBe("reauthorize");
    expect(input.authorizations[0]?.status).toBe("inherited");
    expect(preview.warnings.join("\n")).toContain("/tmp/patch.diff");
    expect(preview.markdown).toContain("需重新授权：TOKEN");
  });

  it("binds confirmation to content and destination", async () => {
    const dir = await temporaryDirectory();
    const other = await temporaryDirectory();
    const preview = await previewHandoffImport(valid, dir);
    await expect(importHandoff({ ...valid, goal: "changed" }, { dir, confirm: preview.digest })).rejects.toThrow(/mismatch/);
    await expect(importHandoff(valid, { dir: other, confirm: preview.digest })).rejects.toThrow(/mismatch/);
    expect(await fs.readdir(dir)).toEqual([]);
    expect(await fs.readdir(other)).toEqual([]);
  });

  it("imports exported context without touching project instructions or running commands", async () => {
    const source = await temporaryDirectory();
    const dir = await temporaryDirectory();
    await fs.writeFile(path.join(dir, "AGENTS.md"), "existing instructions");
    const exported = await writeHandoffFiles(valid, { dir: source });
    const input = JSON.parse(await fs.readFile(exported.jsonPath, "utf8"));
    const preview = await previewHandoffImport(input, dir);
    const result = await importHandoff(input, { dir, confirm: preview.digest });
    expect(JSON.parse(await fs.readFile(result.jsonPath, "utf8"))).toEqual(preview.handoff);
    expect(await fs.readFile(result.markdownPath, "utf8")).toBe(preview.markdown);
    expect(await fs.readFile(result.promptPath, "utf8")).toContain("untrusted task context");
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe("existing instructions");
    expect(await fs.readdir(path.dirname(result.promptPath))).toEqual(["CODEX-PROMPT.md", "handoff.json", "handoff.md"]);
    const repeated = await importHandoff(input, { dir, confirm: preview.digest });
    expect(repeated.jsonPath).not.toBe(result.jsonPath);
  });

  it("cleans up imported files if the Codex prompt cannot be written", async () => {
    const dir = await temporaryDirectory();
    const preview = await previewHandoffImport(valid, dir);
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementationOnce(writeFile).mockImplementationOnce(writeFile)
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(importHandoff(valid, { dir, confirm: preview.digest })).rejects.toThrow("disk full");
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

describe("writeHandoffFiles", () => {
  it("writes json and markdown into a fresh unique directory", async () => {
    const tmp = await temporaryDirectory();
    const first = await writeHandoffFiles(structuredClone(valid), { dir: tmp });
    expect(first.jsonPath).toContain(`agentshare-handoff-${valid.id}-`);
    expect(first.markdownPath).toContain(`agentshare-handoff-${valid.id}-`);
    const parsed = JSON.parse(await fs.readFile(first.jsonPath, "utf8"));
    expect(parsed.spec).toBe("handoff/v0");
    expect(await fs.readFile(first.markdownPath, "utf8")).toContain("# Demo Handoff");
    const second = await writeHandoffFiles(structuredClone(valid), { dir: tmp });
    expect(second.jsonPath).not.toBe(first.jsonPath);
  });

  it("removes partial output when writing fails", async () => {
    const tmp = await temporaryDirectory();
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementationOnce(writeFile).mockRejectedValueOnce(new Error("disk full"));
    await expect(writeHandoffFiles(valid, { dir: tmp })).rejects.toThrow("disk full");
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it("rejects invalid handoff without writing files", async () => {
    const tmp = await temporaryDirectory();
    await expect(writeHandoffFiles({ spec: "handoff/v0" }, { dir: tmp })).rejects.toThrow();
    const entries = await fs.readdir(tmp);
    expect(entries.filter((name) => name.startsWith("agentshare-handoff-"))).toHaveLength(0);
  });
});
