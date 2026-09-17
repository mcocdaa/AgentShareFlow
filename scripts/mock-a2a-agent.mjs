import { createServer } from "node:http";

const port = Number(process.env.MOCK_A2A_PORT ?? 9999);
const base = `http://127.0.0.1:${port}`;

const card = {
  name: "Mock A2A Agent",
  description: "Echoes text back; used to smoke-test endpoint shares.",
  version: "1.0.0",
  url: base,
  protocolVersion: "1.0",
  capabilities: {},
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "echo", name: "Echo", description: "Replies with pong: <text>" }],
};

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(card));
    return;
  }
  if (req.method === "POST" && req.url === "/") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      let request;
      try {
        request = JSON.parse(raw);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (request.method !== "SendMessage" && request.method !== "message/send") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601 } }));
        return;
      }
      const text = request.params?.message?.parts?.[0]?.text ?? "";
      const contextId = request.params?.message?.contextId ?? `ctx-${Date.now()}`;
      console.log(`[mock-a2a] ${request.method}: ${text}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            task: {
              id: `task-${Date.now()}`,
              contextId,
              status: { state: "TASK_STATE_COMPLETED" },
              artifacts: [{ artifactId: "reply", name: "reply", parts: [{ text: `pong: ${text}` }] }],
            },
          },
        }),
      );
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock A2A agent on ${base}`);
  console.log(`card: ${base}/.well-known/agent-card.json`);
});
