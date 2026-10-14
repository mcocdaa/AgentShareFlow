import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { type Lockfile, type LockEntry } from "./lockfile.js";
import { collectDirectoryFiles } from "./ingest.js";
import { type Harness, HARNESSES } from "./manifest.js";
import { resolveSkillsDir } from "./harness.js";

export type SyncStatus = "synced" | "missing" | "drifted" | "orphaned";

export interface SyncEntryReport {
  owner: string;
  name: string;
  version: string;
  target: string;
  scope: string;
  dest: string;
  status: SyncStatus;
  fileCount: number;
  reason?: string;
}

export interface OrphanedSkill {
  target: string;
  dest: string;
  name: string;
}

export interface SyncReport {
  lockfile?: string;
  total: number;
  synced: number;
  missing: number;
  drifted: number;
  orphaned: number;
  entries: SyncEntryReport[];
  orphans: OrphanedSkill[];
}

export interface SyncCheckOptions {
  lockfilePath?: string;
  targetHarness?: Harness;
  scope?: "user" | "project" | "dir";
  checkOrphans?: boolean;
  cwd?: string;
}

export async function computeSkillFileHashes(dir: string): Promise<Map<string, string>> {
  const files = await collectDirectoryFiles(dir);
  const fileHashes = new Map<string, string>();
  for (const rel of files) {
    const normalized = rel.split(path.sep).join("/");
    const content = await fsp.readFile(path.join(dir, rel));
    const digest = createHash("sha256").update(content).digest("hex");
    fileHashes.set(normalized, digest);
  }
  return fileHashes;
}

export async function computeSkillDirectoryHash(dir: string): Promise<string> {
  const fileHashes = await computeSkillFileHashes(dir);
  const overall = createHash("sha256");
  for (const [rel, fileDigest] of fileHashes.entries()) {
    overall.update(`${rel}:${fileDigest}\n`);
  }
  return overall.digest("hex");
}

function hashesEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, val] of a.entries()) {
    if (b.get(key) !== val) return false;
  }
  return true;
}

function resolveSourceAgentsSkillDir(
  item: LockEntry,
  dest: string,
  lock: Lockfile,
  options: SyncCheckOptions,
): string | null {
  const skillFolderName = path.basename(dest);

  // 1. Check if lockfile has a canonical "agents" install entry for the same pack
  const agentsEntry = lock.installs.find(
    (entry) =>
      entry.target === "agents" &&
      entry.owner === item.owner &&
      entry.name === item.name &&
      entry.scope === item.scope,
  );
  if (agentsEntry) {
    const resolvedAgents = path.resolve(agentsEntry.dest);
    if (resolvedAgents !== dest && fs.existsSync(resolvedAgents) && fs.statSync(resolvedAgents).isDirectory()) {
      return resolvedAgents;
    }
  }

  // 2. Check standard .agents/skills/<skillFolderName> via resolveSkillsDir or relative workspace layout
  const candidates = [
    path.join(
      resolveSkillsDir("agents", {
        project: item.scope === "project",
        cwd: options.cwd,
      }),
      skillFolderName,
    ),
    ...(options.cwd ? [path.resolve(options.cwd, ".agents", "skills", skillFolderName)] : []),
    path.resolve(dest, "..", "..", "..", ".agents", "skills", skillFolderName),
    path.resolve(dest, "..", "..", ".agents", "skills", skillFolderName),
  ];

  for (const candidate of candidates) {
    const resolvedCandidate = path.resolve(candidate);
    if (
      resolvedCandidate !== dest &&
      fs.existsSync(resolvedCandidate) &&
      fs.statSync(resolvedCandidate).isDirectory()
    ) {
      return resolvedCandidate;
    }
  }

  return null;
}

/**
 * Checks the synchronization state between the lockfile and the local filesystem across harnesses.
 */
export async function checkSyncStatus(
  lock: Lockfile,
  options: SyncCheckOptions = {},
): Promise<SyncReport> {
  const entries: SyncEntryReport[] = [];
  let synced = 0;
  let missing = 0;
  let drifted = 0;

  for (const item of lock.installs) {
    if (options.targetHarness && item.target !== options.targetHarness) continue;
    if (options.scope && item.scope !== options.scope) continue;

    const dest = path.resolve(item.dest);
    if (!fs.existsSync(dest)) {
      entries.push({
        owner: item.owner,
        name: item.name,
        version: item.version,
        target: item.target,
        scope: item.scope,
        dest: item.dest,
        status: "missing",
        fileCount: 0,
        reason: "Destination directory does not exist",
      });
      missing++;
      continue;
    }

    const stat = await fsp.stat(dest);
    if (!stat.isDirectory()) {
      entries.push({
        owner: item.owner,
        name: item.name,
        version: item.version,
        target: item.target,
        scope: item.scope,
        dest: item.dest,
        status: "drifted",
        fileCount: 0,
        reason: "Destination exists but is not a directory",
      });
      drifted++;
      continue;
    }

    const files = await collectDirectoryFiles(dest);
    if (files.length === 0) {
      entries.push({
        owner: item.owner,
        name: item.name,
        version: item.version,
        target: item.target,
        scope: item.scope,
        dest: item.dest,
        status: "missing",
        fileCount: 0,
        reason: "Destination directory exists but is completely empty",
      });
      missing++;
      continue;
    }

    const hasSkillMd = files.some((f) => f.toLowerCase() === "skill.md" || f.toLowerCase().endsWith("/skill.md"));
    if (!hasSkillMd) {
      entries.push({
        owner: item.owner,
        name: item.name,
        version: item.version,
        target: item.target,
        scope: item.scope,
        dest: item.dest,
        status: "drifted",
        fileCount: files.length,
        reason: "Directory does not contain a SKILL.md file",
      });
      drifted++;
      continue;
    }

    // Compute real SHA-256 hashes of skill files in destination
    const destHashes = await computeSkillFileHashes(dest);
    const destDirHash = await computeSkillDirectoryHash(dest);

    // Compare against source .agents/skills directory if available
    const sourceAgentsDir = resolveSourceAgentsSkillDir(item, dest, lock, options);
    if (sourceAgentsDir !== null) {
      const sourceHashes = await computeSkillFileHashes(sourceAgentsDir);
      if (!hashesEqual(sourceHashes, destHashes)) {
        entries.push({
          owner: item.owner,
          name: item.name,
          version: item.version,
          target: item.target,
          scope: item.scope,
          dest: item.dest,
          status: "drifted",
          fileCount: files.length,
          reason: `Skill files drifted from source .agents/skills (SHA-256 hash mismatch)`,
        });
        drifted++;
        continue;
      }
    } else if (/^[0-9a-f]{64}$/i.test(item.digest)) {
      const expectedDigest = item.digest.toLowerCase();
      const matchesDirHash = expectedDigest === destDirHash;
      const matchesAnyFileHash = [...destHashes.values()].includes(expectedDigest);
      if (!matchesDirHash && !matchesAnyFileHash) {
        entries.push({
          owner: item.owner,
          name: item.name,
          version: item.version,
          target: item.target,
          scope: item.scope,
          dest: item.dest,
          status: "drifted",
          fileCount: files.length,
          reason: `Skill files modified from recorded SHA-256 digest`,
        });
        drifted++;
        continue;
      }
    }

    entries.push({
      owner: item.owner,
      name: item.name,
      version: item.version,
      target: item.target,
      scope: item.scope,
      dest: item.dest,
      status: "synced",
      fileCount: files.length,
    });
    synced++;
  }

  const orphans: OrphanedSkill[] = [];
  if (options.checkOrphans) {
    const harnessesToCheck = options.targetHarness ? [options.targetHarness] : [...HARNESSES];
    const knownDests = new Set(lock.installs.map((i) => path.resolve(i.dest)));

    for (const h of harnessesToCheck) {
      const skillsDir = resolveSkillsDir(h, {
        project: options.scope === "project",
        cwd: options.cwd,
      });
      if (fs.existsSync(skillsDir)) {
        const subdirs = await fsp.readdir(skillsDir, { withFileTypes: true });
        for (const sub of subdirs) {
          if (!sub.isDirectory()) continue;
          const fullDest = path.join(skillsDir, sub.name);
          if (!knownDests.has(fullDest)) {
            orphans.push({
              target: h,
              dest: fullDest,
              name: sub.name,
            });
          }
        }
      }
    }
  }

  return {
    ...(options.lockfilePath ? { lockfile: options.lockfilePath } : {}),
    total: entries.length,
    synced,
    missing,
    drifted,
    orphaned: orphans.length,
    entries,
    orphans,
  };
}

export function formatSyncReport(report: SyncReport): string {
  const lines: string[] = [];
  lines.push("╔══════════════════════════════════════════════════════════════════════════════════╗");
  lines.push("║                         AgentShareFlow Sync Status Report                        ║");
  lines.push("╚══════════════════════════════════════════════════════════════════════════════════╝");
  if (report.lockfile) {
    lines.push(`Lockfile: ${report.lockfile}`);
  }
  lines.push(`Total tracked: ${report.total} | Synced: ${report.synced} | Missing: ${report.missing} | Drifted: ${report.drifted}`);
  if (report.orphaned > 0) {
    lines.push(`Untracked/Orphaned: ${report.orphaned}`);
  }
  lines.push("────────────────────────────────────────────────────────────────────────────────────");

  for (const entry of report.entries) {
    let icon = "✓";
    if (entry.status === "missing") icon = "✗";
    else if (entry.status === "drifted") icon = "⚠";

    const statusBadge = `[${entry.status.toUpperCase()}]`.padEnd(10);
    const targetInfo = `[${entry.target}:${entry.scope}]`.padEnd(16);
    lines.push(`${icon} ${statusBadge} ${targetInfo} ${entry.owner}/${entry.name}@${entry.version}`);
    lines.push(`   └─ Path: ${entry.dest} (${entry.fileCount} files)`);
    if (entry.reason) {
      lines.push(`   └─ Alert: ${entry.reason}`);
    }
  }

  if (report.orphans.length > 0) {
    lines.push("────────────────────────────────────────────────────────────────────────────────────");
    lines.push("Orphaned Skills (installed on system but not registered in lockfile):");
    for (const orphan of report.orphans) {
      lines.push(` ? [${orphan.target}] ${orphan.name} -> ${orphan.dest}`);
    }
  }

  return lines.join("\n");
}
