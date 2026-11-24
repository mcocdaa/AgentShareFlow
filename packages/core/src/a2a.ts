import { randomUUID } from "node:crypto";
import { assertSafeExternalUrl, type DnsLookupFn } from "./ssrf.js";

export interface ContextMessage {
  sender: string;
  content: string;
}

export interface SendHttpOrA2aOptions {
  url: string;
  mode: "http" | "a2a";
  message: string;
  context?: ContextMessage[];
  from: string;
  roomId?: string | null;
  headers?: Record<string, string>;
  allowPrivate?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  lookupFn?: DnsLookupFn;
}

export interface SendHttpOrA2aResult {
  reply: string;
  taskId?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTextFromParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const texts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part["text"] === "string") {
      texts.push(part["text"]);
    }
  }
  return texts;
}

function extractFromTaskObject(task: Record<string, unknown>): {
  texts: string[];
  taskId?: string;
} {
  const texts: string[] = [];
  const taskId = typeof task["id"] === "string" ? task["id"] : undefined;

  const artifacts = task["artifacts"];
  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      if (!isRecord(artifact)) continue;
      texts.push(...extractTextFromParts(artifact["parts"]));
    }
  }

  const status = task["status"];
  if (isRecord(status) && isRecord(status["message"])) {
    texts.push(...extractTextFromParts(status["message"]["parts"]));
  }

  const history = task["history"];
  if (Array.isArray(history)) {
    for (const entry of history) {
      if (!isRecord(entry)) continue;
      const role = entry["role"];
      if (role !== "agent" && role !== "assistant") continue;
      texts.push(...extractTextFromParts(entry["parts"]));
    }
  }

  return { texts, taskId };
}

function extractFromMessageObject(message: Record<string, unknown>): {
  texts: string[];
  taskId?: string;
} {
  const texts = extractTextFromParts(message["parts"]);
  const taskId =
    typeof message["taskId"] === "string" ? message["taskId"] : undefined;
  return { texts, taskId };
}

export function extractA2aResult(result: unknown): SendHttpOrA2aResult {
  if (!isRecord(result)) {
    throw new Error("Invalid A2A response: result must be an object");
  }

  const collected: string[] = [];
  let taskId: string | undefined;

  const appendUnique = (items: string[]) => {
    for (const item of items) {
      const trimmed = item.trim();
      if (trimmed && !collected.includes(trimmed)) {
        collected.push(trimmed);
      }
    }
  };

  // Wrapped union shapes (A2A v1 / protobuf-JSON): result.message and/or result.task
  if (isRecord(result["message"])) {
    const extracted = extractFromMessageObject(result["message"]);
    appendUnique(extracted.texts);
    if (extracted.taskId) taskId = extracted.taskId;
  }

  if (isRecord(result["task"])) {
    const extracted = extractFromTaskObject(result["task"]);
    appendUnique(extracted.texts);
    if (extracted.taskId) taskId = extracted.taskId;
  }

  // Top-level A2A v0.2/v0.3 Message shape
  if (result["kind"] === "message" || Array.isArray(result["parts"])) {
    const extracted = extractFromMessageObject(result);
    appendUnique(extracted.texts);
    if (extracted.taskId && !taskId) taskId = extracted.taskId;
  }

  // Top-level A2A v0.2/v0.3 Task shape
  if (
    result["kind"] === "task" ||
    "artifacts" in result ||
    "status" in result ||
    "history" in result
  ) {
    const extracted = extractFromTaskObject(result);
    appendUnique(extracted.texts);
    if (extracted.taskId && !taskId) taskId = extracted.taskId;
  }

  return {
    reply: collected.join("\n"),
    ...(taskId !== undefined ? { taskId } : {}),
  };
}

function buildHeaders(
  custom?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (custom) {
    for (const [key, value] of Object.entries(custom)) {
      headers[key] = value;
    }
  }
  return headers;
}

async function postJsonNoRedirect(
  safeUrl: URL,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const res = await fetchImpl(safeUrl.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `Redirect blocked for security (HTTP ${res.status} from ${safeUrl.origin})`,
    );
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 256);
    throw new Error(
      `Remote agent request failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  return res;
}

export async function sendHttpOrA2aMessage(
  opts: SendHttpOrA2aOptions,
): Promise<SendHttpOrA2aResult> {
  const safeUrl = await assertSafeExternalUrl(opts.url, {
    allowPrivate: opts.allowPrivate,
    lookupFn: opts.lookupFn,
  });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = buildHeaders(opts.headers);

  if (opts.mode === "http") {
    const res = await postJsonNoRedirect(
      safeUrl,
      {
        message: opts.message,
        from: opts.from,
        roomId: opts.roomId ?? null,
        context: opts.context ?? [],
      },
      headers,
      timeoutMs,
      fetchImpl,
    );

    const rawText = await res.text();
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (typeof parsed === "string") {
        return { reply: parsed };
      }
      if (isRecord(parsed)) {
        const taskId =
          typeof parsed["taskId"] === "string" ? parsed["taskId"] : undefined;
        for (const field of ["reply", "text", "output", "content", "message"]) {
          if (typeof parsed[field] === "string") {
            return {
              reply: parsed[field],
              ...(taskId !== undefined ? { taskId } : {}),
            };
          }
        }
        throw new Error(
          "HTTP agent JSON response missing reply/text/output/content/message string field",
        );
      }
      throw new Error("HTTP agent returned unsupported JSON response");
    } catch (err) {
      if (err instanceof SyntaxError) {
        return { reply: rawText.trim() };
      }
      throw err;
    }
  }

  const rpcParams = {
    message: {
      kind: "message",
      messageId: randomUUID(),
      role: "user",
      parts: [{ kind: "text", text: opts.message }],
      metadata: {
        from: opts.from,
        ...(opts.roomId !== undefined ? { roomId: opts.roomId } : {}),
        ...(opts.context !== undefined ? { context: opts.context } : {}),
      },
    },
  };

  const callA2a = async (method: string): Promise<Record<string, unknown>> => {
    const res = await postJsonNoRedirect(
      safeUrl,
      {
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params: rpcParams,
      },
      headers,
      timeoutMs,
      fetchImpl,
    );
    const data: unknown = await res.json();
    if (!isRecord(data)) {
      throw new Error("Invalid A2A JSON-RPC response");
    }
    return data;
  };

  let rpc = await callA2a("message/send");
  if (isRecord(rpc["error"]) && rpc["error"]["code"] === -32601) {
    rpc = await callA2a("SendMessage");
  }

  if (isRecord(rpc["error"])) {
    const code = rpc["error"]["code"];
    const message = rpc["error"]["message"];
    throw new Error(
      `A2A JSON-RPC error${code !== undefined ? ` (${String(code)})` : ""}: ${typeof message === "string" ? message : "unknown error"}`,
    );
  }

  return extractA2aResult(rpc["result"]);
}
