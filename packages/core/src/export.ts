import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentManifest } from "./manifest.js";

export interface ExportedSkill {
  skill: string;
  dest: string;
}

export interface ExportSkillsResult {
  exported: ExportedSkill[];
  skipped: ExportedSkill[];
}

export async function exportPackSkills(
  extractedDir: string,
  manifest: Pick<AgentManifest, "name" | "skills">,
  outDir: string,
  options: { force?: boolean } = {},
): Promise<ExportSkillsResult> {
  const extracted = path.resolve(extractedDir);
  const baseDir = path.resolve(outDir);
  if (baseDir === extracted || baseDir.startsWith(`${extracted}${path.sep}`)) {
    throw new Error("export destination must be outside the extracted pack");
  }

  const roots = manifest.skills.length > 0 ? manifest.skills : ["."];
  const exported: ExportedSkill[] = [];
  const skipped: ExportedSkill[] = [];

  for (const rel of roots) {
    const source = rel === "." ? extracted : path.join(extracted, rel);
    if (!fs.existsSync(source)) throw new Error(`pack does not contain skill path: ${rel}`);
    const skill = rel === "." ? manifest.name : path.basename(rel);
    const dest = path.join(baseDir, skill);
    if (fs.existsSync(dest) && options.force !== true) {
      skipped.push({ skill, dest });
      continue;
    }
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(baseDir, { recursive: true });
    await fsp.cp(source, dest, { recursive: true });
    exported.push({ skill, dest });
  }

  return { exported, skipped };
}
