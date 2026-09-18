import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

export interface SigningKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signDigest(privateKeyPem: string, digest: string): string {
  return cryptoSign(null, Buffer.from(digest, "utf8"), createPrivateKey(privateKeyPem)).toString(
    "base64",
  );
}

export function verifyDigest(publicKeyPem: string, digest: string, signature: string): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(digest, "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function keyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 32);
}

export function encodePublicKeyHeader(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return der.toString("base64");
}

export function decodePublicKeyHeader(value: string): string {
  return createPublicKey({ key: Buffer.from(value, "base64"), type: "spki", format: "der" })
    .export({ type: "spki", format: "pem" })
    .toString();
}
