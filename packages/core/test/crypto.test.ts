import { describe, expect, it } from "vitest";
import {
  createSignedEncryptedPacket,
  decryptEnvelope,
  deriveSharedKey,
  encryptEnvelope,
  generateNodeKeyPair,
  keyFingerprint,
  signText,
  verifyAndDecryptPacket,
  verifyText,
} from "../src/crypto.js";

describe("crypto primitives", () => {
  it("generates Ed25519 + X25519 key pairs and deterministic fingerprints", () => {
    const a = generateNodeKeyPair();
    const b = generateNodeKeyPair();

    expect(a.signPublicKey).not.toBe(b.signPublicKey);
    expect(a.kxPublicKey).not.toBe(b.kxPublicKey);

    const fpA1 = keyFingerprint(a.signPublicKey);
    const fpA2 = keyFingerprint(a.signPublicKey);
    const fpB = keyFingerprint(b.signPublicKey);

    expect(fpA1).toMatch(/^[0-9a-f]{32}$/);
    expect(fpA1).toBe(fpA2);
    expect(fpA1).not.toBe(fpB);
  });

  it("signs and verifies Ed25519 messages", () => {
    const keys = generateNodeKeyPair();
    const other = generateNodeKeyPair();
    const sig = signText(keys.signPrivateKey, "hello world");

    expect(verifyText(keys.signPublicKey, "hello world", sig)).toBe(true);
    expect(verifyText(keys.signPublicKey, "hello world!", sig)).toBe(false);
    expect(verifyText(other.signPublicKey, "hello world", sig)).toBe(false);
    expect(verifyText(keys.signPublicKey, "hello world", "not-valid-sig")).toBe(
      false,
    );
  });

  it("derives identical X25519+HKDF shared keys on both sides", () => {
    const alice = generateNodeKeyPair();
    const bob = generateNodeKeyPair();
    const charlie = generateNodeKeyPair();

    const keyAB = deriveSharedKey(alice.kxPrivateKey, bob.kxPublicKey);
    const keyBA = deriveSharedKey(bob.kxPrivateKey, alice.kxPublicKey);
    const keyAC = deriveSharedKey(alice.kxPrivateKey, charlie.kxPublicKey);

    expect(keyAB.length).toBe(32);
    expect(keyAB.equals(keyBA)).toBe(true);
    expect(keyAB.equals(keyAC)).toBe(false);
  });

  it("encrypts and decrypts AES-256-GCM envelopes with AAD binding", () => {
    const alice = generateNodeKeyPair();
    const bob = generateNodeKeyPair();
    const key = deriveSharedKey(alice.kxPrivateKey, bob.kxPublicKey);

    const envelope = encryptEnvelope(key, "secret dm", "node-a->node-b");
    expect(envelope.alg).toBe("aes-256-gcm");
    expect(decryptEnvelope(key, envelope, "node-a->node-b")).toBe("secret dm");

    expect(() => decryptEnvelope(key, envelope, "node-a->node-c")).toThrow();

    const tamperedCt = Buffer.from(envelope.ciphertext, "base64");
    tamperedCt[0] = (tamperedCt[0] ?? 0) ^ 0xff;
    expect(() =>
      decryptEnvelope(
        key,
        { ...envelope, ciphertext: tamperedCt.toString("base64") },
        "node-a->node-b",
      ),
    ).toThrow();
  });
});

describe("signed & encrypted P2P packets", () => {
  it("roundtrips createSignedEncryptedPacket and verifyAndDecryptPacket", () => {
    const alice = generateNodeKeyPair();
    const bob = generateNodeKeyPair();
    const now = 1_700_000_000_000;

    const packet = createSignedEncryptedPacket({
      fromNodeId: "node-alice",
      fromHandle: "alice-bot",
      toNodeId: "node-bob",
      senderSignPrivateKey: alice.signPrivateKey,
      senderKxPrivateKey: alice.kxPrivateKey,
      recipientKxPublicKey: bob.kxPublicKey,
      timestamp: now,
      payload: {
        kind: "task_request",
        text: "Summarize PR #42",
        taskId: "task-42",
        metadata: { priority: "high" },
      },
    });

    const payload = verifyAndDecryptPacket({
      packet,
      expectedToNodeId: "node-bob",
      senderSignPublicKey: alice.signPublicKey,
      senderKxPublicKey: alice.kxPublicKey,
      recipientKxPrivateKey: bob.kxPrivateKey,
      nowMs: now + 10_000,
    });

    expect(payload).toEqual({
      kind: "task_request",
      text: "Summarize PR #42",
      taskId: "task-42",
      metadata: { priority: "high" },
    });
  });

  it("rejects tampered metadata, wrong keys, recipient mismatch, skew, and replays", () => {
    const alice = generateNodeKeyPair();
    const bob = generateNodeKeyPair();
    const mallory = generateNodeKeyPair();
    const now = 1_700_000_000_000;

    const packet = createSignedEncryptedPacket({
      fromNodeId: "node-alice",
      fromHandle: "alice",
      toNodeId: "node-bob",
      senderSignPrivateKey: alice.signPrivateKey,
      senderKxPrivateKey: alice.kxPrivateKey,
      recipientKxPublicKey: bob.kxPublicKey,
      timestamp: now,
      payload: { kind: "text", text: "ping" },
    });

    // Tampered header breaks signature
    expect(() =>
      verifyAndDecryptPacket({
        packet: { ...packet, fromHandle: "mallory" },
        senderSignPublicKey: alice.signPublicKey,
        senderKxPublicKey: alice.kxPublicKey,
        recipientKxPrivateKey: bob.kxPrivateKey,
        nowMs: now,
      }),
    ).toThrow(/signature/i);

    // Wrong signing public key
    expect(() =>
      verifyAndDecryptPacket({
        packet,
        senderSignPublicKey: mallory.signPublicKey,
        senderKxPublicKey: alice.kxPublicKey,
        recipientKxPrivateKey: bob.kxPrivateKey,
        nowMs: now,
      }),
    ).toThrow(/signature/i);

    // Wrong recipient nodeId
    expect(() =>
      verifyAndDecryptPacket({
        packet,
        expectedToNodeId: "node-mallory",
        senderSignPublicKey: alice.signPublicKey,
        senderKxPublicKey: alice.kxPublicKey,
        recipientKxPrivateKey: bob.kxPrivateKey,
        nowMs: now,
      }),
    ).toThrow(/mismatch/i);

    // Outside default 300s clock skew
    expect(() =>
      verifyAndDecryptPacket({
        packet,
        senderSignPublicKey: alice.signPublicKey,
        senderKxPublicKey: alice.kxPublicKey,
        recipientKxPrivateKey: bob.kxPrivateKey,
        nowMs: now + 300_001,
      }),
    ).toThrow(/skew/i);

    // Wrong decryption key (Mallory cannot decrypt relay-intercepted packet)
    expect(() =>
      verifyAndDecryptPacket({
        packet,
        senderSignPublicKey: alice.signPublicKey,
        senderKxPublicKey: alice.kxPublicKey,
        recipientKxPrivateKey: mallory.kxPrivateKey,
        nowMs: now,
      }),
    ).toThrow();

    // Replay detection with seenNonces
    const seenNonces = new Set<string>();
    const first = verifyAndDecryptPacket({
      packet,
      senderSignPublicKey: alice.signPublicKey,
      senderKxPublicKey: alice.kxPublicKey,
      recipientKxPrivateKey: bob.kxPrivateKey,
      nowMs: now,
      seenNonces,
    });
    expect(first.text).toBe("ping");

    expect(() =>
      verifyAndDecryptPacket({
        packet,
        senderSignPublicKey: alice.signPublicKey,
        senderKxPublicKey: alice.kxPublicKey,
        recipientKxPrivateKey: bob.kxPrivateKey,
        nowMs: now,
        seenNonces,
      }),
    ).toThrow(/replay/i);
  });
});
