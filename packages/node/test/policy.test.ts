import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathWithinAllowedDir, PolicyGuard } from "../src/policy.js";

describe("PolicyGuard", () => {
  it("enforces default deny whitelist and explicit allow rules", () => {
    const guard = new PolicyGuard({
      defaultAllow: false,
      defaultMode: "auto",
      defaultMaxRequestsPerHour: 60,
      rules: [
        {
          subject: "node:trusted-bot",
          allow: true,
          mode: "auto",
          maxRequestsPerHour: 10,
        },
      ],
    });

    const denied = guard.evaluate({
      fromHandle: "stranger-bot",
      fromUsername: "stranger",
      nowMs: 1_000,
    });
    expect(denied.decision).toBe("deny_policy");

    const allowed = guard.evaluate({
      fromHandle: "@trusted-bot",
      fromUsername: "alice",
      nowMs: 1_000,
    });
    expect(allowed.decision).toBe("allow_auto");
    expect(allowed.matchedRule).toBe("node:trusted-bot");
  });

  it("applies exact precedence: node:<handle> > user:<username> > room:<slug> > * > defaults", () => {
    const guard = new PolicyGuard({
      defaultAllow: false,
      defaultMode: "auto",
      defaultMaxRequestsPerHour: 100,
      rules: [
        {
          subject: "*",
          allow: true,
          mode: "manual_approval",
          maxRequestsPerHour: 100,
        },
        {
          subject: "room:general",
          allow: true,
          mode: "read_only_scoped",
          maxRequestsPerHour: 100,
          allowedDir: "/srv/room-docs",
        },
        {
          subject: "user:alice",
          allow: true,
          mode: "auto",
          maxRequestsPerHour: 100,
        },
        {
          subject: "node:alice-restricted",
          allow: false,
          mode: "auto",
          maxRequestsPerHour: 100,
        },
      ],
    });

    expect(
      guard.evaluate({
        fromHandle: "alice-restricted",
        fromUsername: "alice",
        roomSlug: "general",
        nowMs: 10_000,
      }).decision,
    ).toBe("deny_policy");

    expect(
      guard.evaluate({
        fromHandle: "alice-helper",
        fromUsername: "alice",
        roomSlug: "general",
        nowMs: 10_000,
      }),
    ).toMatchObject({
      decision: "allow_auto",
      matchedRule: "user:alice",
    });

    expect(
      guard.evaluate({
        fromHandle: "bob-bot",
        fromUsername: "bob",
        roomSlug: "general",
        nowMs: 10_000,
      }),
    ).toMatchObject({
      decision: "allow_read_only",
      allowedDir: "/srv/room-docs",
      matchedRule: "room:general",
    });

    expect(
      guard.evaluate({
        fromHandle: "carol-bot",
        fromUsername: "carol",
        roomSlug: "other",
        nowMs: 10_000,
      }),
    ).toMatchObject({
      decision: "require_approval",
      matchedRule: "*",
    });
  });

  it("enforces sliding-window hourly rate limits per subject", () => {
    const guard = new PolicyGuard({
      defaultAllow: true,
      defaultMode: "auto",
      defaultMaxRequestsPerHour: 2,
      rules: [],
    });

    const t0 = 1_700_000_000_000;
    expect(guard.evaluate({ fromHandle: "bot-a", nowMs: t0 }).decision).toBe("allow_auto");
    expect(guard.evaluate({ fromHandle: "bot-a", nowMs: t0 + 10_000 }).decision).toBe("allow_auto");
    expect(guard.evaluate({ fromHandle: "bot-a", nowMs: t0 + 20_000 }).decision).toBe(
      "deny_rate_limit",
    );

    // Independent subject has its own bucket.
    expect(guard.evaluate({ fromHandle: "bot-b", nowMs: t0 + 20_000 }).decision).toBe("allow_auto");

    // Once the earliest timestamp slides out of the 1-hour window, requests are allowed again.
    expect(
      guard.evaluate({ fromHandle: "bot-a", nowMs: t0 + 3_600_000 }).decision,
    ).toBe("allow_auto");
    expect(
      guard.evaluate({ fromHandle: "bot-a", nowMs: t0 + 3_600_001 }).decision,
    ).toBe("deny_rate_limit");
  });

  it("returns require_approval for manual_approval mode and allow_read_only with allowedDir", () => {
    const guard = new PolicyGuard({
      defaultAllow: true,
      defaultMode: "manual_approval",
      defaultMaxRequestsPerHour: 10,
      allowedDir: "/srv/default-ro",
      rules: [
        {
          subject: "node:reader",
          allow: true,
          mode: "read_only_scoped",
          maxRequestsPerHour: 10,
        },
      ],
    });

    expect(guard.evaluate({ fromHandle: "someone" }).decision).toBe("require_approval");
    expect(guard.evaluate({ fromHandle: "reader" })).toMatchObject({
      decision: "allow_read_only",
      allowedDir: "/srv/default-ro",
    });
  });
});

describe("isPathWithinAllowedDir", () => {
  const base = path.resolve("/tmp/agentshare-sandbox");

  it("allows files and nested directories inside allowedDir", () => {
    expect(isPathWithinAllowedDir(".", base)).toBe(true);
    expect(isPathWithinAllowedDir("notes.md", base)).toBe(true);
    expect(isPathWithinAllowedDir("sub/dir/report.txt", base)).toBe(true);
    expect(isPathWithinAllowedDir("..hidden", base)).toBe(true);
    expect(isPathWithinAllowedDir(path.join(base, "inside.txt"), base)).toBe(true);
  });

  it("blocks traversal, sibling prefix collisions, absolute escapes, and null bytes", () => {
    expect(isPathWithinAllowedDir("..", base)).toBe(false);
    expect(isPathWithinAllowedDir("../etc/passwd", base)).toBe(false);
    expect(isPathWithinAllowedDir("sub/../../secret.txt", base)).toBe(false);
    expect(isPathWithinAllowedDir(`${base}-other/secret.txt`, base)).toBe(false);
    expect(isPathWithinAllowedDir("/etc/passwd", base)).toBe(false);
    expect(isPathWithinAllowedDir("notes.md\0.txt", base)).toBe(false);
    expect(isPathWithinAllowedDir("", base)).toBe(false);
  });
});
