import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { type AgentManifest, isSafeRelativePath } from "./manifest.js";

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
    if (!isSafeRelativePath(rel)) {
      throw new Error(`unsafe skill path in manifest: ${rel}`);
    }
    const source = rel === "." ? extracted : path.resolve(extracted, rel);
    if (source !== extracted && !source.startsWith(`${extracted}${path.sep}`)) {
      throw new Error(`unsafe skill path escapes pack root: ${rel}`);
    }
    if (!fs.existsSync(source)) throw new Error(`pack does not contain skill path: ${rel}`);
    const realExtracted = fs.realpathSync(extracted);
    const realSource = fs.realpathSync(source);
    if (realSource !== realExtracted && !realSource.startsWith(`${realExtracted}${path.sep}`)) {
      throw new Error(`skill path symlink escapes pack root: ${rel}`);
    }
    const skill = rel === "." ? manifest.name : path.basename(rel);
    if (!skill || skill === "." || skill === ".." || skill.includes("/") || skill.includes("\\")) {
      throw new Error(`invalid skill destination name: ${skill}`);
    }
    const dest = path.resolve(baseDir, skill);
    if (!dest.startsWith(`${baseDir}${path.sep}`)) {
      throw new Error(`export destination escapes output directory: ${dest}`);
    }
    if (fs.existsSync(dest) && options.force !== true) {
      skipped.push({ skill, dest });
      continue;
    }
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(baseDir, { recursive: true });
    await fsp.cp(realSource, dest, { recursive: true });
    exported.push({ skill, dest });
  }

  return { exported, skipped };
}
