import fs from "node:fs/promises";
import path from "node:path";

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface FileDiff {
  path: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface PackDiff {
  files: FileDiff[];
  added: number;
  removed: number;
  changed: number;
}

const SKIP = new Set([".git", "node_modules", "dist", "data", "coverage", ".agentshare"]);
const MAX_DIFF_LINES = 5000;

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      files.push(...(await listFiles(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

function isBinary(bytes: Buffer): boolean {
  return bytes.includes(0) || bytes.toString("utf8").includes("\uFFFD");
}

export function diffLines(from: string[], to: string[]): { additions: number; deletions: number } {
  if (from.length > MAX_DIFF_LINES || to.length > MAX_DIFF_LINES) {
    const fromSet = new Set(from);
    const toSet = new Set(to);
    return {
      additions: to.filter((line) => !fromSet.has(line)).length,
      deletions: from.filter((line) => !toSet.has(line)).length,
    };
  }
  const width = to.length + 1;
  const table = new Uint32Array((from.length + 1) * width);
  for (let i = from.length - 1; i >= 0; i -= 1) {
    for (let j = to.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = from[i] === to[j]
        ? (table[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const common = table[0] ?? 0;
  return { additions: to.length - common, deletions: from.length - common };
}

export async function diffPackDirs(fromDir: string, toDir: string): Promise<PackDiff> {
  const from = path.resolve(fromDir);
  const to = path.resolve(toDir);
  const fromFiles = new Set(await listFiles(from));
  const toFiles = new Set(await listFiles(to));
  const paths = [...new Set([...fromFiles, ...toFiles])].sort();

  const files: FileDiff[] = [];
  for (const rel of paths) {
    if (fromFiles.has(rel) && !toFiles.has(rel)) {
      files.push({ path: rel, status: "removed", additions: 0, deletions: 0, binary: false });
      continue;
    }
    if (!fromFiles.has(rel) && toFiles.has(rel)) {
      files.push({ path: rel, status: "added", additions: 0, deletions: 0, binary: false });
      continue;
    }
    const fromBytes = await fs.readFile(path.join(from, rel));
    const toBytes = await fs.readFile(path.join(to, rel));
    if (fromBytes.equals(toBytes)) {
      files.push({ path: rel, status: "unchanged", additions: 0, deletions: 0, binary: false });
      continue;
    }
    if (isBinary(fromBytes) || isBinary(toBytes)) {
      files.push({ path: rel, status: "changed", additions: 0, deletions: 0, binary: true });
      continue;
    }
    const counts = diffLines(
      fromBytes.toString("utf8").split("\n"),
      toBytes.toString("utf8").split("\n"),
    );
    files.push({ path: rel, status: "changed", ...counts, binary: false });
  }

  return {
    files,
    added: files.filter((file) => file.status === "added").length,
    removed: files.filter((file) => file.status === "removed").length,
    changed: files.filter((file) => file.status === "changed").length,
  };
}
