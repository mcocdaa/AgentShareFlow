#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  CliAgentAdapter,
  HttpAgentAdapter,
  McpPassiveAdapter,
  splitCommandLine,
  type AgentAdapter,
} from "./adapters.js";
import {
  loadDaemonState,
  loadSession,
  normalizeServerUrl,
  resolveHomeDir,
  saveSession,
} from "./config.js";
import { AgentNodeDaemon } from "./daemon.js";
import { startDemoBotServer } from "./demo-bot.js";
import { runMcpStdioServer } from "./mcp.js";
import { ServerApiClient } from "./server-client.js";

export * from "./config.js";
export * from "./local-store.js";
export * from "./policy.js";
export * from "./adapters.js";
export * from "./server-client.js";
export * from "./daemon.js";
export * from "./webrtc.js";
export * from "./mcp.js";
export * from "./demo-bot.js";

function readPackageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== "string") {
    throw new Error("Missing version field in @agentshare/node package.json");
  }
  return pkg.version;
}

interface GlobalCliOptions {
  home?: string;
  server?: string;
  token?: string;
  json?: boolean;
}

function outputResult(data: unknown, humanText: string, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    process.stdout.write(`${humanText}\n`);
  }
}

function resolveApiClient(opts: GlobalCliOptions): {
  api: ServerApiClient;
  homeDir: string;
  serverUrl: string;
  token: string;
} {
  const homeDir = resolveHomeDir(opts.home);
  const session = loadSession(homeDir);
  const serverUrl = opts.server
    ? normalizeServerUrl(opts.server)
    : session?.serverUrl ?? process.env.AGENTSHARE_SERVER;
  const token = opts.token ?? session?.token ?? process.env.AGENTSHARE_TOKEN;
  if (!serverUrl) {
    throw new Error("Missing server URL. Pass --server <url> or run 'agentshare login'.");
  }
  if (!token) {
    throw new Error("Missing auth token. Pass --token <token> or run 'agentshare login'.");
  }
  return {
    api: new ServerApiClient({ serverUrl, token }),
    homeDir,
    serverUrl,
    token,
  };
}

async function callLocalDaemon<T>(
  homeDir: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const state = loadDaemonState(homeDir);
  if (!state) {
    throw new Error(
      `No running local node found in ${homeDir}. Start one with 'agentshare node start --handle <handle>'.`,
    );
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${state.localControlToken}`,
    accept: "application/json",
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${state.localControlUrl}${route}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const errMsg =
      typeof parsed["error"] === "string"
        ? parsed["error"]
        : `Local daemon request failed (HTTP ${res.status})`;
    throw new Error(errMsg);
  }
  return parsed as T;
}

function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals) => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve(signal);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

export function createCli(): Command {
  const program = new Command();
  program
    .name("agentshare")
    .description("AgentShareFlow v2 local agent node, P2P DM daemon, and MCP bridge")
    .version(readPackageVersion())
    .option("--home <dir>", "Home directory for identity, session, policy, and local.db")
    .option("--server <url>", "AgentShare server URL")
    .option("--token <token>", "Session bearer token")
    .option("--json", "Output machine-readable JSON", false);

  program
    .command("register")
    .description("Register a new account with an invite code and save session")
    .requiredOption("-u, --username <username>", "Lowercase username")
    .requiredOption("-p, --password <password>", "Account password (min 8 chars)")
    .requiredOption("-i, --invite <code>", "Server invite code")
    .option("-d, --display-name <name>", "Display name")
    .option("--server <url>", "Server URL")
    .action(async (cmdOpts: {
      username: string;
      password: string;
      invite: string;
      displayName?: string;
      server?: string;
    }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const serverUrl = normalizeServerUrl(
        cmdOpts.server ?? globals.server ?? process.env.AGENTSHARE_SERVER ?? "http://127.0.0.1:8787",
      );
      const api = new ServerApiClient({ serverUrl });
      const res = await api.register({
        username: cmdOpts.username,
        password: cmdOpts.password,
        displayName: cmdOpts.displayName,
        inviteCode: cmdOpts.invite,
      });
      saveSession(homeDir, { serverUrl, token: res.token, user: res.user });
      outputResult(
        { serverUrl, user: res.user },
        `Registered @${res.user.username} (${res.user.role}) on ${serverUrl}`,
        Boolean(globals.json),
      );
    });

  program
    .command("login")
    .description("Log in to an AgentShare server and save session")
    .requiredOption("-u, --username <username>", "Username")
    .requiredOption("-p, --password <password>", "Password")
    .option("--server <url>", "Server URL")
    .action(async (cmdOpts: {
      username: string;
      password: string;
      server?: string;
    }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const existing = loadSession(homeDir);
      const serverUrl = normalizeServerUrl(
        cmdOpts.server ??
          globals.server ??
          existing?.serverUrl ??
          process.env.AGENTSHARE_SERVER ??
          "http://127.0.0.1:8787",
      );
      const api = new ServerApiClient({ serverUrl });
      const res = await api.login({
        username: cmdOpts.username,
        password: cmdOpts.password,
      });
      saveSession(homeDir, { serverUrl, token: res.token, user: res.user });
      outputResult(
        { serverUrl, user: res.user },
        `Logged in as @${res.user.username} (${res.user.role}) on ${serverUrl}`,
        Boolean(globals.json),
      );
    });

  const nodeCmd = program
    .command("node")
    .description("Manage the local AgentShare node daemon");

  nodeCmd
    .command("start")
    .description("Start the local P2P node daemon and connect to the server")
    .requiredOption("--handle <handle>", "Unique node handle (without @)")
    .option("--display-name <name>", "Display name")
    .option("--description <text>", "Node description", "")
    .option("--capabilities <csv>", "Comma-separated capability tags", "")
    .option("--port <port>", "Direct P2P HTTP listen port (0 for random)", "0")
    .option("--bind <host>", "Direct P2P HTTP bind host", "127.0.0.1")
    .option("--advertise <url>", "Advertised direct URL (or 'none' to disable direct URL)")
    .option("--local-port <port>", "Local 127.0.0.1 control API port (0 for random)", "0")
    .option("--adapter <kind>", "Adapter kind: mcp | http | a2a | cli", "mcp")
    .option("--endpoint <url>", "HTTP or A2A agent endpoint URL")
    .option("--token-env <name>", "Environment variable name holding endpoint Bearer token")
    .option("--cmd <command>", "CLI agent command (tokenized safely without shell)")
    .option("--policy <path>", "Path to local policy.json")
    .option("--allow-private", "Allow private/loopback Direct P2P and HTTP/A2A targets", false)
    .option("--no-webrtc", "Disable WebRTC DataChannel P2P transport")
    .option("--stun <urls>", "Comma-separated STUN/TURN URLs (or 'none' to disable STUN)")
    .option("--server <url>", "Server URL override")
    .option("--token <token>", "Auth token override")
    .action(async (cmdOpts: {
      handle: string;
      displayName?: string;
      description: string;
      capabilities: string;
      port: string;
      bind: string;
      advertise?: string;
      localPort: string;
      adapter: string;
      endpoint?: string;
      tokenEnv?: string;
      cmd?: string;
      policy?: string;
      allowPrivate: boolean;
      webrtc: boolean;
      stun?: string;
      server?: string;
      token?: string;
    }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const { homeDir, serverUrl, token } = resolveApiClient({
        ...globals,
        server: cmdOpts.server ?? globals.server,
        token: cmdOpts.token ?? globals.token,
      });

      let adapter: AgentAdapter;
      switch (cmdOpts.adapter) {
        case "mcp":
          adapter = new McpPassiveAdapter();
          break;
        case "http":
        case "a2a": {
          if (!cmdOpts.endpoint) {
            throw new Error(`Adapter '${cmdOpts.adapter}' requires --endpoint <url>`);
          }
          adapter = new HttpAgentAdapter({
            mode: cmdOpts.adapter,
            endpoint: cmdOpts.endpoint,
            tokenEnv: cmdOpts.tokenEnv,
            allowPrivate: cmdOpts.allowPrivate,
          });
          break;
        }
        case "cli": {
          if (!cmdOpts.cmd) {
            throw new Error("Adapter 'cli' requires --cmd <command>");
          }
          const parsed = splitCommandLine(cmdOpts.cmd);
          adapter = new CliAgentAdapter({
            command: parsed.command,
            args: parsed.args,
          });
          break;
        }
        default:
          throw new Error(`Unsupported adapter '${cmdOpts.adapter}'. Use mcp, http, a2a, or cli.`);
      }

      const advertiseUrl =
        cmdOpts.advertise === undefined
          ? undefined
          : cmdOpts.advertise.toLowerCase() === "none"
            ? null
            : cmdOpts.advertise;

      const capabilities = cmdOpts.capabilities
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);

      const iceServers =
        cmdOpts.stun === undefined
          ? undefined
          : cmdOpts.stun.trim().toLowerCase() === "none" || cmdOpts.stun.trim() === ""
            ? []
            : cmdOpts.stun
                .split(",")
                .map((u) => u.trim())
                .filter(Boolean)
                .map((urls) => ({ urls }));

      const daemon = new AgentNodeDaemon({
        homeDir,
        serverUrl,
        token,
        handle: cmdOpts.handle,
        displayName: cmdOpts.displayName,
        description: cmdOpts.description,
        capabilities,
        adapter,
        policyPath: cmdOpts.policy,
        bindHost: cmdOpts.bind,
        port: Number(cmdOpts.port),
        advertiseUrl,
        localControlPort: Number(cmdOpts.localPort),
        allowPrivate: cmdOpts.allowPrivate,
        enableWebRtc: cmdOpts.webrtc,
        ...(iceServers !== undefined ? { iceServers } : {}),
        onLog: (msg) => process.stderr.write(`[agentshare] ${msg}\n`),
      });

      const state = await daemon.start();
      outputResult(
        state,
        [
          `AgentShare node @${state.handle} online`,
          `  Node ID:        ${state.nodeId}`,
          `  Server:         ${state.serverUrl}`,
          `  Adapter:        ${adapter.kind}`,
          `  Direct P2P URL: ${state.directUrl ?? "(none)"}`,
          `  Local Control:  ${state.localControlUrl}`,
          `  Local Token:    ${state.localControlToken}`,
          `  WebRTC P2P:     ${daemon.webrtcEnabled ? "ON" : "OFF"}`,
          `  Relay Fallback: ${daemon.relayEnabled ? "ON" : "OFF (P2P Only)"}`,
        ].join("\n"),
        Boolean(globals.json),
      );

      await waitForShutdownSignal();
      await daemon.close();
    });

  program
    .command("mcp")
    .description("Run the JSON-RPC 2.0 MCP stdio bridge for Claude Code / Cursor / Codex")
    .action(async (_cmdOpts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const server = runMcpStdioServer({
        homeDir: globals.home,
        serverUrl: globals.server,
        token: globals.token,
      });
      await waitForShutdownSignal();
      server.stop();
    });

  program
    .command("dm <peer> <message>")
    .description("Send an E2EE P2P direct message via the running local node daemon")
    .option("--force-relay", "Force encrypted relay transport", false)
    .action(async (peer: string, message: string, cmdOpts: { forceRelay: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const res = await callLocalDaemon<{
        message: { id: string; peerHandle: string; transport: string };
        transport: string;
      }>(homeDir, "POST", "/local/dms", {
        peer,
        content: message,
        forceRelay: cmdOpts.forceRelay,
      });
      outputResult(
        res,
        `Sent E2EE DM to @${res.message.peerHandle} via ${res.transport} (id=${res.message.id})`,
        Boolean(globals.json),
      );
    });

  const roomCmd = program
    .command("room")
    .description("List, create, read, and post messages in rooms");

  roomCmd
    .command("list")
    .description("List rooms you belong to")
    .action(async (_cmdOpts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const { api } = resolveApiClient(globals);
      const { rooms } = await api.listRooms();
      const lines =
        rooms.length === 0
          ? "No rooms."
          : rooms
              .map(
                (r) =>
                  `#${r.slug} (${r.id}) — ${r.name} [unread=${r.unreadCount ?? 0}, mentions=${r.mentionCount ?? 0}]`,
              )
              .join("\n");
      outputResult({ rooms }, lines, Boolean(globals.json));
    });

  roomCmd
    .command("create <name>")
    .description("Create a new room")
    .option("--slug <slug>", "Optional URL slug")
    .option("--topic <topic>", "Room topic")
    .option("--max-hops <n>", "Max agent auto-reply hops")
    .action(async (name: string, cmdOpts: {
      slug?: string;
      topic?: string;
      maxHops?: string;
    }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const { api } = resolveApiClient(globals);
      const { room } = await api.createRoom({
        name,
        slug: cmdOpts.slug,
        topic: cmdOpts.topic,
        ...(cmdOpts.maxHops ? { maxAgentHops: Number(cmdOpts.maxHops) } : {}),
      });
      outputResult(
        { room },
        `Created room #${room.slug} (${room.id})`,
        Boolean(globals.json),
      );
    });

  roomCmd
    .command("read <room>")
    .description("Read messages from a room (by ID or slug)")
    .option("--since <seq>", "Only show messages after seq")
    .option("--limit <n>", "Maximum messages to return", "50")
    .action(async (room: string, cmdOpts: { since?: string; limit: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const { api } = resolveApiClient(globals);
      const { messages } = await api.listRoomMessages(room, {
        ...(cmdOpts.since ? { sinceSeq: Number(cmdOpts.since) } : {}),
        limit: Number(cmdOpts.limit),
      });
      const lines =
        messages.length === 0
          ? "No messages."
          : messages
              .map((m) => `[#${m.seq}] @${m.senderHandle} (${m.senderType}): ${m.content}`)
              .join("\n");
      outputResult({ room, messages }, lines, Boolean(globals.json));
    });

  roomCmd
    .command("send <room> <message>")
    .description("Post a message to a room")
    .option("--reset-loop", "Reset agent loop-breaker chain", false)
    .action(async (room: string, message: string, cmdOpts: { resetLoop: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const { api } = resolveApiClient(globals);
      const { message: posted } = await api.sendRoomMessage(room, {
        content: message,
        ...(cmdOpts.resetLoop ? { resetLoop: true } : {}),
      });
      outputResult(
        { message: posted },
        `Posted [#${posted.seq}] to ${room}: ${posted.content}`,
        Boolean(globals.json),
      );
    });

  const pairCmd = program
    .command("pair")
    .description("Create or redeem one-time peer pairing codes");

  pairCmd
    .command("create")
    .description("Create a temporary pair code to authorize a peer")
    .option("--node-id <id>", "Restrict to a specific node ID")
    .option("--max-uses <n>", "Maximum uses", "1")
    .option("--expires <minutes>", "Expiry in minutes", "60")
    .action(async (cmdOpts: { nodeId?: string; maxUses: string; expires: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const { api } = resolveApiClient(globals);
      const { pairCode } = await api.createPairCode({
        nodeId: cmdOpts.nodeId,
        maxUses: Number(cmdOpts.maxUses),
        expiresInMinutes: Number(cmdOpts.expires),
      });
      outputResult(
        { pairCode },
        `Pair code: ${pairCode.code} (expires ${new Date(pairCode.expiresAt).toISOString()})`,
        Boolean(globals.json),
      );
    });

  pairCmd
    .command("redeem <code>")
    .description("Redeem a peer pair code")
    .action(async (code: string, _cmdOpts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const { api } = resolveApiClient(globals);
      const res = await api.redeemPairCode(code);
      const handles = res.nodes.map((n) => `@${n.handle}`).join(", ") || "(none online)";
      outputResult(
        res,
        `Paired! Authorized nodes: ${handles}`,
        Boolean(globals.json),
      );
    });

  const approvalsCmd = program
    .command("approvals")
    .description("Inspect and approve/reject local manual_approval requests");

  approvalsCmd
    .command("list")
    .description("List local approval requests")
    .option("--status <status>", "Filter by status: pending | approved | rejected | all", "pending")
    .action(async (cmdOpts: { status: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const res = await callLocalDaemon<{
        approvals: Array<{
          id: string;
          kind: string;
          fromHandle: string;
          status: string;
          content: string;
        }>;
      }>(homeDir, "GET", `/local/approvals?status=${encodeURIComponent(cmdOpts.status)}`);
      const lines =
        res.approvals.length === 0
          ? "No approval requests."
          : res.approvals
              .map((a) => `${a.id} [${a.status}] (${a.kind}) from @${a.fromHandle}: ${a.content}`)
              .join("\n");
      outputResult(res, lines, Boolean(globals.json));
    });

  approvalsCmd
    .command("approve <id>")
    .description("Approve a pending local request and execute adapter reply")
    .action(async (id: string, _cmdOpts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const res = await callLocalDaemon<{ ok: boolean; reply: string | null }>(
        homeDir,
        "POST",
        `/local/approvals/${encodeURIComponent(id)}/approve`,
      );
      outputResult(
        res,
        `Approved ${id}${res.reply ? ` — reply: ${res.reply}` : ""}`,
        Boolean(globals.json),
      );
    });

  approvalsCmd
    .command("reject <id>")
    .description("Reject a pending local request")
    .action(async (id: string, _cmdOpts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const res = await callLocalDaemon<{ ok: boolean }>(
        homeDir,
        "POST",
        `/local/approvals/${encodeURIComponent(id)}/reject`,
      );
      outputResult(res, `Rejected ${id}`, Boolean(globals.json));
    });

  program
    .command("demo-bot")
    .description("Run a lightweight local HTTP demo bot (supports context + 'ping @handle')")
    .option("--port <port>", "HTTP listen port", "9901")
    .option("--host <host>", "HTTP bind host", "127.0.0.1")
    .option("--name <name>", "Bot display name / handle", "helper-bot")
    .action(async (cmdOpts: { port: string; host: string; name: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalCliOptions>();
      const bot = await startDemoBotServer({
        port: Number(cmdOpts.port),
        host: cmdOpts.host,
        name: cmdOpts.name,
      });
      outputResult(
        { name: bot.name, url: bot.url, port: bot.port },
        `Demo bot '${bot.name}' listening at ${bot.url}`,
        Boolean(globals.json),
      );
      await waitForShutdownSignal();
      await bot.close();
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const cli = createCli();
  await cli.parseAsync(argv);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(path.resolve(entry))
    );
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(entry);
  }
}

if (isMainModule()) {
  runCli().catch((err) => {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
