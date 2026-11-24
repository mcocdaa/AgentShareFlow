import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateNodeKeyPair,
  keyFingerprint,
  NodePolicyConfigSchema,
  UserProfileSchema,
  type NodeKeyPair,
  type NodePolicyConfig,
  type UserProfile,
} from "@agentshare/core";

export interface NodeIdentity {
  nodeId: string;
  keys: NodeKeyPair;
}

export interface SessionConfig {
  serverUrl: string;
  token: string;
  user: UserProfile;
}

export interface DaemonState {
  localControlUrl: string;
  localControlToken: string;
  handle: string;
  nodeId: string;
  directUrl: string | null;
  serverUrl: string;
  pid?: number;
  startedAt?: number;
}

export const DEFAULT_POLICY_CONFIG: NodePolicyConfig = {
  defaultAllow: true,
  defaultMode: "auto",
  defaultMaxRequestsPerHour: 60,
  rules: [],
};

export function resolveHomeDir(override?: string): string {
  const candidate = override?.trim() || process.env.AGENTSHARE_HOME?.trim();
  return path.resolve(candidate || path.join(os.homedir(), ".agentshare"));
}

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function httpToWsUrl(serverUrl: string): string {
  const base = normalizeServerUrl(serverUrl);
  if (base.startsWith("https://")) {
    return `wss://${base.slice("https://".length)}/ws`;
  }
  if (base.startsWith("http://")) {
    return `ws://${base.slice("http://".length)}/ws`;
  }
  if (base.startsWith("ws://") || base.startsWith("wss://")) {
    return base.endsWith("/ws") ? base : `${base}/ws`;
  }
  return `ws://${base}/ws`;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeSecretJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Ignore on platforms where chmod is unsupported.
  }
}

function isNodeKeyPair(value: unknown): value is NodeKeyPair {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec["signPublicKey"] === "string" &&
    typeof rec["signPrivateKey"] === "string" &&
    typeof rec["kxPublicKey"] === "string" &&
    typeof rec["kxPrivateKey"] === "string"
  );
}

export function loadOrCreateIdentity(homeDir: string): NodeIdentity {
  ensureDir(homeDir);
  const filePath = path.join(homeDir, "identity.json");
  if (existsSync(filePath)) {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (typeof raw["nodeId"] === "string" && isNodeKeyPair(raw["keys"])) {
      return { nodeId: raw["nodeId"], keys: raw["keys"] };
    }
    throw new Error(`Invalid identity file at ${filePath}`);
  }
  const keys = generateNodeKeyPair();
  const identity: NodeIdentity = {
    nodeId: keyFingerprint(keys.signPublicKey),
    keys,
  };
  writeSecretJson(filePath, identity);
  return identity;
}

export function loadSession(homeDir: string): SessionConfig | null {
  const filePath = path.join(homeDir, "session.json");
  if (!existsSync(filePath)) return null;
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (typeof raw["serverUrl"] !== "string" || typeof raw["token"] !== "string") {
    return null;
  }
  const parsedUser = UserProfileSchema.safeParse(raw["user"]);
  if (!parsedUser.success) return null;
  return {
    serverUrl: normalizeServerUrl(raw["serverUrl"]),
    token: raw["token"],
    user: parsedUser.data,
  };
}

export function saveSession(homeDir: string, session: SessionConfig): void {
  const normalized: SessionConfig = {
    serverUrl: normalizeServerUrl(session.serverUrl),
    token: session.token,
    user: UserProfileSchema.parse(session.user),
  };
  writeSecretJson(path.join(homeDir, "session.json"), normalized);
}

export function clearSession(homeDir: string): void {
  const filePath = path.join(homeDir, "session.json");
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore missing file.
  }
}

export function loadPolicy(homeDir: string, overridePath?: string): NodePolicyConfig {
  const filePath = overridePath ? path.resolve(overridePath) : path.join(homeDir, "policy.json");
  if (!existsSync(filePath)) {
    if (overridePath) {
      throw new Error(`Policy file not found: ${filePath}`);
    }
    return {
      ...DEFAULT_POLICY_CONFIG,
      rules: [],
    };
  }
  const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return NodePolicyConfigSchema.parse(raw);
}

export function savePolicy(homeDir: string, policy: NodePolicyConfig): void {
  const validated = NodePolicyConfigSchema.parse(policy);
  ensureDir(homeDir);
  writeFileSync(
    path.join(homeDir, "policy.json"),
    `${JSON.stringify(validated, null, 2)}\n`,
    "utf8",
  );
}

export function loadDaemonState(homeDir: string): DaemonState | null {
  const filePath = path.join(homeDir, "daemon.json");
  if (!existsSync(filePath)) return null;
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (
    typeof raw["localControlUrl"] !== "string" ||
    typeof raw["localControlToken"] !== "string" ||
    typeof raw["handle"] !== "string" ||
    typeof raw["nodeId"] !== "string" ||
    typeof raw["serverUrl"] !== "string"
  ) {
    return null;
  }
  return {
    localControlUrl: raw["localControlUrl"],
    localControlToken: raw["localControlToken"],
    handle: raw["handle"],
    nodeId: raw["nodeId"],
    directUrl: typeof raw["directUrl"] === "string" ? raw["directUrl"] : null,
    serverUrl: normalizeServerUrl(raw["serverUrl"]),
    ...(typeof raw["pid"] === "number" ? { pid: raw["pid"] } : {}),
    ...(typeof raw["startedAt"] === "number" ? { startedAt: raw["startedAt"] } : {}),
  };
}

export function saveDaemonState(homeDir: string, state: DaemonState): void {
  writeSecretJson(path.join(homeDir, "daemon.json"), state);
}

export function clearDaemonState(homeDir: string): void {
  const filePath = path.join(homeDir, "daemon.json");
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore missing file.
  }
}
