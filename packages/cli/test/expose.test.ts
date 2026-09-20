import { describe, expect, it, vi } from "vitest";
import type { TunnelFrame } from "@agentshare/core";
import { createA2AForwarder } from "../src/expose.js";

function visitor(shareId: string, sessionId: string, content: string): TunnelFrame {
  return { type: "visitor_message", shareId, sessionId, content };
}

describe("createA2AForwarder", () => {
  it("replies in order per session and keeps the A2A contextId", async () => {
    const seen: Array<[string, string | undefined]> = [];
    const reply = vi.fn(async (text: string, contextId?: string) => {
      seen.push([text, contextId]);
      return { text: `pong: ${text}`, contextId: `ctx-${text}` };
    });
    const frames: TunnelFrame[] = [];
    const send = vi.fn(async (frame: TunnelFrame) => {
      frames.push(frame);
    });
    const forwarder = createA2AForwarder(reply, send);

    forwarder.onFrame(visitor("s1", "a", "one"));
    forwarder.onFrame(visitor("s1", "a", "two"));
    forwarder.onFrame(visitor("s1", "b", "other"));
    await forwarder.idle();

    expect(reply).toHaveBeenCalledTimes(3);
    expect(seen).toContainEqual(["one", undefined]);
    expect(seen).toContainEqual(["two", "ctx-one"]);
    expect(seen).toContainEqual(["other", undefined]);
    expect(frames.filter((frame) => frame.sessionId === "a")).toEqual([
      { type: "agent_done", shareId: "s1", sessionId: "a", content: "pong: one" },
      { type: "agent_done", shareId: "s1", sessionId: "a", content: "pong: two" },
    ]);
    expect(frames.filter((frame) => frame.sessionId === "b")).toEqual([
      { type: "agent_done", shareId: "s1", sessionId: "b", content: "pong: other" },
    ]);
  });

  it("sends agent_error when the local agent fails", async () => {
    const send = vi.fn(async () => {});
    const forwarder = createA2AForwarder(async () => {
      throw new Error("connection refused");
    }, send);

    forwarder.onFrame(visitor("s1", "a", "hello"));
    await forwarder.idle();

    expect(send).toHaveBeenCalledWith({
      type: "agent_error",
      shareId: "s1",
      sessionId: "a",
      message: "connection refused",
    });
  });

  it("ignores non-visitor frames and empty replies", async () => {
    const send = vi.fn(async () => {});
    const reply = vi.fn(async () => ({ text: "" }));
    const forwarder = createA2AForwarder(reply, send);

    forwarder.onFrame({ type: "ping" });
    expect(reply).not.toHaveBeenCalled();

    forwarder.onFrame(visitor("s1", "a", "hi"));
    await forwarder.idle();
    expect(send).toHaveBeenCalledWith({
      type: "agent_done",
      shareId: "s1",
      sessionId: "a",
      content: "(the agent returned no text)",
    });
  });
});
