export interface A2AAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
}

export interface A2AAgentCard {
  name: string;
  description?: string;
  version?: string;
  url: string;
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: A2AAgentSkill[];
  [key: string]: unknown;
}

export interface A2AMessagePart {
  text?: string;
  [key: string]: unknown;
}

export interface A2ASendResult {
  text: string;
  contextId?: string;
  taskId?: string;
  state?: string;
}

export interface A2AClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function agentCardUrl(base: string): string {
  const url = new URL(base);
  if (url.pathname.endsWith(".json")) return url.toString();
  return new URL("/.well-known/agent-card.json", url).toString();
}

export async function fetchAgentCard(base: string, options: A2AClientOptions = {}): Promise<A2AAgentCard> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(agentCardUrl(base), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`agent card fetch failed: HTTP ${res.status}`);
  const card = (await res.json()) as Partial<A2AAgentCard>;
  if (typeof card.name !== "string" || typeof card.url !== "string") {
    throw new Error("invalid agent card: name and url are required");
  }
  return card as A2AAgentCard;
}

function textFromParts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const texts: string[] = [];
  for (const part of value) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (typeof record["text"] === "string") texts.push(record["text"]);
  }
  return texts;
}

export function extractA2AText(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];
  const record = result as Record<string, unknown>;
  const texts: string[] = [];

  const message = record["message"];
  if (typeof message === "object" && message !== null) {
    texts.push(...textFromParts((message as Record<string, unknown>)["parts"]));
  }

  const task = record["task"];
  if (typeof task === "object" && task !== null) {
    const taskRecord = task as Record<string, unknown>;
    const artifacts = taskRecord["artifacts"];
    if (Array.isArray(artifacts)) {
      for (const artifact of artifacts) {
        if (typeof artifact !== "object" || artifact === null) continue;
        texts.push(...textFromParts((artifact as Record<string, unknown>)["parts"]));
      }
    }
    const history = taskRecord["history"];
    if (Array.isArray(history)) {
      for (const entry of history) {
        if (typeof entry !== "object" || entry === null) continue;
        const entryRecord = entry as Record<string, unknown>;
        if (entryRecord["role"] !== "agent") continue;
        texts.push(...textFromParts(entryRecord["parts"]));
      }
    }
    const status = taskRecord["status"];
    if (typeof status === "object" && status !== null) {
      const statusMessage = (status as Record<string, unknown>)["message"];
      if (typeof statusMessage === "object" && statusMessage !== null) {
        texts.push(...textFromParts((statusMessage as Record<string, unknown>)["parts"]));
      }
    }
  }
  return texts;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

async function callJsonRpc(
  endpoint: string,
  method: string,
  params: unknown,
  options: A2AClientOptions,
): Promise<JsonRpcResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`A2A request failed: HTTP ${res.status}`);
  return (await res.json()) as JsonRpcResponse;
}

export interface A2ASendOptions extends A2AClientOptions {
  contextId?: string;
  referenceTaskIds?: string[];
}

export async function sendA2AMessage(
  endpoint: string,
  text: string,
  options: A2ASendOptions = {},
): Promise<A2ASendResult> {
  const message = {
    role: "user",
    parts: [{ text }],
    messageId: crypto.randomUUID(),
    ...options.contextId === undefined ? {} : { contextId: options.contextId },
    ...options.referenceTaskIds === undefined ? {} : { referenceTaskIds: options.referenceTaskIds },
  };

  let payload = await callJsonRpc(endpoint, "SendMessage", { message }, options);
  if (payload.error?.code === -32601) {
    payload = await callJsonRpc(endpoint, "message/send", { message }, options);
  }
  if (payload.error) throw new Error(payload.error.message ?? `A2A error ${payload.error.code ?? ""}`);
  if (payload.result === undefined) throw new Error("A2A response has no result");

  const result = payload.result as Record<string, unknown>;
  const task = result["task"] as Record<string, unknown> | undefined;
  const messageResult = result["message"] as Record<string, unknown> | undefined;
  const contextId =
    (typeof task?.["contextId"] === "string" ? task["contextId"] : undefined) ??
    (typeof messageResult?.["contextId"] === "string" ? messageResult["contextId"] : undefined) ??
    options.contextId;

  return {
    text: extractA2AText(result).join("\n").trim(),
    ...contextId === undefined ? {} : { contextId },
    ...task === undefined || typeof task["id"] !== "string" ? {} : { taskId: task["id"] },
    ...task === undefined || typeof (task["status"] as Record<string, unknown> | undefined)?.["state"] !== "string"
      ? {}
      : { state: (task["status"] as Record<string, unknown>)["state"] as string },
  };
}
