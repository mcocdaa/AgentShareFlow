import { describe, expect, it, vi } from "vitest";
import { handleMcpRequest, type McpDeps } from "../src/mcp.js";
import type { RegistryClient } from "../src/client.js";
import type { InstallOutcome } from "../src/commands.js";

function deps(overrides: Partial<McpDeps> = {}): McpDeps {
  const client = {
    search: vi.fn(async () => ({
      items: [
        {
          owner: "o",
          name: "hello",
          version: "1.0.0",
          title: "Hello",
          description: "d",
          mode: "offline",
          tags: ["handoff"],
          downloads: 2,
          createdAt: "now",
        },
      ],
    })),
    info: vi.fn(async () => ({
      owner: "o",
      name: "hello",
      version: "1.0.0",
      title: "Hello",
      description: "d",
      mode: "offline",
      tags: [],
      downloads: 2,
      createdAt: "now",
      digest: "abc",
      size: 1,
      downloadUrl: "/d",
      manifest: {},
      versions: ["1.0.0"],
    })),
  } as unknown as RegistryClient;
  const install = vi.fn(
    async (): Promise<InstallOutcome> => ({
      owner: "o",
      name: "hello",
      version: "1.0.0",
      mode: "offline",
      installed: [{ target: "agents", dest: "/home/u/.agents/skills/hello" }],
      skipped: [],
      scan: { findings: [], scannedFiles: 2, blocked: false },
      secrets: [],
    }),
  );
  return { registry: "http://relay.test", client, install, ...overrides };
}

async function call(request: Record<string, unknown>, d = deps()) {
  return (await handleMcpRequest(request, d)) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

describe("MCP server", () => {
  it("answers initialize and ignores the initialized notification", async () => {
    const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init.result?.["protocolVersion"]).toBe("2024-11-05");
    expect(init.result?.["serverInfo"]).toMatchObject({ name: "agentshare" });
    await expect(handleMcpRequest({ method: "notifications/initialized" }, deps())).resolves.toBeUndefined();
  });

  it("lists search, info, and install tools with schemas", async () => {
    const response = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = response.result?.["tools"] as Array<{ name: string; inputSchema: { required?: string[] } }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "agentshare_search",
      "agentshare_info",
      "agentshare_install",
    ]);
    expect(tools[0]?.inputSchema.required).toEqual(["query"]);
  });

  it("runs tools/call search and returns text content", async () => {
    const response = await call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "agentshare_search", arguments: { query: "handoff" } },
    });
    const content = response.result?.["content"] as Array<{ text: string }>;
    expect(content[0]?.text).toContain('"ref": "o/hello@1.0.0"');
  });

  it("installs through the shared install operation", async () => {
    const d = deps();
    const response = await call(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "agentshare_install", arguments: { ref: "o/hello@1.0.0", target: "codex" } },
      },
      d,
    );
    const content = response.result?.["content"] as Array<{ text: string }>;
    expect(content[0]?.text).toContain("installed o/hello@1.0.0");
    expect(d.install).toHaveBeenCalledWith("o/hello@1.0.0", { target: "codex" });
  });

  it("reports tool failures as isError results, not protocol errors", async () => {
    const failing = deps({
      install: vi.fn(async () => {
        throw new Error("install blocked by the security scan (high severity)");
      }),
    });
    const response = await call(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "agentshare_install", arguments: { ref: "o/evil" } },
      },
      failing,
    );
    expect(response.error).toBeUndefined();
    expect(response.result?.["isError"]).toBe(true);
    expect((response.result?.["content"] as Array<{ text: string }>)[0]?.text).toContain("security scan");
  });

  it("rejects unknown methods and unknown tools", async () => {
    const method = await call({ jsonrpc: "2.0", id: 6, method: "nope" });
    expect(method.error?.code).toBe(-32601);
    const tool = await call({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "agentshare_delete_everything", arguments: {} },
    });
    expect(tool.error?.code).toBe(-32602);
  });
});
