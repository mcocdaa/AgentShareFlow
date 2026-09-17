import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const dataDir = path.resolve(process.env.AGENTSHARE_DATA ?? "data");
const publicUrl = process.env.AGENTSHARE_PUBLIC_URL;
const webDir = path.resolve(process.env.AGENTSHARE_WEB_DIR ?? path.join(here, "..", "..", "web", "dist"));
const app = createApp({
  dataDir,
  webDir,
  ...publicUrl === undefined ? {} : { publicUrl },
});

serve({ fetch: app.fetch, port }, (info) => {
  const authMode = process.env.AGENTSHARE_TOKENS ? "token list" : "dev (any token accepted)";
  console.log(`agentshare registry listening on http://localhost:${info.port}`);
  console.log(`data dir: ${dataDir}`);
  console.log(`web dir: ${webDir}`);
  console.log(`public url: ${publicUrl ?? `http://localhost:${info.port}`}`);
  console.log(`auth mode: ${authMode}`);
});
