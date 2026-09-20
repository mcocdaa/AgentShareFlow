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

/**
 * S3 / MinIO distributed object storage driver skeleton.
 * Provides standard interface ready for AWS S3 SDK or S3 REST client adapter.
 */
export class S3StorageDriver implements IStorageDriver {
  constructor(public readonly config: S3StorageConfig) {}

  private resolveS3Key(key: string): string {
    const cleanKey = key.replace(/^\/+/, "");
    return this.config.prefix ? `${this.config.prefix.replace(/\/+$/, "")}/${cleanKey}` : cleanKey;
  }

  async put(key: string, _data: Uint8Array): Promise<string> {
    const s3Key = this.resolveS3Key(key);
    // S3 PUT Object implementation contract
    return `s3://${this.config.bucket}/${s3Key}`;
  }

  async get(_keyOrPath: string): Promise<Uint8Array | null> {
    // S3 GET Object implementation contract
    return null;
  }

  async exists(_keyOrPath: string): Promise<boolean> {
    // S3 HEAD Object implementation contract
    return false;
  }

  async delete(_keyOrPath: string): Promise<void> {
    // S3 DELETE Object implementation contract
  }
}
