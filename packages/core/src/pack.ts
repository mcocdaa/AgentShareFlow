import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { type AgentManifest, formatIssues, parseManifest } from "./manifest.js";

export const MANIFEST_FILENAME = "agent.json";

const DEFAULT_EXCLUDES = [".git", "node_modules", "dist", "data", ".agentshare", "coverage"];

export interface ReadPackResult {
  dir: string;
  manifest: AgentManifest;
}

function normalizeEntry(entry: string): string {
  return entry.replace(/^\.\//, "");
}

export async function readPack(dir: string): Promise<ReadPackResult> {
  const resolved = path.resolve(dir);
  const manifestPath = path.join(resolved, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`missing ${MANIFEST_FILENAME} in ${resolved}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`${MANIFEST_FILENAME} is not valid JSON: ${formatIssues(error)}`);
  }

  let manifest: AgentManifest;
  try {
    manifest = parseManifest(raw);
  } catch (error) {
    throw new Error(`invalid manifest: ${formatIssues(error)}`);
  }

  for (const rel of [...manifest.skills, ...manifest.instructions]) {
    if (!fs.existsSync(path.join(resolved, rel))) {
      throw new Error(`manifest references missing path: ${rel}`);
    }
  }
  if (manifest.mcp && !fs.existsSync(path.join(resolved, manifest.mcp.config))) {
    throw new Error(`manifest references missing mcp config: ${manifest.mcp.config}`);
  }

  return { dir: resolved, manifest };
}

export interface CreatePackResult {
  file: string;
  digest: string;
  size: number;
}

export async function createPackTarball(dir: string, outFile: string): Promise<CreatePackResult> {
  const resolved = path.resolve(dir);
  const out = path.resolve(outFile);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  if (fs.existsSync(out)) await fsp.rm(out, { force: true });

  await tar.create(
    {
      gzip: true,
      file: out,
      cwd: resolved,
      portable: true,
      filter: (entry) => {
        const rel = normalizeEntry(entry);
        if (!rel) return true;
        if (DEFAULT_EXCLUDES.some((x) => rel === x || rel.startsWith(`${x}/`))) return false;
        if (rel.endsWith(".tgz")) return false;
        return true;
      },
    },
    ["."],
  );

  const bytes = await fsp.readFile(out);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const { size } = await fsp.stat(out);
  return { file: out, digest, size };
}

export async function extractPackTarball(file: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  await tar.extract({ file: path.resolve(file), cwd: path.resolve(dest) });
}
