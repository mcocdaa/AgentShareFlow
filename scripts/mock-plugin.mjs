import { writeFileSync } from "node:fs";
import { ShareClient, TunnelClient } from "../packages/core/dist/index.js";

const registry = process.env.AGENTSHARE_REGISTRY ?? "http://localhost:8787";
const token = process.env.AGENTSHARE_TOKEN ?? "devtoken";
const title = process.env.AGENTSHARE_TITLE ?? "mock agent";

const client = new ShareClient({ registry, token });
const share = await client.createShare({ title, project: "mock" });
console.log(`share: ${share.id}`);
console.log(`url:   ${client.shareUrl(share.id)}`);
if (process.env.AGENTSHARE_SHARE_FILE) {
  writeFileSync(process.env.AGENTSHARE_SHARE_FILE, share.id);
}

const tunnel = new TunnelClient({
  registry,
  shareId: share.id,
  token,
  onStatus: (status) => console.log(`tunnel: ${status}`),
  onFrame: (frame) => {
    if (frame.type !== "visitor_message") return;
    console.log(`visitor[${frame.sessionId}]: ${frame.content}`);
    void (async () => {
      await tunnel.send({
        type: "fork_created",
        shareId: share.id,
        sessionId: frame.sessionId,
        dshSessionId: `mock-${frame.sessionId}`,
      });
      const reply = `pong: ${frame.content}`;
      for (const chunk of reply.match(/.{1,8}/g) ?? []) {
        await tunnel.send({
          type: "agent_chunk",
          shareId: share.id,
          sessionId: frame.sessionId,
          content: chunk,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await tunnel.send({
        type: "agent_done",
        shareId: share.id,
        sessionId: frame.sessionId,
        content: reply,
      });
    })();
  },
});

tunnel.start();
process.on("SIGTERM", () => {
  void tunnel.stop().then(() => process.exit(0));
});
setInterval(() => {}, 60_000);
