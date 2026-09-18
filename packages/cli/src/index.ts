#!/usr/bin/env node
import { Command } from "commander";
import {
  diffCommand,
  handoffImportCommand,
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
  searchCommand,
  whoamiCommand,
} from "./commands.js";
import { RegistryClient } from "./client.js";
import { loadConfig, resolveRegistry, resolveToken } from "./config.js";
import { serveMcpCommand } from "./mcp.js";

const program = new Command();

program
  .name("agentshare")
  .description("Publish, discover, and install Agent Packs")
  .version("0.1.0");

program
  .command("login")
  .description("save registry URL and token to the local config")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--owner <owner>", "default owner namespace")
  .action(loginCommand);

program.command("whoami").description("print current config").action(whoamiCommand);

program
  .command("pack")
  .description("validate a pack directory and create a tarball")
  .argument("[dir]", "pack directory", ".")
  .option("--out <file>", "output tarball path")
  .action(packCommand);

program
  .command("push")
  .description("validate, pack, and publish a pack directory")
  .argument("[dir]", "pack directory", ".")
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .option("--dry-run", "validate and pack without uploading")
  .option("--allow-risky", "publish even when the security scan reports high-severity findings")
  .option("--sign", "sign the release with an ed25519 key")
  .option("--key <file>", "signing key file (default: CLI config dir signing-key.json)")
  .action(pushCommand);

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

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
