import { randomBytes } from "node:crypto";
import {
  type A2AAgentCard,
  type Handoff,
  type ShareMode,
  fetchAgentCard,
  formatHandoffIssues,
  isTunnelFrame,
  parseHandoff,
  sendA2AMessage,
  type TunnelFrame,
} from "@agentshare/core";
import { Hono } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import { streamSSE } from "hono/streaming";
import { authenticate } from "./auth.js";
import { type RegistryDb, type ShareMessageRow, type ShareRow } from "./db.js";
import type { HubStream, ShareHub } from "./share-hub.js";

const WINDOW_MS = 60_000;
const SHARE_LIMIT_PER_WINDOW = 30;
const SESSION_LIMIT_PER_WINDOW = 10;

function makeHubStream(stream: SSEStreamingApi): HubStream {
  return {
    write: (event, data) => {
      void stream.writeSSE({ event, data: JSON.stringify(data) });
    },
    close: () => {
      void stream.close();
    },
  };
}

function effectiveStatus(share: ShareRow, hub: ShareHub): "online" | "offline" | "revoked" {
  if (share.status === "revoked") return "revoked";
  if (share.mode === "endpoint") return "online";
  return hub.hasTunnel(share.id) ? "online" : "offline";
}

function agentInfo(share: ShareRow) {
  if (share.agent_card === null) return undefined;
  try {
    const card = JSON.parse(share.agent_card) as A2AAgentCard;
    return {
      name: card.name,
      ...card.description === undefined ? {} : { description: card.description },
      ...card.skills === undefined
        ? {}
        : {
            skills: card.skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
              ...skill.description === undefined ? {} : { description: skill.description },
            })),
          },
    };
  } catch {
    return undefined;
  }
}

function storedHandoff(share: ShareRow): Handoff | undefined {
  if (share.handoff === null) return undefined;
  try {
    return parseHandoff(JSON.parse(share.handoff));
  } catch {
    return undefined;
  }
}

function summary(share: ShareRow, hub: ShareHub, baseUrl: string) {
  return {
    id: share.id,
    owner: share.owner,
    title: share.title,
    mode: share.mode,
    project: share.project ?? undefined,
    status: effectiveStatus(share, hub),
    url: `${baseUrl.replace(/\/$/, "")}/#/share/${share.id}`,
    ...agentInfo(share) === undefined ? {} : { agent: agentInfo(share) },
    hasHandoff: share.handoff !== null,
    createdAt: share.created_at,
    lastSeenAt: share.last_seen_at ?? undefined,
  };
}

function detail(share: ShareRow, hub: ShareHub, baseUrl: string) {
  const handoff = storedHandoff(share);
  return {
    ...summary(share, hub, baseUrl),
    ...handoff === undefined ? {} : { handoff },
  };
}

function messagePayload(message: ShareMessageRow) {
  return {
    id: message.id,
    sessionId: message.session_id,
    role: message.role,
    content: message.content,
    createdAt: message.created_at,
  };
}

export interface ShareRouteDeps {
  db: RegistryDb;
  hub: ShareHub;
  publicUrl?: string;
}

export function createShareRoutes({ db, hub, publicUrl }: ShareRouteDeps): Hono {
  const app = new Hono();
  const hits = new Map<string, number[]>();

  const baseUrl = (requestUrl: string): string => publicUrl ?? new URL(requestUrl).origin;

  const allow = (key: string, limit: number): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };

  const owner = (header: string | undefined): string | undefined => authenticate(header)?.owner;

  const respondWithA2A = async (share: ShareRow, sessionId: string, content: string): Promise<void> => {
    const finish = (role: ShareMessageRow["role"], text: string): void => {
      const message = db.insertShareMessage({
        sessionId,
        role,
        content: text,
        created_at: new Date().toISOString(),
      });
      hub.publish(share.id, "message", messagePayload(message), sessionId);
      hub.publish(share.id, "done", { sessionId }, sessionId);
    };
    try {
      const session = db.getShareSession(sessionId);
      const result = await sendA2AMessage(share.endpoint_url ?? "", content, {
        ...session?.a2a_context_id == null ? {} : { contextId: session.a2a_context_id },
      });
      if (result.contextId !== undefined) db.setShareSessionA2aContext(sessionId, result.contextId);
      finish("agent", result.text === "" ? "(the agent returned no text)" : result.text);
    } catch (error) {
      finish("system", `A2A error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  app.post("/shares", async (c) => {
    const who = owner(c.req.header("authorization"));
    if (!who) return c.json({ error: "unauthorized" }, 401);

    const body = (await c.req.json().catch(() => ({}))) as {
      title?: unknown;
      project?: unknown;
      mode?: unknown;
      agentCardUrl?: unknown;
      handoff?: unknown;
    };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title.length === 0 || title.length > 120) {
      return c.json({ error: "title is required (1-120 chars)" }, 400);
    }
    const project =
      typeof body.project === "string" && body.project.length <= 200 ? body.project : null;
    const mode: ShareMode = body.mode === "endpoint" ? "endpoint" : "tunnel";

    let handoff: string | null = null;
    if (body.handoff !== undefined && body.handoff !== null) {
      const serialized = JSON.stringify(body.handoff);
      if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
        return c.json({ error: "handoff exceeds 256 KiB" }, 400);
      }
      try {
        handoff = JSON.stringify(parseHandoff(body.handoff));
      } catch (error) {
        return c.json({ error: "invalid handoff", details: formatHandoffIssues(error) }, 400);
      }
    }

    let endpointUrl: string | null = null;
    let agentCard: string | null = null;
    if (mode === "endpoint") {
      const cardUrl = typeof body.agentCardUrl === "string" ? body.agentCardUrl.trim() : "";
      if (cardUrl === "") {
        return c.json({ error: "agentCardUrl is required for endpoint shares" }, 400);
      }
      try {
        const card = await fetchAgentCard(cardUrl);
        endpointUrl = card.url;
        agentCard = JSON.stringify(card);
      } catch (error) {
        return c.json(
          {
            error: "failed to fetch agent card",
            details: error instanceof Error ? error.message : String(error),
          },
          400,
        );
      }
    }

    const share: ShareRow = {
      id: randomBytes(16).toString("hex"),
      owner: who,
      title,
      project,
      status: "offline",
      mode,
      endpoint_url: endpointUrl,
      agent_card: agentCard,
      handoff,
      created_at: new Date().toISOString(),
      last_seen_at: null,
    };
    db.insertShare(share);
    return c.json(detail(share, hub, baseUrl(c.req.url)), 201);
  });

  app.get("/shares", (c) => {
    const who = owner(c.req.header("authorization"));
    if (!who) return c.json({ error: "unauthorized" }, 401);
    const base = baseUrl(c.req.url);
    return c.json({ items: db.listShares(who).map((share) => summary(share, hub, base)) });
  });

  app.get("/shares/:id", (c) => {
    const share = db.getShare(c.req.param("id"));
    if (!share) return c.json({ error: "not found" }, 404);
    return c.json(detail(share, hub, baseUrl(c.req.url)));
  });

  app.post("/shares/:id/revoke", (c) => {
    const who = owner(c.req.header("authorization"));
    if (!who) return c.json({ error: "unauthorized" }, 401);
    const share = db.getShare(c.req.param("id"));
    if (!share) return c.json({ error: "not found" }, 404);
    if (share.owner !== who) return c.json({ error: "forbidden" }, 403);

    db.setShareStatus(share.id, "revoked");
    hub.publish(share.id, "status", { status: "revoked" });
    hub.closeShare(share.id);
    return c.json(summary({ ...share, status: "revoked" }, hub, baseUrl(c.req.url)));
  });

  app.get("/shares/:id/transcript", (c) => {
    const who = owner(c.req.header("authorization"));
    if (!who) return c.json({ error: "unauthorized" }, 401);
    const share = db.getShare(c.req.param("id"));
    if (!share) return c.json({ error: "not found" }, 404);
    if (share.owner !== who) return c.json({ error: "forbidden" }, 403);
    return c.json({
      share: summary(share, hub, baseUrl(c.req.url)),
      sessions: db.listShareSessions(share.id),
      messages: db.listShareMessages(share.id).map(messagePayload),
    });
  });

  app.get("/shares/:id/events", (c) =>
    streamSSE(c, async (stream) => {
      const share = db.getShare(c.req.param("id"));
      if (!share) {
        await stream.writeSSE({ event: "status", data: JSON.stringify({ status: "revoked" }) });
        await stream.close();
        return;
      }
      const sessionId = c.req.query("sessionId") ?? undefined;
      const client = makeHubStream(stream);
      let alive = true;
      hub.addVisitor(share.id, client, sessionId);
      stream.onAbort(() => {
        alive = false;
        hub.removeVisitor(share.id, client);
      });

      await stream.writeSSE({
        event: "status",
        data: JSON.stringify({ status: effectiveStatus(share, hub) }),
      });
      if (sessionId) {
        for (const message of db.listShareMessages(share.id, sessionId)) {
          await stream.writeSSE({ event: "message", data: JSON.stringify(messagePayload(message)) });
        }
      }
      while (alive) {
        await stream.sleep(15_000);
        if (!alive) break;
        try {
          await stream.writeSSE({ event: "ping", data: "{}" });
        } catch {
          break;
        }
      }
    }),
  );

  app.post("/shares/:id/messages", async (c) => {
    const share = db.getShare(c.req.param("id"));
    if (!share) return c.json({ error: "not found" }, 404);
    if (share.status === "revoked") return c.json({ error: "share is revoked" }, 410);
    const isEndpoint = share.mode === "endpoint";
    if (!isEndpoint && !hub.hasTunnel(share.id)) {
      return c.json({ error: "share is offline" }, 409);
    }
    if (isEndpoint && share.endpoint_url === null) {
      return c.json({ error: "endpoint share has no agent url" }, 409);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: unknown;
      content?: unknown;
      visitorName?: unknown;
    };
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (content.length === 0 || content.length > 4000) {
      return c.json({ error: "content is required (1-4000 chars)" }, 400);
    }
    const visitorName =
      typeof body.visitorName === "string" && body.visitorName.trim().length > 0
        ? body.visitorName.trim().slice(0, 40)
        : undefined;

    let sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    if (sessionId) {
      const session = db.getShareSession(sessionId);
      if (!session || session.share_id !== share.id) {
        return c.json({ error: "unknown sessionId for this share" }, 400);
      }
    } else {
      sessionId = randomBytes(12).toString("hex");
      db.insertShareSession({
        id: sessionId,
        share_id: share.id,
        visitor_name: visitorName ?? null,
        created_at: new Date().toISOString(),
      });
    }

    if (!allow(`share:${share.id}`, SHARE_LIMIT_PER_WINDOW)) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    if (!allow(`session:${sessionId}`, SESSION_LIMIT_PER_WINDOW)) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }

    const message = db.insertShareMessage({
      sessionId,
      role: "visitor",
      content,
      created_at: new Date().toISOString(),
    });
    hub.publish(share.id, "message", messagePayload(message), sessionId);

    if (isEndpoint) {
      void respondWithA2A(share, sessionId, content);
      return c.json({ sessionId, message: messagePayload(message) }, 201);
    }

    const frame: TunnelFrame = {
      type: "visitor_message",
      shareId: share.id,
      sessionId,
      messageId: message.id,
      content,
      ...(visitorName === undefined ? {} : { visitorName }),
    };
    if (!hub.sendToTunnel(share.id, frame)) {
      return c.json({ error: "share is offline" }, 409);
    }
    return c.json({ sessionId, message: messagePayload(message) }, 201);
  });

  app.get("/tunnel/:shareId/events", (c) =>
    streamSSE(c, async (stream) => {
      const who = owner(c.req.header("authorization"));
      if (!who) {
        await stream.close();
        return;
      }
      const share = db.getShare(c.req.param("shareId"));
      if (!share || share.owner !== who || share.status === "revoked" || share.mode !== "tunnel") {
        await stream.close();
        return;
      }

      const client = makeHubStream(stream);
      hub.connectTunnel(share.id, client);
      db.setShareStatus(share.id, "online");
      db.touchShare(share.id, new Date().toISOString());
      hub.publish(share.id, "status", { status: "online" });

      let alive = true;
      stream.onAbort(() => {
        alive = false;
        if (hub.disconnectTunnel(share.id, client)) {
          const current = db.getShare(share.id);
          if (current && current.status !== "revoked") {
            db.setShareStatus(share.id, "offline");
            hub.publish(share.id, "status", { status: "offline" });
          }
        }
      });

      await stream.writeSSE({
        event: "frame",
        data: JSON.stringify({ type: "ping", at: new Date().toISOString() }),
      });
      while (alive) {
        await stream.sleep(15_000);
        if (!alive) break;
        try {
          await stream.writeSSE({
            event: "frame",
            data: JSON.stringify({ type: "ping", at: new Date().toISOString() }),
          });
        } catch {
          break;
        }
      }
    }),
  );

  app.post("/tunnel/:shareId/frames", async (c) => {
    const who = owner(c.req.header("authorization"));
    if (!who) return c.json({ error: "unauthorized" }, 401);
    const share = db.getShare(c.req.param("shareId"));
    if (!share) return c.json({ error: "not found" }, 404);
    if (share.owner !== who) return c.json({ error: "forbidden" }, 403);
    if (share.status === "revoked") return c.json({ error: "share is revoked" }, 410);
    if (share.mode !== "tunnel") return c.json({ error: "not a tunnel share" }, 400);

    const body: unknown = await c.req.json().catch(() => undefined);
    if (!isTunnelFrame(body)) return c.json({ error: "invalid frame" }, 400);
    const frame: TunnelFrame = body.type === "ping" ? body : { ...body, shareId: share.id };
    db.touchShare(share.id, new Date().toISOString());

    switch (frame.type) {
      case "fork_created": {
        const session = db.getShareSession(frame.sessionId);
        if (!session || session.share_id !== share.id) {
          return c.json({ error: "unknown sessionId for this share" }, 400);
        }
        db.setShareSessionDshId(frame.sessionId, frame.dshSessionId);
        return c.json({ ok: true });
      }
      case "agent_chunk": {
        hub.publish(
          share.id,
          "delta",
          { sessionId: frame.sessionId, content: frame.content },
          frame.sessionId,
        );
        return c.json({ ok: true });
      }
      case "agent_done": {
        const message = db.insertShareMessage({
          sessionId: frame.sessionId,
          role: "agent",
          content: frame.content,
          created_at: new Date().toISOString(),
        });
        hub.publish(share.id, "message", messagePayload(message), frame.sessionId);
        hub.publish(share.id, "done", { sessionId: frame.sessionId }, frame.sessionId);
        return c.json({ ok: true });
      }
      case "agent_error": {
        const message = db.insertShareMessage({
          sessionId: frame.sessionId,
          role: "system",
          content: frame.message,
          created_at: new Date().toISOString(),
        });
        hub.publish(share.id, "message", messagePayload(message), frame.sessionId);
        hub.publish(share.id, "done", { sessionId: frame.sessionId }, frame.sessionId);
        return c.json({ ok: true });
      }
      default:
        return c.json({ ok: true });
    }
  });

  return app;
}
