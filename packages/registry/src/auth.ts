import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { OWNER_PATTERN } from "@agentshare/core";
import { Hono } from "hono";
import type { RegistryDb } from "./db.js";
import type { OidcConfig } from "./oidc.js";

export interface AuthResult {
  owner: string;
}

export interface TokenLookupDb {
  getOwnerByToken(token: string): string | undefined;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, keyHex] = storedHash.split(":");
  if (!salt || !keyHex) return false;
  try {
    const keyBuf = Buffer.from(keyHex, "hex");
    const derived = scryptSync(password, salt, 64);
    if (keyBuf.length !== derived.length) return false;
    return timingSafeEqual(keyBuf, derived);
  } catch {
    return false;
  }
}

export function authenticate(
  header: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  db?: TokenLookupDb,
): AuthResult | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;

  if (db) {
    const dbOwner = db.getOwnerByToken(token);
    if (dbOwner) {
      return { owner: dbOwner.toLowerCase() };
    }
  }

  const raw = env.AGENTSHARE_TOKENS?.trim();
  const devOwner = (env.AGENTSHARE_DEV_OWNER ?? "dev").toLowerCase();

  if (!raw) return { owner: devOwner };

  for (const entry of raw.split(",")) {
    const [candidate, owner] = entry.trim().split(":");
    if (candidate === token) {
      return { owner: (owner?.trim() || devOwner).toLowerCase() };
    }
  }
  return null;
}

export function createAuthRoutes(db: RegistryDb, oidc?: OidcConfig): Hono {
  const app = new Hono();

  app.post("/auth/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rawUsername =
      typeof body.username === "string"
        ? body.username
        : typeof body.owner === "string"
          ? body.owner
          : "";
    const username = rawUsername.trim().toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";

    if (!username || !OWNER_PATTERN.test(username)) {
      return c.json(
        {
          error:
            "invalid username: must be lowercase alphanumeric or hyphens (1-39 chars, no leading/trailing hyphen)",
        },
        400,
      );
    }
    if (password.length < 4) {
      return c.json({ error: "password must be at least 4 characters" }, 400);
    }
    if (db.getUser(username)) {
      return c.json({ error: `user "${username}" is already registered` }, 409);
    }

    const now = new Date().toISOString();
    db.createUser(username, hashPassword(password), now);
    const token = `as_${randomBytes(24).toString("hex")}`;
    db.issueToken(token, username, now);

    return c.json(
      {
        ok: true,
        owner: username,
        username,
        token,
      },
      201,
    );
  });

  app.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rawUsername =
      typeof body.username === "string"
        ? body.username
        : typeof body.owner === "string"
          ? body.owner
          : "";
    const username = rawUsername.trim().toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";

    if (!username || !password) {
      return c.json({ error: "username and password are required" }, 400);
    }

    const user = db.getUser(username);
    if (user && verifyPassword(password, user.password_hash)) {
      const now = new Date().toISOString();
      const token = `as_${randomBytes(24).toString("hex")}`;
      db.issueToken(token, username, now);
      return c.json({
        ok: true,
        owner: username,
        username,
        token,
      });
    }

    // Also allow logging in if password matches a configured AGENTSHARE_TOKENS entry for this owner
    const envAuth = authenticate(`Bearer ${password}`, process.env, db);
    if (envAuth && envAuth.owner === username) {
      return c.json({
        ok: true,
        owner: username,
        username,
        token: password,
      });
    }

    return c.json({ error: "invalid username or password" }, 401);
  });

  if (oidc === undefined) {
    app.get("/me", (c) => {
      const auth = authenticate(c.req.header("authorization"), process.env, db);
      if (!auth) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return c.json({ owner: auth.owner });
    });
  }

  return app;
}
