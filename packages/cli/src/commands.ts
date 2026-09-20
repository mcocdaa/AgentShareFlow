import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  HARNESSES,
  LOCKFILE_FILENAME,
  ShareClient,
  type AgentManifest,
  type Harness,
  type PackMode,
  formatIssues,
  parseManifest,
  previewHandoffImport,
  importHandoff,
  createPackTarball,
  diffPackDirs,
  extractPackTarball,
  encodePublicKeyHeader,
  exportPackSkills,
  formatScanFinding,
  importFromClawHub,
  importFromSkillsSh,
  importFromSmithery,
  type ImportResult,
  generateSigningKeyPair,
  keyFingerprint,
  readLockfile,
  signDigest,
  verifyDigest,
  readPack,
  resolveSkillsDir,
  scanPack,
  summarizeScan,
  upsertInstall,
  writeLockfile,
  type LockEntry,
  type ScanReport,
  discoverHarnessSkills,
  ingestSkillFromHarness,
  checkSyncStatus,
  formatSyncReport,
  type DiscoveredSkill,
  type IngestResult,
  type SyncReport,
  parsePolicy,
  evaluatePolicy,
  formatPolicyEvaluation,
  type PolicyDefinition,
  type PolicyEvaluationResult,
  executeInSandbox,
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

function defaultSigningKeyPath(): string {
  return (
    process.env.AGENTSHARE_SIGNING_KEY ?? path.join(path.dirname(configPath()), "signing-key.json")
  );
}

async function loadSigningKey(
  file: string,
): Promise<{ publicKey: string; privateKey: string }> {
  const parsed = JSON.parse(await fsp.readFile(path.resolve(file), "utf8")) as {
    publicKey?: unknown;
    privateKey?: unknown;
  };
  if (typeof parsed.publicKey !== "string" || typeof parsed.privateKey !== "string") {
    throw new Error(`invalid signing key file: ${file}`);
  }
  return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}

export async function keygenCommand(options: { out?: string }): Promise<void> {
  const file = path.resolve(options.out ?? defaultSigningKeyPath());
  if (fs.existsSync(file)) throw new Error(`signing key already exists: ${file}`);
  const keys = generateSigningKeyPair();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  console.log(`keygen    ${file}`);
  console.log(`fingerprint ${keyFingerprint(keys.publicKey)}`);
  console.log(keys.publicKey.trim());
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

export interface InitOptions {
  yes?: boolean;
  name?: string;
  version?: string;
  title?: string;
  description?: string;
  mode?: PackMode;
  targets?: string;
  mcp?: boolean;
  mcpConfig?: string;
  secrets?: string;
  tags?: string;
  force?: boolean;
}

export async function initCommand(
  dir = ".",
  options: InitOptions = {},
): Promise<void> {
  const targetDir = path.resolve(dir);
  await fsp.mkdir(targetDir, { recursive: true });
  const manifestFile = path.join(targetDir, "agent.json");

  if (fs.existsSync(manifestFile) && !options.force && !options.yes) {
    if (!process.stdin.isTTY) {
      throw new Error("agent.json already exists; use --force to overwrite");
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (
      await rl.question("agent.json already exists. Overwrite? (y/N): ")
    )
      .trim()
      .toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("Initialization aborted.");
      return;
    }
  }

  const defaultName =
    path
      .basename(targetDir)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "") || "my-agent-pack";

  let name = options.name ?? defaultName;
  let version = options.version ?? "0.1.0";
  let title =
    options.title ??
    name
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  let description = options.description ?? `${title} agent skill pack.`;
  let mode: PackMode = options.mode ?? "offline";
  let compatibility: Harness[] = options.targets
    ? resolveTargets(options.targets)
    : ["agents", "claude", "codex"];
  let configureMcp = options.mcp ?? false;
  let mcpConfigFile = options.mcpConfig ?? "mcp.json";
  let secretsList: string[] = options.secrets
    ? options.secrets
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : [];
  let tagsList: string[] = options.tags
    ? options.tags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    : ["agent"];

  if (process.stdin.isTTY && !options.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log("\n  Welcome to AgentShareFlow init wizard");
      console.log("  This will guide you to create an agent.json pack manifest.\n");

      const ansName = (await rl.question(`  Package name (${name}): `)).trim();
      if (ansName) name = ansName.toLowerCase();

      const ansVersion = (await rl.question(`  Version (${version}): `)).trim();
      if (ansVersion) version = ansVersion;

      const ansTitle = (await rl.question(`  Title (${title}): `)).trim();
      if (ansTitle) title = ansTitle;

      const ansDesc = (await rl.question(`  Description (${description}): `)).trim();
      if (ansDesc) description = ansDesc;

      const ansMode = (
        await rl.question(`  Pack mode [offline/endpoint/runtime] (${mode}): `)
      )
        .trim()
        .toLowerCase();
      if (ansMode === "offline" || ansMode === "endpoint" || ansMode === "runtime") {
        mode = ansMode;
      }

      const ansTargets = (
        await rl.question(
          `  Target harnesses [agents, claude, codex, opencode, openclaw, hermes] (${compatibility.join(
            ", ",
          )}): `,
        )
      ).trim();
      if (ansTargets) {
        compatibility = resolveTargets(ansTargets);
      }

      const ansMcp = (await rl.question(`  Configure MCP dependencies? (y/N): `))
        .trim()
        .toLowerCase();
      if (ansMcp === "y" || ansMcp === "yes") {
        configureMcp = true;
        const ansMcpConfig = (
          await rl.question(`  MCP config file path (${mcpConfigFile}): `)
        ).trim();
        if (ansMcpConfig) mcpConfigFile = ansMcpConfig;
      }

      const ansSecrets = (
        await rl.question(
          `  Declarative secrets (e.g. GITHUB_TOKEN, OPENAI_API_KEY) [optional]: `,
        )
      ).trim();
      if (ansSecrets) {
        secretsList = ansSecrets
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);
      }

      const ansTags = (
        await rl.question(`  Tags (comma-separated) (${tagsList.join(", ")}): `)
      ).trim();
      if (ansTags) {
        tagsList = ansTags
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
      }
    } finally {
      rl.close();
    }
  }

  const manifest: AgentManifest = {
    spec: "agent-pack/v0",
    name,
    version,
    title,
    description,
    mode,
    tags: tagsList,
    compatibility,
    skills: ["."],
    instructions: [],
    ...(configureMcp ? { mcp: { config: mcpConfigFile } } : {}),
    secrets: secretsList,
    metadata: {},
  };

  try {
    parseManifest(manifest);
  } catch (err) {
    throw new Error(`Invalid manifest configuration: ${formatIssues(err)}`);
  }

  await fsp.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (configureMcp) {
    const fullMcpPath = path.join(targetDir, mcpConfigFile);
    if (!fs.existsSync(fullMcpPath)) {
      const template = {
        mcpServers: {
          sample: {
            command: "echo",
            args: ["sample-mcp-server"],
          },
        },
      };
      await fsp.mkdir(path.dirname(fullMcpPath), { recursive: true });
      await fsp.writeFile(fullMcpPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
    }
  }

  const skillFile = path.join(targetDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    const starterSkill = [
      `# ${title}`,
      "",
      `${description}`,
      "",
      "## When to Use",
      "",
      "- Activate this skill for code analysis, refactoring, or domain tasks.",
      "",
      "## Capabilities",
      "",
      "- Fast inspection and prompt skill distribution",
      "- Standardized tool execution across Claude Code, Codex, and OpenCode",
      "",
      "## Usage",
      "",
      "Follow defined harness instructions and verify outcomes with test suites.",
      "",
    ].join("\n");
    await fsp.writeFile(skillFile, starterSkill, "utf8");
  }

  console.log(`\n  ✨ Agent Pack initialized successfully!`);
  console.log(`  manifest:   ${manifestFile}`);
  console.log(`  skills:     ${skillFile}`);
  if (configureMcp) {
    console.log(`  mcp config: ${path.join(targetDir, mcpConfigFile)}`);
  }
  console.log(`\n  Next steps:`);
  console.log(`    1. Edit SKILL.md to document agent prompt & skills`);
  console.log(`    2. Run 'agentshare pack' to validate and build tarball`);
  console.log(`    3. Run 'agentshare publish' to release to registry\n`);
}

export interface PublishOptions {
  registry?: string;
  token?: string;
  dryRun?: boolean;
  allowRisky?: boolean;
  sign?: boolean;
  key?: string;
  policy?: string;
  owner?: string;
  visibility?: string;
  yes?: boolean;
}

export async function publishCommand(
  dir = ".",
  options: PublishOptions = {},
): Promise<void> {
  const config = loadConfig();
  const registry = resolveRegistry(config, options.registry);
  const token = resolveToken(config, options.token);
  const pack = await readPack(dir);

  // 1. Static Security Scan
  console.log(`\n  [1/4] Security Scan:`);
  const report = await scanPack(pack.dir);
  if (report.findings.length === 0) {
    console.log(`    ✓ Static security scan passed (0 findings)`);
  } else {
    for (const finding of report.findings) {
      console.log(`    ${finding.severity === "high" ? "✖" : "!"} ${formatScanFinding(finding)}`);
    }
    console.log(`    Summary: ${summarizeScan(report)}`);
  }
  if (report.blocked && !options.allowRisky) {
    throw new Error(
      `publish blocked by security scan (high severity findings); pass --allow-risky to proceed anyway`,
    );
  }

  // 1.5 Enterprise Policy Verification
  const policyFile =
    options.policy ??
    (fs.existsSync(path.join(pack.dir, "policy.json"))
      ? path.join(pack.dir, "policy.json")
      : fs.existsSync(path.join(process.cwd(), "policy.json"))
      ? path.join(process.cwd(), "policy.json")
      : undefined);

  if (policyFile) {
    console.log(`\n  [Policy Check]: Validating enterprise compliance...`);
    try {
      const policyContent = JSON.parse(await fsp.readFile(policyFile, "utf8"));
      const policy = parsePolicy(policyContent);
      const evalResult = evaluatePolicy(policy, {
        manifest: pack.manifest,
        scan: report,
      });

      if (evalResult.passed) {
        console.log(`    ✓ Policy "${evalResult.policyName}" passed (${evalResult.totalRules} rules)`);
      } else {
        console.log(`    ✗ Policy check failed with ${evalResult.violations.length} violation(s):`);
        for (const v of evalResult.violations) {
          console.log(`      - [${v.ruleId}] ${v.message}`);
        }
        if (!options.allowRisky) {
          throw new Error(
            `publish blocked by enterprise policy "${evalResult.policyName}"; review violations or pass --allow-risky`,
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("publish blocked by enterprise policy")) {
        throw err;
      }
      throw new Error(`Failed to evaluate policy file (${policyFile}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Tarball packaging & local verification
  console.log(`\n  [2/4] Packaging Tarball:`);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "agentshare-publish-"));
  try {
    const file = path.join(tmp, `${pack.manifest.name}-${pack.manifest.version}.tgz`);
    const result = await createPackTarball(pack.dir, file);
    console.log(`    ✓ Tarball created: ${result.size} bytes`);
    console.log(`    ✓ SHA256 digest:  ${result.digest}`);

    // 3. Local self-signing verification
    console.log(`\n  [3/4] Signature & Verification:`);
    let signing: { publicKeyHeader: string; signature: string; fingerprint: string } | undefined;
    const keyFile = options.key ?? defaultSigningKeyPath();
    const shouldSign =
      options.sign === true || (options.key !== undefined && fs.existsSync(keyFile));

    if (shouldSign) {
      if (!fs.existsSync(keyFile)) {
        throw new Error(
          `Signing key not found at ${keyFile}. Run 'agentshare keygen' first or omit --sign.`,
        );
      }
      const keys = await loadSigningKey(keyFile);
      const signature = signDigest(keys.privateKey, result.digest);
      const isValid = verifyDigest(keys.publicKey, result.digest, signature);
      if (!isValid) {
        throw new Error("Local self-signature verification failed! Generated signature is invalid.");
      }
      const fp = keyFingerprint(keys.publicKey);
      signing = {
        publicKeyHeader: encodePublicKeyHeader(keys.publicKey),
        signature,
        fingerprint: fp,
      };
      console.log(`    ✓ Ed25519 local self-signature generated and verified`);
      console.log(`    ✓ Key fingerprint: ${fp}`);
    } else {
      console.log(`    (unsigned release)`);
    }

    // 4. Interactive Confirmation Preview
    console.log(`\n  [4/4] Publish Preview:`);
    console.log("  ┌────────────────────────────────────────────────────────────┐");
    console.log(
      `  │ Agent Pack:     ${pack.manifest.name}@${pack.manifest.version}`.padEnd(63) + "│",
    );
    console.log(`  │ Title:          ${truncate(pack.manifest.title, 42)}`.padEnd(63) + "│");
    console.log(`  │ Mode:           ${pack.manifest.mode}`.padEnd(63) + "│");
    console.log(
      `  │ Harnesses:      ${pack.manifest.compatibility.join(", ")}`.padEnd(63) + "│",
    );
    if (pack.manifest.mcp) {
      console.log(`  │ MCP Config:     ${pack.manifest.mcp.config}`.padEnd(63) + "│");
    }
    if ((pack.manifest.secrets ?? []).length > 0) {
      console.log(
        `  │ Secrets:        ${pack.manifest.secrets?.join(", ")}`.padEnd(63) + "│",
      );
    }
    console.log(
      `  │ Security:       ${report.blocked ? "RISKY (override)" : "CLEAN"}`.padEnd(63) + "│",
    );
    console.log(
      `  │ Signature:      ${signing ? `Ed25519 (${signing.fingerprint})` : "None"}`.padEnd(
        63,
      ) + "│",
    );
    console.log(`  │ Tarball Size:   ${result.size} bytes`.padEnd(63) + "│");
    console.log(`  │ Registry:       ${registry}`.padEnd(63) + "│");
    console.log("  └────────────────────────────────────────────────────────────┘");

    if (options.dryRun) {
      console.log("\n  ✨ Dry-run complete. Nothing was uploaded.\n");
      return;
    }

    if (!token) {
      throw new Error("Not logged in. Run 'agentshare login' or pass --token.");
    }

    if (process.stdin.isTTY && !options.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (
        await rl.question(`\n  Ready to publish to ${registry}? (y/N): `)
      )
        .trim()
        .toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") {
        console.log("  Publish cancelled by user.\n");
        return;
      }
    }

    const bytes = await fsp.readFile(file);
    const client = new RegistryClient(registry, token);
    const published = await client.publish(
      pack.manifest,
      bytes,
      result.digest,
      signing
        ? { publicKeyHeader: signing.publicKeyHeader, signature: signing.signature }
        : undefined,
      { owner: options.owner, visibility: options.visibility },
    );

    console.log(`\n  🚀 Successfully published ${published.ref}!`);
    console.log(`  Registry: ${registry}`);
    console.log(`  Install:  agentshare install ${published.ref}\n`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

export async function pushCommand(
  dir: string,
  options: {
    registry?: string;
    token?: string;
    dryRun?: boolean;
    allowRisky?: boolean;
    sign?: boolean;
    key?: string;
    yes?: boolean;
  },
): Promise<void> {
  return publishCommand(dir, { ...options, yes: options.yes ?? true });
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
      verifyDownloadedPack(detail, bytes);
      const signer = detail.signature?.fingerprint;
      if (entry.signer !== undefined && signer !== entry.signer) {
        throw new Error(
          `signer changed for ${entry.owner}/${entry.name} (${entry.signer} -> ${signer ?? "unsigned"}); reinstall manually with --force to accept`,
        );
      }
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
        ...signer === undefined ? {} : { signer },
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
  options: { registry?: string; token?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const client = new RegistryClient(
    resolveRegistry(config, options.registry),
    resolveToken(config, options.token),
  );
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

function verifyDownloadedPack(
  detail: { owner: string; name: string; version: string; digest: string; signature?: { publicKey: string; value: string } },
  bytes: Uint8Array,
): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== detail.digest) {
    throw new Error(`digest mismatch for ${detail.owner}/${detail.name}@${detail.version}; refusing to install`);
  }
  if (detail.signature !== undefined && !verifyDigest(detail.signature.publicKey, detail.digest, detail.signature.value)) {
    throw new Error(
      `signature verification failed for ${detail.owner}/${detail.name}@${detail.version}; refusing to install`,
    );
  }
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
  verifyDownloadedPack(detail, bytes);

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
          ...detail.signature === undefined ? {} : { signer: detail.signature.fingerprint },
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

export interface ImportCliOptions {
  out?: string;
  name?: string;
  skill?: string;
  version?: string;
  force?: boolean;
  json?: boolean;
}

export async function importCommand(
  provider: string,
  source: string,
  options: ImportCliOptions,
): Promise<void> {
  let result: ImportResult;
  if (provider === "smithery") {
    result = await importFromSmithery(source, options);
  } else if (provider === "clawhub") {
    result = await importFromClawHub(source, options);
  } else if (provider === "skills-sh") {
    result = await importFromSkillsSh(source, options);
  } else {
    throw new Error(`unknown provider "${provider}" (use smithery, clawhub, or skills-sh)`);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          provider: result.provider,
          source: result.source,
          dir: result.dir,
          manifest: result.manifest,
          files: result.files,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`import  ${result.provider} ${result.source}`);
  console.log(`pack    ${result.manifest.name}@${result.manifest.version} (${result.manifest.mode})`);
  console.log(`files   ${result.files.length}`);
  console.log(`dir     ${result.dir}`);
  const relative = path.relative(process.cwd(), result.dir);
  console.log(`next    agentshare push ${relative.startsWith("..") || path.isAbsolute(relative) ? result.dir : relative}`);
}

export interface ExportOptions {
  registry?: string;
  token?: string;
  out?: string;
  force?: boolean;
  allowRisky?: boolean;
  json?: boolean;
}

export async function exportCommand(ref: string, options: ExportOptions): Promise<void> {
  if (options.out === undefined) throw new Error("--out <dir> is required");
  const config = loadConfig();
  const registry = resolveRegistry(config, options.registry);
  const client = new RegistryClient(registry, resolveToken(config, options.token));
  const { owner, name, version } = parseRef(ref);
  const detail = await client.info(owner, name, version);
  const bytes = await client.downloadBytes(owner, name, detail.version);
  verifyDownloadedPack(detail, bytes);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "agentshare-export-"));
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
        `export blocked by the security scan (high severity):\n${highlights}\nreview the findings or pass --allow-risky`,
      );
    }

    const result = await exportPackSkills(extracted, detail.manifest, path.resolve(options.out), {
      force: options.force,
    });

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            owner,
            name,
            version: detail.version,
            digest: detail.digest,
            exported: result.exported,
            skipped: result.skipped,
            scan,
          },
          null,
          2,
        ),
      );
      return;
    }
    for (const finding of scan.findings) console.log(`scan    ${formatScanFinding(finding)}`);
    if (scan.findings.length > 0) console.log(`scan    ${summarizeScan(scan)}`);
    for (const item of result.skipped) console.log(`skip    ${item.dest} (exists, use --force)`);
    console.log(`export  ${owner}/${name}@${detail.version}`);
    for (const item of result.exported) console.log(`  -> ${item.dest}`);
    if (detail.manifest.instructions.length > 0 || detail.manifest.mcp !== undefined) {
      console.log("note    instructions/mcp configs stay in the pack; export contains skills only");
    }
    if (result.exported.length === 0) console.log("nothing exported");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

export interface IngestCliOptions {
  from: string;
  name?: string;
  out?: string;
  project?: boolean;
  targets?: string;
  force?: boolean;
  list?: boolean;
  cwd?: string;
  json?: boolean;
}

export async function ingestCommand(
  skillName: string | undefined,
  options: IngestCliOptions,
): Promise<void> {
  const fromHarness = (options.from ?? "").trim().toLowerCase();
  if (!fromHarness) {
    throw new Error("--from <harness> is required (agents, claude, codex, opencode, openclaw, hermes)");
  }
  if (!HARNESSES.includes(fromHarness as Harness)) {
    throw new Error(`unknown harness "${fromHarness}"; expected one of: ${HARNESSES.join(", ")}`);
  }
  const harness = fromHarness as Harness;

  if (options.list || !skillName) {
    const skills = await discoverHarnessSkills(harness, {
      project: options.project,
      cwd: options.cwd,
    });
    if (options.json) {
      console.log(JSON.stringify(skills, null, 2));
      return;
    }
    console.log(`Discovered skills in ${harness} (${options.project ? "project" : "user"} scope):`);
    if (skills.length === 0) {
      console.log("  (no skills found)");
      return;
    }
    for (const item of skills) {
      const badges: string[] = [];
      if (item.hasSkillMd) badges.push("SKILL.md");
      if (item.hasMcp) badges.push("mcp.json");
      console.log(`  • ${item.name.padEnd(24)} [${badges.join(", ") || "scripts"}] (${item.files.length} files)`);
    }
    console.log(`\nTo ingest: agentshare ingest --from ${harness} <skill-name>`);
    return;
  }

  const targetHarnesses = options.targets
    ? resolveTargets(options.targets)
    : [harness, "agents" as Harness];

  const result = await ingestSkillFromHarness(harness, skillName, {
    name: options.name,
    out: options.out,
    project: options.project,
    force: options.force,
    cwd: options.cwd,
    targetHarnesses,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("┌────────────────────────────────────────────────────────────┐");
  console.log(`│ Ingested:    ${result.manifest.name}@${result.manifest.version} (from ${harness})`.padEnd(61) + "│");
  console.log(`│ Title:       ${truncate(result.manifest.title, 42)}`.padEnd(61) + "│");
  console.log(`│ Targets:     ${result.manifest.compatibility.join(", ")}`.padEnd(61) + "│");
  console.log(`│ Output:      ${result.outDir}`.padEnd(61) + "│");
  console.log(`│ Files:       ${result.files.join(", ")}`.padEnd(61) + "│");
  if (result.manifest.secrets.length > 0) {
    console.log(`│ Secrets:     ${result.manifest.secrets.join(", ")}`.padEnd(61) + "│");
  }
  console.log("└────────────────────────────────────────────────────────────┘");
  const rel = path.relative(process.cwd(), result.outDir);
  const nextTarget = rel.startsWith("..") || path.isAbsolute(rel) ? result.outDir : rel;
  console.log(`✨ Pack scaffolded! To inspect or publish:\n   agentshare publish ${nextTarget}`);
}

export interface SyncCliOptions {
  target?: string;
  project?: boolean;
  dryRun?: boolean;
  repair?: boolean;
  checkOrphans?: boolean;
  registry?: string;
  token?: string;
  cwd?: string;
  json?: boolean;
}

export async function syncCommand(options: SyncCliOptions): Promise<void> {
  const workingDir = options.cwd ?? process.cwd();
  const lockfilePath = options.project
    ? path.join(workingDir, LOCKFILE_FILENAME)
    : fs.existsSync(path.join(workingDir, LOCKFILE_FILENAME))
    ? path.join(workingDir, LOCKFILE_FILENAME)
    : path.join(path.dirname(configPath()), LOCKFILE_FILENAME);

  if (!fs.existsSync(lockfilePath)) {
    if (options.json) {
      console.log(JSON.stringify({ status: "empty", message: "no lockfile found" }, null, 2));
      return;
    }
    console.log(`No lockfile found at ${lockfilePath}`);
    console.log("Install packs first using `agentshare install <pack>` to create a lockfile.");
    return;
  }

  const lock = await readLockfile(lockfilePath);
  const targetHarness = options.target && HARNESSES.includes(options.target as Harness)
    ? (options.target as Harness)
    : undefined;

  const report = await checkSyncStatus(lock, {
    lockfilePath,
    targetHarness,
    scope: options.project ? "project" : undefined,
    checkOrphans: options.checkOrphans ?? true,
    cwd: workingDir,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatSyncReport(report));

  if (options.repair && (report.missing > 0 || report.drifted > 0)) {
    console.log("\nAttempting automatic re-installation/repair for missing and drifted packs...");
    const config = loadConfig();
    const registry = resolveRegistry(config, options.registry);
    const client = new RegistryClient(registry, resolveToken(config, options.token));

    const needsRepair = report.entries.filter((e) => e.status === "missing" || e.status === "drifted");
    let repairedCount = 0;

    for (const item of needsRepair) {
      try {
        console.log(`Repairing ${item.owner}/${item.name}@${item.version} -> ${item.dest}...`);
        await installPack(client, registry, `${item.owner}/${item.name}@${item.version}`, {
          target: item.target,
          project: item.scope === "project",
          dir: path.dirname(item.dest),
          force: true,
        });
        repairedCount++;
      } catch (err) {
        console.log(`  ✗ Failed to repair ${item.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`Repair complete: ${repairedCount}/${needsRepair.length} restored.`);
  }
}

export interface PolicyCheckOptions {
  policy?: string;
  json?: boolean;
}

export async function policyCheckCommand(
  dir = ".",
  options: PolicyCheckOptions = {},
): Promise<void> {
  const pack = await readPack(dir);
  const report = await scanPack(pack.dir);
  const policyFile =
    options.policy ??
    (fs.existsSync(path.join(pack.dir, "policy.json"))
      ? path.join(pack.dir, "policy.json")
      : path.join(process.cwd(), "policy.json"));

  if (!fs.existsSync(policyFile)) {
    throw new Error(`Policy file not found: ${policyFile}. Pass --policy <file>`);
  }

  const policyContent = JSON.parse(await fsp.readFile(policyFile, "utf8"));
  const policy = parsePolicy(policyContent);
  const evalResult = evaluatePolicy(policy, {
    manifest: pack.manifest,
    scan: report,
  });

  if (options.json) {
    console.log(JSON.stringify(evalResult, null, 2));
    if (!evalResult.passed) process.exitCode = 1;
    return;
  }

  console.log(formatPolicyEvaluation(evalResult));
  if (!evalResult.passed) {
    process.exitCode = 1;
  }
}

export async function orgCreateCommand(
  name: string,
  options: { title?: string; description?: string; registry?: string; token?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const token = resolveToken(config, options.token);
  if (!token) throw new Error("Creating organization requires authentication. Run `agentshare login`.");
  const client = new RegistryClient(resolveRegistry(config, options.registry), token);
  const result = await client.createOrg(name, options.title, options.description);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`✓ Organization "${result.org.name}" created (${result.org.display_name}) with role: ${result.role}`);
}

export async function orgListCommand(
  options: { registry?: string; token?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const token = resolveToken(config, options.token);
  if (!token) throw new Error("Listing organizations requires authentication. Run `agentshare login`.");
  const client = new RegistryClient(resolveRegistry(config, options.registry), token);
  const result = await client.listOrgs();
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log("Your Organizations:");
  if (result.organizations.length === 0) {
    console.log("  (no organizations found)");
    return;
  }
  for (const item of result.organizations) {
    console.log(`  • ${item.org.name.padEnd(20)} [${item.role}]  ${item.org.display_name}`);
  }
}

export async function orgMembersCommand(
  name: string,
  options: { registry?: string; token?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const client = new RegistryClient(resolveRegistry(config, options.registry), resolveToken(config, options.token));
  const result = await client.getOrg(name);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Organization: ${result.org.name} (${result.org.display_name})`);
  console.log(`Your Role:    ${result.role ?? "none"}`);
  if (result.members && result.members.length > 0) {
    console.log("\nMembers:");
    for (const m of result.members) {
      console.log(`  • ${m.member_identity.padEnd(24)} [${m.role}]`);
    }
  }
}

export async function orgAddMemberCommand(
  orgName: string,
  memberIdentity: string,
  options: { role?: string; registry?: string; token?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const token = resolveToken(config, options.token);
  if (!token) throw new Error("Adding organization member requires authentication.");
  const client = new RegistryClient(resolveRegistry(config, options.registry), token);
  const result = await client.addOrgMember(orgName, memberIdentity, options.role ?? "member");
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`✓ Added/updated ${result.member_identity} in ${result.org_name} with role [${result.role}]`);
}

export async function orgRemoveMemberCommand(
  orgName: string,
  memberIdentity: string,
  options: { registry?: string; token?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const token = resolveToken(config, options.token);
  if (!token) throw new Error("Removing organization member requires authentication.");
  const client = new RegistryClient(resolveRegistry(config, options.registry), token);
  const result = await client.removeOrgMember(orgName, memberIdentity);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`✓ Removed ${memberIdentity} from ${orgName}`);
}

export interface RunCommandOptions {
  input?: string;
  entry?: string;
  timeout?: string;
  registry?: string;
  token?: string;
  json?: boolean;
}

export async function runCommand(
  packTarget: string,
  options: RunCommandOptions = {},
): Promise<void> {
  const timeoutMs = options.timeout ? Number.parseInt(options.timeout, 10) : 5000;
  let parsedInput: unknown = options.input;
  if (typeof options.input === "string") {
    try {
      parsedInput = JSON.parse(options.input);
    } catch {
      // Keep as string
    }
  }

  let runDir = "";
  let cleanupDir: string | null = null;

  if (fs.existsSync(packTarget)) {
    const stat = fs.statSync(packTarget);
    if (stat.isDirectory()) {
      runDir = path.resolve(packTarget);
    } else if (packTarget.endsWith(".tgz") || packTarget.endsWith(".tar.gz")) {
      cleanupDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agentshare-run-"));
      await extractPackTarball(packTarget, cleanupDir);
      runDir = cleanupDir;
    }
  } else {
    const match = packTarget.match(/^([a-z0-9-]+)\/([a-z0-9-]+)(?:@([0-9a-zA-Z.-]+))?$/i);
    if (!match) {
      throw new Error(`invalid pack target "${packTarget}". Must be a local path, tarball, or owner/name[@version]`);
    }
    const [, owner, name, versionSpec] = match;
    const config = loadConfig();
    const client = new RegistryClient(
      resolveRegistry(config, options.registry),
      resolveToken(config, options.token),
    );

    let version = versionSpec;
    if (!version) {
      const detail = await client.info(owner!, name!);
      version = detail.version;
    }

    const tarball = await client.downloadBytes(owner!, name!, version);
    cleanupDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agentshare-run-remote-"));
    const tmpTar = path.join(cleanupDir, "pack.tgz");
    await fsp.writeFile(tmpTar, Buffer.from(tarball));
    const extractedDir = path.join(cleanupDir, "pack");
    await extractPackTarball(tmpTar, extractedDir);
    runDir = extractedDir;
  }

  try {
    const result = await executeInSandbox({
      packDir: runDir,
      input: parsedInput,
      entryScript: options.entry,
      timeoutMs,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = result.exitCode || 1;
      return;
    }

    console.log(`\n📦 Agent Pack Sandbox Execution`);
    console.log(`────────────────────────────────────────────────────────────`);
    console.log(`Status:         ${result.ok ? "✅ SUCCESS" : "❌ FAILED"}`);
    console.log(`Execution Time: ${result.executionTimeMs}ms`);
    console.log(`Exit Code:      ${result.exitCode}`);
    console.log(`Sandboxed:      ${result.sandboxed ? "YES (Isolated Node/Subprocess)" : "NO"}`);
    if (result.error) {
      console.log(`Error:          ${result.error}`);
    }
    console.log(`────────────────────────────────────────────────────────────`);

    if (result.logs.length > 0) {
      console.log(`\n📋 Execution Logs:`);
      for (const line of result.logs) {
        console.log(`  ${line}`);
      }
    }

    console.log(`\n📤 Output Result:`);
    if (typeof result.output === "object" && result.output !== null) {
      console.log(JSON.stringify(result.output, null, 2));
    } else {
      console.log(result.output ?? "(no output)");
    }

    if (!result.ok) {
      process.exitCode = result.exitCode || 1;
    }
  } finally {
    if (cleanupDir) {
      await fsp.rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
