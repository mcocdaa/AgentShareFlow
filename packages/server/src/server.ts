import { DEFAULT_MAX_AGENT_HOPS } from "@agentshare/core";
import { parseStunUrls, startServer } from "./index.js";

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : fallback;
}

function parseMaxHops(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_AGENT_HOPS;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 50
    ? parsed
    : DEFAULT_MAX_AGENT_HOPS;
}

const port = parsePort(process.env.PORT, 8787);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = process.env.AGENTSHARE_DATA;
const relayEnabled =
  process.env.AGENTSHARE_ENABLE_RELAY !== undefined
    ? process.env.AGENTSHARE_ENABLE_RELAY === "true"
    : undefined;
const maxAgentHops = parseMaxHops(process.env.AGENTSHARE_MAX_AGENT_HOPS);
const iceServers = parseStunUrls(process.env.AGENTSHARE_STUN_URLS);

const server = await startServer({
  port,
  host,
  dataDir,
  publicUrl: process.env.AGENTSHARE_PUBLIC_URL,
  relayEnabled,
  maxAgentHops,
  iceServers,
  adminUser: process.env.AGENTSHARE_ADMIN_USER,
  adminPass: process.env.AGENTSHARE_ADMIN_PASS,
  bootstrapInvite: process.env.AGENTSHARE_BOOTSTRAP_INVITE,
});

console.log(`[agentshare-server] listening on ${server.url} (ws: ${server.wsUrl})`);
console.log(
  `[agentshare-server] relayEnabled=${server.db.getRelayEnabled()} maxAgentHops=${maxAgentHops} iceServers=${iceServers.length}`,
);
if (server.bootstrapInviteCode) {
  console.log(
    `[agentshare-server] bootstrap admin invite code: ${server.bootstrapInviteCode}`,
  );
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[agentshare-server] received ${signal}, shutting down...`);
  await server.close();
  process.exit(0);
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
