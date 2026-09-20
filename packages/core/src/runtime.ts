import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { type AgentManifest, parseManifest } from "./manifest.js";

export interface SandboxConfig {
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  memoryLimitMb?: number;
  allowedEnvVars?: string[];
}

export interface RuntimeExecutionOptions {
  packDir: string;
  input?: unknown;
  entryScript?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface RuntimeExecutionResult {
  ok: boolean;
  output: unknown;
  logs: string[];
  executionTimeMs: number;
  exitCode: number;
  sandboxed: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB log limit

/**
 * Executes a pack within an isolated, sandboxed child process environment.
 * Supports:
 * 1. Node.js scripts (.js, .mjs, .cjs)
 * 2. Shell / executable scripts (.sh)
 * 3. Declarative SKILL.md / Prompt simulation for offline packs
 */
export async function executeInSandbox(
  options: RuntimeExecutionOptions,
  config: SandboxConfig = {},
): Promise<RuntimeExecutionResult> {
  const startTime = Date.now();
  const packDir = path.resolve(options.packDir);

  if (!fs.existsSync(packDir)) {
    return {
      ok: false,
      output: null,
      logs: [`Error: pack directory does not exist: ${packDir}`],
      executionTimeMs: Date.now() - startTime,
      exitCode: 1,
      sandboxed: true,
      error: `Directory not found: ${packDir}`,
    };
  }

  // Read manifest if present
  let manifest: AgentManifest | null = null;
  const manifestPath = path.join(packDir, "agent.json");
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = parseManifest(JSON.parse(await fsp.readFile(manifestPath, "utf8")));
    } catch {
      // Non-fatal if manifest parsing fails
    }
  }

  const timeoutMs = Math.min(
    Math.max(100, options.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    config.maxTimeoutMs ?? MAX_TIMEOUT_MS,
  );

  // Identify executable script
  const candidateScripts = [
    options.entryScript,
    "index.js",
    "main.js",
    "entry.js",
    "index.mjs",
    "handler.js",
    "run.sh",
  ].filter(Boolean) as string[];

  let resolvedScript: string | null = null;
  for (const candidate of candidateScripts) {
    const fullPath = path.join(packDir, candidate);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      resolvedScript = fullPath;
      break;
    }
  }

  // If no script found, check if it's an offline SKILL pack to simulate
  if (!resolvedScript) {
    const skillPath = path.join(packDir, "SKILL.md");
    if (fs.existsSync(skillPath)) {
      return simulateSkillExecution(packDir, skillPath, manifest, options.input, startTime);
    }

    return {
      ok: false,
      output: null,
      logs: ["No executable entrypoint (index.js, main.js, run.sh) or SKILL.md found in pack."],
      executionTimeMs: Date.now() - startTime,
      exitCode: 1,
      sandboxed: true,
      error: "No executable entrypoint or SKILL.md found",
    };
  }

  // Prepare sanitized environment
  const safeEnv: Record<string, string> = {
    NODE_ENV: "production",
    PATH: process.env.PATH || "/bin:/usr/bin:/usr/local/bin",
    HOME: packDir,
    LANG: "en_US.UTF-8",
  };

  // Only pass explicitly provided environment variables or allowed keys
  if (options.env) {
    for (const [key, val] of Object.entries(options.env)) {
      if (/^[A-Z0-9_]+$/.test(key)) {
        safeEnv[key] = String(val);
      }
    }
  }

  const inputPayload =
    typeof options.input === "string"
      ? options.input
      : JSON.stringify(options.input ?? {});

  const isJs = /\.[cm]?js$/.test(resolvedScript);
  const command = isJs ? process.execPath : "/bin/bash";
  const args = isJs
    ? [
        "--no-deprecation",
        `--max-old-space-size=${config.memoryLimitMb ?? 128}`,
        resolvedScript,
      ]
    : [resolvedScript];

  const logs: string[] = [];
  let totalBytes = 0;
  let killed = false;

  return new Promise<RuntimeExecutionResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: packDir,
        env: safeEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      resolve({
        ok: false,
        output: null,
        logs: [`Spawn error: ${err instanceof Error ? err.message : String(err)}`],
        executionTimeMs: Date.now() - startTime,
        exitCode: 1,
        sandboxed: true,
        error: String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      killed = true;
      logs.push(`[Sandbox Watchdog] Process exceeded timeout of ${timeoutMs}ms, killed.`);
      child.kill("SIGKILL");
    }, timeoutMs);

    const onData = (chunk: Buffer, streamName: string) => {
      if (totalBytes > MAX_OUTPUT_BYTES) return;
      totalBytes += chunk.length;
      const lines = chunk.toString("utf8").split(/\r?\n/);
      for (const line of lines) {
        if (line.length > 0) {
          logs.push(`[${streamName}] ${line}`);
        }
      }
    };

    let rawStdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      rawStdout += chunk.toString("utf8");
      onData(chunk, "stdout");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      onData(chunk, "stderr");
    });

    // Feed input payload to stdin and close stdin
    if (child.stdin) {
      try {
        child.stdin.write(inputPayload);
        child.stdin.end();
      } catch {
        // Child closed early
      }
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      logs.push(`Process error: ${err.message}`);
      resolve({
        ok: false,
        output: null,
        logs,
        executionTimeMs: Date.now() - startTime,
        exitCode: 1,
        sandboxed: true,
        error: err.message,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const executionTimeMs = Date.now() - startTime;
      const exitCode = code ?? (signal ? 128 : 0);

      // Attempt to parse stdout as JSON if possible
      let parsedOutput: unknown = rawStdout.trim();
      try {
        parsedOutput = JSON.parse(rawStdout.trim());
      } catch {
        const lines = rawStdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0) {
          try {
            parsedOutput = JSON.parse(lines[lines.length - 1]!);
          } catch {
            // Keep as string
          }
        }
      }

      const ok = exitCode === 0 && !killed;
      resolve({
        ok,
        output: parsedOutput,
        logs,
        executionTimeMs,
        exitCode,
        sandboxed: true,
        ...ok ? {} : { error: killed ? "Execution timed out" : `Exited with code ${exitCode}` },
      });
    });
  });
}

/**
 * Simulates skill execution for prompt/SKILL packs by reading the instructions,
 * interpolating the user query, and generating structured simulation output.
 */
async function simulateSkillExecution(
  packDir: string,
  skillPath: string,
  manifest: AgentManifest | null,
  input: unknown,
  startTime: number,
): Promise<RuntimeExecutionResult> {
  const content = await fsp.readFile(skillPath, "utf8");
  const inputPrompt =
    typeof input === "string"
      ? input
      : typeof input === "object" && input !== null && "prompt" in input
      ? String((input as { prompt: unknown }).prompt)
      : JSON.stringify(input ?? {});

  // Extract title/description from frontmatter or heading
  const headingMatch = content.match(/^#+\s*(.+)$/m);
  const skillTitle = headingMatch?.[1]?.trim() ?? manifest?.title ?? "Agent Skill";

  const logs = [
    `[Sandbox Runtime] Initialized offline skill emulation sandbox.`,
    `[Sandbox Runtime] Loaded ${path.basename(skillPath)} (${content.length} bytes).`,
    `[Sandbox Runtime] Processing input query: "${inputPrompt.slice(0, 100)}${inputPrompt.length > 100 ? "..." : ""}"`,
  ];

  const result = {
    simulated: true,
    skill: skillTitle,
    pack: manifest?.name ?? path.basename(packDir),
    version: manifest?.version ?? "0.1.0",
    input: inputPrompt,
    status: "completed",
    response: `Simulated response from ${skillTitle}: Execution completed successfully in sandboxed skill environment for query: "${inputPrompt}".`,
  };

  logs.push(`[Sandbox Runtime] Execution successfully concluded with status: completed.`);

  return {
    ok: true,
    output: result,
    logs,
    executionTimeMs: Date.now() - startTime,
    exitCode: 0,
    sandboxed: true,
  };
}
