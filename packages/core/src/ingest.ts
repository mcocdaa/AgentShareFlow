import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  type Harness,
  HARNESSES,
  type AgentManifest,
  PACK_SPEC,
  parseManifest,
} from "./manifest.js";
import { resolveSkillsDir, type ResolveSkillsDirOptions } from "./harness.js";
import { parseSkillFrontmatter, sanitizePackName } from "./import.js";
import { MANIFEST_FILENAME } from "./pack.js";

export interface DiscoveredSkill {
  name: string;
  dir: string;
  hasSkillMd: boolean;
  hasMcp: boolean;
  files: string[];
}

export interface IngestOptions {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  project?: boolean;
  cwd?: string;
  out?: string;
  force?: boolean;
  targetHarnesses?: Harness[];
}

export interface IngestResult {
  harness: Harness;
  skillName: string;
  sourceDir: string;
  outDir: string;
  manifest: AgentManifest;
  files: string[];
}

const COMMON_NON_SECRETS = new Set([
  "HTTP",
  "HTTPS",
  "JSON",
  "YAML",
  "REST",
  "README",
  "UTF",
  "UUID",
  "NOTE",
  "TODO",
  "FIXME",
  "FAIL",
  "PASS",
]);

export function detectDeclaredSecrets(content: string): string[] {
  const matches = content.match(/\b([A-Z][A-Z0-9_]{2,})\b/g) ?? [];
  const found = new Set<string>();

  for (const match of matches) {
    if (COMMON_NON_SECRETS.has(match)) continue;
    if (
      match.endsWith("_TOKEN") ||
      match.endsWith("_KEY") ||
      match.endsWith("_SECRET") ||
      match.endsWith("_AUTH") ||
      match.endsWith("_PASSWORD") ||
      match.endsWith("_CREDENTIALS") ||
      match.includes("API_KEY") ||
      match.startsWith("GITHUB_") ||
      match.startsWith("OPENAI_") ||
      match.startsWith("ANTHROPIC_") ||
      match.startsWith("AWS_")
    ) {
      found.add(match);
    }
  }

  return [...found].sort().slice(0, 32);
}

export async function collectDirectoryFiles(dir: string, baseDir: string = dir): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === ".DS_Store" ||
      entry.name === MANIFEST_FILENAME
    ) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectDirectoryFiles(fullPath, baseDir)));
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, fullPath));
    }
  }
  return results.sort();
}

/**
 * Discover existing skills within a target harness directory.
 */
export async function discoverHarnessSkills(
  harness: Harness,
  options: ResolveSkillsDirOptions = {},
): Promise<DiscoveredSkill[]> {
  const baseDir = resolveSkillsDir(harness, options);
  if (!fs.existsSync(baseDir)) return [];

  const entries = await fsp.readdir(baseDir, { withFileTypes: true });
  const skills: DiscoveredSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(baseDir, entry.name);
    const files = await collectDirectoryFiles(skillDir);
    const hasSkillMd = files.some(
      (f) => f === "SKILL.md" || f.endsWith("/SKILL.md") || f.toLowerCase() === "skill.md",
    );
    const hasMcp = files.some((f) => f === "mcp.json" || f.endsWith("/mcp.json"));

    skills.push({
      name: entry.name,
      dir: skillDir,
      hasSkillMd,
      hasMcp,
      files,
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Ingest a skill from an existing harness installation and scaffold a standard Agent Pack.
 */
export async function ingestSkillFromHarness(
  harness: Harness,
  skillName: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const harnessDir = resolveSkillsDir(harness, {
    project: options.project,
    cwd: options.cwd,
  });

  let sourceDir = path.join(harnessDir, skillName);
  if (!fs.existsSync(sourceDir)) {
    // Check if skillName is a direct relative or absolute path
    const fallbackPath = path.resolve(options.cwd ?? process.cwd(), skillName);
    if (fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).isDirectory()) {
      sourceDir = fallbackPath;
    } else {
      throw new Error(
        `Skill "${skillName}" not found in ${harness} directory (${harnessDir}) or local path (${fallbackPath})`,
      );
    }
  }

  const files = await collectDirectoryFiles(sourceDir);
  if (files.length === 0) {
    throw new Error(`Source skill directory "${sourceDir}" is empty`);
  }

  const skillMdRel = files.find(
    (f) => f === "SKILL.md" || f.endsWith("/SKILL.md") || f.toLowerCase() === "skill.md",
  );
  let skillContent = "";
  let frontmatter: { name?: string; description?: string } = {};

  if (skillMdRel !== undefined) {
    skillContent = await fsp.readFile(path.join(sourceDir, skillMdRel), "utf8");
    frontmatter = parseSkillFrontmatter(skillContent);
  }

  const detectedSecrets = detectDeclaredSecrets(skillContent);
  const hasMcp = files.some((f) => f === "mcp.json" || f.endsWith("/mcp.json"));

  const packName = sanitizePackName(options.name ?? frontmatter.name ?? skillName);
  const title = (options.title ?? frontmatter.name ?? skillName).slice(0, 120);
  const description = (
    options.description ??
    frontmatter.description ??
    `Skill "${skillName}" ingested from ${harness} environment.`
  ).slice(0, 1024);

  const targets = (
    options.targetHarnesses && options.targetHarnesses.length > 0
      ? options.targetHarnesses
      : [harness, "agents" as Harness]
  ).filter((h): h is Harness => HARNESSES.includes(h));

  const uniqueTargets = [...new Set(targets)];

  const manifest = parseManifest({
    spec: PACK_SPEC,
    name: packName,
    version: options.version ?? "0.1.0",
    title,
    description,
    mode: "offline",
    tags: ["ingested", harness, skillName],
    compatibility: uniqueTargets.length > 0 ? uniqueTargets : ["agents"],
    skills: ["."],
    ...(hasMcp ? { mcp: { config: "mcp.json" } } : {}),
    secrets: detectedSecrets,
    metadata: {
      ingestedFrom: harness,
      sourceSkill: skillName,
      ingestedAt: new Date().toISOString(),
    },
  });

  const outDir = path.resolve(
    options.out ?? path.join(options.cwd ?? process.cwd(), packName),
  );

  if (fs.existsSync(outDir)) {
    const existing = await fsp.readdir(outDir);
    if (existing.length > 0 && options.force !== true) {
      throw new Error(`Output directory "${outDir}" is not empty (use --force to overwrite)`);
    }
  }

  await fsp.mkdir(outDir, { recursive: true });

  const copiedFiles: string[] = [];
  for (const rel of files) {
    const srcFile = path.join(sourceDir, rel);
    const destFile = path.join(outDir, rel);
    await fsp.mkdir(path.dirname(destFile), { recursive: true });
    await fsp.copyFile(srcFile, destFile);
    copiedFiles.push(rel);
  }

  // Ensure SKILL.md exists
  if (!copiedFiles.includes("SKILL.md")) {
    const fallbackSkillMd = [
      "---",
      `name: ${packName}`,
      `description: ${description.replace(/\n+/g, " ")}`,
      "---",
      "",
      `# ${title}`,
      "",
      description,
      "",
    ].join("\n");
    await fsp.writeFile(path.join(outDir, "SKILL.md"), fallbackSkillMd, "utf8");
    copiedFiles.push("SKILL.md");
  }

  // Write agent.json
  await fsp.writeFile(
    path.join(outDir, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  copiedFiles.push(MANIFEST_FILENAME);

  return {
    harness,
    skillName,
    sourceDir,
    outDir,
    manifest,
    files: copiedFiles.sort(),
  };
}
