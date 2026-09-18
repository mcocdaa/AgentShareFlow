import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sign } from "hono/utils/jwt/jwt";
import { createApp } from "../src/app.js";
import { oidcConfigFromEnv, ownerFromClaims } from "../src/oidc.js";

const OIDC_ENV = [
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_AUTH_SECRET",
  "OIDC_REDIRECT_URI",
  "OIDC_AUTH_EXTERNAL_URL",
  "OIDC_OWNER_CLAIM",
  "OIDC_OWNER_MAP",
  "AGENTSHARE_TOKENS",
] as const;

const saved = new Map<string, string | undefined>();
for (const key of OIDC_ENV) saved.set(key, process.env[key]);

function setEnv(values: Partial<Record<(typeof OIDC_ENV)[number], string | undefined>>): void {
  for (const key of OIDC_ENV) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of OIDC_ENV) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("ownerFromClaims", () => {
  it("slugifies email local parts", () => {
    expect(ownerFromClaims({ email: "alice@example.com" }, {})).toBe("alice");
    expect(ownerFromClaims({ email: "Alice.Smith+tag@example.com" }, {})).toBe("alice-smith-tag");
    expect(ownerFromClaims({ email: "!!!@example.com" }, {})).toBeUndefined();
    expect(ownerFromClaims({}, {})).toBeUndefined();
  });

  it("honors a configured claim with email fallback", () => {
    expect(ownerFromClaims({ preferred_username: "bob" }, { ownerClaim: "preferred_username" })).toBe("bob");
    expect(ownerFromClaims({ email: "carol@x.test" }, { ownerClaim: "preferred_username" })).toBe("carol");
  });

  it("applies the owner map and validates mapped namespaces", () => {
    const map = "alice@corp.test:acme, bob@corp.test:BAD NAME";
    expect(ownerFromClaims({ email: "alice@corp.test" }, { ownerMap: map })).toBe("acme");
    expect(ownerFromClaims({ email: "bob@corp.test" }, { ownerMap: map })).toBeUndefined();
    expect(ownerFromClaims({ email: "dave@other.test" }, { ownerMap: map })).toBe("dave");
  });
});

describe("oidcConfigFromEnv", () => {
  it("requires the full configuration", () => {
    setEnv({ OIDC_ISSUER: "https://id.test" });
    expect(oidcConfigFromEnv()).toBeUndefined();
    setEnv({
      OIDC_ISSUER: "https://id.test",
      OIDC_CLIENT_ID: "cid",
      OIDC_CLIENT_SECRET: "secret",
      OIDC_AUTH_SECRET: "s".repeat(40),
    });
    const config = oidcConfigFromEnv();
    expect(config?.redirectUri).toBe("/api/v1/auth/callback");
  });
});

const tempDirs: string[] = [];

async function appWithOidc() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentshare-oidc-"));
  tempDirs.push(dir);
  setEnv({
    OIDC_ISSUER: "https://id.example.test",
    OIDC_CLIENT_ID: "cid",
    OIDC_CLIENT_SECRET: "secret",
    OIDC_AUTH_SECRET: "s".repeat(40),
    AGENTSHARE_TOKENS: "tok:tokowner",
  });
  return createApp({ dataDir: dir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function sessionCookie(email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await sign(
    { rtk: "refresh-token", rtkexp: now + 3600, ssnexp: now + 86_400, email },
    "s".repeat(40),
    "HS256",
  );
  return `oidc-auth=${jwt}`;
}

describe("OIDC session as registry identity", () => {
  it("returns the mapped owner for a signed session", async () => {
    const app = await appWithOidc();
    const res = await app.request("/api/v1/me", { headers: { cookie: await sessionCookie("alice@corp.test") } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ owner: "alice", email: "alice@corp.test" });
  });

  it("rejects a session without a derivable namespace", async () => {
    const app = await appWithOidc();
    const res = await app.request("/api/v1/me", { headers: { cookie: await sessionCookie("!!!@corp.test") } });
    expect(res.status).toBe(403);
  });

  it("accepts the session as owner on shared routes without breaking bearer auth", async () => {
    const app = await appWithOidc();
    const cookie = await sessionCookie("alice@corp.test");

    const viaCookie = await app.request("/api/v1/shares", { headers: { cookie } });
    expect(viaCookie.status).toBe(200);
    expect(await viaCookie.json()).toEqual({ items: [] });

    const viaBearer = await app.request("/api/v1/shares", {
      headers: { authorization: "Bearer tok" },
    });
    expect(viaBearer.status).toBe(200);

    const anonymous = await app.request("/api/v1/shares");
    expect(anonymous.status).toBe(401);
  });

  it("maps the session owner when creating a share", async () => {
    const app = await appWithOidc();
    const res = await app.request("/api/v1/shares", {
      method: "POST",
      headers: { cookie: await sessionCookie("bob@corp.test"), "content-type": "application/json" },
      body: JSON.stringify({ title: "from oidc" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ owner: "bob" });
  });
});
