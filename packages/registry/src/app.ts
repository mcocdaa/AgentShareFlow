import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { RegistryDb } from "./db.js";
import { createOidcRoutes, oidcConfigFromEnv, oidcMiddleware } from "./oidc.js";
import { createPackRoutes } from "./pack-routes.js";
import { orgRoutes } from "./org-routes.js";
import { ShareHub } from "./share-hub.js";
import { createShareRoutes } from "./share-routes.js";
import { type IStorageDriver, LocalStorageDriver, createStorageDriverFromEnv } from "./storage.js";

export interface AppOptions {
  dataDir: string;
  publicUrl?: string;
  webDir?: string;
  a2aReplyTimeoutMs?: number;
  storage?: IStorageDriver;
}

export function createApp({
  dataDir,
  publicUrl,
  webDir,
  a2aReplyTimeoutMs,
  storage,
}: AppOptions): Hono {
  fs.mkdirSync(dataDir, { recursive: true });
  const packsDir = path.join(dataDir, "packs");
  fs.mkdirSync(packsDir, { recursive: true });
  const driver = storage ?? createStorageDriverFromEnv(packsDir);
  const db = new RegistryDb(path.join(dataDir, "registry.db"));
  const hub = new ShareHub();

  const app = new Hono();
  app.use("*", cors());

  const oidc = oidcConfigFromEnv();
  if (oidc !== undefined) app.use("*", oidcMiddleware(oidc));

  if (webDir !== undefined && fs.existsSync(path.join(webDir, "index.html"))) {
    app.use(
      "*",
      serveStatic({
        root: webDir,
        rewriteRequestPath: (requestPath) => (requestPath === "/" ? "/index.html" : requestPath),
      }),
    );
  }

  app.get("/api", (c) =>
    c.json({ name: "agentshare-registry", spec: "agent-pack/v0", api: "/api/v1" }),
  );

  app.get("/healthz", (c) => c.json({ ok: true, packs: db.count() }));

  if (oidc !== undefined) app.route("/api/v1", createOidcRoutes(oidc));
  app.route("/api/v1", orgRoutes(db, oidc));

  app.route(
    "/api/v1",
    createPackRoutes({
      db,
      packsDir,
      storage: driver,
      ...oidc === undefined ? {} : { oidc },
    }),
  );
  app.route(
    "/api/v1",
    createShareRoutes({
      db,
      hub,
      ...publicUrl === undefined ? {} : { publicUrl },
      ...a2aReplyTimeoutMs === undefined ? {} : { a2aReplyTimeoutMs },
      ...oidc === undefined ? {} : { oidc },
    }),
  );

  return app;
}
