import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_AGENT_HOPS, type IceServerConfig } from "@agentshare/core";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import {
  bootstrapAuth,
  extractBearerToken,
  hashSessionToken,
  resolveSession,
} from "./auth.js";
import { ServerDb } from "./db.js";
import { ServerHub } from "./hub.js";

export { createApp, type CreateAppOptions } from "./app.js";
export {
  bootstrapAuth,
  extractBearerToken,
  hashPassword,
  hashSessionToken,
  mintSessionToken,
  resolveSession,
  revokeSession,
  verifyPassword,
} from "./auth.js";
export {
  DbError,
  ServerDb,
  type InviteRecord,
  type RoomMemberInfo,
  type RoomRow,
  type UserRow,
} from "./db.js";
export {
  ServerHub,
  type PostRoomMessageInput,
  type ServerHubOptions,
} from "./hub.js";

export const DEFAULT_STUN_URL = "stun:stun.l.google.com:19302";

export function parseStunUrls(value: string | undefined): IceServerConfig[] {
  if (value === undefined) {
    return [{ urls: DEFAULT_STUN_URL }];
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((urls) => ({ urls }));
}

export interface StartServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  dataDir?: string;
  publicUrl?: string;
  relayEnabled?: boolean;
  maxAgentHops?: number;
  iceServers?: IceServerConfig[];
  adminUser?: string;
  adminPass?: string;
  bootstrapInvite?: string;
  webDistDir?: string;
}

export interface StartedServer {
  port: number;
  url: string;
  wsUrl: string;
  bootstrapInviteCode: string | null;
  db: ServerDb;
  hub: ServerHub;
  close(): Promise<void>;
}

const DEFAULT_WEB_DIST_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);

export async function startServer(
  options: StartServerOptions = {},
): Promise<StartedServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 8787;

  const dbPath =
    options.dbPath ??
    (options.dataDir
      ? path.join(options.dataDir, "agentshare.db")
      : process.env.AGENTSHARE_DATA
        ? path.join(process.env.AGENTSHARE_DATA, "agentshare.db")
        : path.join(process.cwd(), "data", "agentshare.db"));

  const db = new ServerDb(dbPath);

  if (options.relayEnabled !== undefined) {
    db.setRelayEnabled(options.relayEnabled);
  } else if (db.getSetting("relay_enabled") === null) {
    db.setRelayEnabled(process.env.AGENTSHARE_ENABLE_RELAY === "true");
  }

  const maxAgentHops = options.maxAgentHops ?? DEFAULT_MAX_AGENT_HOPS;
  const iceServers =
    options.iceServers !== undefined
      ? options.iceServers
      : parseStunUrls(process.env.AGENTSHARE_STUN_URLS);
  const { bootstrapInviteCode } = bootstrapAuth(db, {
    adminUser: options.adminUser ?? process.env.AGENTSHARE_ADMIN_USER,
    adminPass: options.adminPass ?? process.env.AGENTSHARE_ADMIN_PASS,
    bootstrapInvite:
      options.bootstrapInvite ?? process.env.AGENTSHARE_BOOTSTRAP_INVITE,
  });

  const hub = new ServerHub(db, { iceServers });
  const app = createApp({
    db,
    hub,
    maxAgentHops,
    iceServers,
    webDistDir: options.webDistDir ?? DEFAULT_WEB_DIST_DIR,
  });

  const httpServer = createServer(getRequestListener(app.fetch));
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const token =
      url.searchParams.get("token")?.trim() ||
      extractBearerToken(req.headers.authorization);
    const user = token ? resolveSession(db, token) : null;
    if (!token || !user) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized",
      );
      socket.destroy();
      return;
    }

    const tokenHash = hashSessionToken(token);
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.handleConnection(ws, user, tokenHash);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      httpServer.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(requestedPort, host);
  });

  const address = httpServer.address() as AddressInfo;
  const port = address.port;
  const baseUrl = options.publicUrl
    ? options.publicUrl.replace(/\/+$/, "")
    : `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  const wsUrl = `${baseUrl.replace(/^http/i, "ws")}/ws`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    hub.close();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    db.close();
  };

  return {
    port,
    url: baseUrl,
    wsUrl,
    bootstrapInviteCode,
    db,
    hub,
    close,
  };
}
