import { gzipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { extractManifestFromTarball, readTarEntry } from "../src/tar.js";

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function entry(name: string, content: string, type = 48): Uint8Array {
  const bytes = strToU8(content);
  const header = new Uint8Array(512);
  header.set(strToU8(name), 0);
  header.set(strToU8(bytes.length.toString(8).padStart(11, "0")), 124);
  header[156] = type;
  const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  padded.set(bytes);
  return concat([header, padded]);
}

function tar(entries: Uint8Array[]): Uint8Array {
  return concat([...entries, new Uint8Array(1024)]);
}

const manifest = JSON.stringify({ spec: "agent-pack/v0", name: "demo", version: "0.1.0" });

describe("extractManifestFromTarball", () => {
  it("reads agent.json from a gzipped tarball with mixed entries", () => {
    const bytes = gzipSync(
      tar([
        entry("SKILL.md", "# Demo\n"),
        entry("./agent.json", manifest),
        entry("references/notes.md", "notes\n"),
      ]),
    );
    expect(extractManifestFromTarball(bytes)).toMatchObject({ name: "demo", version: "0.1.0" });
  });

  it("reads an uncompressed tarball and skips directory entries", () => {
    const bytes = tar([entry("references/", "", 53), entry("agent.json", manifest)]);
    expect(extractManifestFromTarball(bytes)).toMatchObject({ name: "demo" });
  });

  it("fails when agent.json is missing or invalid", () => {
    expect(() => extractManifestFromTarball(gzipSync(tar([entry("SKILL.md", "# x\n")])))).toThrow(
      "agent.json not found in the tarball",
    );
    expect(() => extractManifestFromTarball(tar([entry("agent.json", "{oops")]))).toThrow(
      "agent.json is not valid JSON",
    );
  });
});

describe("readTarEntry", () => {
  it("normalizes ./ prefixes and returns raw bytes", () => {
    const value = readTarEntry(tar([entry("./agent.json", manifest)]), "agent.json");
    expect(new TextDecoder().decode(value)).toBe(manifest);
  });

  it("returns undefined when absent", () => {
    expect(readTarEntry(tar([entry("SKILL.md", "x")]), "agent.json")).toBeUndefined();
  });
});
