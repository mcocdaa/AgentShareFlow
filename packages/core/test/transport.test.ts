import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createSignedEncryptedPacket,
  generateNodeKeyPair,
  verifyAndDecryptPacket,
} from "../src/crypto.js";
import type { P2pPacket } from "../src/protocol.js";
import {
  DirectHttpTransport,
  FallbackTransportRouter,
  RelayTransport,
  TransportError,
  WebRtcTransportStub,
  type TransportPeer,
} from "../src/transport.js";

function makeSamplePacket() {
  const alice = generateNodeKeyPair();
  const bob = generateNodeKeyPair();
  const packet = createSignedEncryptedPacket({
    fromNodeId: "node-alice",
    fromHandle: "alice",
    toNodeId: "node-bob",
    senderSignPrivateKey: alice.signPrivateKey,
    senderKxPrivateKey: alice.kxPrivateKey,
    recipientKxPublicKey: bob.kxPublicKey,
    payload: { kind: "text", text: "direct-or-relay" },
  });
  return { alice, bob, packet };
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("DirectHttpTransport", () => {
  it("POSTs packet to ${directUrl}/p2p/v2/message with redirect manual and preserves subpath", async () => {
    const { packet } = makeSamplePacket();
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const transport = new DirectHttpTransport({
      lookupFn: publicLookup,
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    await transport.send(
      { nodeId: "node-bob", directUrl: "https://peer.example/prefix/" },
      packet,
    );

    expect(capturedUrl).toBe("https://peer.example/prefix/p2p/v2/message");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.redirect).toBe("manual");
    expect(JSON.parse(String(capturedInit?.body))).toEqual(packet);
  });

  it("blocks private URLs by default and blocks HTTP 3xx redirects", async () => {
    const { packet } = makeSamplePacket();

    const ssrfTransport = new DirectHttpTransport({
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    await expect(
      ssrfTransport.send(
        { nodeId: "node-bob", directUrl: "http://127.0.0.1:9001" },
        packet,
      ),
    ).rejects.toMatchObject({ code: "DIRECT_FAILED" });

    const redirectTransport = new DirectHttpTransport({
      lookupFn: publicLookup,
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/secret" },
        }),
    });
    await expect(
      redirectTransport.send(
        { nodeId: "node-bob", directUrl: "https://peer.example" },
        packet,
      ),
    ).rejects.toMatchObject({ code: "DIRECT_FAILED" });
  });

  it("delivers encrypted packet end-to-end over a local HTTP server when allowPrivate is true", async () => {
    const { alice, bob, packet } = makeSamplePacket();
    let received: P2pPacket | null = null;

    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/p2p/v2/message") {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk.toString();
        });
        req.on("end", () => {
          received = JSON.parse(raw) as P2pPacket;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const transport = new DirectHttpTransport({ allowPrivate: true });
      await transport.send(
        { nodeId: "node-bob", directUrl: `http://127.0.0.1:${port}` },
        packet,
      );

      expect(received).not.toBeNull();
      const decrypted = verifyAndDecryptPacket({
        packet: received!,
        expectedToNodeId: "node-bob",
        senderSignPublicKey: alice.signPublicKey,
        senderKxPublicKey: alice.kxPublicKey,
        recipientKxPrivateKey: bob.kxPrivateKey,
      });
      expect(decrypted.text).toBe("direct-or-relay");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("WebRtcTransportStub & RelayTransport", () => {
  it("throws WEBRTC_UNAVAILABLE from stub", async () => {
    const { packet } = makeSamplePacket();
    const webrtc = new WebRtcTransportStub();
    await expect(
      webrtc.send({ nodeId: "node-bob", directUrl: null }, packet),
    ).rejects.toMatchObject({ code: "WEBRTC_UNAVAILABLE" });
  });

  it("enforces enabled toggle and wraps relay errors", async () => {
    const { packet } = makeSamplePacket();
    const forwarded: string[] = [];
    const relay = new RelayTransport({
      enabled: true,
      forward: async (toNodeId) => {
        forwarded.push(toNodeId);
      },
    });

    await relay.send({ nodeId: "node-bob", directUrl: null }, packet);
    expect(forwarded).toEqual(["node-bob"]);

    relay.setEnabled(false);
    await expect(
      relay.send({ nodeId: "node-bob", directUrl: null }, packet),
    ).rejects.toMatchObject({ code: "RELAY_DISABLED" });

    const failingRelay = new RelayTransport({
      enabled: true,
      forward: async () => {
        throw new Error("ws closed");
      },
    });
    await expect(
      failingRelay.send({ nodeId: "node-bob", directUrl: null }, packet),
    ).rejects.toMatchObject({ code: "RELAY_FAILED" });
  });
});

describe("FallbackTransportRouter", () => {
  it("uses direct first and skips fallback when direct succeeds", async () => {
    const { packet } = makeSamplePacket();
    let relayCalled = false;

    const router = new FallbackTransportRouter({
      direct: new DirectHttpTransport({
        lookupFn: publicLookup,
        fetchImpl: async () => new Response("ok", { status: 200 }),
      }),
      webrtc: new WebRtcTransportStub(),
      relay: new RelayTransport({
        enabled: true,
        forward: async () => {
          relayCalled = true;
        },
      }),
    });

    const result = await router.send(
      { nodeId: "node-bob", directUrl: "https://peer.example" },
      packet,
    );

    expect(result.mode).toBe("direct");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.ok).toBe(true);
    expect(relayCalled).toBe(false);
  });

  it("falls back direct -> webrtc -> relay and records every attempt", async () => {
    const { packet } = makeSamplePacket();
    const peer: TransportPeer = { nodeId: "node-bob", directUrl: null };
    let relayedPacket: P2pPacket | null = null;

    const router = new FallbackTransportRouter({
      direct: new DirectHttpTransport(),
      webrtc: new WebRtcTransportStub(),
      relay: new RelayTransport({
        enabled: true,
        forward: async (_to, p) => {
          relayedPacket = p;
        },
      }),
    });

    const result = await router.send(peer, packet);
    expect(result.mode).toBe("relay");
    expect(relayedPacket).toEqual(packet);
    expect(result.attempts.map((a) => [a.mode, a.ok, a.code])).toEqual([
      ["direct", false, "DIRECT_FAILED"],
      ["webrtc", false, "WEBRTC_UNAVAILABLE"],
      ["relay", true, undefined],
    ]);
  });

  it("supports forceRelay option", async () => {
    const { packet } = makeSamplePacket();
    let directCalled = false;

    const router = new FallbackTransportRouter({
      direct: new DirectHttpTransport({
        lookupFn: publicLookup,
        fetchImpl: async () => {
          directCalled = true;
          return new Response("ok", { status: 200 });
        },
      }),
      relay: new RelayTransport({
        enabled: true,
        forward: async () => {},
      }),
    });

    const result = await router.send(
      { nodeId: "node-bob", directUrl: "https://peer.example" },
      packet,
      { forceRelay: true },
    );

    expect(directCalled).toBe(false);
    expect(result.mode).toBe("relay");
    expect(result.attempts).toHaveLength(1);
  });

  it("throws ALL_TRANSPORTS_FAILED when direct fails and relay is disabled", async () => {
    const { packet } = makeSamplePacket();
    const router = new FallbackTransportRouter({
      direct: new DirectHttpTransport({
        lookupFn: publicLookup,
        fetchImpl: async () => new Response("down", { status: 503 }),
      }),
      webrtc: new WebRtcTransportStub(),
      relay: new RelayTransport({
        enabled: false,
        forward: async () => {},
      }),
    });

    let caught: unknown;
    try {
      await router.send(
        { nodeId: "node-bob", directUrl: "https://peer.example" },
        packet,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TransportError);
    const te = caught as TransportError;
    expect(te.code).toBe("ALL_TRANSPORTS_FAILED");
    expect(te.attempts?.map((a) => a.code)).toEqual([
      "DIRECT_FAILED",
      "WEBRTC_UNAVAILABLE",
      "RELAY_DISABLED",
    ]);

    await expect(
      router.send(
        { nodeId: "node-bob", directUrl: "https://peer.example" },
        packet,
        { forceRelay: true },
      ),
    ).rejects.toMatchObject({ code: "RELAY_DISABLED" });
  });
});
