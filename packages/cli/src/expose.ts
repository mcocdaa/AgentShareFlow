import {
  ShareClient,
  TunnelClient,
  fetchAgentCard,
  sendA2AMessage,
  type A2ASendResult,
  type TunnelFrame,
} from "@agentshare/core";
import { loadConfig, resolveRegistry, resolveToken } from "./config.js";

export interface ExposeOptions {
  a2a?: string;
  title?: string;
  project?: string;
  registry?: string;
  token?: string;
}

export interface A2AForwarder {
  onFrame: (frame: TunnelFrame) => void;
  idle: () => Promise<void>;
}

export function createA2AForwarder(
  reply: (text: string, contextId?: string) => Promise<A2ASendResult>,
  send: (frame: TunnelFrame) => Promise<void>,
): A2AForwarder {
  const contexts = new Map<string, string>();
  const queues = new Map<string, Promise<void>>();

  const enqueue = (key: string, task: () => Promise<void>): void => {
    const previous = queues.get(key) ?? Promise.resolve();
    queues.set(
      key,
      previous.then(task).catch(() => {}),
    );
  };

  return {
    onFrame(frame: TunnelFrame): void {
      if (frame.type !== "visitor_message") return;
      enqueue(frame.sessionId, async () => {
        try {
          const contextId = contexts.get(frame.sessionId);
          const result = await reply(frame.content, contextId);
          if (result.contextId !== undefined) contexts.set(frame.sessionId, result.contextId);
          await send({
            type: "agent_done",
            shareId: frame.shareId,
            sessionId: frame.sessionId,
            content: result.text.length > 0 ? result.text : "(the agent returned no text)",
          });
        } catch (error) {
          await send({
            type: "agent_error",
            shareId: frame.shareId,
            sessionId: frame.sessionId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
    async idle(): Promise<void> {
      await Promise.all([...queues.values()]);
    },
  };
}

export async function exposeCommand(options: ExposeOptions): Promise<void> {
  if (options.a2a === undefined || options.a2a.length === 0) {
    throw new Error("--a2a <url> is required");
  }
  const config = loadConfig();
  const registry = resolveRegistry(config, options.registry);
  const token = resolveToken(config, options.token);
  if (!token) throw new Error("not logged in, run `agentshare login` or pass --token");

  const card = await fetchAgentCard(options.a2a);
  const endpoint = URL.canParse(card.url) ? card.url : options.a2a;

  const client = new ShareClient({ registry, token });
  const share = await client.createShare({
    title: options.title ?? card.name,
    mode: "tunnel",
    ...options.project === undefined ? {} : { project: options.project },
  });

  let tunnel: TunnelClient;
  const forwarder = createA2AForwarder(
    (text, contextId) =>
      sendA2AMessage(endpoint, text, contextId === undefined ? {} : { contextId }),
    (frame) => tunnel.send(frame),
  );

  tunnel = new TunnelClient({
    registry,
    shareId: share.id,
    token,
    onFrame: (frame) => forwarder.onFrame(frame),
    onStatus: (status) => {
      if (status === "online") console.log("online  tunnel connected");
    },
  });
  tunnel.start();

  console.log(`expose  ${card.name} -> ${share.url ?? client.shareUrl(share.id)}`);
  console.log(`facade  ${registry.replace(/\/$/, "")}/api/v1/shares/${share.id}/a2a`);
  console.log(`agent   ${endpoint}`);
  console.log("stop    Ctrl+C revokes the share");

  const shutdown = async (): Promise<void> => {
    await tunnel.stop();
    try {
      await client.revokeShare(share.id);
      console.log(`revoked ${share.id}`);
    } catch (error) {
      console.error(`revoke failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await new Promise<void>(() => {});
}
