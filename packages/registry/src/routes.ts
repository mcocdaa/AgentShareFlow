import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AgentManifest,
  OWNER_PATTERN,
  formatIssues,
  parseManifest,
} from "@agentshare/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authenticate } from "./auth.js";
import { type PackRow, RegistryDb } from "./db.js";
import { ShareHub } from "./share-hub.js";
import { createShareRoutes } from "./share-routes.js";

interface AppOptions {
  dataDir: string;
}

function pick(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function toSummary(row: PackRow) {
  return {
    owner: row.owner,
    name: row.name,
    version: row.version,
    title: row.title,
    description: row.description,
    mode: row.mode,
    tags: JSON.parse(row.tags) as string[],
    downloads: row.downloads,
    createdAt: row.created_at,
  };
}

function toDetail(row: PackRow, versions: string[]) {
  return {
    ...toSummary(row),
    digest: row.digest,
    size: row.size,
    downloadUrl: `/api/v1/agents/${row.owner}/${row.name}/${row.version}/download`,
    manifest: JSON.parse(row.manifest) as AgentManifest,
    versions,
  };
}

export function createApp({ dataDir }: AppOptions): Hono {
  const packsDir = path.join(dataDir, "packs");
  fs.mkdirSync(packsDir, { recursive: true });
  const db = new RegistryDb(path.join(dataDir, "registry.db"));
  const hub = new ShareHub();

  const app = new Hono();
  app.use("*", cors());
  app.route("/api/v1", createShareRoutes({ db, hub }));

  app.get("/", (c) =>
    c.json({ name: "agentshare-registry", spec: "agent-pack/v0", api: "/api/v1" }),
  );

  app.get("/healthz", (c) => c.json({ ok: true, packs: db.count() }));

  app.get("/api/v1/search", (c) => {
    const query = (c.req.query("q") ?? "").trim();
    const mode = c.req.query("mode");
    return c.json({ items: db.search(query, mode).map(toSummary) });
  });

  app.get("/api/v1/agents/:owner/:name", (c) => {
    const { owner, name } = c.req.param();
    const versions = db.versions(owner, name);
    const latest = versions.at(-1);
    if (!latest) return c.json({ error: "not found" }, 404);
    return c.json(toDetail(latest, versions.map((row) => row.version)));
  });

  app.get("/api/v1/agents/:owner/:name/:version", (c) => {
    const { owner, name, version } = c.req.param();
    const row = db.get(owner, name, version);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(toDetail(row, db.versions(owner, name).map((entry) => entry.version)));
  });

  app.get("/api/v1/agents/:owner/:name/:version/download", (c) => {
    const { owner, name, version } = c.req.param();
    const row = db.get(owner, name, version);
    if (!row) return c.json({ error: "not found" }, 404);
    db.bumpDownloads(owner, name, version);
    return new Response(fs.readFileSync(row.file), {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${name}-${version}.tgz"`,
      },
    });
  });

  app.post("/api/v1/agents", async (c) => {
    const auth = authenticate(c.req.header("authorization"));
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    if (!OWNER_PATTERN.test(auth.owner)) {
      return c.json({ error: "invalid owner namespace" }, 400);
    }

    const body = await c.req.parseBody();
    const manifestRaw = pick(body["manifest"]);
    const tarball = pick(body["tarball"]);
    if (typeof manifestRaw !== "string") {
      return c.json({ error: "manifest field is required (JSON string)" }, 400);
    }
    if (!(tarball instanceof File)) {
      return c.json({ error: "tarball field is required (application/gzip)" }, 400);
    }

    let manifest: AgentManifest;
    try {
      manifest = parseManifest(JSON.parse(manifestRaw));
    } catch (error) {
      return c.json({ error: "invalid manifest", details: formatIssues(error) }, 400);
    }

    const bytes = new Uint8Array(await tarball.arrayBuffer());
    if (bytes.length === 0) return c.json({ error: "empty tarball" }, 400);

    const digest = createHash("sha256").update(bytes).digest("hex");
    const declared = c.req.header("x-pack-digest");
    if (declared && declared !== digest) {
      return c.json({ error: "digest mismatch", details: `expected ${declared}, got ${digest}` }, 400);
    }

    if (db.get(auth.owner, manifest.name, manifest.version)) {
      return c.json(
        { error: `${auth.owner}/${manifest.name}@${manifest.version} already exists, releases are immutable` },
        409,
      );
    }

    const dir = path.join(packsDir, auth.owner, manifest.name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${manifest.version}.tgz`);
    fs.writeFileSync(file, bytes);

    db.insert({
      owner: auth.owner,
      name: manifest.name,
      version: manifest.version,
      title: manifest.title,
      description: manifest.description,
      mode: manifest.mode,
      tags: JSON.stringify(manifest.tags),
      manifest: JSON.stringify(manifest),
      digest,
      size: bytes.length,
      file,
      created_at: new Date().toISOString(),
    });

    return c.json(
      {
        ok: true,
        ref: `${auth.owner}/${manifest.name}@${manifest.version}`,
        digest,
        size: bytes.length,
      },
      201,
    );
  });

  return app;
}
