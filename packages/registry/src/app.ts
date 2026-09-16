import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { RegistryDb } from "./db.js";
import { createPackRoutes } from "./pack-routes.js";
import { ShareHub } from "./share-hub.js";
import { createShareRoutes } from "./share-routes.js";

export interface AppOptions {
  dataDir: string;
}

export function createApp({ dataDir }: AppOptions): Hono {
  const packsDir = path.join(dataDir, "packs");
  fs.mkdirSync(packsDir, { recursive: true });
  const db = new RegistryDb(path.join(dataDir, "registry.db"));
  const hub = new ShareHub();

  const app = new Hono();
  app.use("*", cors());

  app.get("/", (c) =>
    c.json({ name: "agentshare-registry", spec: "agent-pack/v0", api: "/api/v1" }),
  );

  app.get("/healthz", (c) => c.json({ ok: true, packs: db.count() }));

  app.route("/api/v1", createPackRoutes({ db, packsDir }));
  app.route("/api/v1", createShareRoutes({ db, hub }));

  return app;
}
