import { gunzipSync } from "fflate";

function readString(bytes: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = start + length;
  while (end < limit && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(start, end));
}

function readOctal(bytes: Uint8Array, start: number, length: number): number {
  const text = readString(bytes, start, length).trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

export function readTarEntry(tar: Uint8Array, name: string): Uint8Array | undefined {
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const entryName = readString(header, 0, 100).replace(/^\.\//, "");
    const size = readOctal(header, 124, 12);
    const type = header[156] ?? 0;
    const dataStart = offset + 512;
    if ((type === 48 || type === 0) && entryName === name) {
      return tar.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

export function extractManifestFromTarball(bytes: Uint8Array): unknown {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(bytes);
  } catch {
    tar = bytes;
  }
  const entry = readTarEntry(tar, "agent.json");
  if (entry === undefined) throw new Error("agent.json not found in the tarball");
  try {
    return JSON.parse(new TextDecoder().decode(entry));
  } catch {
    throw new Error("agent.json is not valid JSON");
  }
}
