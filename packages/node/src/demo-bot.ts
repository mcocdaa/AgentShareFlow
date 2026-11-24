import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface DemoBotServerOptions {
  port?: number;
  host?: string;
  name?: string;
}

export interface StartedDemoBotServer {
  port: number;
  url: string;
  name: string;
  close(): Promise<void>;
}

const PING_PATTERN = /\bping\s+@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})\b/i;

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(
          typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function buildDemoBotReply(
  name: string,
  message: string,
  from: string,
  context: Array<{ sender: string; content: string }>,
): string {
  const handleSlug = name
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");

  const pingMatch = PING_PATTERN.exec(message);
  if (pingMatch?.[1]) {
    const target = pingMatch[1].toLowerCase();
    return `@${target} ping @${handleSlug} (pong from ${name})`;
  }

  const sanitizeMentions = (text: string) =>
    text.replace(/@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})/g, "$1");

  const trimmed = sanitizeMentions(message.trim());
  if (context.length > 0) {
    const latest = context[context.length - 1];
    const snippet = latest
      ? `${latest.sender}: "${sanitizeMentions(latest.content.slice(0, 80))}"`
      : "";
    return `[${name}] Ack from ${from}: "${trimmed}" (context=${context.length}, latest ${snippet})`;
  }
  return `[${name}] Ack from ${from}: "${trimmed}"`;
}

export function startDemoBotServer(
  options: DemoBotServerOptions = {},
): Promise<StartedDemoBotServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const name = options.name ?? "helper-bot";

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/healthz") {
        writeJson(res, 200, { ok: true, name });
        return;
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        const message = typeof body["message"] === "string" ? body["message"] : "";
        const from = typeof body["from"] === "string" ? body["from"] : "unknown";
        const rawContext = Array.isArray(body["context"]) ? body["context"] : [];
        const context = rawContext
          .filter(
            (entry): entry is { sender: string; content: string } =>
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as Record<string, unknown>)["sender"] === "string" &&
              typeof (entry as Record<string, unknown>)["content"] === "string",
          )
          .map((entry) => ({ sender: entry.sender, content: entry.content }));

        const reply = buildDemoBotReply(name, message, from, context);
        writeJson(res, 200, { reply });
        return;
      }
      writeJson(res, 404, { error: "Not found" });
    } catch (err) {
      writeJson(res, 400, {
        error: err instanceof Error ? err.message : "Bad request",
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address() as AddressInfo;
      const hostStr =
        host === "0.0.0.0" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
      resolve({
        port: addr.port,
        url: `http://${hostStr}:${addr.port}`,
        name,
        close: () =>
          new Promise<void>((resClose) => {
            server.close(() => resClose());
          }),
      });
    });
  });
}
