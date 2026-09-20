import { z } from "zod";
import { type AgentManifest } from "./manifest.js";
import { type ScanReport } from "./scan.js";
import {
  type SigningKeyPair,
  signDigest,
  verifyDigest,
  keyFingerprint,
} from "./signing.js";
import { createHash } from "node:crypto";

export const POLICY_OPERATORS = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "contains_any",
  "contains_all",
  "not_contains_any",
  "matches_regex",
  "min_length",
  "max_length",
  "is_empty",
  "is_not_empty",
] as const;
export type PolicyOperator = (typeof POLICY_OPERATORS)[number];

export const PolicyConditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(POLICY_OPERATORS),
  value: z.unknown().optional(),
  values: z.array(z.unknown()).optional(),
});
export type PolicyCondition = z.infer<typeof PolicyConditionSchema>;

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  level: z.enum(["error", "warn"]).default("error"),
  condition: PolicyConditionSchema,
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyDefinitionSchema = z.object({
  name: z.string().min(1),
  version: z.string().default("1.0.0"),
  description: z.string().optional(),
  rules: z.array(PolicyRuleSchema).min(1),
});
export type PolicyDefinition = z.infer<typeof PolicyDefinitionSchema>;

export interface PolicyContext {
  manifest: AgentManifest;
  scan?: ScanReport;
  signer?: {
    fingerprint: string;
    issuer?: string;
  };
  files?: string[];
  tarballSize?: number;
}

export interface PolicyViolation {
  ruleId: string;
  description: string;
  level: "error" | "warn";
  field: string;
  actualValue: unknown;
  message: string;
}

export interface PolicyEvaluationResult {
  policyName: string;
  passed: boolean;
  totalRules: number;
  violations: PolicyViolation[];
  warnings: PolicyViolation[];
}

export function parsePolicy(input: unknown): PolicyDefinition {
  return PolicyDefinitionSchema.parse(input);
}

export function resolveFieldPath(target: unknown, fieldPath: string): unknown {
  if (target === null || target === undefined) return undefined;
  const segments = fieldPath.split(".");
  let curr: unknown = target;

  for (const seg of segments) {
    if (typeof curr !== "object" || curr === null) return undefined;
    curr = (curr as Record<string, unknown>)[seg];
  }
  return curr;
}

export function evaluateCondition(
  actual: unknown,
  condition: PolicyCondition,
): { matched: boolean; message?: string } {
  const { operator, value, values } = condition;

  switch (operator) {
    case "equals": {
      const matched = actual === value;
      return {
        matched,
        message: matched ? undefined : `expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
      };
    }
    case "not_equals": {
      const matched = actual !== value;
      return {
        matched,
        message: matched ? undefined : `expected not to equal ${JSON.stringify(value)}`,
      };
    }
    case "in": {
      const allowed = Array.isArray(values) ? values : [value];
      const matched = allowed.some((v) => v === actual);
      return {
        matched,
        message: matched ? undefined : `value ${JSON.stringify(actual)} is not in allowed list [${allowed.join(", ")}]`,
      };
    }
    case "not_in": {
      const forbidden = Array.isArray(values) ? values : [value];
      const matched = !forbidden.some((v) => v === actual);
      return {
        matched,
        message: matched ? undefined : `value ${JSON.stringify(actual)} is in forbidden list [${forbidden.join(", ")}]`,
      };
    }
    case "contains": {
      if (Array.isArray(actual)) {
        const matched = actual.includes(value);
        return { matched, message: matched ? undefined : `array does not contain ${JSON.stringify(value)}` };
      }
      if (typeof actual === "string") {
        const matched = actual.includes(String(value));
        return { matched, message: matched ? undefined : `string does not contain "${value}"` };
      }
      return { matched: false, message: `field is neither an array nor string` };
    }
    case "not_contains": {
      if (Array.isArray(actual)) {
        const matched = !actual.includes(value);
        return { matched, message: matched ? undefined : `array contains forbidden value ${JSON.stringify(value)}` };
      }
      if (typeof actual === "string") {
        const matched = !actual.includes(String(value));
        return { matched, message: matched ? undefined : `string contains forbidden substring "${value}"` };
      }
      return { matched: true };
    }
    case "contains_any": {
      if (!Array.isArray(actual)) {
        return { matched: false, message: `expected array, got ${typeof actual}` };
      }
      const targets = Array.isArray(values) ? values : [value];
      const matched = targets.some((t) => actual.includes(t));
      return {
        matched,
        message: matched ? undefined : `array does not contain any of: [${targets.join(", ")}]`,
      };
    }
    case "contains_all": {
      if (!Array.isArray(actual)) {
        return { matched: false, message: `expected array, got ${typeof actual}` };
      }
      const targets = Array.isArray(values) ? values : [value];
      const matched = targets.every((t) => actual.includes(t));
      return {
        matched,
        message: matched ? undefined : `array is missing required elements from: [${targets.join(", ")}]`,
      };
    }
    case "not_contains_any": {
      if (!Array.isArray(actual)) return { matched: true };
      const forbidden = Array.isArray(values) ? values : [value];
      const intersected = forbidden.filter((f) => actual.includes(f));
      const matched = intersected.length === 0;
      return {
        matched,
        message: matched ? undefined : `array contains forbidden items: [${intersected.join(", ")}]`,
      };
    }
    case "matches_regex": {
      if (typeof actual !== "string") {
        return { matched: false, message: `expected string to match regex, got ${typeof actual}` };
      }
      const re = new RegExp(String(value));
      const matched = re.test(actual);
      return {
        matched,
        message: matched ? undefined : `value "${actual}" does not match regex pattern "${value}"`,
      };
    }
    case "min_length": {
      const len = Array.isArray(actual) || typeof actual === "string" ? actual.length : 0;
      const min = Number(value);
      const matched = len >= min;
      return {
        matched,
        message: matched ? undefined : `length ${len} is below minimum requirement ${min}`,
      };
    }
    case "max_length": {
      const len = Array.isArray(actual) || typeof actual === "string" ? actual.length : 0;
      const max = Number(value);
      const matched = len <= max;
      return {
        matched,
        message: matched ? undefined : `length ${len} exceeds maximum allowed ${max}`,
      };
    }
    case "is_empty": {
      const empty =
        actual === undefined ||
        actual === null ||
        actual === "" ||
        (Array.isArray(actual) && actual.length === 0) ||
        (typeof actual === "object" && Object.keys(actual).length === 0);
      return {
        matched: empty,
        message: empty ? undefined : `expected field to be empty, but it has content`,
      };
    }
    case "is_not_empty": {
      const empty =
        actual === undefined ||
        actual === null ||
        actual === "" ||
        (Array.isArray(actual) && actual.length === 0) ||
        (typeof actual === "object" && Object.keys(actual).length === 0);
      return {
        matched: !empty,
        message: !empty ? undefined : `expected field to have content, but it is empty`,
      };
    }
    default:
      return { matched: false, message: `unknown operator: ${operator}` };
  }
}

/**
 * Evaluates a policy definition against a pack context (manifest, scan report, signer, files).
 */
export function evaluatePolicy(
  policy: PolicyDefinition,
  context: PolicyContext,
): PolicyEvaluationResult {
  const violations: PolicyViolation[] = [];
  const warnings: PolicyViolation[] = [];

  for (const rule of policy.rules) {
    const actual = resolveFieldPath(context, rule.condition.field);
    const result = evaluateCondition(actual, rule.condition);

    if (!result.matched) {
      const violation: PolicyViolation = {
        ruleId: rule.id,
        description: rule.description,
        level: rule.level,
        field: rule.condition.field,
        actualValue: actual,
        message: result.message ?? "Rule condition check failed",
      };

      if (rule.level === "error") {
        violations.push(violation);
      } else {
        warnings.push(violation);
      }
    }
  }

  return {
    policyName: policy.name,
    passed: violations.length === 0,
    totalRules: policy.rules.length,
    violations,
    warnings,
  };
}

export function formatPolicyEvaluation(result: PolicyEvaluationResult): string {
  const lines: string[] = [];
  lines.push("╔══════════════════════════════════════════════════════════════════════════════════╗");
  lines.push(`║ Policy Check: ${result.policyName.padEnd(66)} ║`);
  lines.push("╚══════════════════════════════════════════════════════════════════════════════════╝");
  lines.push(
    `Status: ${result.passed ? "✓ PASSED" : "✗ FAILED"} | Total Rules: ${result.totalRules} | Errors: ${result.violations.length} | Warnings: ${result.warnings.length}`,
  );
  lines.push("────────────────────────────────────────────────────────────────────────────────────");

  for (const v of result.violations) {
    lines.push(` ✗ [ERROR] Rule "${v.ruleId}": ${v.description}`);
    lines.push(`   └─ Field: ${v.field}`);
    lines.push(`   └─ Cause: ${v.message}`);
  }

  for (const w of result.warnings) {
    lines.push(` ⚠ [WARN]  Rule "${w.ruleId}": ${w.description}`);
    lines.push(`   └─ Field: ${w.field}`);
    lines.push(`   └─ Cause: ${w.message}`);
  }

  return lines.join("\n");
}

/* ========================================================================== */
/* In-toto / Sigstore Attestation Statement & Envelope                      */
/* ========================================================================== */

export interface AttestationStatement {
  _type: "https://in-toto.io/Statement/v1";
  subject: Array<{
    name: string;
    digest: { sha256: string };
  }>;
  predicateType: "https://agentshare.io/attestation/v1";
  predicate: {
    signer?: string;
    issuer?: string;
    timestamp: string;
    policyResult?: {
      policyName: string;
      passed: boolean;
      violationsCount: number;
    };
    metadata?: Record<string, unknown>;
  };
}

export interface AttestationSignature {
  keyid: string;
  sig: string;
  publicKey: string;
}

export interface AttestationEnvelope {
  payloadType: "application/vnd.in-toto+json";
  payload: string; // Base64 encoded JSON
  signatures: AttestationSignature[];
}

export function createAttestationEnvelope(
  statement: AttestationStatement,
  keyPair: SigningKeyPair,
): AttestationEnvelope {
  const jsonStr = JSON.stringify(statement);
  const payloadBase64 = Buffer.from(jsonStr, "utf8").toString("base64");
  const digest = createHash("sha256").update(Buffer.from(payloadBase64, "utf8")).digest("hex");
  const signature = signDigest(keyPair.privateKey, digest);
  const fingerprint = keyFingerprint(keyPair.publicKey);

  return {
    payloadType: "application/vnd.in-toto+json",
    payload: payloadBase64,
    signatures: [
      {
        keyid: fingerprint,
        sig: signature,
        publicKey: keyPair.publicKey,
      },
    ],
  };
}

export function verifyAttestationEnvelope(
  envelope: AttestationEnvelope,
  expectedFingerprint?: string,
): { valid: boolean; statement?: AttestationStatement; error?: string } {
  try {
    if (envelope.payloadType !== "application/vnd.in-toto+json") {
      return { valid: false, error: `unsupported payloadType: ${envelope.payloadType}` };
    }
    if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
      return { valid: false, error: "envelope has no signatures" };
    }

    const payloadDigest = createHash("sha256")
      .update(Buffer.from(envelope.payload, "utf8"))
      .digest("hex");

    for (const sig of envelope.signatures) {
      if (expectedFingerprint && sig.keyid !== expectedFingerprint) {
        continue;
      }
      const verified = verifyDigest(sig.publicKey, payloadDigest, sig.sig);
      if (verified) {
        const decoded = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
        return { valid: true, statement: decoded as AttestationStatement };
      }
    }

    return { valid: false, error: "no valid signature matched or signature verification failed" };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
