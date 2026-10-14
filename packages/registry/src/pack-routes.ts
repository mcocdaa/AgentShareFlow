import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AgentManifest,
  OWNER_PATTERN,
  decodePublicKeyHeader,
  extractPackTarball,
  formatIssues,
  formatScanFinding,
  keyFingerprint,
  parseManifest,
  readPackReadme,
  scanPack,
  verifyDigest,
  parsePolicy,
  evaluatePolicy,
  executeInSandbox,
} from "@agentshare/core";
import { Hono } from "hono";
import { type PackRow, type RegistryDb } from "./db.js";
import { resolveOwner } from "./identity.js";
import type { OidcConfig } from "./oidc.js";
import { type IStorageDriver, LocalStorageDriver } from "./storage.js";

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
    visibility: row.visibility,
    createdAt: row.created_at,
  };
}

function toDetail(
  row: PackRow,
  versions: string[],
  stars: number,
  readme: string | null = null,
  starred?: boolean,
) {
  return {
    ...toSummary(row, stars),
    digest: row.digest,
    size: row.size,
    visibility: row.visibility,
    downloadUrl: `/api/v1/agents/${row.owner}/${row.name}/${row.version}/download`,
    readmeUrl: `/api/v1/agents/${row.owner}/${row.name}/${row.version}/readme`,
    readme,
    manifest: JSON.parse(row.manifest) as AgentManifest,
    versions,
    ...starred === undefined ? {} : { starred },
    ...row.public_key === null || row.signature === null
      ? {}
      : {
          signature: {
            algorithm: "ed25519" as const,
            publicKey: row.public_key,
            fingerprint: keyFingerprint(row.public_key),
            value: row.signature,
          },
        },
  };
}

const PLAYGROUND_WINDOW_MS = 60_000;
const PLAYGROUND_LIMIT_PER_WINDOW = 10;
const MAX_UPLOAD_TARBALL_BYTES = 25 * 1024 * 1024;

export async function getAuthenticatedUser(
  c: Parameters<typeof resolveOwner>[0],
  _db: RegistryDb,
  oidc?: OidcConfig,
): Promise<string | undefined> {
  return resolveOwner(c, oidc);
}

export interface PackRouteDeps {
  db: RegistryDb;
  packsDir: string;
  storage?: IStorageDriver;
  oidc?: OidcConfig;
}

export function createPackRoutes({ db, packsDir, storage, oidc }: PackRouteDeps): Hono {
  const app = new Hono();
  const driver: IStorageDriver = storage ?? new LocalStorageDriver(packsDir);
  const playgroundHits = new Map<string, number[]>();

  const allowPlayground = (key: string): boolean => {
    const now = Date.now();
    if (playgroundHits.size > 5000) {
      for (const [k, timestamps] of playgroundHits.entries()) {
        const active = timestamps.filter((t) => now - t < PLAYGROUND_WINDOW_MS);
        if (active.length === 0) playgroundHits.delete(k);
        else playgroundHits.set(k, active);
      }
      if (playgroundHits.size > 5000) {
        const oldest = playgroundHits.keys().next().value;
        if (oldest !== undefined) playgroundHits.delete(oldest);
      }
    }
    const recent = (playgroundHits.get(key) ?? []).filter((t) => now - t < PLAYGROUND_WINDOW_MS);
    if (recent.length >= PLAYGROUND_LIMIT_PER_WINDOW) {
      playgroundHits.set(key, recent);
      return false;
    }
    recent.push(now);
    playgroundHits.set(key, recent);
    return true;
  };

  app.get("/search", async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    const mode = c.req.query("mode");
    const who = await resolveOwner(c, oidc);
    const rows = db.search(query, mode).filter((row) => db.canUserReadPack(who, row.owner, row.visibility));
    return c.json({
      items: rows.map((row) => toSummary(row, db.countStars(row.owner, row.name))),
    });
  });

  app.get("/agents/:owner/:name", async (c) => {
    const { owner, name } = c.req.param();
    const who = await resolveOwner(c, oidc);
    const versions = db.versions(owner, name);
    const latest = versions.at(-1);
    if (!latest) return c.json({ error: "not found" }, 404);
    if (!db.canUserReadPack(who, latest.owner, latest.visibility)) {
      return c.json({ error: "not found" }, 404);
    }
    const totalDownloads = versions.reduce((sum, v) => sum + v.downloads, 0);
    const bytes = await driver.get(latest.file);
    const readme = bytes ? readPackReadme(bytes) : null;
    return c.json(
      toDetail(
        { ...latest, downloads: totalDownloads },
        versions.map((row) => row.version),
        db.countStars(owner, name),
        readme,
        who === undefined ? undefined : db.hasStar(who, owner, name),
      ),
    );
  });

  app.get("/agents/:owner/:name/:version", async (c) => {
    const { owner, name, version } = c.req.param();
    const who = await resolveOwner(c, oidc);
    const row = db.get(owner, name, version);
    if (!row) return c.json({ error: "not found" }, 404);
    if (!db.canUserReadPack(who, row.owner, row.visibility)) {
      return c.json({ error: "not found" }, 404);
    }
    const bytes = await driver.get(row.file);
    const readme = bytes ? readPackReadme(bytes) : null;
    return c.json(
      toDetail(
        row,
        db.versions(owner, name).map((entry) => entry.version),
        db.countStars(owner, name),
        readme,
        who === undefined ? undefined : db.hasStar(who, owner, name),
      ),
    );
  });

  app.get("/agents/:owner/:name/:version/readme", async (c) => {
    const { owner, name, version } = c.req.param();
    const who = await resolveOwner(c, oidc);
    const row = db.get(owner, name, version);
    if (!row) return c.json({ error: "not found" }, 404);
    if (!db.canUserReadPack(who, row.owner, row.visibility)) {
      return c.json({ error: "not found" }, 404);
    }
    const bytes = await driver.get(row.file);
    if (!bytes) return c.json({ error: "file not found" }, 404);
    const readme = readPackReadme(bytes);
    return c.json({ readme });
  });

  app.get("/agents/:owner/:name/:version/download", async (c) => {
    const { owner, name, version } = c.req.param();
    const who = await resolveOwner(c, oidc);
    const row = db.get(owner, name, version);
    if (!row) return c.json({ error: "not found" }, 404);
    if (!db.canUserReadPack(who, row.owner, row.visibility)) {
      return c.json({ error: "not found" }, 404);
    }
    db.bumpDownloads(owner, name, version);
    const data = await driver.get(row.file);
    if (!data) return c.json({ error: "file not found" }, 404);
    return new Response(Buffer.from(data), {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${name}-${version}.tgz"`,
      },
    });
  });

  app.post("/agents/:owner/:name/:version/playground", async (c) => {
    const who = await getAuthenticatedUser(c, db, oidc);
    if (!who) return c.json({ error: "unauthorized" }, 401);
    if (!allowPlayground(`playground:${who}`)) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }

    const { owner, name, version } = c.req.param();
    const row = db.get(owner, name, version);
    if (!row) return c.json({ error: "not found" }, 404);
    if (!db.canUserReadPack(who, row.owner, row.visibility)) {
      return c.json({ error: "not found" }, 404);
    }
    const data = await driver.get(row.file);
    if (!data) return c.json({ error: "file not found" }, 404);

    let body: { input?: unknown; entry?: string; entryScript?: string; timeoutMs?: number } = {};
    try {
      body = await c.req.json();
    } catch {
      // Optional JSON body
    }

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agentshare-playground-"));
    try {
      const tarballPath = path.join(tmpDir, "pack.tgz");
      await fsp.writeFile(tarballPath, Buffer.from(data));
      const extractedDir = path.join(tmpDir, "pack");
      await extractPackTarball(tarballPath, extractedDir);

      const result = await executeInSandbox({
        packDir: extractedDir,
        input: body.input,
        entryScript: body.entryScript ?? body.entry,
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 5000,
      });

      return c.json(result);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
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
    const callerOwner = await resolveOwner(c, oidc);
    if (!callerOwner) return c.json({ error: "unauthorized" }, 401);

    const targetOwner = (c.req.header("x-pack-owner") ?? callerOwner).toLowerCase();
    if (!OWNER_PATTERN.test(targetOwner)) {
      return c.json({ error: "invalid owner namespace" }, 400);
    }

    if (!db.canUserWritePack(callerOwner, targetOwner)) {
      return c.json({ error: `forbidden: you do not have permission to publish to ${targetOwner}` }, 403);
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
    if (tarball.size > MAX_UPLOAD_TARBALL_BYTES) {
      return c.json({ error: "tarball exceeds maximum allowed size (25 MiB)" }, 400);
    }

    let manifest: AgentManifest;
    let rawSubmittedManifest: Record<string, unknown>;
    try {
      const parsedRaw: unknown = JSON.parse(manifestRaw);
      rawSubmittedManifest =
        typeof parsedRaw === "object" && parsedRaw !== null
          ? (parsedRaw as Record<string, unknown>)
          : {};
      manifest = parseManifest(parsedRaw);
    } catch (error) {
      return c.json({ error: "invalid manifest", details: formatIssues(error) }, 400);
    }

    const bytes = new Uint8Array(await tarball.arrayBuffer());
    if (bytes.length === 0) return c.json({ error: "empty tarball" }, 400);
    if (bytes.length > MAX_UPLOAD_TARBALL_BYTES) {
      return c.json({ error: "tarball exceeds maximum allowed size (25 MiB)" }, 400);
    }

    const digest = createHash("sha256").update(bytes).digest("hex");
    const declared = c.req.header("x-pack-digest");
    if (declared && declared !== digest) {
      return c.json(
        { error: "digest mismatch", details: `expected ${declared}, got ${digest}` },
        400,
      );
    }

    const publicKeyHeader = c.req.header("x-pack-public-key");
    const signature = c.req.header("x-pack-signature");
    if ((publicKeyHeader === undefined) !== (signature === undefined)) {
      return c.json({ error: "signing requires both x-pack-public-key and x-pack-signature" }, 400);
    }
    let publicKey: string | null = null;
    if (publicKeyHeader !== undefined && signature !== undefined) {
      try {
        publicKey = decodePublicKeyHeader(publicKeyHeader);
      } catch {
        return c.json({ error: "invalid public key" }, 400);
      }
      if (!verifyDigest(publicKey, digest, signature)) {
        return c.json({ error: "invalid signature" }, 400);
      }
    }

    if (db.get(targetOwner, manifest.name, manifest.version)) {
      return c.json(
        {
          error: `${targetOwner}/${manifest.name}@${manifest.version} already exists, releases are immutable`,
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

      const extractedManifestPath = path.join(extracted, "agent.json");
      if (!fs.existsSync(extractedManifestPath)) {
        return c.json(
          { error: "invalid tarball", details: "agent.json is missing from the tarball archive" },
          400,
        );
      }
      let archiveManifest: AgentManifest;
      let rawArchiveManifest: Record<string, unknown>;
      try {
        const parsedArchiveRaw: unknown = JSON.parse(await fsp.readFile(extractedManifestPath, "utf8"));
        rawArchiveManifest =
          typeof parsedArchiveRaw === "object" && parsedArchiveRaw !== null
            ? (parsedArchiveRaw as Record<string, unknown>)
            : {};
        archiveManifest = parseManifest(parsedArchiveRaw);
      } catch (error) {
        return c.json(
          { error: "invalid agent.json in tarball", details: formatIssues(error) },
          400,
        );
      }

      const submittedOwner =
        manifest.owner?.toLowerCase() ??
        (typeof rawSubmittedManifest.owner === "string"
          ? rawSubmittedManifest.owner.trim().toLowerCase()
          : undefined);
      const archiveOwner =
        archiveManifest.owner?.toLowerCase() ??
        (typeof rawArchiveManifest.owner === "string"
          ? rawArchiveManifest.owner.trim().toLowerCase()
          : undefined);
      const ownerMismatch =
        (submittedOwner !== undefined && archiveOwner !== undefined && submittedOwner !== archiveOwner) ||
        (archiveOwner !== undefined && archiveOwner !== targetOwner) ||
        (submittedOwner !== undefined && submittedOwner !== targetOwner);
      const skillsMatch =
        archiveManifest.skills.length === manifest.skills.length &&
        archiveManifest.skills.every((skill, idx) => skill === manifest.skills[idx]);

      if (
        ownerMismatch ||
        archiveManifest.name !== manifest.name ||
        archiveManifest.version !== manifest.version ||
        !skillsMatch
      ) {
        return c.json(
          {
            error: "manifest mismatch: submitted manifest does not match agent.json in tarball",
          },
          400,
        );
      }
      manifest = archiveManifest;

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

      if (process.env.AGENTS_POLICY_FILE && fs.existsSync(process.env.AGENTS_POLICY_FILE)) {
        try {
          const policyContent = JSON.parse(await fsp.readFile(process.env.AGENTS_POLICY_FILE, "utf8"));
          const policy = parsePolicy(policyContent);
          const evalResult = evaluatePolicy(policy, {
            manifest,
            scan: report,
            signer: publicKey ? { fingerprint: keyFingerprint(publicKey) } : undefined,
          });
          if (!evalResult.passed) {
            return c.json(
              {
                error: `pack rejected by enterprise policy: ${evalResult.policyName}`,
                details: evalResult.violations.map((v) => `[${v.ruleId}] ${v.message}`).join("; "),
              },
              400,
            );
          }
        } catch (err) {
          return c.json(
            { error: "policy evaluation error", details: err instanceof Error ? err.message : String(err) },
            500,
          );
        }
      }
    } finally {
      await fsp.rm(scanTmp, { recursive: true, force: true });
    }

    const visibilityHeader = c.req.header("x-pack-visibility");
    const visibility =
      visibilityHeader && ["public", "internal", "private"].includes(visibilityHeader)
        ? visibilityHeader
        : manifest.metadata?.visibility && ["public", "internal", "private"].includes(manifest.metadata.visibility)
        ? manifest.metadata.visibility
        : "public";

    const relKey = path.join(targetOwner, manifest.name, `${manifest.version}.tgz`);
    const file = await driver.put(relKey, bytes);

    db.insert({
      owner: targetOwner,
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
      public_key: publicKey,
      signature: signature ?? null,
      visibility,
      created_at: new Date().toISOString(),
    });

    return c.json(
      {
        ok: true,
        ref: `${targetOwner}/${manifest.name}@${manifest.version}`,
        digest,
        size: bytes.length,
        visibility,
      },
      201,
    );
  });

  return app;
}
