import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { RegistryDb } from "./db.js";
import { createPackRoutes } from "./pack-routes.js";
import { ShareHub } from "./share-hub.js";
import { createShareRoutes } from "./share-routes.js";

export interface AppOptions {
  dataDir: string;
  publicUrl?: string;
  webDir?: string;
  a2aReplyTimeoutMs?: number;
}

export function createApp({ dataDir, publicUrl, webDir, a2aReplyTimeoutMs }: AppOptions): Hono {
  const packsDir = path.join(dataDir, "packs");
  fs.mkdirSync(packsDir, { recursive: true });
  const db = new RegistryDb(path.join(dataDir, "registry.db"));
  const hub = new ShareHub();

  const app = new Hono();
  app.use("*", cors());

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

  app.route("/api/v1", createPackRoutes({ db, packsDir }));
  app.route(
    "/api/v1",
    createShareRoutes({
      db,
      hub,
      ...publicUrl === undefined ? {} : { publicUrl },
      ...a2aReplyTimeoutMs === undefined ? {} : { a2aReplyTimeoutMs },
    }),
  );

  return app;
}
