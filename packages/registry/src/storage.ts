import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Storage driver interface decoupling pack artifact persistence
 * from local filesystem storage, enabling S3/MinIO cloud distribution.
 */
export interface IStorageDriver {
  /**
   * Persist binary data at a storage key.
   * Returns a resolved identifier / file path / URI.
   */
  put(key: string, data: Uint8Array): Promise<string>;

  /**
   * Retrieve binary data for a storage key or locator.
   * Returns null if not found.
   */
  get(keyOrPath: string): Promise<Uint8Array | null>;

  /**
   * Check whether data exists for a storage key or locator.
   */
  exists(keyOrPath: string): Promise<boolean>;

  /**
   * Remove binary data for a storage key or locator.
   */
  delete?(keyOrPath: string): Promise<void>;
}

/**
 * In-memory storage driver, ideal for unit testing, CI, and ephemeral instances.
 */
export class MemoryStorageDriver implements IStorageDriver {
  private readonly store = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array): Promise<string> {
    this.store.set(key, new Uint8Array(data));
    return `memory://${key}`;
  }

  async get(keyOrPath: string): Promise<Uint8Array | null> {
    const key = keyOrPath.replace(/^memory:\/\//, "");
    const data = this.store.get(key);
    return data ? new Uint8Array(data) : null;
  }

  async exists(keyOrPath: string): Promise<boolean> {
    const key = keyOrPath.replace(/^memory:\/\//, "");
    return this.store.has(key);
  }

  async delete(keyOrPath: string): Promise<void> {
    const key = keyOrPath.replace(/^memory:\/\//, "");
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Local filesystem implementation of IStorageDriver.
 */
export class LocalStorageDriver implements IStorageDriver {
  constructor(public readonly baseDir: string) {}

  private resolvePath(keyOrPath: string): string {
    return path.isAbsolute(keyOrPath) ? keyOrPath : path.join(this.baseDir, keyOrPath);
  }

  async put(key: string, data: Uint8Array): Promise<string> {
    const fullPath = this.resolvePath(key);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, data);
    return fullPath;
  }

  async get(keyOrPath: string): Promise<Uint8Array | null> {
    const fullPath = this.resolvePath(keyOrPath);
    try {
      const buf = await fsp.readFile(fullPath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async exists(keyOrPath: string): Promise<boolean> {
    const fullPath = this.resolvePath(keyOrPath);
    return fs.existsSync(fullPath);
  }

  async delete(keyOrPath: string): Promise<void> {
    const fullPath = this.resolvePath(keyOrPath);
    try {
      await fsp.rm(fullPath, { force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

/**
 * Configuration options for S3/MinIO compatible object storage.
 */
export interface S3StorageConfig {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
  forcePathStyle?: boolean;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * S3 / MinIO distributed object storage driver with native AWS SigV4 authentication.
 * Zero external dependencies.
 */
export class S3StorageDriver implements IStorageDriver {
  public readonly region: string;
  public readonly endpoint: string;

  constructor(public readonly config: S3StorageConfig) {
    this.region = config.region ?? "us-east-1";
    this.endpoint = (
      config.endpoint ?? `https://${config.bucket}.s3.${this.region}.amazonaws.com`
    ).replace(/\/+$/, "");
  }

  private resolveS3Key(key: string): string {
    const cleanKey = key.replace(/^s3:\/\/[^/]+\//, "").replace(/^\/+/, "");
    return this.config.prefix
      ? `${this.config.prefix.replace(/\/+$/, "")}/${cleanKey}`
      : cleanKey;
  }

  private buildUrl(s3Key: string): { url: URL; canonicalPath: string } {
    const isPathStyle = this.config.forcePathStyle ?? (this.config.endpoint !== undefined);
    if (isPathStyle) {
      const canonicalPath = `/${this.config.bucket}/${s3Key}`;
      return { url: new URL(canonicalPath, this.endpoint), canonicalPath };
    }
    const canonicalPath = `/${s3Key}`;
    return { url: new URL(canonicalPath, this.endpoint), canonicalPath };
  }

  private signRequest(
    method: string,
    url: URL,
    canonicalPath: string,
    payloadHash: string,
    headers: Record<string, string> = {},
  ): Record<string, string> {
    if (!this.config.accessKeyId || !this.config.secretAccessKey) {
      return headers;
    }

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    const signedHeadersList = ["host", "x-amz-content-sha256", "x-amz-date"];
    const allHeaders: Record<string, string> = {
      ...headers,
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };

    const canonicalHeadersStr =
      `host:${allHeaders.host}\n` +
      `x-amz-content-sha256:${allHeaders["x-amz-content-sha256"]}\n` +
      `x-amz-date:${allHeaders["x-amz-date"]}\n`;

    const signedHeadersStr = signedHeadersList.join(";");

    const canonicalRequest = [
      method,
      canonicalPath,
      "", // query string
      canonicalHeadersStr,
      signedHeadersStr,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");

    const kDate = hmacSha256(`AWS4${this.config.secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, this.region);
    const kService = hmacSha256(kRegion, "s3");
    const kSigning = hmacSha256(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

    allHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

    return allHeaders;
  }

  async put(key: string, data: Uint8Array): Promise<string> {
    const s3Key = this.resolveS3Key(key);
    const { url, canonicalPath } = this.buildUrl(s3Key);
    const payloadHash = sha256Hex(data);

    const headers = this.signRequest("PUT", url, canonicalPath, payloadHash, {
      "content-type": "application/gzip",
      "content-length": String(data.length),
    });

    const res = await fetch(url.toString(), {
      method: "PUT",
      headers,
      body: Buffer.from(data),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`S3 PUT failed (${res.status} ${res.statusText}): ${errText}`);
    }

    return `s3://${this.config.bucket}/${s3Key}`;
  }

  async get(keyOrPath: string): Promise<Uint8Array | null> {
    const s3Key = this.resolveS3Key(keyOrPath);
    const { url, canonicalPath } = this.buildUrl(s3Key);
    const payloadHash = sha256Hex("");

    const headers = this.signRequest("GET", url, canonicalPath, payloadHash);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers,
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`S3 GET failed (${res.status} ${res.statusText}): ${errText}`);
    }

    return new Uint8Array(await res.arrayBuffer());
  }

  async exists(keyOrPath: string): Promise<boolean> {
    const s3Key = this.resolveS3Key(keyOrPath);
    const { url, canonicalPath } = this.buildUrl(s3Key);
    const payloadHash = sha256Hex("");

    const headers = this.signRequest("HEAD", url, canonicalPath, payloadHash);

    const res = await fetch(url.toString(), {
      method: "HEAD",
      headers,
    });

    if (res.status === 404) return false;
    return res.ok;
  }

  async delete(keyOrPath: string): Promise<void> {
    const s3Key = this.resolveS3Key(keyOrPath);
    const { url, canonicalPath } = this.buildUrl(s3Key);
    const payloadHash = sha256Hex("");

    const headers = this.signRequest("DELETE", url, canonicalPath, payloadHash);

    await fetch(url.toString(), {
      method: "DELETE",
      headers,
    }).catch(() => {});
  }
}

/**
 * Creates the appropriate storage driver based on environment variables or local fallback.
 */
export function createStorageDriverFromEnv(fallbackBaseDir: string): IStorageDriver {
  if (process.env.S3_BUCKET) {
    return new S3StorageDriver({
      bucket: process.env.S3_BUCKET,
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? "us-east-1",
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
      prefix: process.env.S3_PREFIX,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" || process.env.S3_ENDPOINT !== undefined,
    });
  }
  return new LocalStorageDriver(fallbackBaseDir);
}
