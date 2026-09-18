import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  HARNESSES,
  LOCKFILE_FILENAME,
  ShareClient,
  type Harness,
  previewHandoffImport,
  importHandoff,
  createPackTarball,
  diffPackDirs,
  extractPackTarball,
  formatScanFinding,
  readLockfile,
  readPack,
  resolveSkillsDir,
  scanPack,
  summarizeScan,
  upsertInstall,
  writeLockfile,
  type LockEntry,
  type ScanReport,
} from "@agentshare/core";
import { RegistryClient } from "./client.js";
import { configPath, loadConfig, maskToken, resolveRegistry, resolveToken, saveConfig } from "./config.js";

export async function handoffImportCommand(
  file: string,
  options: { target?: string; dir?: string; confirm?: string; json?: boolean },
): Promise<void> {
  if ((options.target ?? "codex") !== "codex") throw new Error("handoff import currently supports only codex");
  const handle = await fsp.open(path.resolve(file), "r");
  let input: unknown;
  try {
    if (!(await handle.stat()).isFile()) throw new Error("handoff must be a regular JSON file");
    const bytes = Buffer.alloc(256 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 256 * 1024) throw new Error("handoff exceeds 256 KiB");
    input = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
  const dir = options.dir ?? process.cwd();
  const preview = await previewHandoffImport(input, dir);
  if (options.confirm === undefined) {
    if (options.json) {
      console.log(JSON.stringify({ status: "preview", ...preview }, null, 2));
    } else {
      console.log(preview.markdown);
      for (const warning of preview.warnings) console.log(`warning: ${warning}`);
      console.log(`destination  ${preview.destination} (new independent subdirectory)`);
      console.log(`confirm      rerun with the same arguments and --confirm ${preview.digest}`);
    }
    return;
  }
  const written = await importHandoff(input, { dir, confirm: options.confirm });
  if (options.json) {
    console.log(JSON.stringify({ status: "imported", ...written }, null, 2));
  } else {
    console.log(`imported  ${written.jsonPath}`);
    console.log(`context   ${written.markdownPath}`);
    console.log(`next      ask Codex in your project to read ${written.promptPath}`);
  }
}

function shareClient(options: { registry?: string; token?: string }): ShareClient {
  const config = loadConfig();
  return new ShareClient({
    registry: resolveRegistry(config, options.registry),
    token: resolveToken(config, options.token),
  });
}

export async function shareSubmissionsCommand(
  shareId: string,
  options: { registry?: string; token?: string; json?: boolean },
): Promise<void> {
  const { items } = await shareClient(options).listSubmissions(shareId);
  if (options.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log(`no submissions for share ${shareId}`);
    return;
  }
  for (const item of items) {
    console.log(
      `#${item.id}  [${item.status}]  ${item.createdAt}${item.authorName === undefined ? "" : `  ${item.authorName}`}`,
    );
    console.log(`  ${item.summary}`);
    for (const change of item.changes) console.log(`  - ${change}`);
    for (const question of item.openQuestions) console.log(`  ? ${question}`);
    if (item.ownerNote !== undefined) console.log(`  note: ${item.ownerNote}`);
  }
}

export async function shareDecideCommand(
  shareId: string,
  submissionId: string,
  options: {
    accept?: boolean;
    reject?: boolean;
    note?: string;
    registry?: string;
    token?: string;
    json?: boolean;
  },
): Promise<void> {
  if (options.accept === options.reject) {
    throw new Error("pass exactly one of --accept or --reject");
  }
  const id = Number(submissionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("submissionId must be a positive integer");
  const submission = await shareClient(options).decideSubmission(
    shareId,
    id,
    options.accept ? "accepted" : "rejected",
    options.note,
  );
  if (options.json) {
    console.log(JSON.stringify(submission, null, 2));
    return;
  }
  console.log(
    `#${submission.id}  ${submission.status}${submission.ownerNote === undefined ? "" : ` — ${submission.ownerNote}`}`,
  );
}

export interface RefParts {
  owner: string;
  name: string;
  version?: string;
}

export function parseRef(ref: string): RefParts {
  const [pathPart, version] = ref.split("@");
  const [owner, name] = (pathPart ?? "").split("/");
  if (!owner || !name) throw new Error(`invalid ref "${ref}", expected owner/name[@version]`);
  return { owner, name, version };
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}

function resolveTargets(input?: string): Harness[] {
  if (!input || input === "agents") return ["agents"];
  if (input === "all") return [...HARNESSES];
  const parts = input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (!(HARNESSES as readonly string[]).includes(part)) {
      throw new Error(`unknown target "${part}", supported: ${HARNESSES.join(", ")}, all`);
    }
  }
  return parts as Harness[];
}

export async function loginCommand(options: {
  registry?: string;
  token?: string;
  owner?: string;
}): Promise<void> {
  const config = loadConfig();
  let token = options.token ?? process.env.AGENTSHARE_TOKEN;
  if (!token && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    token = (await rl.question("Token: ")).trim();
    rl.close();
  }
  if (!token) throw new Error("token is required, pass --token or set AGENTSHARE_TOKEN");

  const next = {
    ...config,
    token,
    registry: options.registry ?? config.registry,
    owner: options.owner ?? config.owner,
  };
  const file = saveConfig(next);
  console.log(`saved   ${file}`);
  console.log(`registry ${next.registry ?? "(unset)"}`);
  console.log(`owner    ${next.owner ?? "(assigned by registry on publish)"}`);
}

export function whoamiCommand(): void {
  const config = loadConfig();
  console.log(`config   ${configPath()}`);
  console.log(`registry ${config.registry ?? "(unset)"}`);
  console.log(`owner    ${config.owner ?? "(unset)"}`);
  console.log(`token    ${config.token ? maskToken(config.token) : "(unset)"}`);
}

async function scanOrReport(dir: string, allowRisky: boolean, action: string): Promise<void> {
  const report = await scanPack(dir);
  if (report.findings.length === 0) return;
  for (const finding of report.findings) console.log(`scan    ${formatScanFinding(finding)}`);
  console.log(`scan    ${summarizeScan(report)}`);
  if (report.blocked && !allowRisky) {
    throw new Error(
      `${action} blocked by the security scan (high severity); review the findings or pass --allow-risky`,
    );
  }
}

export async function packCommand(dir: string, options: { out?: string }): Promise<void> {
  const pack = await readPack(dir);
  await scanOrReport(pack.dir, true, "pack");
  const out = path.resolve(options.out ?? `${pack.manifest.name}-${pack.manifest.version}.tgz`);
  const result = await createPackTarball(pack.dir, out);
  console.log(`packed  ${pack.manifest.name}@${pack.manifest.version}`);
  console.log(`file    ${result.file}`);
  console.log(`sha256  ${result.digest}`);
  console.log(`size    ${result.size} bytes`);
}

export async function pushCommand(
  dir: string,
  options: { registry?: string; token?: string; dryRun?: boolean; allowRisky?: boolean },
): Promise<void> {
  const config = loadConfig();
  const registry = resolveRegistry(config, options.registry);
  const token = resolveToken(config, options.token);
  const pack = await readPack(dir);
  await scanOrReport(pack.dir, options.allowRisky === true, "publish");

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "agentshare-push-"));
  try {
    const file = path.join(tmp, `${pack.manifest.name}-${pack.manifest.version}.tgz`);
    const result = await createPackTarball(pack.dir, file);
    console.log(`pack    ${pack.manifest.name}@${pack.manifest.version} (${pack.manifest.mode})`);
    console.log(`sha256  ${result.digest}`);

    if (options.dryRun) {
      console.log("dry-run ok, nothing uploaded");
      return;
    }
    if (!token) throw new Error("not logged in, run `agentshare login` or pass --token");

    const bytes = await fsp.readFile(file);
    const client = new RegistryClient(registry, token);
    const published = await client.publish(pack.manifest, bytes, result.digest);
    console.log(`pushed  ${published.ref}`);
    console.log(`to      ${registry}`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

interface UpdateResult {
  file: string;
  owner: string;
  name: string;
  from: string;
  to: string;
  dest: string;
  status: "updated" | "planned" | "up-to-date";
}

export async function updateCommand(
  ref: string | undefined,
  options: {
    registry?: string;
    token?: string;
    dryRun?: boolean;
    allowRisky?: boolean;
    json?: boolean;
  },
): Promise<void> {
  const config = loadConfig();
  const registry = resolveRegistry(config, options.registry);
  const client = new RegistryClient(registry, resolveToken(config, options.token));
  const filter = ref === undefined ? undefined : parseRef(ref);
  const files = [
    path.join(process.cwd(), LOCKFILE_FILENAME),
    path.join(path.dirname(configPath()), LOCKFILE_FILENAME),
  ];
  const results: UpdateResult[] = [];

  for (const file of files) {
    const lock = await readLockfile(file);
    if (lock.installs.length === 0) continue;
    let next = lock;
    let dirty = false;
    for (const entry of lock.installs) {
      if (filter !== undefined && (entry.owner !== filter.owner || entry.name !== filter.name)) continue;
      const detail = await client.info(entry.owner, entry.name, filter?.version);
      if (detail.version === entry.version) {
        results.push({ ...snapshot(entry), file, to: detail.version, status: "up-to-date" });
        continue;
      }
      if (options.dryRun) {
        results.push({ ...snapshot(entry), file, to: detail.version, status: "planned" });
        continue;
      }
      const bytes = await client.downloadBytes(entry.owner, entry.name, detail.version);
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "agentshare-update-"));
      try {
        const tarball = path.join(tmp, "pack.tgz");
        await fsp.writeFile(tarball, bytes);
        const extracted = path.join(tmp, "pack");
        await extractPackTarball(tarball, extracted);
        await scanOrReport(extracted, options.allowRisky === true, "update");
        const roots = detail.manifest.skills.length > 0 ? detail.manifest.skills : ["."];
        const wanted = path.basename(entry.dest);
        const rel = roots.find((root) =>
          (root === "." ? detail.manifest.name : path.basename(root)) === wanted,
        );
        if (rel === undefined) throw new Error(`${entry.owner}/${entry.name} no longer provides ${wanted}`);
        const source = rel === "." ? extracted : path.join(extracted, rel);
        await fsp.rm(entry.dest, { recursive: true, force: true });
        await fsp.mkdir(path.dirname(entry.dest), { recursive: true });
        await fsp.cp(source, entry.dest, { recursive: true });
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
      next = upsertInstall(next, {
        ...entry,
        version: detail.version,
        digest: detail.digest,
        mode: detail.manifest.mode,
        registry,
        installedAt: new Date().toISOString(),
      });
      dirty = true;
      results.push({ ...snapshot(entry), file, to: detail.version, status: "updated" });
    }
    if (dirty) await writeLockfile(file, next);
  }

  if (options.json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log("nothing to update (no matching lockfile entries)");
    return;
  }
  for (const item of results) {
    switch (item.status) {
      case "up-to-date":
        console.log(`ok      ${item.owner}/${item.name}@${item.from}`);
        break;
      case "planned":
        console.log(`plan    ${item.owner}/${item.name}  ${item.from} -> ${item.to}  ${item.dest}`);
        break;
      case "updated":
        console.log(`update  ${item.owner}/${item.name}  ${item.from} -> ${item.to}  ${item.dest}`);
        break;
    }
  }
  if (options.dryRun) console.log("dry-run: nothing changed");
}

function snapshot(entry: LockEntry): Omit<UpdateResult, "file" | "to" | "status"> {
  return {
    owner: entry.owner,
    name: entry.name,
    from: entry.version,
    dest: entry.dest,
  };
}

export async function starCommand(
  ref: string,
  options: { unstar?: boolean; registry?: string; token?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const token = resolveToken(config, options.token);
  if (!token) throw new Error("starring requires login, run `agentshare login` or pass --token");
  const client = new RegistryClient(resolveRegistry(config, options.registry), token);
  const { owner, name } = parseRef(ref);
  const result = await client.setStar(owner, name, options.unstar !== true);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.starred ? "starred  " : "unstarred"} ${owner}/${name}  stars: ${result.stars}`);
}

export async function diffCommand(
  fromRef: string,
  toRef: string,
  options: { registry?: string; token?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const client = new RegistryClient(resolveRegistry(config, options.registry), resolveToken(config, options.token));
  const from = parseRef(fromRef);
  const to = parseRef(toRef);
  const fromDetail = await client.info(from.owner, from.name, from.version);
  const toDetail = await client.info(to.owner, to.name, to.version);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "agentshare-diff-"));
  try {
    const download = async (prefix: string, detail: typeof fromDetail): Promise<string> => {
      const bytes = await client.downloadBytes(detail.owner, detail.name, detail.version);
      const tarball = path.join(tmp, `${prefix}.tgz`);
      await fsp.writeFile(tarball, bytes);
      const dir = path.join(tmp, prefix);
      await extractPackTarball(tarball, dir);
      return dir;
    };
    const fromDir = await download("from", fromDetail);
    const toDir = await download("to", toDetail);
    const diff = await diffPackDirs(fromDir, toDir);
    const fromLabel = `${fromDetail.owner}/${fromDetail.name}@${fromDetail.version}`;
    const toLabel = `${toDetail.owner}/${toDetail.name}@${toDetail.version}`;

    if (options.json) {
      console.log(JSON.stringify({ from: fromLabel, to: toLabel, diff }, null, 2));
      return;
    }
    console.log(`${fromLabel} -> ${toLabel}`);
    const changed = diff.files.filter((file) => file.status !== "unchanged");
    if (changed.length === 0) {
      console.log("no changes");
      return;
    }
    for (const file of changed) {
      const tag = file.status === "added" ? "A" : file.status === "removed" ? "D" : "M";
      const counts = file.binary ? "binary" : `+${file.additions} -${file.deletions}`;
      console.log(`${tag}  ${file.path}  ${counts}`);
    }
    console.log(`${diff.added} added, ${diff.removed} removed, ${diff.changed} changed`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

export async function searchCommand(
  query: string,
  options: { registry?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const client = new RegistryClient(resolveRegistry(config, options.registry), resolveToken(config));
  const { items } = await client.search(query);
  if (options.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log(`no packs found for "${query}"`);
    return;
  }
  for (const item of items) {
    console.log(`${item.owner}/${item.name}@${item.version}  [${item.mode}]  downloads:${item.downloads}`);
    console.log(`  ${item.title} — ${truncate(item.description, 100)}`);
  }
}

export async function infoCommand(
  ref: string,
  options: { registry?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const client = new RegistryClient(resolveRegistry(config, options.registry), resolveToken(config));
  const { owner, name, version } = parseRef(ref);
  const detail = await client.info(owner, name, version);
  if (options.json) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }
  const manifest = detail.manifest;
  console.log(`${detail.owner}/${detail.name}@${detail.version}  [${detail.mode}]`);
  console.log(`title       ${detail.title}`);
  console.log(`description ${detail.description}`);
  console.log(`downloads   ${detail.downloads}`);
  console.log(`stars       ${detail.stars}${detail.starred === true ? " (starred by you)" : ""}`);
  console.log(`versions    ${detail.versions.join(", ")}`);
  console.log(`license     ${manifest.license ?? "(unset)"}`);
  console.log(`targets     ${manifest.compatibility.join(", ")}`);
  if (manifest.tags.length) console.log(`tags        ${manifest.tags.join(", ")}`);
  if (manifest.endpoint) {
    console.log(`endpoint    ${manifest.endpoint.type} ${manifest.endpoint.url}`);
  }
  if (manifest.runtime) {
    console.log(`runtime     ${manifest.runtime.image ?? manifest.runtime.dockerfile} (${manifest.runtime.protocol})`);
  }
  if (manifest.secrets.length) console.log(`secrets     ${manifest.secrets.join(", ")}`);
  console.log(`install     agentshare install ${owner}/${name}@${detail.version} --target agents`);
}

export interface InstallOptions {
  target?: string;
  project?: boolean;
  dir?: string;
  force?: boolean;
  allowRisky?: boolean;
}

export interface InstallOutcome {
  owner: string;
  name: string;
  version: string;
  mode: string;
  installed: Array<{ target: Harness; dest: string }>;
  skipped: string[];
  scan: ScanReport;
  lockfile?: string;
  endpoint?: { type: string; url: string };
  secrets: string[];
}

export async function installPack(
  client: RegistryClient,
  registry: string,
  ref: string,
  options: InstallOptions,
): Promise<InstallOutcome> {
  const { owner, name, version } = parseRef(ref);
  const detail = await client.info(owner, name, version);
  const bytes = await client.downloadBytes(owner, name, detail.version);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "agentshare-install-"));
  try {
    const tarball = path.join(tmp, "pack.tgz");
    await fsp.writeFile(tarball, bytes);
    const extracted = path.join(tmp, "pack");
    await extractPackTarball(tarball, extracted);

    const scan = await scanPack(extracted);
    if (scan.blocked && options.allowRisky !== true) {
      const highlights = scan.findings
        .filter((finding) => finding.severity === "high")
        .map(formatScanFinding)
        .join("\n");
      throw new Error(
        `install blocked by the security scan (high severity):\n${highlights}\nreview the findings or pass --allow-risky`,
      );
    }

    const roots = detail.manifest.skills.length > 0 ? detail.manifest.skills : ["."];
    const targets = resolveTargets(options.target);
    const installed: Array<{ target: Harness; dest: string }> = [];
    const skipped: string[] = [];

    for (const harness of targets) {
      const baseDir = options.dir
        ? path.resolve(options.dir)
        : resolveSkillsDir(harness, { project: options.project });
      for (const rel of roots) {
        const source = rel === "." ? extracted : path.join(extracted, rel);
        if (!fs.existsSync(source)) throw new Error(`pack does not contain skill path: ${rel}`);
        const skillName = rel === "." ? detail.manifest.name : path.basename(rel);
        const dest = path.join(baseDir, skillName);
        if (fs.existsSync(dest) && !options.force) {
          skipped.push(dest);
          continue;
        }
        await fsp.rm(dest, { recursive: true, force: true });
        await fsp.mkdir(baseDir, { recursive: true });
        await fsp.cp(source, dest, { recursive: true });
        installed.push({ target: harness, dest });
      }
    }

    let lockfile: string | undefined;
    if (installed.length > 0) {
      lockfile = options.project
        ? path.join(process.cwd(), LOCKFILE_FILENAME)
        : path.join(path.dirname(configPath()), LOCKFILE_FILENAME);
      const scope = options.project ? "project" : options.dir ? "dir" : "user";
      let lock = await readLockfile(lockfile);
      for (const item of installed) {
        lock = upsertInstall(lock, {
          owner,
          name,
          version: detail.version,
          digest: detail.digest,
          mode: detail.manifest.mode,
          target: item.target,
          scope,
          dest: item.dest,
          registry,
          installedAt: new Date().toISOString(),
        });
      }
      await writeLockfile(lockfile, lock);
    }

    return {
      owner,
      name,
      version: detail.version,
      mode: detail.manifest.mode,
      installed,
      skipped,
      scan,
      ...lockfile === undefined ? {} : { lockfile },
      ...detail.manifest.endpoint === undefined ? {} : { endpoint: detail.manifest.endpoint },
      secrets: detail.manifest.secrets,
    };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

export async function installCommand(
  ref: string,
  options: InstallOptions & { registry?: string; token?: string },
): Promise<void> {
  const config = loadConfig();
  const registry = resolveRegistry(config, options.registry);
  const client = new RegistryClient(registry, resolveToken(config, options.token));
  const result = await installPack(client, registry, ref, options);

  for (const finding of result.scan.findings) console.log(`scan    ${formatScanFinding(finding)}`);
  if (result.scan.findings.length > 0) console.log(`scan    ${summarizeScan(result.scan)}`);
  for (const dest of result.skipped) console.log(`skip    ${dest} (exists, use --force)`);
  if (result.lockfile !== undefined) console.log(`record  ${result.lockfile}`);
  console.log(`install ${result.owner}/${result.name}@${result.version} (mode: ${result.mode})`);
  for (const item of result.installed) console.log(`  -> ${item.dest}`);
  if (result.endpoint) console.log(`online  ${result.endpoint.type} ${result.endpoint.url}`);
  if (result.secrets.length > 0) console.log(`secrets ${result.secrets.join(", ")}`);
  if (result.installed.length === 0) console.log("nothing installed");
}
