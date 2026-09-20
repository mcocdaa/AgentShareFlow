import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalStorageDriver,
  MemoryStorageDriver,
  S3StorageDriver,
  createStorageDriverFromEnv,
} from "../src/storage.js";
import { createApp } from "../src/app.js";
import {
  createPackTarball,
  generateSigningKeyPair,
  signDigest,
  encodePublicKeyHeader,
  keyFingerprint,
} from "@agentshare/core";
import { createHash } from "node:crypto";

describe("Storage Drivers", () => {
  const tempDirs: string[] = [];

  async function temporaryDirectory(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  describe("MemoryStorageDriver", () => {
    it("performs put, get, exists, and delete in-memory", async () => {
      const driver = new MemoryStorageDriver();
      const testData = new TextEncoder().encode("hello agent storage");

      expect(await driver.exists("test-key.tar.gz")).toBe(false);
      expect(await driver.get("test-key.tar.gz")).toBeNull();

      const uri = await driver.put("test-key.tar.gz", testData);
      expect(uri).toBe("memory://test-key.tar.gz");

      expect(await driver.exists("test-key.tar.gz")).toBe(true);
      expect(await driver.exists("memory://test-key.tar.gz")).toBe(true);

      const retrieved = await driver.get("test-key.tar.gz");
      expect(retrieved).not.toBeNull();
      expect(new TextDecoder().decode(retrieved!)).toBe("hello agent storage");

      await driver.delete("test-key.tar.gz");
      expect(await driver.exists("test-key.tar.gz")).toBe(false);
      expect(await driver.get("test-key.tar.gz")).toBeNull();
    });

    it("clears all stored items", async () => {
      const driver = new MemoryStorageDriver();
      await driver.put("k1", new Uint8Array([1, 2, 3]));
      await driver.put("k2", new Uint8Array([4, 5, 6]));

      expect(await driver.exists("k1")).toBe(true);
      expect(await driver.exists("k2")).toBe(true);

      driver.clear();
      expect(await driver.exists("k1")).toBe(false);
      expect(await driver.exists("k2")).toBe(false);
    });
  });

  describe("LocalStorageDriver", () => {
    it("performs put, get, exists, and delete on local filesystem", async () => {
      const dir = await temporaryDirectory("local-storage-test-");
      const driver = new LocalStorageDriver(dir);
      const testData = new TextEncoder().encode("file content on disk");

      expect(await driver.exists("sub/pack.tgz")).toBe(false);
      expect(await driver.get("sub/pack.tgz")).toBeNull();

      const filePath = await driver.put("sub/pack.tgz", testData);
      expect(filePath).toBe(path.join(dir, "sub/pack.tgz"));

      expect(await driver.exists("sub/pack.tgz")).toBe(true);
      expect(await driver.exists(filePath)).toBe(true);

      const data = await driver.get("sub/pack.tgz");
      expect(data).not.toBeNull();
      expect(new TextDecoder().decode(data!)).toBe("file content on disk");

      await driver.delete("sub/pack.tgz");
      expect(await driver.exists("sub/pack.tgz")).toBe(false);
      expect(await driver.get("sub/pack.tgz")).toBeNull();
    });
  });

  describe("S3StorageDriver", () => {
    let mockServer: http.Server;
    let serverPort: number;
    let receivedRequests: Array<{
      method: string;
      url: string;
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    }> = [];
    const mockStorage = new Map<string, Buffer>();

    beforeEach(async () => {
      receivedRequests = [];
      mockStorage.clear();

      mockServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks);
          const reqInfo = {
            method: req.method ?? "GET",
            url: req.url ?? "/",
            headers: req.headers,
            body,
          };
          receivedRequests.push(reqInfo);

          const key = req.url ?? "/";

          if (req.method === "PUT") {
            mockStorage.set(key, body);
            res.writeHead(200, { "Content-Type": "application/xml" });
            res.end("<PutObjectResult/>");
          } else if (req.method === "GET") {
            if (mockStorage.has(key)) {
              const data = mockStorage.get(key)!;
              res.writeHead(200, {
                "Content-Length": String(data.length),
                "Content-Type": "application/gzip",
              });
              res.end(data);
            } else {
              res.writeHead(404, { "Content-Type": "application/xml" });
              res.end("<Error><Code>NoSuchKey</Code></Error>");
            }
          } else if (req.method === "HEAD") {
            if (mockStorage.has(key)) {
              res.writeHead(200, { "Content-Length": String(mockStorage.get(key)!.length) });
              res.end();
            } else {
              res.writeHead(404);
              res.end();
            }
          } else if (req.method === "DELETE") {
            mockStorage.delete(key);
            res.writeHead(204);
            res.end();
          } else {
            res.writeHead(405);
            res.end();
          }
        });
      });

      await new Promise<void>((resolve) => {
        mockServer.listen(0, "127.0.0.1", () => {
          const addr = mockServer.address();
          if (typeof addr === "object" && addr) {
            serverPort = addr.port;
          }
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it("signs requests with native SigV4 and performs CRUD operations", async () => {
      const driver = new S3StorageDriver({
        bucket: "agents-test-bucket",
        endpoint: `http://127.0.0.1:${serverPort}`,
        region: "us-east-1",
        accessKeyId: "TEST_ACCESS_KEY",
        secretAccessKey: "TEST_SECRET_KEY",
        prefix: "packs",
        forcePathStyle: true,
      });

      const payload = new TextEncoder().encode("s3 archive binary content");

      // 1. PUT
      const s3Uri = await driver.put("agent-pack-1.0.0.tar.gz", payload);
      expect(s3Uri).toBe("s3://agents-test-bucket/packs/agent-pack-1.0.0.tar.gz");

      const putReq = receivedRequests.find((r) => r.method === "PUT");
      expect(putReq).toBeDefined();
      expect(putReq?.url).toBe("/agents-test-bucket/packs/agent-pack-1.0.0.tar.gz");
      expect(putReq?.headers.authorization).toContain("AWS4-HMAC-SHA256 Credential=TEST_ACCESS_KEY/");
      expect(putReq?.headers["x-amz-date"]).toBeDefined();
      expect(putReq?.headers["x-amz-content-sha256"]).toBeDefined();

      // 2. EXISTS
      const exists = await driver.exists("agent-pack-1.0.0.tar.gz");
      expect(exists).toBe(true);

      const notExists = await driver.exists("nonexistent.tar.gz");
      expect(notExists).toBe(false);

      // 3. GET
      const fetched = await driver.get("agent-pack-1.0.0.tar.gz");
      expect(fetched).not.toBeNull();
      expect(new TextDecoder().decode(fetched!)).toBe("s3 archive binary content");

      const fetchedMissing = await driver.get("nonexistent.tar.gz");
      expect(fetchedMissing).toBeNull();

      // 4. DELETE
      await driver.delete("agent-pack-1.0.0.tar.gz");
      const existsAfterDelete = await driver.exists("agent-pack-1.0.0.tar.gz");
      expect(existsAfterDelete).toBe(false);
    });
  });

  describe("createStorageDriverFromEnv", () => {
    const savedBucket = process.env.S3_BUCKET;

    afterEach(() => {
      if (savedBucket !== undefined) process.env.S3_BUCKET = savedBucket;
      else delete process.env.S3_BUCKET;
    });

    it("returns LocalStorageDriver when S3_BUCKET is unset", () => {
      delete process.env.S3_BUCKET;
      const driver = createStorageDriverFromEnv("/tmp/test-base");
      expect(driver).toBeInstanceOf(LocalStorageDriver);
    });

    it("returns S3StorageDriver when S3_BUCKET is set", () => {
      process.env.S3_BUCKET = "my-registry-bucket";
      const driver = createStorageDriverFromEnv("/tmp/test-base");
      expect(driver).toBeInstanceOf(S3StorageDriver);
    });
  });

  describe("Registry integration with MemoryStorageDriver", () => {
    it("publishes and downloads tarball seamlessly using an abstracted storage driver", async () => {
      const dataDir = await temporaryDirectory("agentshare-reg-storage-");
      const packDir = await temporaryDirectory("agentshare-pack-src-");
      const memoryDriver = new MemoryStorageDriver();

      const app = createApp({
        dataDir,
        storage: memoryDriver,
      });

      // Prepare a signed pack
      const keyPair = generateSigningKeyPair();
      const manifest = {
        spec: "agent-pack/v0",
        name: "storage-test-pack",
        version: "1.0.0",
        title: "Storage Test Pack",
        description: "Testing abstracted storage backend",
        mode: "offline",
        skills: ["."],
      };

      await fs.writeFile(path.join(packDir, "agent.json"), JSON.stringify(manifest));
      await fs.writeFile(path.join(packDir, "SKILL.md"), "# Storage Test Pack\n");
      const tarballPath = path.join(packDir, "pack.tgz");
      await createPackTarball(packDir, tarballPath);
      const tarball = await fs.readFile(tarballPath);
      const digest = createHash("sha256").update(tarball).digest("hex");
      const signature = signDigest(keyPair.privateKey, digest);

      const form = new FormData();
      form.set("manifest", JSON.stringify(manifest));
      form.set("tarball", new Blob([tarball], { type: "application/gzip" }), "pack.tgz");

      const pubRes = await app.request("/api/v1/agents", {
        method: "POST",
        headers: {
          authorization: "Bearer test-dev-token",
          "x-pack-digest": digest,
          "x-pack-signature": signature,
          "x-pack-public-key": encodePublicKeyHeader(keyPair.publicKey),
        },
        body: form,
      });

      expect(pubRes.status).toBe(201);
      const pubBody = (await pubRes.json()) as { ok: boolean; ref: string };
      expect(pubBody.ok).toBe(true);
      expect(pubBody.ref).toBe("dev/storage-test-pack@1.0.0");

      // Verify that the tarball was saved in memoryDriver
      const downloadRes = await app.request("/api/v1/agents/dev/storage-test-pack/1.0.0/download", {
        method: "GET",
        headers: { authorization: "Bearer test-dev-token" },
      });

      expect(downloadRes.status).toBe(200);
      const downloadedBytes = new Uint8Array(await downloadRes.arrayBuffer());
      expect(downloadedBytes.length).toBe(tarball.length);
      expect(Buffer.from(downloadedBytes).equals(Buffer.from(tarball))).toBe(true);
    });
  });
});
