import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../packages/server/dist/index.js";
import {
  AgentNodeDaemon,
  HttpAgentAdapter,
  ServerApiClient,
  saveSession,
  startDemoBotServer,
} from "../packages/node/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");
const adminUser = process.env.AGENTSHARE_ADMIN_USER ?? "admin";
const adminPass = process.env.AGENTSHARE_ADMIN_PASS ?? "admin1234";
const demoRoot =
  process.env.AGENTSHARE_DEMO_DIR ??
  path.join(os.tmpdir(), "agentshare-v2-demo");

const serverDataDir = path.join(demoRoot, "server");
const botHomeDir = path.join(demoRoot, "helper-bot");
const mcpHomeDir = path.join(demoRoot, "local-mcp");
mkdirSync(serverDataDir, { recursive: true });
mkdirSync(botHomeDir, { recursive: true });
mkdirSync(mcpHomeDir, { recursive: true });

async function main() {
  const server = await startServer({
    host,
    port,
    dataDir: serverDataDir,
    dbPath: path.join(serverDataDir, "server.db"),
    relayEnabled: false,
    adminUser,
    adminPass,
    webDistDir: path.resolve(repoRoot, "packages/web/dist"),
  });

  const api = new ServerApiClient({ serverUrl: server.url });
  const login = await api.login({ username: adminUser, password: adminPass });
  api.setToken(login.token);
  saveSession(mcpHomeDir, {
    serverUrl: server.url,
    token: login.token,
    user: login.user,
  });

  const { rooms } = await api.listRooms();
  let general = rooms.find((r) => r.slug === "general");
  if (!general) {
    const created = await api.createRoom({
      name: "General",
      slug: "general",
      topic: "Welcome to AgentShare v2 — mention @helper-bot to test!",
    });
    general = created.room;
  }

  const { invite } = await api.createInvite({
    maxUses: 20,
    expiresInHours: 168,
    role: "member",
  });

  const demoBot = await startDemoBotServer({
    host: "127.0.0.1",
    port: 0,
    name: "helper-bot",
  });

  const botDaemon = new AgentNodeDaemon({
    homeDir: botHomeDir,
    serverUrl: server.url,
    token: login.token,
    handle: "helper-bot",
    displayName: "Helper Bot",
    description: "Built-in local HTTP demo agent (supports room context & 'ping @handle')",
    capabilities: ["chat", "context", "loop-demo"],
    adapter: new HttpAgentAdapter({
      mode: "http",
      endpoint: demoBot.url,
      allowPrivate: true,
    }),
    bindHost: "127.0.0.1",
    port: 0,
    allowPrivate: true,
    onLog: (msg) => process.stderr.write(`[helper-bot] ${msg}\n`),
  });

  const botState = await botDaemon.start();
  await botDaemon.subscribeRoom(general.id);

  const mcpConfig = {
    mcpServers: {
      agentshare: {
        command: "node",
        args: [path.resolve(repoRoot, "packages/node/dist/index.js"), "mcp"],
        env: {
          AGENTSHARE_HOME: mcpHomeDir,
        },
      },
    },
  };

  console.log("");
  console.log("==============================================================");
  console.log("  AgentShareFlow v2 Demo Ready");
  console.log("==============================================================");
  console.log(`  Web UI / API:    ${server.url}`);
  console.log(`  Default Room:    #${general.slug} (${general.id})`);
  console.log(`  Admin Login:     ${adminUser} / ${adminPass}`);
  console.log(`  Invite Code:     ${invite.code}`);
  console.log("  Relay Fallback:  OFF (P2P Direct Only — toggle in Admin UI)");
  console.log("");
  console.log("  Active Demo Bot: @helper-bot");
  console.log(`    HTTP Endpoint: ${demoBot.url}`);
  console.log(`    Direct P2P:    ${botState.directUrl}`);
  console.log(`    Local Control: ${botState.localControlUrl}`);
  console.log(`    Local Token:   ${botState.localControlToken}`);
  console.log("");
  console.log("  Ready-to-paste MCP client config (Claude Code / Cursor / Codex):");
  console.log(JSON.stringify(mcpConfig, null, 2));
  console.log("");
  console.log("  Press Ctrl+C to stop.");
  console.log("==============================================================");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down AgentShareFlow demo...");
    await botDaemon.close().catch(() => {});
    await demoBot.close().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("Failed to start AgentShareFlow demo:", err);
  process.exit(1);
});
