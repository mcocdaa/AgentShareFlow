import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sign } from "hono/utils/jwt/jwt";
import {
  createPackTarball,
  encodePublicKeyHeader,
  generateSigningKeyPair,
  keyFingerprint,
  signDigest,
} from "@agentshare/core";
import { createHash } from "node:crypto";
import { createApp } from "../src/app.js";

const ENV_KEYS = [
  "AGENTSHARE_TOKENS",
  "AGENTSHARE_DEV_OWNER",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_AUTH_SECRET",
] as const;

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const tempDirs: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeApp(tokenMode: "token" | "oidc") {
  const dataDir = await temporaryDirectory("agentshare-packs-");
  setEnv(
    tokenMode === "token"
      ? { AGENTSHARE_TOKENS: "tok:starowner" }
      : {
          AGENTSHARE_TOKENS: "tok:starowner",
          OIDC_ISSUER: "https://id.example.test",
          OIDC_CLIENT_ID: "cid",
          OIDC_CLIENT_SECRET: "secret",
          OIDC_AUTH_SECRET: "s".repeat(40),
        },
  );
  return createApp({ dataDir });
}

async function publish(app: ReturnType<typeof createApp>, auth: Record<string, string>) {
  const packDir = await temporaryDirectory("agentshare-pack-");
  await fs.writeFile(
    path.join(packDir, "agent.json"),
    JSON.stringify({
      spec: "agent-pack/v0",
      name: "starred-pack",
      version: "0.1.0",
      title: "Starred Pack",
      description: "For star tests.",
      mode: "offline",
      skills: ["."],
    }),
  );
  await fs.writeFile(path.join(packDir, "SKILL.md"), "# Starred\n");
  const tarball = path.join(packDir, "pack.tgz");
  await createPackTarball(packDir, tarball);

  const manifest = JSON.parse(await fs.readFile(path.join(packDir, "agent.json"), "utf8")) as unknown;
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  form.set("tarball", new Blob([await fs.readFile(tarball)], { type: "application/gzip" }), "pack.tgz");
  const res = await app.request("/api/v1/agents", { method: "POST", headers: auth, body: form });
  expect(res.status).toBe(201);
  return "starowner/starred-pack";
}

async function sessionCookie(email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await sign(
    { rtk: "rt", rtkexp: now + 3600, ssnexp: now + 86_400, email },
    "s".repeat(40),
    "HS256",
  );
  return `oidc-auth=${jwt}`;
}

async function buildPack(name: string, version: string) {
  const packDir = await temporaryDirectory("agentshare-sign-");
  const manifest = {
    spec: "agent-pack/v0",
    name,
    version,
    title: "Signed Pack",
    description: "For signing tests.",
    mode: "offline",
    skills: ["."],
  };
  await fs.writeFile(path.join(packDir, "agent.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(packDir, "SKILL.md"), "# Signed\n");
  const tarball = path.join(packDir, "pack.tgz");
  await createPackTarball(packDir, tarball);
  const bytes = await fs.readFile(tarball);
  return { manifest, bytes, digest: createHash("sha256").update(bytes).digest("hex") };
}

async function postPack(
  app: ReturnType<typeof createApp>,
  packed: Awaited<ReturnType<typeof buildPack>>,
  headers: Record<string, string>,
) {
  const form = new FormData();
  form.set("manifest", JSON.stringify(packed.manifest));
  form.set("tarball", new Blob([packed.bytes], { type: "application/gzip" }), "pack.tgz");
  return app.request("/api/v1/agents", { method: "POST", headers, body: form });
}

describe("pack signatures", () => {
  it("stores a valid ed25519 signature and rejects bad or partial signing headers", async () => {
    const app = await makeApp("token");
    const auth = { authorization: "Bearer tok" };
    const keys = generateSigningKeyPair();

    const signed = await buildPack("signed-pack", "0.1.0");
    const good = await postPack(app, signed, {
      ...auth,
      "x-pack-digest": signed.digest,
      "x-pack-public-key": encodePublicKeyHeader(keys.publicKey),
      "x-pack-signature": signDigest(keys.privateKey, signed.digest),
    });
    expect(good.status).toBe(201);

    const detail = await app.request("/api/v1/agents/starowner/signed-pack");
    const body = (await detail.json()) as {
      signature?: { algorithm: string; fingerprint: string; value: string };
    };
    expect(body.signature?.algorithm).toBe("ed25519");
    expect(body.signature?.fingerprint).toBe(keyFingerprint(keys.publicKey));

    const bad = await buildPack("signed-pack", "0.2.0");
    const invalid = await postPack(app, bad, {
      ...auth,
      "x-pack-digest": bad.digest,
      "x-pack-public-key": encodePublicKeyHeader(keys.publicKey),
      "x-pack-signature": signDigest(keys.privateKey, "some-other-digest"),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid signature" });

    const partial = await buildPack("signed-pack", "0.3.0");
    const partialRes = await postPack(app, partial, {
      ...auth,
      "x-pack-public-key": encodePublicKeyHeader(keys.publicKey),
    });
    expect(partialRes.status).toBe(400);
    expect(await partialRes.json()).toMatchObject({ error: "signing requires both x-pack-public-key and x-pack-signature" });
  });

  it("keeps unsigned releases without signature metadata", async () => {
    const app = await makeApp("token");
    const unsigned = await buildPack("plain-pack", "0.1.0");
    expect((await postPack(app, unsigned, { authorization: "Bearer tok" })).status).toBe(201);
    const detail = await app.request("/api/v1/agents/starowner/plain-pack");
    expect(await detail.json()).not.toHaveProperty("signature");
  });
});

describe("pack stars", () => {
  it("starts at zero, requires auth, toggles once per owner, and reports in detail", async () => {
    const app = await makeApp("token");
    const ref = await publish(app, { authorization: "Bearer tok" });

    const anonymousStar = await app.request(`/api/v1/agents/${ref}/star`, { method: "POST" });
    expect(anonymousStar.status).toBe(401);

    const unknown = await app.request("/api/v1/agents/starowner/missing/star", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
    });
    expect(unknown.status).toBe(404);

    const detailBefore = await app.request(`/api/v1/agents/${ref}`);
    const beforeBody = (await detailBefore.json()) as { stars: number; starred?: boolean };
    expect(beforeBody).toMatchObject({ stars: 0 });
    expect(beforeBody).not.toHaveProperty("starred");

    const starred = await app.request(`/api/v1/agents/${ref}/star`, {
      method: "POST",
      headers: { authorization: "Bearer tok" },
    });
    expect(await starred.json()).toEqual({ starred: true, stars: 1 });

    const again = await app.request(`/api/v1/agents/${ref}/star`, {
      method: "POST",
      headers: { authorization: "Bearer tok" },
    });
    expect(await again.json()).toEqual({ starred: true, stars: 1 });

    const detailAuthed = await app.request(`/api/v1/agents/${ref}`, {
      headers: { authorization: "Bearer tok" },
    });
    expect(await detailAuthed.json()).toMatchObject({ stars: 1, starred: true });

    const search = await app.request("/api/v1/search?q=starred");
    const items = (await search.json()) as { items: Array<{ stars: number }> };
    expect(items.items[0]?.stars).toBe(1);

    const unstarred = await app.request(`/api/v1/agents/${ref}/star`, {
      method: "DELETE",
      headers: { authorization: "Bearer tok" },
    });
    expect(await unstarred.json()).toEqual({ starred: false, stars: 0 });
  });

  it("accepts an OIDC session as the starring identity", async () => {
    const app = await makeApp("oidc");
    const ref = await publish(app, { authorization: "Bearer tok" });

    const starred = await app.request(`/api/v1/agents/${ref}/star`, {
      method: "POST",
      headers: { cookie: await sessionCookie("carol@corp.test") },
    });
    expect(await starred.json()).toEqual({ starred: true, stars: 1 });

    const detail = await app.request(`/api/v1/agents/${ref}`, {
      headers: { cookie: await sessionCookie("carol@corp.test") },
    });
    expect(await detail.json()).toMatchObject({ stars: 1, starred: true });

    const other = await app.request(`/api/v1/agents/${ref}`, {
      headers: { cookie: await sessionCookie("dave@corp.test") },
    });
    expect(await other.json()).toMatchObject({ stars: 1, starred: false });
  });
});
