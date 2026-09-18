import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Harness } from "./manifest.js";

export const LOCKFILE_SPEC = "agentshare-lock/v0";

export const LOCKFILE_FILENAME = "agentshare.lock.json";

export const LockEntrySchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  digest: z.string().min(1),
  mode: z.string().min(1),
  target: z.string().min(1),
  scope: z.enum(["user", "project", "dir"]),
  dest: z.string().min(1),
  registry: z.string().min(1).optional(),
  installedAt: z.string().min(1),
});
export type LockEntry = z.infer<typeof LockEntrySchema>;

export const LockfileSchema = z.object({
  spec: z.literal(LOCKFILE_SPEC),
  installs: z.array(LockEntrySchema).default([]),
});
export type Lockfile = z.infer<typeof LockfileSchema>;

export function parseLockfile(input: unknown): Lockfile {
  return LockfileSchema.parse(input);
}

export function formatLockfileIssues(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export function emptyLockfile(): Lockfile {
  return { spec: LOCKFILE_SPEC, installs: [] };
}

export interface InstallRecordInput {
  owner: string;
  name: string;
  version: string;
  digest: string;
  mode: string;
  target: Harness | string;
  scope: "user" | "project" | "dir";
  dest: string;
  registry?: string;
  installedAt: string;
}

export function upsertInstall(lock: Lockfile, entry: InstallRecordInput): Lockfile {
  const installs = lock.installs.filter(
    (item) => !(item.owner === entry.owner && item.name === entry.name && item.dest === entry.dest),
  );
  installs.push(entry);
  return { spec: LOCKFILE_SPEC, installs };
}

export async function readLockfile(file: string): Promise<Lockfile> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLockfile();
    throw error;
  }
  return parseLockfile(JSON.parse(raw));
}

export async function writeLockfile(file: string, lock: Lockfile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}
