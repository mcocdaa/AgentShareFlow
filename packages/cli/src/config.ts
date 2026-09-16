import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  registry?: string;
  token?: string;
  owner?: string;
}

export const DEFAULT_REGISTRY = "http://localhost:8787";

export function configPath(): string {
  if (process.env.AGENTSHARE_CONFIG) return process.env.AGENTSHARE_CONFIG;
  const dir =
    process.env.AGENTSHARE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "agentshare");
  return path.join(dir, "config.json");
}

export function loadConfig(): CliConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: CliConfig): string {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function resolveRegistry(config: CliConfig, flag?: string): string {
  return flag ?? config.registry ?? process.env.AGENTSHARE_REGISTRY ?? DEFAULT_REGISTRY;
}

export function resolveToken(config: CliConfig, flag?: string): string | undefined {
  return flag ?? process.env.AGENTSHARE_TOKEN ?? config.token;
}

export function maskToken(token: string): string {
  if (token.length <= 6) return "***";
  return `${token.slice(0, 3)}***${token.slice(-3)}`;
}
