import { randomBytes } from "node:crypto";
import { isTunnelFrame, type TunnelFrame } from "@agentshare/core";
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
  return hub.hasTunnel(share.id) ? "online" : "offline";
}

function summary(share: ShareRow, hub: ShareHub) {
  return {
    id: share.id,
    owner: share.owner,
    title: share.title,
    project: share.project ?? undefined,
    status: effectiveStatus(share, hub),
    createdAt: share.created_at,
    lastSeenAt: share.last_seen_at ?? undefined,
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
}

export function createShareRoutes({ db, hub }: ShareRouteDeps): Hono {
  const app = new Hono();
  const hits = new Map<string, number[]>();

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

  app.post("/shares", async (c) => {
    const who = owner(c.req.header("authorization"));
    if (!who) return c.json({ error: "unauthorized" }, 401);

    const body = (await c.req.json().catch(() => ({}))) as {
      title?: unknown;
      project?: unknown;
    };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title.length === 0 || title.length > 120) {
      return c.json({ error: "title is required (1-120 chars)" }, 400);
    }
    const project =
      typeof body.project === "string" && body.project.length <= 200 ? body.project : null;

    const share: ShareRow = {
      id: randomBytes(16).toString("hex"),
      owner: who,
      title,
      project,
      status: "offline",
      created_at: new Date().toISOString(),
      last_seen_at: null,
    };
    db.insertShare(share);
    return c.json(summary(share, hub), 201);
  });

  app.get("/shares", (c) => {
    const who = owner(c.req.header("authorization"));
    if (!who) return c.json({ error: "unauthorized" }, 401);
    return c.json({ items: db.listShares(who).map((share) => summary(share, hub)) });
  });

  app.get("/shares/:id", (c) => {
    const share = db.getShare(c.req.param("id"));
    if (!share) return c.json({ error: "not found" }, 404);
    return c.json(summary(share, hub));
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
    return c.json(summary({ ...share, status: "revoked" }, hub));
  });

  app.get("/shares/:id/transcript", (c) => {
    const who = owner(c.req.header("authorization"));
    if (!who) return c.json({ error: "unauthorized" }, 401);
    const share = db.getShare(c.req.param("id"));
    if (!share) return c.json({ error: "not found" }, 404);
    if (share.owner !== who) return c.json({ error: "forbidden" }, 403);
    return c.json({
      share: summary(share, hub),
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
    if (!hub.hasTunnel(share.id)) return c.json({ error: "share is offline" }, 409);

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
    hub.publish(share.id, "message", messagePayload(message), sessionId);
    return c.json({ sessionId, message: messagePayload(message) }, 201);
  });

  app.get("/tunnel/:shareId/events", (c) =>
    streamSSE(c, async (stream) => {
      const who = owner(c.req.header("authorization"));
      if (!who) {
        await stream.writeSSE({ event: "frame", data: JSON.stringify({ type: "ping" }) });
        await stream.close();
        return;
      }
      const share = db.getShare(c.req.param("shareId"));
      if (!share || share.owner !== who || share.status === "revoked") {
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
        hub.publish(share.id, "delta", { sessionId: frame.sessionId, content: frame.content }, frame.sessionId);
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
