#!/usr/bin/env node
import { Command } from "commander";
import {
  infoCommand,
  installCommand,
  loginCommand,
  packCommand,
  pushCommand,
  searchCommand,
  whoamiCommand,
} from "./commands.js";

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
  .action(pushCommand);

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
  .option("--registry <url>", "registry base URL")
  .option("--token <token>", "API token")
  .action(installCommand);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
