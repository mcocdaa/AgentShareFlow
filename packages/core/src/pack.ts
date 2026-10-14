import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import * as tar from "tar";
import { type AgentManifest, formatIssues, isSafeRelativePath, parseManifest } from "./manifest.js";

export const MANIFEST_FILENAME = "agent.json";
export const MAX_DECOMPRESSED_TAR_BYTES = 50 * 1024 * 1024;

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
    if (!isSafeRelativePath(rel)) {
      throw new Error(`manifest references unsafe path: ${rel}`);
    }
    const target = rel === "." ? resolved : path.resolve(resolved, rel);
    if (target !== resolved && !target.startsWith(`${resolved}${path.sep}`)) {
      throw new Error(`manifest references path outside pack directory: ${rel}`);
    }
    if (!fs.existsSync(target)) {
      throw new Error(`manifest references missing path: ${rel}`);
    }
  }
  if (manifest.mcp) {
    if (!isSafeRelativePath(manifest.mcp.config)) {
      throw new Error(`manifest references unsafe mcp config: ${manifest.mcp.config}`);
    }
    const mcpTarget = path.resolve(resolved, manifest.mcp.config);
    if (!mcpTarget.startsWith(`${resolved}${path.sep}`)) {
      throw new Error(`manifest references mcp config outside pack directory: ${manifest.mcp.config}`);
    }
    if (!fs.existsSync(mcpTarget)) {
      throw new Error(`manifest references missing mcp config: ${manifest.mcp.config}`);
    }
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

function readTarString(bytes: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = start + length;
  while (end < limit && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(start, end));
}

function readTarOctal(bytes: Uint8Array, start: number, length: number): number {
  const text = readTarString(bytes, start, length).trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

function readTarEntryName(header: Uint8Array): string {
  const rawName = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  const combined = prefix ? `${prefix}/${rawName}` : rawName;
  return combined.replace(/^\.\//, "");
}

export function readTarEntry(tarBytes: Uint8Array, name: string): Uint8Array | undefined {
  const normalizedTarget = name.replace(/^\.\//, "");
  for (let offset = 0; offset + 512 <= tarBytes.length; ) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const entryName = readTarEntryName(header);
    const size = readTarOctal(header, 124, 12);
    const type = header[156] ?? 0;
    const dataStart = offset + 512;
    if (!Number.isFinite(size) || size < 0 || dataStart + size > tarBytes.length) break;
    if ((type === 48 || type === 0) && entryName === normalizedTarget) {
      return tarBytes.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

export function readPackReadme(tarballBytes: Uint8Array): string | null {
  let tarData: Uint8Array;
  try {
    tarData = gunzipSync(tarballBytes, { maxOutputLength: 50 * 1024 * 1024 });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE"
    ) {
      throw err;
    }
    tarData = tarballBytes;
  }
  const candidates = ["SKILL.md", "README.md", "skill.md", "readme.md"];
  for (const candidate of candidates) {
    const entry = readTarEntry(tarData, candidate);
    if (entry !== undefined) {
      return new TextDecoder().decode(entry);
    }
  }
  for (let offset = 0; offset + 512 <= tarData.length; ) {
    const header = tarData.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const entryName = readTarEntryName(header);
    const size = readTarOctal(header, 124, 12);
    const type = header[156] ?? 0;
    const dataStart = offset + 512;
    if (!Number.isFinite(size) || size < 0 || dataStart + size > tarData.length) break;
    if (
      (type === 48 || type === 0) &&
      (entryName.endsWith("/SKILL.md") || entryName.endsWith("/README.md"))
    ) {
      const entry = tarData.subarray(dataStart, dataStart + size);
      return new TextDecoder().decode(entry);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

