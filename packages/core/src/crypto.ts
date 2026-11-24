import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import {
  canonicalPacketSigningInput,
  DmPayloadSchema,
  P2pPacketSchema,
  PROTOCOL_VERSION,
  type DmPayload,
  type EncryptedEnvelope,
  type P2pPacket,
} from "./protocol.js";

export interface NodeKeyPair {
  signPublicKey: string;
  signPrivateKey: string;
  kxPublicKey: string;
  kxPrivateKey: string;
}

export interface CreatePacketOptions {
  fromNodeId: string;
  fromHandle: string;
  toNodeId: string;
  senderSignPrivateKey: string;
  senderKxPrivateKey: string;
  recipientKxPublicKey: string;
  payload: DmPayload;
  id?: string;
  timestamp?: number;
  nonce?: string;
}

export interface VerifyPacketOptions {
  packet: P2pPacket;
  expectedToNodeId?: string;
  senderSignPublicKey: string;
  senderKxPublicKey: string;
  recipientKxPrivateKey: string;
  maxSkewMs?: number;
  nowMs?: number;
  seenNonces?: Set<string>;
}

const DEFAULT_MAX_SKEW_MS = 300_000;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

function importPublicKey(encoded: string): KeyObject {
  if (encoded.includes("-----BEGIN")) {
    return createPublicKey(encoded);
  }
  return createPublicKey({
    key: Buffer.from(encoded, "base64"),
    format: "der",
    type: "spki",
  });
}

function importPrivateKey(encoded: string): KeyObject {
  if (encoded.includes("-----BEGIN")) {
    return createPrivateKey(encoded);
  }
  return createPrivateKey({
    key: Buffer.from(encoded, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

export function generateNodeKeyPair(): NodeKeyPair {
  const signPair = generateKeyPairSync("ed25519");
  const kxPair = generateKeyPairSync("x25519");
  return {
    signPublicKey: signPair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    signPrivateKey: signPair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    kxPublicKey: kxPair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    kxPrivateKey: kxPair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
}

export function keyFingerprint(signPublicKey: string): string {
  const der = importPublicKey(signPublicKey).export({
    format: "der",
    type: "spki",
  });
  return createHash("sha256").update(der).digest("hex").slice(0, 32);
}

export function signText(privateKey: string, text: string): string {
  return cryptoSign(
    null,
    Buffer.from(text, "utf8"),
    importPrivateKey(privateKey),
  ).toString("base64");
}

export function verifyText(
  publicKey: string,
  text: string,
  signature: string,
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(text, "utf8"),
      importPublicKey(publicKey),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function deriveSharedKey(
  myKxPrivateKey: string,
  peerKxPublicKey: string,
): Buffer {
  const secret = diffieHellman({
    privateKey: importPrivateKey(myKxPrivateKey),
    publicKey: importPublicKey(peerKxPublicKey),
  });
  return Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      Buffer.from("agentshare-v2"),
      Buffer.from("dm-e2ee"),
      32,
    ),
  );
}

export function encryptEnvelope(
  sharedKey: Buffer,
  plaintext: string,
  aad?: string,
): EncryptedEnvelope {
  if (sharedKey.length !== 32) {
    throw new Error("Shared key must be 32 bytes for aes-256-gcm");
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", sharedKey, iv);
  if (aad !== undefined) {
    cipher.setAAD(Buffer.from(aad, "utf8"));
  }
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptEnvelope(
  sharedKey: Buffer,
  envelope: EncryptedEnvelope,
  aad?: string,
): string {
  if (sharedKey.length !== 32) {
    throw new Error("Shared key must be 32 bytes for aes-256-gcm");
  }
  if (envelope.alg !== "aes-256-gcm") {
    throw new Error(`Unsupported cipher algorithm: ${String(envelope.alg)}`);
  }
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error("Invalid AES-GCM IV length");
  }
  if (tag.length !== GCM_TAG_BYTES) {
    throw new Error("Invalid AES-GCM auth tag length");
  }
  const decipher = createDecipheriv("aes-256-gcm", sharedKey, iv);
  if (aad !== undefined) {
    decipher.setAAD(Buffer.from(aad, "utf8"));
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export function createSignedEncryptedPacket(
  options: CreatePacketOptions,
): P2pPacket {
  const payload = DmPayloadSchema.parse(options.payload);
  const sharedKey = deriveSharedKey(
    options.senderKxPrivateKey,
    options.recipientKxPublicKey,
  );
  const aad = `${options.fromNodeId}->${options.toNodeId}`;
  const envelope = encryptEnvelope(sharedKey, JSON.stringify(payload), aad);
  const unsignedPacket: Omit<P2pPacket, "signature"> = {
    version: PROTOCOL_VERSION,
    id: options.id ?? randomUUID(),
    fromNodeId: options.fromNodeId,
    fromHandle: options.fromHandle,
    toNodeId: options.toNodeId,
    timestamp: options.timestamp ?? Date.now(),
    nonce: options.nonce ?? randomBytes(16).toString("hex"),
    envelope,
  };
  const signature = signText(
    options.senderSignPrivateKey,
    canonicalPacketSigningInput(unsignedPacket),
  );
  return {
    ...unsignedPacket,
    signature,
  };
}

export function verifyAndDecryptPacket(options: VerifyPacketOptions): DmPayload {
  const packet = P2pPacketSchema.parse(options.packet);
  if (
    options.expectedToNodeId !== undefined &&
    packet.toNodeId !== options.expectedToNodeId
  ) {
    throw new Error(
      `Packet recipient mismatch: expected ${options.expectedToNodeId}, got ${packet.toNodeId}`,
    );
  }

  const maxSkewMs = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  const nowMs = options.nowMs ?? Date.now();
  if (Math.abs(nowMs - packet.timestamp) > maxSkewMs) {
    throw new Error("Packet timestamp outside allowed clock skew");
  }

  const { signature, ...unsignedPacket } = packet;
  const signingInput = canonicalPacketSigningInput(unsignedPacket);
  if (!verifyText(options.senderSignPublicKey, signingInput, signature)) {
    throw new Error("Invalid packet signature");
  }

  const nonceKey = `${packet.fromNodeId}:${packet.nonce}`;
  if (options.seenNonces?.has(nonceKey)) {
    throw new Error("Replay detected: duplicate packet nonce");
  }

  const sharedKey = deriveSharedKey(
    options.recipientKxPrivateKey,
    options.senderKxPublicKey,
  );
  const aad = `${packet.fromNodeId}->${packet.toNodeId}`;
  const plaintext = decryptEnvelope(sharedKey, packet.envelope, aad);

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Decrypted DM payload is not valid JSON");
  }

  const payload = DmPayloadSchema.parse(parsed);
  options.seenNonces?.add(nonceKey);
  return payload;
}
