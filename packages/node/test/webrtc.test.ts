import { afterEach, describe, expect, it } from "vitest";
import {
  createSignedEncryptedPacket,
  generateNodeKeyPair,
  TransportError,
  verifyAndDecryptPacket,
  type NodeKeyPair,
  type P2pPacket,
} from "@agentshare/core";
import { createCli } from "../src/index.js";
import {
  WebRtcPeerManager,
  WebRtcTransport,
  type WebRtcInboundOutcome,
  type WebRtcSignalSendInput,
} from "../src/webrtc.js";

interface TestPeerIdentity {
  nodeId: string;
  handle: string;
  keys: NodeKeyPair;
}

function makePeer(nodeId: string, handle: string): TestPeerIdentity {
  return {
    nodeId,
    handle,
    keys: generateNodeKeyPair(),
  };
}

function makeEncryptedPacket(
  from: TestPeerIdentity,
  to: TestPeerIdentity,
  text: string,
): P2pPacket {
  return createSignedEncryptedPacket({
    fromNodeId: from.nodeId,
    fromHandle: from.handle,
    toNodeId: to.nodeId,
    senderSignPrivateKey: from.keys.signPrivateKey,
    senderKxPrivateKey: from.keys.kxPrivateKey,
    recipientKxPublicKey: to.keys.kxPublicKey,
    payload: {
      kind: "text",
      text,
    },
  });
}

describe("WebRtcPeerManager & WebRtcTransport", () => {
  const managersToClose: WebRtcPeerManager[] = [];

  afterEach(async () => {
    while (managersToClose.length > 0) {
      const mgr = managersToClose.pop();
      if (mgr) {
        await mgr.close().catch(() => {});
      }
    }
  });

  it("delivers signed E2EE P2pPacket with ACK over localhost DataChannel (iceServers: []) and reuses channel", async () => {
    const peerA = makePeer("node-aaa", "alpha");
    const peerB = makePeer("node-bbb", "beta");

    const receivedOnB: string[] = [];
    const receivedOnA: string[] = [];
    let signalCount = 0;

    let managerA!: WebRtcPeerManager;
    let managerB!: WebRtcPeerManager;

    managerA = new WebRtcPeerManager({
      localNodeId: peerA.nodeId,
      iceServers: [],
      sendSignal: (sig: WebRtcSignalSendInput) => {
        signalCount += 1;
        void managerB.handleSignal(peerA.nodeId, sig.signalType, sig.payload);
      },
      onInboundPacket: async (packet): Promise<WebRtcInboundOutcome> => {
        const decrypted = verifyAndDecryptPacket({
          packet,
          expectedToNodeId: peerA.nodeId,
          senderSignPublicKey: peerB.keys.signPublicKey,
          senderKxPublicKey: peerB.keys.kxPublicKey,
          recipientKxPrivateKey: peerA.keys.kxPrivateKey,
        });
        receivedOnA.push(decrypted.text);
        return { ok: true, status: 200 };
      },
    });

    managerB = new WebRtcPeerManager({
      localNodeId: peerB.nodeId,
      iceServers: [],
      sendSignal: (sig: WebRtcSignalSendInput) => {
        signalCount += 1;
        void managerA.handleSignal(peerB.nodeId, sig.signalType, sig.payload);
      },
      onInboundPacket: async (packet): Promise<WebRtcInboundOutcome> => {
        const decrypted = verifyAndDecryptPacket({
          packet,
          expectedToNodeId: peerB.nodeId,
          senderSignPublicKey: peerA.keys.signPublicKey,
          senderKxPublicKey: peerA.keys.kxPublicKey,
          recipientKxPrivateKey: peerB.keys.kxPrivateKey,
        });
        receivedOnB.push(decrypted.text);
        return { ok: true, status: 200 };
      },
    });
    managersToClose.push(managerA, managerB);

    const transportA = new WebRtcTransport(managerA);
    const transportB = new WebRtcTransport(managerB);
    expect(transportA.mode).toBe("webrtc");

    const pkt1 = makeEncryptedPacket(peerA, peerB, "hello-over-werift-1");
    await transportA.send({ nodeId: peerB.nodeId, directUrl: null }, pkt1);
    expect(receivedOnB).toEqual(["hello-over-werift-1"]);

    const signalsAfterConnect = signalCount;
    expect(signalsAfterConnect).toBeGreaterThanOrEqual(2);

    // Reverse direction reuses the already-open DataChannel without re-negotiating.
    const pkt2 = makeEncryptedPacket(peerB, peerA, "reply-on-same-dc-2");
    await transportB.send({ nodeId: peerA.nodeId, directUrl: null }, pkt2);
    expect(receivedOnA).toEqual(["reply-on-same-dc-2"]);
    expect(signalCount).toBe(signalsAfterConnect);
  }, 15_000);

  it("resolves simultaneous glare cleanly without deadlock when both peers send in the same tick", async () => {
    const politePeer = makePeer("node-001", "polite-bot");
    const impolitePeer = makePeer("node-999", "impolite-bot");

    const receivedOnPolite: string[] = [];
    const receivedOnImpolite: string[] = [];

    let politeMgr!: WebRtcPeerManager;
    let impoliteMgr!: WebRtcPeerManager;

    politeMgr = new WebRtcPeerManager({
      localNodeId: politePeer.nodeId,
      iceServers: [],
      sendSignal: async (sig) => {
        // Deliberately await re-entrant in-memory delivery to verify zero lock deadlock.
        await impoliteMgr.handleSignal(politePeer.nodeId, sig.signalType, sig.payload);
      },
      onInboundPacket: async (packet) => {
        const decrypted = verifyAndDecryptPacket({
          packet,
          expectedToNodeId: politePeer.nodeId,
          senderSignPublicKey: impolitePeer.keys.signPublicKey,
          senderKxPublicKey: impolitePeer.keys.kxPublicKey,
          recipientKxPrivateKey: politePeer.keys.kxPrivateKey,
        });
        receivedOnPolite.push(decrypted.text);
        return { ok: true, status: 200 };
      },
    });

    impoliteMgr = new WebRtcPeerManager({
      localNodeId: impolitePeer.nodeId,
      iceServers: [],
      sendSignal: async (sig) => {
        await politeMgr.handleSignal(impolitePeer.nodeId, sig.signalType, sig.payload);
      },
      onInboundPacket: async (packet) => {
        const decrypted = verifyAndDecryptPacket({
          packet,
          expectedToNodeId: impolitePeer.nodeId,
          senderSignPublicKey: politePeer.keys.signPublicKey,
          senderKxPublicKey: politePeer.keys.kxPublicKey,
          recipientKxPrivateKey: impolitePeer.keys.kxPrivateKey,
        });
        receivedOnImpolite.push(decrypted.text);
        return { ok: true, status: 200 };
      },
    });
    managersToClose.push(politeMgr, impoliteMgr);

    const transportPolite = new WebRtcTransport(politeMgr);
    const transportImpolite = new WebRtcTransport(impoliteMgr);

    const pktFromPolite = makeEncryptedPacket(politePeer, impolitePeer, "glare-from-polite");
    const pktFromImpolite = makeEncryptedPacket(impolitePeer, politePeer, "glare-from-impolite");

    await Promise.all([
      transportPolite.send({ nodeId: impolitePeer.nodeId, directUrl: null }, pktFromPolite),
      transportImpolite.send({ nodeId: politePeer.nodeId, directUrl: null }, pktFromImpolite),
    ]);

    expect(receivedOnImpolite).toEqual(["glare-from-polite"]);
    expect(receivedOnPolite).toEqual(["glare-from-impolite"]);
  }, 15_000);

  it("throws TransportError(WEBRTC_UNAVAILABLE) on missing peer timeout, policy rejection, and cleans up on close()", async () => {
    const peerA = makePeer("node-aaa", "alpha");
    const peerB = makePeer("node-bbb", "beta");

    const isolatedMgr = new WebRtcPeerManager({
      localNodeId: peerA.nodeId,
      iceServers: [],
      connectTimeoutMs: 250,
      ackTimeoutMs: 250,
      sendSignal: () => {
        // Drop all signaling messages to simulate unreachable peer.
      },
      onInboundPacket: async () => ({ ok: true, status: 200 }),
    });
    managersToClose.push(isolatedMgr);

    const isolatedTransport = new WebRtcTransport(isolatedMgr);
    const missingPkt = makeEncryptedPacket(peerA, peerB, "will-timeout");

    let caughtErr: unknown;
    try {
      await isolatedTransport.send({ nodeId: peerB.nodeId, directUrl: null }, missingPkt);
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(TransportError);
    expect((caughtErr as TransportError).code).toBe("WEBRTC_UNAVAILABLE");
    expect((caughtErr as TransportError).mode).toBe("webrtc");

    // Verify policy rejection returns WEBRTC_UNAVAILABLE while keeping DataChannel usable.
    let rejectNext = true;
    let mgr1!: WebRtcPeerManager;
    let mgr2!: WebRtcPeerManager;

    mgr1 = new WebRtcPeerManager({
      localNodeId: peerA.nodeId,
      iceServers: [],
      sendSignal: (sig) => {
        void mgr2.handleSignal(peerA.nodeId, sig.signalType, sig.payload);
      },
      onInboundPacket: async () => ({ ok: true, status: 200 }),
    });
    mgr2 = new WebRtcPeerManager({
      localNodeId: peerB.nodeId,
      iceServers: [],
      sendSignal: (sig) => {
        void mgr1.handleSignal(peerB.nodeId, sig.signalType, sig.payload);
      },
      onInboundPacket: async () => {
        if (rejectNext) {
          rejectNext = false;
          return { ok: false, status: 403, error: "Denied by local policy" };
        }
        return { ok: true, status: 200 };
      },
    });
    managersToClose.push(mgr1, mgr2);

    const t1 = new WebRtcTransport(mgr1);
    await expect(
      t1.send(
        { nodeId: peerB.nodeId, directUrl: null },
        makeEncryptedPacket(peerA, peerB, "blocked-by-policy"),
      ),
    ).rejects.toMatchObject({
      code: "WEBRTC_UNAVAILABLE",
      mode: "webrtc",
    });

    await expect(
      t1.send(
        { nodeId: peerB.nodeId, directUrl: null },
        makeEncryptedPacket(peerA, peerB, "allowed-next"),
      ),
    ).resolves.toBeUndefined();

    expect(mgr1.getActivePeerCount()).toBe(1);
    expect(mgr2.getActivePeerCount()).toBe(1);

    mgr1.updateIceServers([{ urls: "stun:stun.example.org:3478" }]);
    expect(mgr1.getIceServers()).toEqual([{ urls: "stun:stun.example.org:3478" }]);

    await mgr1.close();
    await mgr2.close();
    expect(mgr1.getActivePeerCount()).toBe(0);
    expect(mgr2.getActivePeerCount()).toBe(0);

    await expect(
      t1.send(
        { nodeId: peerB.nodeId, directUrl: null },
        makeEncryptedPacket(peerA, peerB, "after-close"),
      ),
    ).rejects.toMatchObject({
      code: "WEBRTC_UNAVAILABLE",
      mode: "webrtc",
    });
  }, 15_000);

  it("exposes --no-webrtc and --stun flags on agentshare node start CLI", () => {
    const cli = createCli();
    const nodeCmd = cli.commands.find((c) => c.name() === "node");
    const startCmd = nodeCmd?.commands.find((c) => c.name() === "start");
    expect(startCmd).toBeDefined();
    const longFlags = startCmd!.options.map((o) => o.long);
    expect(longFlags).toContain("--no-webrtc");
    expect(longFlags).toContain("--stun");
  });
});
