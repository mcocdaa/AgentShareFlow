import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportPackSkills } from "../src/index.js";

const tempDirs: string[] = [];

async function temporaryDirectory(prefix = "agentshare-export-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("exportPackSkills", () => {
  it("exports named skill roots as flat SKILL.md directories", async () => {
    const pack = await temporaryDirectory();
    await fs.mkdir(path.join(pack, "skills/changelog"), { recursive: true });
    await fs.writeFile(path.join(pack, "skills/changelog/SKILL.md"), "# Changelog\n");
    await fs.mkdir(path.join(pack, "skills/release-notes/references"), { recursive: true });
    await fs.writeFile(path.join(pack, "skills/release-notes/SKILL.md"), "# Release notes\n");
    await fs.writeFile(path.join(pack, "skills/release-notes/references/format.md"), "format\n");
    const out = await temporaryDirectory();

    const result = await exportPackSkills(pack, { name: "release-helper", skills: ["skills/changelog", "skills/release-notes"] }, out);

    expect(result.skipped).toEqual([]);
    expect(result.exported.map((item) => item.skill)).toEqual(["changelog", "release-notes"]);
    await expect(fs.readFile(path.join(out, "changelog/SKILL.md"), "utf8")).resolves.toBe("# Changelog\n");
    await expect(fs.readFile(path.join(out, "release-notes/references/format.md"), "utf8")).resolves.toBe("format\n");
  });

  it("uses the pack name for a root skill and refuses to overwrite without force", async () => {
    const pack = await temporaryDirectory();
    await fs.writeFile(path.join(pack, "SKILL.md"), "# Root\n");
    const out = await temporaryDirectory();

    const first = await exportPackSkills(pack, { name: "hello-handoff", skills: ["."] }, out);
    expect(first.exported.map((item) => item.dest)).toEqual([path.join(out, "hello-handoff")]);

    await fs.writeFile(path.join(pack, "SKILL.md"), "# Root v2\n");
    const second = await exportPackSkills(pack, { name: "hello-handoff", skills: ["."] }, out);
    expect(second.exported).toEqual([]);
    expect(second.skipped.map((item) => item.dest)).toEqual([path.join(out, "hello-handoff")]);
    await expect(fs.readFile(path.join(out, "hello-handoff/SKILL.md"), "utf8")).resolves.toBe("# Root\n");

    const third = await exportPackSkills(pack, { name: "hello-handoff", skills: ["."] }, out, { force: true });
    expect(third.exported).toHaveLength(1);
    await expect(fs.readFile(path.join(out, "hello-handoff/SKILL.md"), "utf8")).resolves.toBe("# Root v2\n");
  });

  it("rejects missing skill roots and destinations inside the pack", async () => {
    const pack = await temporaryDirectory();
    await expect(exportPackSkills(pack, { name: "x", skills: ["skills/nope"] }, await temporaryDirectory())).rejects.toThrow(
      "pack does not contain skill path: skills/nope",
    );
    await expect(exportPackSkills(pack, { name: "x", skills: [] }, path.join(pack, "nested"))).rejects.toThrow(
      "export destination must be outside the extracted pack",
    );
  });
});
