#!/usr/bin/env node
import { Command } from "commander";
import {
  diffCommand,
  exportCommand,
  handoffImportCommand,
  importCommand,
  infoCommand,
  installPack,
  keygenCommand,
  starCommand,
  shareDecideCommand,
  shareSubmissionsCommand,
  updateCommand,
  installCommand,
  loginCommand,
  packCommand,
  pushCommand,
  publishCommand,
  initCommand,
  searchCommand,
  whoamiCommand,
  ingestCommand,
  syncCommand,
  policyCheckCommand,
  orgCreateCommand,
  orgListCommand,
  orgMembersCommand,
  orgAddMemberCommand,
  orgRemoveMemberCommand,
  runCommand,
  federationListCommand,
  federationAddCommand,
  federationRemoveCommand,
} from "./commands.js";
import { exposeCommand } from "./expose.js";
import { RegistryClient } from "./client.js";
import { loadConfig, resolveRegistry, resolveToken } from "./config.js";
import { serveMcpCommand } from "./mcp.js";

const program = new Command();

program
  .name("agentshare")
  .description("Publish, discover, and install Agent Packs")
  .version("0.1.0", "-V, --cli-version");

program
  .command("login")
  .description("save registry URL and token to the local config")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--owner <owner>", "default owner namespace")
  .action(loginCommand);

program.command("whoami").description("print current config").action(whoamiCommand);

program
  .command("init")
  .description("interactively generate a compliant agent.json manifest and skill scaffold")
  .argument("[dir]", "target directory", ".")
  .option("-y, --yes", "skip interactive prompts and accept defaults")
  .option("--name <name>", "package name (lowercase alphanumeric/hyphens)")
  .option("--version <semver>", "version number (e.g. 0.1.0)")
  .option("--title <title>", "human-readable package title")
  .option("--description <desc>", "short description")
  .option("--mode <mode>", "pack mode (offline, endpoint, runtime)")
  .option("--targets <targets>", "target harnesses (agents, claude, codex, opencode, openclaw, hermes)")
  .option("--mcp", "configure MCP tool dependencies")
  .option("--mcp-config <file>", "MCP configuration file name (default: mcp.json)")
  .option("--secrets <secrets>", "comma-separated required secrets (e.g. GITHUB_TOKEN)")
  .option("--tags <tags>", "comma-separated discovery tags")
  .option("--force", "overwrite existing agent.json")
  .action(initCommand);

program
  .command("pack")
  .description("validate a pack directory and create a tarball")
  .argument("[dir]", "pack directory", ".")
  .option("--out <file>", "output tarball path")
  .action(packCommand);

program
  .command("publish")
  .description("inspect, scan, verify signatures, and publish an Agent Pack to registry")
  .argument("[dir]", "pack directory", ".")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--dry-run", "validate, scan, and preview without uploading")
  .option("--allow-risky", "publish even when the security scan reports high-severity findings")
  .option("--sign", "sign the release with an ed25519 key")
  .option("--key <file>", "signing key file (default: CLI config dir signing-key.json)")
  .option("--policy <file>", "enterprise policy compliance file (default: ./policy.json)")
  .option("--owner <owner>", "target owner/organization namespace")
  .option("--visibility <level>", "package visibility: public, internal, private", "public")
  .option("-y, --yes", "skip interactive confirmation prompt")
  .action(publishCommand);

program
  .command("push")
  .description("validate, pack, and publish a pack directory (alias for publish)")
  .argument("[dir]", "pack directory", ".")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--dry-run", "validate and pack without uploading")
  .option("--allow-risky", "publish even when the security scan reports high-severity findings")
  .option("--sign", "sign the release with an ed25519 key")
  .option("--key <file>", "signing key file (default: CLI config dir signing-key.json)")
  .option("--policy <file>", "enterprise policy compliance file (default: ./policy.json)")
  .option("--owner <owner>", "target owner/organization namespace")
  .option("--visibility <level>", "package visibility: public, internal, private", "public")
  .option("-y, --yes", "skip interactive confirmation prompt")
  .action(publishCommand);

program
  .command("keygen")
  .description("generate an ed25519 signing key")
  .option("--out <file>", "key file path (default: CLI config dir signing-key.json)")
  .action(keygenCommand);

program
  .command("search")
  .description("search packs on the registry")
  .argument("<query>", "search query")
  .option("--registry <url>", "registry base URL")
  .option("--federated", "search across local registry and all connected federation peers")
  .option("--json", "machine-readable output")
  .action(searchCommand);

program
  .command("info")
  .description("show pack details")
  .argument("<ref>", "owner/name[@version]")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token (shows your star state)")
  .option("--json", "machine-readable output")
  .action(infoCommand);

program
  .command("install")
  .description("download a pack and install its skills into a harness")
  .argument("<ref>", "owner/name[@version]")
  .option("--target <targets>", "agents, claude, codex, opencode, openclaw, hermes, all", "agents")
  .option("--project", "install into the current project instead of the user directory")
  .option("--dir <path>", "override the install directory")
  .option("--force", "overwrite an existing install")
  .option("--allow-risky", "install even when the security scan reports high-severity findings")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .action(installCommand);

program
  .command("export")
  .description("download a pack and export its skills as plain SKILL.md directories")
  .argument("<ref>", "owner/name[@version]")
  .requiredOption("--out <dir>", "output directory for the exported skills")
  .option("--force", "overwrite existing skill directories")
  .option("--allow-risky", "export even when the security scan reports high-severity findings")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(exportCommand);

program
  .command("import")
  .description("convert a skill or MCP server from another registry into a local Agent Pack")
  .argument("<provider>", "smithery, clawhub, or skills-sh")
  .argument("<source>", "smithery qualifiedName, clawhub owner/slug, or skills-sh owner/repo")
  .option("--out <dir>", "output pack directory (default: ./<name>)")
  .option("--name <name>", "override the derived pack name")
  .option("--skill <name>", "skills-sh only: import a single skill by name")
  .option("--version <version>", "clawhub only: import a specific version")
  .option("--force", "write into a non-empty destination")
  .option("--json", "machine-readable output")
  .action(importCommand);

program
  .command("ingest")
  .description("extract an existing skill from a harness into a standard Agent Pack")
  .argument("[skillName]", "name of the skill to ingest")
  .requiredOption("--from <harness>", "source harness (agents, claude, codex, opencode, openclaw, hermes)")
  .option("--name <name>", "custom name for the generated pack")
  .option("--out <dir>", "destination directory")
  .option("--project", "inspect project-level harness directory instead of user directory")
  .option("--targets <targets>", "comma-separated compatibility targets (default: source harness + agents)")
  .option("--list", "list discovered skills in the target harness directory")
  .option("--force", "overwrite destination directory if non-empty")
  .option("--json", "machine-readable output")
  .action(ingestCommand);

program
  .command("sync")
  .description("check and repair synchronization between lockfile and installed harness skills")
  .option("--target <harness>", "filter by harness target")
  .option("--project", "sync project lockfile instead of user lockfile")
  .option("--repair", "attempt to repair missing or drifted skills")
  .option("--no-orphans", "skip scanning for unmanaged orphaned skills")
  .option("--registry <url>", "registry base URL (for repair)")
  .option("--token <token>", "API token (for repair)")
  .option("--json", "machine-readable output")
  .action(syncCommand);

const share = program.command("share").description("review outcomes submitted through a share link");

share
  .command("submissions")
  .description("list outcome submissions for one of your shares")
  .argument("<shareId>", "share id from the share URL")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(shareSubmissionsCommand);

share
  .command("decide")
  .description("accept or reject one submission")
  .argument("<shareId>", "share id from the share URL")
  .argument("<submissionId>", "submission id from `share submissions`")
  .option("--accept", "accept the submission")
  .option("--reject", "reject the submission")
  .option("--note <text>", "optional note sent to the visitor")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(shareDecideCommand);

program.command("handoff")
  .description("preview and import selected work context")
  .command("import")
  .argument("<file>", "handoff.json exported by the source agent")
  .option("--target <harness>", "target tool (codex only)", "codex")
  .option("--dir <path>", "existing parent directory for independent imported files", ".")
  .option("--confirm <digest>", "confirm the exact preview digest")
  .option("--json", "machine-readable preview or result")
  .action(handoffImportCommand);

program
  .command("star")
  .description("star a pack")
  .argument("<ref>", "owner/name[@version]")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(starCommand);

program
  .command("unstar")
  .description("remove your star from a pack")
  .argument("<ref>", "owner/name[@version]")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action((ref: string, options: { registry?: string; token?: string; json?: boolean }) =>
    starCommand(ref, { ...options, unstar: true }));

program
  .command("diff")
  .description("compare two pack versions file by file")
  .argument("<from>", "owner/name[@version]")
  .argument("<to>", "owner/name[@version]")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(diffCommand);

program
  .command("expose")
  .description("share a local A2A agent through an outbound tunnel (no public URL needed)")
  .requiredOption("--a2a <url>", "local A2A agent base URL (its Agent Card is validated)")
  .option("--title <title>", "share title (default: agent card name)")
  .option("--project <name>", "project label shown to visitors")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .action(exposeCommand);

program
  .command("update")
  .description("reinstall locked packs to their latest versions")
  .argument("[ref]", "owner/name[@version], defaults to every locked pack")
  .option("--dry-run", "show planned updates without installing")
  .option("--allow-risky", "update even when the security scan reports high-severity findings")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(updateCommand);

program
  .command("serve")
  .description("run the registry as an MCP stdio server so agents can search and install packs")
  .option("--mcp", "use the MCP stdio transport (required)")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .action((options: { mcp?: boolean; registry?: string; token?: string }) => {
    if (options.mcp !== true) throw new Error("serve currently supports only --mcp");
    const config = loadConfig();
    const registry = resolveRegistry(config, options.registry);
    const client = new RegistryClient(registry, resolveToken(config, options.token));
    serveMcpCommand({
      registry,
      client,
      install: (ref, installOptions) => installPack(client, registry, ref, installOptions),
    });
  });

const policy = program.command("policy").description("validate agent packs against enterprise compliance policies");

policy
  .command("check")
  .description("evaluate an Agent Pack against a declarative policy.json")
  .argument("[dir]", "pack directory", ".")
  .option("--policy <file>", "path to policy.json file")
  .option("--json", "machine-readable output")
  .action(policyCheckCommand);

const org = program.command("org").description("manage enterprise organizations and workspace members");

org
  .command("create")
  .description("create a new enterprise organization")
  .argument("<name>", "organization namespace slug")
  .option("--title <title>", "human-readable organization name")
  .option("--description <desc>", "organization description")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(orgCreateCommand);

org
  .command("list")
  .description("list organizations you belong to")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(orgListCommand);

org
  .command("members")
  .description("list members in an organization")
  .argument("<name>", "organization namespace slug")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(orgMembersCommand);

org
  .command("add-member")
  .description("add or update an organization member's role")
  .argument("<org>", "organization namespace slug")
  .argument("<identity>", "user identity / email / username")
  .option("--role <role>", "role: owner, admin, member, viewer", "member")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(orgAddMemberCommand);

org
  .command("remove-member")
  .description("remove a member from an organization")
  .argument("<org>", "organization namespace slug")
  .argument("<identity>", "user identity / email / username")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(orgRemoveMemberCommand);

program
  .command("run")
  .description("execute an Agent Pack in an isolated runtime sandbox")
  .argument("<pack>", "local directory, tarball (.tgz), or registry reference (owner/name[@version])")
  .option("-i, --input <data>", "input query string or JSON payload to pass to the agent")
  .option("-e, --entry <script>", "entry script override (e.g. index.js, run.sh)")
  .option("-t, --timeout <ms>", "execution timeout in milliseconds", "5000")
  .option("--registry <url>", "registry base URL (for remote packs)")
  .option("--token <token>", "API token (for remote packs)")
  .option("--json", "output execution result as JSON")
  .action(runCommand);

const federation = program
  .command("federation")
  .description("manage cross-registry A2A federation peers");

federation
  .command("list")
  .description("list all connected federation peers")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(federationListCommand);

federation
  .command("add")
  .description("register a new federation peer registry")
  .argument("<url>", "peer registry base URL")
  .option("--name <name>", "optional human-readable peer name")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(federationAddCommand);

federation
  .command("remove")
  .description("deregister a federation peer registry")
  .argument("<peerId>", "peer ID or URL")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--json", "machine-readable output")
  .action(federationRemoveCommand);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
