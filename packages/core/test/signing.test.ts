import { describe, expect, it } from "vitest";
import {
  decodePublicKeyHeader,
  encodePublicKeyHeader,
  generateSigningKeyPair,
  keyFingerprint,
  signDigest,
  verifyDigest,
} from "../src/index.js";

describe("signing", () => {
  it("signs and verifies a digest", () => {
    const keys = generateSigningKeyPair();
    const signature = signDigest(keys.privateKey, "abc123");
    expect(verifyDigest(keys.publicKey, "abc123", signature)).toBe(true);
    expect(verifyDigest(keys.publicKey, "abc124", signature)).toBe(false);
  });

  it("rejects tampered signatures and foreign keys", () => {
    const keys = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const signature = signDigest(keys.privateKey, "digest");
    expect(verifyDigest(other.publicKey, "digest", signature)).toBe(false);
    expect(verifyDigest(keys.publicKey, "digest", Buffer.from("nope").toString("base64"))).toBe(false);
    expect(verifyDigest("not a pem", "digest", signature)).toBe(false);
  });

  it("round-trips the public key through the single-line header form", () => {
    const keys = generateSigningKeyPair();
    const header = encodePublicKeyHeader(keys.publicKey);
    expect(header).not.toContain("\n");
    const pem = decodePublicKeyHeader(header);
    expect(keyFingerprint(pem)).toBe(keyFingerprint(keys.publicKey));
  });

  it("fingerprints a key deterministically", () => {
    const keys = generateSigningKeyPair();
    expect(keyFingerprint(keys.publicKey)).toBe(keyFingerprint(keys.publicKey));
    expect(keyFingerprint(keys.publicKey)).toHaveLength(32);
  });
});
