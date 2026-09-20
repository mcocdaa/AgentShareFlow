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
