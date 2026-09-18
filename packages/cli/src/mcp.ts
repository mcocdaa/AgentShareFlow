import { createInterface } from "node:readline";
import { installPack, type InstallOutcome, type InstallOptions } from "./commands.js";
import type { RegistryClient } from "./client.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "agentshare";
export const MCP_SERVER_VERSION = "0.1.0";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "agentshare_search",
    description:
      "Search AgentShare packs (skills, prompts, MCP configs) by keyword. Returns owner/name@version, mode, and descriptions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword." },
        mode: { type: "string", enum: ["offline", "endpoint", "runtime"] },
      },
      required: ["query"],
    },
  },
  {
    name: "agentshare_info",
    description: "Show one AgentShare pack: versions, tags, install targets, declared secret names, endpoint or runtime.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Pack reference owner/name[@version]." },
      },
      required: ["ref"],
    },
  },
  {
    name: "agentshare_install",
    description:
      "Install an AgentShare pack into a local harness skill directory (default cross-client `agents`). High-severity security findings abort the install.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Pack reference owner/name[@version]." },
        target: {
          type: "string",
          description: "agents, claude, codex, opencode, openclaw, hermes, or all. Default agents.",
        },
        project: { type: "boolean", description: "Install into the current project instead of the user directory." },
        force: { type: "boolean", description: "Overwrite an existing install." },
      },
      required: ["ref"],
    },
  },
];

export interface McpDeps {
  registry: string;
  client: RegistryClient;
  install: (ref: string, options: InstallOptions) => Promise<InstallOutcome>;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function textContent(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function installSummary(result: InstallOutcome): string {
  const lines = [`installed ${result.owner}/${result.name}@${result.version} (mode: ${result.mode})`];
  for (const item of result.installed) lines.push(`-> ${item.dest}`);
  for (const dest of result.skipped) lines.push(`skipped ${dest} (exists)`);
  if (result.endpoint) lines.push(`endpoint ${result.endpoint.type} ${result.endpoint.url}`);
  if (result.secrets.length > 0) lines.push(`secrets ${result.secrets.join(", ")}`);
  if (result.installed.length === 0 && result.skipped.length === 0) lines.push("nothing installed");
  return lines.join("\n");
}

export async function handleMcpRequest(request: JsonRpcRequest, deps: McpDeps): Promise<unknown | undefined> {
  const id = request.id ?? null;
  if (typeof request.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
  }
  switch (request.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        },
      };
    case "notifications/initialized":
      return undefined;
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    case "tools/call": {
      const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const name = params.name;
      try {
        if (name === "agentshare_search") {
          const query = typeof args["query"] === "string" ? args["query"].trim() : "";
          if (query === "") throw new Error("query is required");
          const mode = typeof args["mode"] === "string" ? args["mode"] : undefined;
          const { items } = await deps.client.search(query, mode);
          return {
            jsonrpc: "2.0",
            id,
            result: textContent(
              JSON.stringify(
                items.map((item) => ({
                  ref: `${item.owner}/${item.name}@${item.version}`,
                  mode: item.mode,
                  title: item.title,
                  description: item.description,
                  tags: item.tags,
                  downloads: item.downloads,
                })),
                null,
                2,
              ),
            ),
          };
        }
        if (name === "agentshare_info") {
          const ref = typeof args["ref"] === "string" ? args["ref"] : "";
          if (ref === "") throw new Error("ref is required");
          const slash = ref.split("@")[0]?.split("/") ?? [];
          const owner = slash[0];
          const packName = slash[1];
          if (!owner || !packName) throw new Error("ref must be owner/name[@version]");
          const detail = await deps.client.info(owner, packName, ref.split("@")[1]);
          return {
            jsonrpc: "2.0",
            id,
            result: textContent(JSON.stringify(detail, null, 2)),
          };
        }
        if (name === "agentshare_install") {
          const ref = typeof args["ref"] === "string" ? args["ref"] : "";
          if (ref === "") throw new Error("ref is required");
          const result = await deps.install(ref, {
            ...typeof args["target"] === "string" ? { target: args["target"] } : {},
            ...args["project"] === true ? { project: true } : {},
            ...args["force"] === true ? { force: true } : {},
          });
          return { jsonrpc: "2.0", id, result: textContent(installSummary(result)) };
        }
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `unknown tool: ${String(name)}` },
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            ...textContent(error instanceof Error ? error.message : String(error)),
            isError: true,
          },
        };
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${request.method}` } };
  }
}

export function serveMcpCommand(deps: McpDeps): void {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const write = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    void handleMcpRequest(request, deps)
      .then((response) => {
        if (response !== undefined) write(response);
      })
      .catch((error: unknown) => {
        write({
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      });
  });
}


