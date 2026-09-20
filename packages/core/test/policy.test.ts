import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  parsePolicy,
  formatPolicyEvaluation,
  createAttestationEnvelope,
  verifyAttestationEnvelope,
  generateSigningKeyPair,
  type PolicyDefinition,
  type PolicyContext,
  PACK_SPEC,
} from "../src/index.js";

describe("policy engine", () => {
  const samplePolicy: PolicyDefinition = parsePolicy({
    name: "corp-security-baseline",
    version: "1.0.0",
    rules: [
      {
        id: "approved-license",
        description: "Packs must specify an approved open source or enterprise license",
        level: "error",
        condition: {
          field: "manifest.license",
          operator: "in",
          values: ["MIT", "Apache-2.0", "Proprietary-Corp"],
        },
      },
      {
        id: "forbid-root-secrets",
        description: "Packs must not declare AWS_SECRET_ACCESS_KEY without exception",
        level: "error",
        condition: {
          field: "manifest.secrets",
          operator: "not_contains_any",
          values: ["AWS_SECRET_ACCESS_KEY", "ROOT_PASSWORD"],
        },
      },
      {
        id: "require-claude-or-codex",
        description: "Packs should support at least claude or codex harnesses",
        level: "warn",
        condition: {
          field: "manifest.compatibility",
          operator: "contains_any",
          values: ["claude", "codex"],
        },
      },
      {
        id: "clean-security-scan",
        description: "Static security scan must have zero blocking high severity findings",
        level: "error",
        condition: {
          field: "scan.blocked",
          operator: "equals",
          value: false,
        },
      },
    ],
  });

  it("passes compliant packs with 0 errors", () => {
    const context: PolicyContext = {
      manifest: {
        spec: PACK_SPEC,
        name: "safe-pack",
        version: "1.0.0",
        title: "Safe Pack",
        description: "Compliant agent pack",
        mode: "offline",
        tags: ["safe"],
        license: "Apache-2.0",
        compatibility: ["claude", "agents"],
        skills: ["."],
        instructions: [],
        secrets: ["GITHUB_TOKEN"],
        metadata: {},
      },
      scan: {
        blocked: false,
        findings: [],
      },
    };

    const result = evaluatePolicy(samplePolicy, context);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);

    const formatted = formatPolicyEvaluation(result);
    expect(formatted).toContain("Status: ✓ PASSED");
  });

  it("detects license, secret, and scan violations", () => {
    const context: PolicyContext = {
      manifest: {
        spec: PACK_SPEC,
        name: "risky-pack",
        version: "1.0.0",
        title: "Risky Pack",
        description: "Non-compliant pack",
        mode: "offline",
        tags: ["risky"],
        license: "GPL-3.0",
        compatibility: ["opencode"],
        skills: ["."],
        instructions: [],
        secrets: ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"],
        metadata: {},
      },
      scan: {
        blocked: true,
        findings: [
          {
            severity: "high",
            message: "Dangerous shell pipe curl | sh found",
            file: "run.sh",
            line: 1,
            pattern: "curl.*sh",
          },
        ],
      },
    };

    const result = evaluatePolicy(samplePolicy, context);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
    expect(result.warnings.length).toBe(1); // missing claude/codex

    const violationRuleIds = result.violations.map((v) => v.ruleId);
    expect(violationRuleIds).toContain("approved-license");
    expect(violationRuleIds).toContain("forbid-root-secrets");
    expect(violationRuleIds).toContain("clean-security-scan");

    const formatted = formatPolicyEvaluation(result);
    expect(formatted).toContain("Status: ✗ FAILED");
    expect(formatted).toContain("approved-license");
  });
});

describe("supply chain attestation", () => {
  it("generates in-toto attestation envelope and verifies signature", () => {
    const keyPair = generateSigningKeyPair();

    const envelope = createAttestationEnvelope(
      {
        _type: "https://in-toto.io/Statement/v1",
        subject: [
          {
            name: "corp/review-pack@1.0.0",
            digest: { sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
          },
        ],
        predicateType: "https://agentshare.io/attestation/v1",
        predicate: {
          signer: "corp-ci-pipeline",
          issuer: "https://token.actions.githubusercontent.com",
          timestamp: new Date().toISOString(),
          policyResult: {
            policyName: "corp-security-baseline",
            passed: true,
            violationsCount: 0,
          },
        },
      },
      keyPair,
    );

    expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(envelope.signatures).toHaveLength(1);

    const verified = verifyAttestationEnvelope(envelope);
    expect(verified.valid).toBe(true);
    expect(verified.statement?.subject[0]?.name).toBe("corp/review-pack@1.0.0");
    expect(verified.statement?.predicate.policyResult?.passed).toBe(true);
  });

  it("rejects tampered attestation envelope", () => {
    const keyPair = generateSigningKeyPair();
    const envelope = createAttestationEnvelope(
      {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: "p@1.0.0", digest: { sha256: "abc" } }],
        predicateType: "https://agentshare.io/attestation/v1",
        predicate: { timestamp: new Date().toISOString() },
      },
      keyPair,
    );

    // Tamper payload
    const tampered = {
      ...envelope,
      payload: Buffer.from('{"tampered": true}').toString("base64"),
    };
    const res = verifyAttestationEnvelope(tampered);
    expect(res.valid).toBe(false);
  });
});
