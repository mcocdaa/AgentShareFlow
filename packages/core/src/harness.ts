import os from "node:os";
import path from "node:path";
import type { Harness } from "./manifest.js";

export interface HarnessTarget {
  user: string;
  project: string;
}

export const HARNESS_TARGETS: Record<Harness, HarnessTarget> = {
  agents: { user: "~/.agents/skills", project: ".agents/skills" },
  claude: { user: "~/.claude/skills", project: ".claude/skills" },
  codex: { user: "~/.codex/skills", project: ".codex/skills" },
  opencode: { user: "~/.config/opencode/skills", project: ".opencode/skills" },
  openclaw: { user: "~/.openclaw/skills", project: "skills" },
  hermes: { user: "~/.hermes/skills", project: ".hermes/skills" },
};

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

export interface ResolveSkillsDirOptions {
  project?: boolean;
  cwd?: string;
}

export function resolveSkillsDir(harness: Harness, options: ResolveSkillsDirOptions = {}): string {
  const target = HARNESS_TARGETS[harness];
  if (options.project) {
    return path.resolve(options.cwd ?? process.cwd(), target.project);
  }
  return expandHome(target.user);
}
