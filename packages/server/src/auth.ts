import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { HANDLE_PATTERN, type UserProfile } from "@agentshare/core";
import type { ServerDb } from "./db.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_KEY_LEN = 64;

export interface BootstrapOptions {
  adminUser?: string;
  adminPass?: string;
  bootstrapInvite?: string;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEY_LEN);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const saltHex = parts[1];
  const hashHex = parts[2];
  if (!saltHex || !hashHex) {
    return false;
  }
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, salt, expected.length);
    if (actual.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function mintSessionToken(
  db: ServerDb,
  userId: string,
  ttlMs = SESSION_TTL_MS,
): { token: string; tokenHash: string; expiresAt: number } {
  const now = Date.now();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const expiresAt = now + ttlMs;
  db.insertSession({
    tokenHash,
    userId,
    expiresAt,
    createdAt: now,
  });
  return { token, tokenHash, expiresAt };
}

export function resolveSession(db: ServerDb, token: string): UserProfile | null {
  if (!token) return null;
  return db.getSessionUser(hashSessionToken(token));
}

export function revokeSession(db: ServerDb, token: string): string {
  const tokenHash = hashSessionToken(token);
  db.deleteSession(tokenHash);
  return tokenHash;
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

export function bootstrapAuth(
  db: ServerDb,
  options: BootstrapOptions = {},
): { bootstrapInviteCode: string | null } {
  if (db.countUsers() > 0) {
    return { bootstrapInviteCode: null };
  }

  const adminUser = options.adminUser?.trim();
  const adminPass = options.adminPass;
  const requestedInvite = options.bootstrapInvite?.trim();

  if (adminUser && adminPass) {
    const normalized = adminUser.toLowerCase();
    if (!HANDLE_PATTERN.test(normalized)) {
      throw new Error(
        `Invalid bootstrap admin username "${adminUser}": must match ${HANDLE_PATTERN}`,
      );
    }
    if (adminPass.length < 8) {
      throw new Error("Bootstrap admin password must be at least 8 characters");
    }
    db.createUser({
      username: normalized,
      displayName: adminUser,
      passwordHash: hashPassword(adminPass),
      role: "admin",
    });

    if (requestedInvite) {
      const existing = db.getInvite(requestedInvite);
      if (
        existing &&
        existing.role === "admin" &&
        existing.usedCount < existing.maxUses &&
        existing.expiresAt > Date.now()
      ) {
        return { bootstrapInviteCode: existing.code };
      }
      if (!existing) {
        const created = db.createInvite({
          code: requestedInvite,
          createdBy: null,
          role: "admin",
          maxUses: 1,
          expiresAt: Date.now() + BOOTSTRAP_INVITE_TTL_MS,
        });
        return { bootstrapInviteCode: created.code };
      }
    }
    return { bootstrapInviteCode: null };
  }

  if (requestedInvite) {
    const existing = db.getInvite(requestedInvite);
    if (
      existing &&
      existing.role === "admin" &&
      existing.usedCount < existing.maxUses &&
      existing.expiresAt > Date.now()
    ) {
      return { bootstrapInviteCode: existing.code };
    }
    if (!existing) {
      const created = db.createInvite({
        code: requestedInvite,
        createdBy: null,
        role: "admin",
        maxUses: 1,
        expiresAt: Date.now() + BOOTSTRAP_INVITE_TTL_MS,
      });
      return { bootstrapInviteCode: created.code };
    }
  }

  const active = db.findActiveAdminInvite();
  if (active) {
    return { bootstrapInviteCode: active.code };
  }

  const created = db.createInvite({
    createdBy: null,
    role: "admin",
    maxUses: 1,
    expiresAt: Date.now() + BOOTSTRAP_INVITE_TTL_MS,
  });
  return { bootstrapInviteCode: created.code };
}
