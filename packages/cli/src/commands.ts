import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  HARNESSES,
  type Harness,
  createPackTarball,
  extractPackTarball,
  readPack,
  resolveSkillsDir,
} from "@agentshare/core";
import { RegistryClient } from "./client.js";
import { configPath, loadConfig, maskToken, resolveRegistry, resolveToken, saveConfig } from "./config.js";

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

export async function packCommand(dir: string, options: { out?: string }): Promise<void> {
  const pack = await readPack(dir);
  const out = path.resolve(options.out ?? `${pack.manifest.name}-${pack.manifest.version}.tgz`);
  const result = await createPackTarball(pack.dir, out);
  console.log(`packed  ${pack.manifest.name}@${pack.manifest.version}`);
  console.log(`file    ${result.file}`);
  console.log(`sha256  ${result.digest}`);
  console.log(`size    ${result.size} bytes`);
}

export async function pushCommand(
  dir: string,
  options: { registry?: string; token?: string; dryRun?: boolean },
): Promise<void> {
  const config = loadConfig();
  const registry = resolveRegistry(config, options.registry);
  const token = resolveToken(config, options.token);
  const pack = await readPack(dir);

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

export async function installCommand(
  ref: string,
  options: {
    target?: string;
    project?: boolean;
    dir?: string;
    force?: boolean;
    registry?: string;
    token?: string;
  },
): Promise<void> {
  const config = loadConfig();
  const client = new RegistryClient(
    resolveRegistry(config, options.registry),
    resolveToken(config, options.token),
  );
  const { owner, name, version } = parseRef(ref);
  const detail = await client.info(owner, name, version);
  const bytes = await client.downloadBytes(owner, name, detail.version);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "agentshare-install-"));
  try {
    const tarball = path.join(tmp, "pack.tgz");
    await fsp.writeFile(tarball, bytes);
    const extracted = path.join(tmp, "pack");
    await extractPackTarball(tarball, extracted);

    const roots = detail.manifest.skills.length > 0 ? detail.manifest.skills : ["."];
    const targets = resolveTargets(options.target);
    const installed: string[] = [];

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
          console.log(`skip    ${dest} (exists, use --force)`);
          continue;
        }
        await fsp.rm(dest, { recursive: true, force: true });
        await fsp.mkdir(baseDir, { recursive: true });
        await fsp.cp(source, dest, { recursive: true });
        installed.push(dest);
      }
    }

    console.log(`install ${owner}/${name}@${detail.version} (mode: ${detail.manifest.mode})`);
    for (const dir of installed) console.log(`  -> ${dir}`);
    if (detail.manifest.mode === "endpoint" && detail.manifest.endpoint) {
      console.log(`online  ${detail.manifest.endpoint.type} ${detail.manifest.endpoint.url}`);
    }
    if (detail.manifest.secrets.length > 0) {
      console.log(`secrets ${detail.manifest.secrets.join(", ")}`);
    }
    if (installed.length === 0) {
      console.log("nothing installed");
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}
