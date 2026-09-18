import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AgentManifest,
  OWNER_PATTERN,
  extractPackTarball,
  formatIssues,
  formatScanFinding,
  parseManifest,
  scanPack,
} from "@agentshare/core";
import { Hono } from "hono";
import { type PackRow, type RegistryDb } from "./db.js";
import { resolveOwner } from "./identity.js";
import type { OidcConfig } from "./oidc.js";

function pick(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function toSummary(row: PackRow, stars: number) {
  return {
    owner: row.owner,
    name: row.name,
    version: row.version,
    title: row.title,
    description: row.description,
    mode: row.mode,
    tags: JSON.parse(row.tags) as string[],
    downloads: row.downloads,
    stars,
    createdAt: row.created_at,
  };
}

function toDetail(row: PackRow, versions: string[], stars: number, starred?: boolean) {
  return {
    ...toSummary(row, stars),
    digest: row.digest,
    size: row.size,
    downloadUrl: `/api/v1/agents/${row.owner}/${row.name}/${row.version}/download`,
    manifest: JSON.parse(row.manifest) as AgentManifest,
    versions,
    ...starred === undefined ? {} : { starred },
  };
}

export interface PackRouteDeps {
  db: RegistryDb;
  packsDir: string;
  oidc?: OidcConfig;
}

export function createPackRoutes({ db, packsDir, oidc }: PackRouteDeps): Hono {
  const app = new Hono();

  app.get("/search", (c) => {
    const query = (c.req.query("q") ?? "").trim();
    const mode = c.req.query("mode");
    return c.json({
      items: db.search(query, mode).map((row) => toSummary(row, db.countStars(row.owner, row.name))),
    });
  });

  app.get("/agents/:owner/:name", async (c) => {
    const { owner, name } = c.req.param();
    const versions = db.versions(owner, name);
    const latest = versions.at(-1);
    if (!latest) return c.json({ error: "not found" }, 404);
    const who = await resolveOwner(c, oidc);
    return c.json(
      toDetail(
        latest,
        versions.map((row) => row.version),
        db.countStars(owner, name),
        who === undefined ? undefined : db.hasStar(who, owner, name),
      ),
    );
  });

  app.get("/agents/:owner/:name/:version", async (c) => {
    const { owner, name, version } = c.req.param();
    const row = db.get(owner, name, version);
    if (!row) return c.json({ error: "not found" }, 404);
    const who = await resolveOwner(c, oidc);
    return c.json(
      toDetail(
        row,
        db.versions(owner, name).map((entry) => entry.version),
        db.countStars(owner, name),
        who === undefined ? undefined : db.hasStar(who, owner, name),
      ),
    );
  });

  app.get("/agents/:owner/:name/:version/download", (c) => {
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

  app.post("/agents/:owner/:name/star", async (c) => {
    const who = await resolveOwner(c, oidc);
    if (!who) return c.json({ error: "unauthorized" }, 401);
    const { owner, name } = c.req.param();
    if (!db.latest(owner, name)) return c.json({ error: "not found" }, 404);
    db.addStar(who, owner, name, new Date().toISOString());
    return c.json({ starred: true, stars: db.countStars(owner, name) });
  });

  app.delete("/agents/:owner/:name/star", async (c) => {
    const who = await resolveOwner(c, oidc);
    if (!who) return c.json({ error: "unauthorized" }, 401);
    const { owner, name } = c.req.param();
    if (!db.latest(owner, name)) return c.json({ error: "not found" }, 404);
    db.removeStar(who, owner, name);
    return c.json({ starred: false, stars: db.countStars(owner, name) });
  });

  app.post("/agents", async (c) => {
    const owner = await resolveOwner(c, oidc);
    if (!owner) return c.json({ error: "unauthorized" }, 401);
    if (!OWNER_PATTERN.test(owner)) {
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
      return c.json(
        { error: "digest mismatch", details: `expected ${declared}, got ${digest}` },
        400,
      );
    }

    if (db.get(owner, manifest.name, manifest.version)) {
      return c.json(
        {
          error: `${owner}/${manifest.name}@${manifest.version} already exists, releases are immutable`,
        },
        409,
      );
    }

    const scanTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "agentshare-publish-"));
    try {
      const tarballPath = path.join(scanTmp, "pack.tgz");
      await fsp.writeFile(tarballPath, bytes);
      const extracted = path.join(scanTmp, "pack");
      try {
        await extractPackTarball(tarballPath, extracted);
      } catch (error) {
        return c.json(
          { error: "invalid tarball", details: error instanceof Error ? error.message : String(error) },
          400,
        );
      }
      const report = await scanPack(extracted);
      if (report.blocked) {
        return c.json(
          {
            error: "pack blocked by the security scan",
            details: report.findings
              .filter((finding) => finding.severity === "high")
              .map(formatScanFinding)
              .join("; "),
          },
          400,
        );
      }
    } finally {
      await fsp.rm(scanTmp, { recursive: true, force: true });
    }

    const dir = path.join(packsDir, owner, manifest.name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${manifest.version}.tgz`);
    fs.writeFileSync(file, bytes);

    db.insert({
      owner: owner,
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
        ref: `${owner}/${manifest.name}@${manifest.version}`,
        digest,
        size: bytes.length,
      },
      201,
    );
  });

  return app;
}
