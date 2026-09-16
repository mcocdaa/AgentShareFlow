import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./routes.js";

const port = Number(process.env.PORT ?? 8787);
const dataDir = path.resolve(process.env.AGENTSHARE_DATA ?? "data");
const app = createApp({ dataDir });

serve({ fetch: app.fetch, port }, (info) => {
  const authMode = process.env.AGENTSHARE_TOKENS ? "token list" : "dev (any token accepted)";
  console.log(`agentshare registry listening on http://localhost:${info.port}`);
  console.log(`data dir: ${dataDir}`);
  console.log(`auth mode: ${authMode}`);
});
