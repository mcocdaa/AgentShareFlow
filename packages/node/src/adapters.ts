import { spawn } from "node:child_process";
import {
  sendHttpOrA2aMessage,
  type ContextMessage,
  type NodeKind,
} from "@agentshare/core";

export interface AgentTurnInput {
  text: string;
  fromHandle: string;
  roomId?: string | null;
  context?: Array<{ sender: string; content: string }>;
  readOnlyDir?: string;
}

export interface AgentAdapter {
  readonly kind: NodeKind;
  handleTurn(input: AgentTurnInput): Promise<string | null>;
}

export class McpPassiveAdapter implements AgentAdapter {
  readonly kind: NodeKind = "mcp";

  async handleTurn(_input: AgentTurnInput): Promise<string | null> {
    return null;
  }
}

export interface HttpAgentAdapterOptions {
  mode: "http" | "a2a";
  endpoint: string;
  tokenEnv?: string;
  allowPrivate?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class HttpAgentAdapter implements AgentAdapter {
  readonly kind: NodeKind;
  private readonly mode: "http" | "a2a";
  private readonly endpoint: string;
  private readonly tokenEnv?: string;
  private readonly allowPrivate: boolean;
  private readonly timeoutMs?: number;
  private readonly headers?: Record<string, string>;
  private readonly fetchImpl?: typeof fetch;

  constructor(options: HttpAgentAdapterOptions) {
    this.mode = options.mode;
    this.kind = options.mode;
    this.endpoint = options.endpoint;
    this.tokenEnv = options.tokenEnv;
    this.allowPrivate = options.allowPrivate ?? false;
    this.timeoutMs = options.timeoutMs;
    this.headers = options.headers;
    this.fetchImpl = options.fetchImpl;
  }

  async handleTurn(input: AgentTurnInput): Promise<string | null> {
    const headers: Record<string, string> = { ...(this.headers ?? {}) };
    if (this.tokenEnv) {
      const token = process.env[this.tokenEnv];
      if (token) {
        headers["authorization"] = `Bearer ${token}`;
      }
    }
    if (input.readOnlyDir) {
      headers["x-agentshare-readonly-dir"] = input.readOnlyDir;
    }
    const context: ContextMessage[] | undefined = input.context?.map((c) => ({
      sender: c.sender,
      content: c.content,
    }));
    const result = await sendHttpOrA2aMessage({
      url: this.endpoint,
      mode: this.mode,
      message: input.text,
      from: input.fromHandle,
      roomId: input.roomId ?? null,
      context,
      headers,
      allowPrivate: this.allowPrivate,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    const reply = result.reply.trim();
    return reply.length > 0 ? reply : null;
  }
}

export interface CliAgentAdapterOptions {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  inputFormat?: "json" | "text";
  maxOutputBytes?: number;
}

const DEFAULT_CLI_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export function splitCommandLine(raw: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of raw.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote !== null) {
    throw new Error("Unterminated quote in command string");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  const [command, ...args] = tokens;
  if (!command) {
    throw new Error("Command string is empty");
  }
  return { command, args };
}

export class CliAgentAdapter implements AgentAdapter {
  readonly kind: NodeKind = "cli";
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly timeoutMs: number;
  private readonly inputFormat: "json" | "text";
  private readonly maxOutputBytes: number;

  constructor(options: CliAgentAdapterOptions) {
    this.command = options.command;
    this.args = options.args ? [...options.args] : [];
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.inputFormat = options.inputFormat ?? "json";
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  handleTurn(input: AgentTurnInput): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        shell: false,
        cwd: input.readOnlyDir ?? this.cwd ?? process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(input.readOnlyDir
            ? { AGENTSHARE_READ_ONLY_DIR: input.readOnlyDir }
            : {}),
        },
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finish = (err: Error | null, output?: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (err) {
          reject(err);
        } else {
          resolve(output ?? null);
        }
      };

      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 1_000);
        finish(
          new Error(
            `CLI agent "${this.command}" timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxOutputBytes) {
          child.kill("SIGKILL");
          finish(new Error("CLI agent stdout exceeded maximum size"));
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= this.maxOutputBytes) {
          stderrChunks.push(chunk);
        }
      });

      child.on("error", (err) => {
        finish(new Error(`Failed to spawn CLI agent "${this.command}": ${err.message}`));
      });

      child.on("close", (code, signal) => {
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim().slice(0, 512);
          finish(
            new Error(
              `CLI agent exited with ${code !== null ? `code ${code}` : `signal ${String(signal)}`}${stderr ? `: ${stderr}` : ""}`,
            ),
          );
          return;
        }
        const reply = Buffer.concat(stdoutChunks).toString("utf8").trim();
        finish(null, reply.length > 0 ? reply : null);
      });

      const stdinPayload =
        this.inputFormat === "text"
          ? `${input.text}\n`
          : `${JSON.stringify({
              text: input.text,
              fromHandle: input.fromHandle,
              roomId: input.roomId ?? null,
              context: input.context ?? [],
              ...(input.readOnlyDir ? { readOnlyDir: input.readOnlyDir } : {}),
            })}\n`;

      child.stdin.on("error", () => {
        // Ignore EPIPE if child exits before reading stdin.
      });
      child.stdin.end(stdinPayload, "utf8");
    });
  }
}
