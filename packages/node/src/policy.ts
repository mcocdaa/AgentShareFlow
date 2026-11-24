import path from "node:path";
import {
  NodePolicyConfigSchema,
  type ApprovalPolicyMode,
  type NodePolicyConfig,
  type PeerPolicyRule,
} from "@agentshare/core";

export type PolicyDecision =
  | "allow_auto"
  | "allow_read_only"
  | "require_approval"
  | "deny_policy"
  | "deny_rate_limit";

export interface PolicyEvaluationInput {
  fromHandle?: string | null;
  fromUsername?: string | null;
  roomSlug?: string | null;
  roomId?: string | null;
  nowMs?: number;
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  allowedDir?: string;
  reason?: string;
  matchedRule?: string;
}

const HOUR_MS = 3_600_000;

function normalizeSubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed === "*") return "*";
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx === -1) return trimmed.toLowerCase();
  const prefix = trimmed.slice(0, colonIdx).toLowerCase();
  const value = trimmed.slice(colonIdx + 1).replace(/^@/, "").toLowerCase();
  return `${prefix}:${value}`;
}

export function isPathWithinAllowedDir(
  targetPath: string,
  allowedDir: string,
): boolean {
  if (
    !targetPath ||
    !allowedDir ||
    targetPath.includes("\0") ||
    allowedDir.includes("\0")
  ) {
    return false;
  }
  const base = path.resolve(allowedDir);
  const target = path.resolve(base, targetPath);
  const rel = path.relative(base, target);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return false;
  }
  return true;
}

export class PolicyGuard {
  private config: NodePolicyConfig;
  private readonly windows = new Map<string, number[]>();

  constructor(config: NodePolicyConfig) {
    this.config = NodePolicyConfigSchema.parse(config);
  }

  getConfig(): NodePolicyConfig {
    return this.config;
  }

  updateConfig(config: NodePolicyConfig): void {
    this.config = NodePolicyConfigSchema.parse(config);
  }

  private findMatchingRule(input: PolicyEvaluationInput): PeerPolicyRule | null {
    const bySubject = new Map<string, PeerPolicyRule>();
    for (const rule of this.config.rules) {
      bySubject.set(normalizeSubject(rule.subject), rule);
    }

    const candidates: string[] = [];
    if (input.fromHandle) {
      candidates.push(
        `node:${input.fromHandle.trim().replace(/^@/, "").toLowerCase()}`,
      );
    }
    if (input.fromUsername) {
      candidates.push(
        `user:${input.fromUsername.trim().replace(/^@/, "").toLowerCase()}`,
      );
    }
    if (input.roomSlug) {
      candidates.push(`room:${input.roomSlug.trim().toLowerCase()}`);
    }
    if (input.roomId && input.roomId !== input.roomSlug) {
      candidates.push(`room:${input.roomId.trim().toLowerCase()}`);
    }
    candidates.push("*");

    for (const candidate of candidates) {
      const hit = bySubject.get(candidate);
      if (hit) return hit;
    }
    return null;
  }

  private resolveRateLimitKey(input: PolicyEvaluationInput): string {
    if (input.fromHandle) {
      return `node:${input.fromHandle.trim().replace(/^@/, "").toLowerCase()}`;
    }
    if (input.fromUsername) {
      return `user:${input.fromUsername.trim().replace(/^@/, "").toLowerCase()}`;
    }
    if (input.roomSlug) {
      return `room:${input.roomSlug.trim().toLowerCase()}`;
    }
    if (input.roomId) {
      return `room:${input.roomId.trim().toLowerCase()}`;
    }
    return "anonymous";
  }

  evaluate(input: PolicyEvaluationInput): PolicyEvaluationResult {
    const rule = this.findMatchingRule(input);
    const allow = rule ? rule.allow : this.config.defaultAllow;
    const mode: ApprovalPolicyMode = rule ? rule.mode : this.config.defaultMode;
    const maxRequestsPerHour = rule
      ? rule.maxRequestsPerHour
      : this.config.defaultMaxRequestsPerHour;
    const allowedDir = rule?.allowedDir ?? this.config.allowedDir;
    const matchedRule = rule ? rule.subject : "default";

    if (!allow) {
      return {
        decision: "deny_policy",
        matchedRule,
        reason: `Denied by policy (${matchedRule})`,
      };
    }

    const nowMs = input.nowMs ?? Date.now();
    const bucketKey = this.resolveRateLimitKey(input);
    if (maxRequestsPerHour <= 0) {
      return {
        decision: "deny_rate_limit",
        matchedRule,
        reason: `Rate limit exceeded (0/hour for ${bucketKey})`,
      };
    }

    const cutoff = nowMs - HOUR_MS;
    const existing = this.windows.get(bucketKey) ?? [];
    const active = existing.filter((ts) => ts > cutoff);
    if (active.length >= maxRequestsPerHour) {
      this.windows.set(bucketKey, active);
      return {
        decision: "deny_rate_limit",
        matchedRule,
        reason: `Rate limit exceeded (${maxRequestsPerHour}/hour for ${bucketKey})`,
      };
    }
    active.push(nowMs);
    this.windows.set(bucketKey, active);

    if (mode === "manual_approval") {
      return {
        decision: "require_approval",
        matchedRule,
        ...(allowedDir !== undefined ? { allowedDir } : {}),
        reason: "Requires local manual approval",
      };
    }
    if (mode === "read_only_scoped") {
      return {
        decision: "allow_read_only",
        matchedRule,
        ...(allowedDir !== undefined ? { allowedDir } : {}),
      };
    }
    return {
      decision: "allow_auto",
      matchedRule,
      ...(allowedDir !== undefined ? { allowedDir } : {}),
    };
  }
}
