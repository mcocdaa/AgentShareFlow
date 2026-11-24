import { randomUUID } from "node:crypto";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import {
  P2pPacketSchema,
  TransportError,
  type IceServerConfig,
  type P2pPacket,
  type PeerTransport,
  type SignalType,
  type TransportMode,
  type TransportPeer,
} from "@agentshare/core";

export const WEBRTC_DATA_CHANNEL_LABEL = "agentshare-p2p-v2";
export const DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS = 8_000;
export const DEFAULT_WEBRTC_ACK_TIMEOUT_MS = 5_000;

const MAX_BUFFERED_ICE_SESSIONS = 4;
const MAX_BUFFERED_ICE_CANDIDATES = 64;
const MAX_IGNORED_SESSIONS = 32;

export interface WebRtcSdpPayload {
  sessionId: string;
  type: "offer" | "answer";
  sdp: string;
}

export interface WebRtcIceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface WebRtcIcePayload {
  sessionId: string;
  candidate: WebRtcIceCandidateInit;
}

export type WebRtcSignalFrameType = "signal.offer" | "signal.answer";

export interface WebRtcSignalSendInput {
  frameType: WebRtcSignalFrameType;
  toNodeId: string;
  signalType: "webrtc_sdp" | "webrtc_ice";
  payload: WebRtcSdpPayload | WebRtcIcePayload;
}

export interface WebRtcInboundOutcome {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface WebRtcPeerManagerOptions {
  localNodeId: string;
  iceServers?: IceServerConfig[];
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  sendSignal: (signal: WebRtcSignalSendInput) => void | Promise<void>;
  onInboundPacket: (packet: P2pPacket) => Promise<WebRtcInboundOutcome>;
  onLog?: (message: string) => void;
}

interface DataChannelPacketFrame {
  type: "p2p_packet";
  packet: P2pPacket;
}

interface DataChannelAckFrame {
  type: "p2p_ack";
  id: string;
  ok: boolean;
  status?: number;
  error?: string;
}

interface OpenWaiter {
  resolve: (dc: RTCDataChannel) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingAck {
  remoteNodeId: string;
  sessionId: string;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PeerSession {
  sessionId: string;
  remoteNodeId: string;
  role: "offerer" | "answerer";
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  makingOffer: boolean;
  remoteDescriptionSet: boolean;
  sdpSent: boolean;
  outboundIceQueue: WebRtcIceCandidateInit[];
  closed: boolean;
}

interface PeerEntry {
  remoteNodeId: string;
  polite: boolean;
  session: PeerSession | null;
  openWaiters: Set<OpenWaiter>;
  pendingIceBySession: Map<string, WebRtcIceCandidateInit[]>;
  ignoredSessionIds: Set<string>;
  opQueue: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSdpPayload(value: unknown): WebRtcSdpPayload | null {
  if (!isRecord(value)) return null;
  if (typeof value["sessionId"] !== "string" || value["sessionId"].length === 0) {
    return null;
  }
  const type = value["type"];
  if (type !== "offer" && type !== "answer") return null;
  if (typeof value["sdp"] !== "string" || value["sdp"].length === 0) {
    return null;
  }
  return {
    sessionId: value["sessionId"],
    type,
    sdp: value["sdp"],
  };
}

function parseIcePayload(value: unknown): WebRtcIcePayload | null {
  if (!isRecord(value)) return null;
  if (typeof value["sessionId"] !== "string" || value["sessionId"].length === 0) {
    return null;
  }
  const candidateObj = value["candidate"];
  if (!isRecord(candidateObj) || typeof candidateObj["candidate"] !== "string") {
    return null;
  }
  const sdpMid = candidateObj["sdpMid"];
  const sdpMLineIndex = candidateObj["sdpMLineIndex"];
  if (sdpMid !== undefined && sdpMid !== null && typeof sdpMid !== "string") {
    return null;
  }
  if (
    sdpMLineIndex !== undefined &&
    sdpMLineIndex !== null &&
    (typeof sdpMLineIndex !== "number" || !Number.isInteger(sdpMLineIndex))
  ) {
    return null;
  }
  return {
    sessionId: value["sessionId"],
    candidate: {
      candidate: candidateObj["candidate"],
      ...(sdpMid !== undefined ? { sdpMid } : {}),
      ...(sdpMLineIndex !== undefined ? { sdpMLineIndex } : {}),
    },
  };
}

function cloneIceServers(servers: IceServerConfig[]): IceServerConfig[] {
  return servers.map((server) => ({
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    ...(server.username !== undefined ? { username: server.username } : {}),
    ...(server.credential !== undefined ? { credential: server.credential } : {}),
  }));
}

export class WebRtcPeerManager {
  private readonly localNodeId: string;
  private iceServers: IceServerConfig[];
  private readonly connectTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly sendSignalFn: (signal: WebRtcSignalSendInput) => void | Promise<void>;
  private readonly onInboundPacket: (packet: P2pPacket) => Promise<WebRtcInboundOutcome>;
  private readonly onLog: (message: string) => void;

  private readonly peers = new Map<string, PeerEntry>();
  private readonly pendingAcks = new Map<string, PendingAck>();
  private readonly activePcs = new Set<RTCPeerConnection>();
  private closed = false;

  constructor(options: WebRtcPeerManagerOptions) {
    this.localNodeId = options.localNodeId;
    this.iceServers = cloneIceServers(options.iceServers ?? []);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_WEBRTC_ACK_TIMEOUT_MS;
    this.sendSignalFn = options.sendSignal;
    this.onInboundPacket = options.onInboundPacket;
    this.onLog = options.onLog ?? (() => {});
  }

  getIceServers(): IceServerConfig[] {
    return cloneIceServers(this.iceServers);
  }

  updateIceServers(iceServers: IceServerConfig[]): void {
    this.iceServers = cloneIceServers(iceServers);
  }

  getActivePeerCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.session && !peer.session.closed) {
        count += 1;
      }
    }
    return count;
  }

  private getOrCreatePeer(remoteNodeId: string): PeerEntry {
    let entry = this.peers.get(remoteNodeId);
    if (!entry) {
      entry = {
        remoteNodeId,
        polite: this.localNodeId < remoteNodeId,
        session: null,
        openWaiters: new Set(),
        pendingIceBySession: new Map(),
        ignoredSessionIds: new Set(),
        opQueue: Promise.resolve(),
      };
      this.peers.set(remoteNodeId, entry);
    }
    return entry;
  }

  private enqueuePeerOp(peer: PeerEntry, op: () => Promise<void>): Promise<void> {
    const next = peer.opQueue.then(op, op).catch((err) => {
      this.onLog(
        `WebRTC signaling error for peer ${peer.remoteNodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    peer.opQueue = next;
    return next;
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: cloneIceServers(this.iceServers),
      // Disable werift's built-in fallback STUN so iceServers: [] works 100% offline.
      iceUseDefaultStunServer: false,
    });
    this.activePcs.add(pc);
    return pc;
  }

  private createSession(
    peer: PeerEntry,
    sessionId: string,
    role: "offerer" | "answerer",
  ): PeerSession {
    const pc = this.createPeerConnection();
    const session: PeerSession = {
      sessionId,
      remoteNodeId: peer.remoteNodeId,
      role,
      pc,
      dc: null,
      makingOffer: false,
      remoteDescriptionSet: false,
      sdpSent: false,
      outboundIceQueue: [],
      closed: false,
    };

    pc.onIceCandidate.subscribe((candidate) => {
      if (this.closed || session.closed || peer.session !== session) return;
      if (!candidate || !candidate.candidate) return;
      const init: WebRtcIceCandidateInit = {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      };
      if (!session.sdpSent) {
        session.outboundIceQueue.push(init);
        return;
      }
      this.dispatchSignal(peer, session, {
        frameType: session.role === "offerer" ? "signal.offer" : "signal.answer",
        toNodeId: peer.remoteNodeId,
        signalType: "webrtc_ice",
        payload: {
          sessionId: session.sessionId,
          candidate: init,
        },
      });
    });

    const onTerminalState = (label: string) => {
      if (this.closed || session.closed || peer.session !== session) return;
      const err = new TransportError(
        "WEBRTC_UNAVAILABLE",
        `WebRTC peer connection ${label} for ${peer.remoteNodeId}`,
        { mode: "webrtc" },
      );
      void this.disposeSession(peer, session, true, err);
    };

    pc.connectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed") {
        onTerminalState(state);
      }
    });

    pc.iceConnectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed") {
        onTerminalState(`ice-${state}`);
      }
    });

    return session;
  }

  private dispatchSignal(
    peer: PeerEntry,
    session: PeerSession,
    signal: WebRtcSignalSendInput,
  ): void {
    if (this.closed || session.closed || peer.session !== session) return;
    // Dispatch asynchronously outside peer.opQueue so re-entrant in-memory signaling cannot deadlock.
    queueMicrotask(() => {
      if (this.closed || session.closed || peer.session !== session) return;
      Promise.resolve()
        .then(() => this.sendSignalFn(signal))
        .catch((err) => {
          if (this.closed || session.closed || peer.session !== session) return;
          const transportErr =
            err instanceof TransportError
              ? err
              : new TransportError(
                  "WEBRTC_UNAVAILABLE",
                  `WebRTC signaling failed for ${peer.remoteNodeId}: ${err instanceof Error ? err.message : String(err)}`,
                  { mode: "webrtc", cause: err },
                );
          void this.disposeSession(peer, session, true, transportErr);
        });
    });
  }

  private flushOutboundIce(peer: PeerEntry, session: PeerSession): void {
    const queued = session.outboundIceQueue.splice(0, session.outboundIceQueue.length);
    for (const init of queued) {
      this.dispatchSignal(peer, session, {
        frameType: session.role === "offerer" ? "signal.offer" : "signal.answer",
        toNodeId: peer.remoteNodeId,
        signalType: "webrtc_ice",
        payload: {
          sessionId: session.sessionId,
          candidate: init,
        },
      });
    }
  }

  private attachDataChannel(
    peer: PeerEntry,
    session: PeerSession,
    dc: RTCDataChannel,
  ): void {
    if (this.closed || session.closed || peer.session !== session) return;
    session.dc = dc;

    const resolveOpen = () => {
      if (this.closed || session.closed || peer.session !== session) return;
      peer.pendingIceBySession.delete(session.sessionId);
      for (const waiter of peer.openWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(dc);
      }
      peer.openWaiters.clear();
    };

    dc.stateChanged.subscribe((state) => {
      if (this.closed || session.closed || peer.session !== session) return;
      if (state === "open") {
        resolveOpen();
      } else if (state === "closed") {
        const err = new TransportError(
          "WEBRTC_UNAVAILABLE",
          `WebRTC DataChannel closed for peer ${peer.remoteNodeId}`,
          { mode: "webrtc" },
        );
        void this.disposeSession(peer, session, true, err);
      }
    });

    dc.onMessage.subscribe((raw) => {
      if (this.closed || session.closed || peer.session !== session) return;
      void this.handleDataChannelMessage(peer, session, dc, raw);
    });

    if (dc.readyState === "open") {
      resolveOpen();
    }
  }

  private async handleDataChannelMessage(
    peer: PeerEntry,
    session: PeerSession,
    dc: RTCDataChannel,
    raw: string | Buffer,
  ): Promise<void> {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(parsedJson) || typeof parsedJson["type"] !== "string") {
      return;
    }

    if (parsedJson["type"] === "p2p_ack") {
      const id = typeof parsedJson["id"] === "string" ? parsedJson["id"] : "";
      const ok = parsedJson["ok"] === true;
      const status =
        typeof parsedJson["status"] === "number" ? parsedJson["status"] : undefined;
      const error =
        typeof parsedJson["error"] === "string" ? parsedJson["error"] : undefined;
      const pending = this.pendingAcks.get(id);
      if (!pending || pending.remoteNodeId !== peer.remoteNodeId) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingAcks.delete(id);
      if (ok) {
        pending.resolve();
      } else {
        pending.reject(
          new TransportError(
            "WEBRTC_UNAVAILABLE",
            error
              ? `WebRTC peer rejected packet (status ${status ?? "error"}): ${error}`
              : `WebRTC peer rejected packet (status ${status ?? "unknown"})`,
            { mode: "webrtc" },
          ),
        );
      }
      return;
    }

    if (parsedJson["type"] === "p2p_packet") {
      const candidatePacket = parsedJson["packet"];
      const parsedPacket = P2pPacketSchema.safeParse(candidatePacket);
      if (!parsedPacket.success) {
        const rawId =
          isRecord(candidatePacket) && typeof candidatePacket["id"] === "string"
            ? candidatePacket["id"]
            : "";
        this.sendAck(dc, {
          type: "p2p_ack",
          id: rawId,
          ok: false,
          status: 400,
          error: "Invalid P2P packet format",
        });
        return;
      }

      const packet = parsedPacket.data;
      let outcome: WebRtcInboundOutcome;
      try {
        outcome = await this.onInboundPacket(packet);
      } catch (err) {
        outcome = {
          ok: false,
          status: 500,
          error: err instanceof Error ? err.message : "Inbound packet handler failed",
        };
      }

      if (this.closed || session.closed) return;
      this.sendAck(dc, {
        type: "p2p_ack",
        id: packet.id,
        ok: outcome.ok,
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      });
    }
  }

  private sendAck(dc: RTCDataChannel, frame: DataChannelAckFrame): void {
    if (dc.readyState !== "open") return;
    try {
      dc.send(JSON.stringify(frame));
    } catch {
      // Ignore send errors if channel closed concurrently.
    }
  }

  private bufferInboundIce(
    peer: PeerEntry,
    sessionId: string,
    candidate: WebRtcIceCandidateInit,
  ): void {
    let list = peer.pendingIceBySession.get(sessionId);
    if (!list) {
      if (peer.pendingIceBySession.size >= MAX_BUFFERED_ICE_SESSIONS) {
        const oldestKey = peer.pendingIceBySession.keys().next().value;
        if (oldestKey !== undefined) {
          peer.pendingIceBySession.delete(oldestKey);
        }
      }
      list = [];
      peer.pendingIceBySession.set(sessionId, list);
    }
    if (list.length < MAX_BUFFERED_ICE_CANDIDATES) {
      list.push(candidate);
    }
  }

  private async flushInboundIce(peer: PeerEntry, session: PeerSession): Promise<void> {
    const queued = peer.pendingIceBySession.get(session.sessionId);
    if (!queued || queued.length === 0) return;
    peer.pendingIceBySession.delete(session.sessionId);
    for (const candidate of queued) {
      if (this.closed || session.closed || peer.session !== session) return;
      await session.pc
        .addIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? undefined,
          sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
        })
        .catch(() => {});
    }
  }

  private rememberIgnoredSession(peer: PeerEntry, sessionId: string): void {
    if (peer.ignoredSessionIds.size >= MAX_IGNORED_SESSIONS) {
      const oldest = peer.ignoredSessionIds.values().next().value;
      if (oldest !== undefined) {
        peer.ignoredSessionIds.delete(oldest);
      }
    }
    peer.ignoredSessionIds.add(sessionId);
    peer.pendingIceBySession.delete(sessionId);
  }

  private rejectPendingAcksForSession(sessionId: string, err: Error): void {
    for (const [id, pending] of this.pendingAcks.entries()) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        this.pendingAcks.delete(id);
        pending.reject(err);
      }
    }
  }

  private rejectOpenWaiters(peer: PeerEntry, err: Error): void {
    for (const waiter of peer.openWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    peer.openWaiters.clear();
  }

  private async disposeSession(
    peer: PeerEntry,
    session: PeerSession,
    failWaiters: boolean,
    reason?: Error,
  ): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    if (peer.session === session) {
      peer.session = null;
    }
    session.outboundIceQueue.length = 0;

    const err =
      reason ??
      new TransportError(
        "WEBRTC_UNAVAILABLE",
        `WebRTC session closed for peer ${peer.remoteNodeId}`,
        { mode: "webrtc" },
      );

    this.rejectPendingAcksForSession(session.sessionId, err);
    if (failWaiters) {
      this.rejectOpenWaiters(peer, err);
    }

    const dc = session.dc;
    session.dc = null;
    if (dc && dc.readyState !== "closed") {
      try {
        dc.close();
      } catch {
        // Ignore close error on already-closed channel.
      }
    }

    try {
      await session.pc.close();
    } catch {
      // Ignore close error on already-closed connection.
    } finally {
      this.activePcs.delete(session.pc);
    }
  }

  private isSessionDead(session: PeerSession): boolean {
    if (session.closed) return true;
    const connState = session.pc.connectionState;
    const iceState = session.pc.iceConnectionState;
    if (connState === "failed" || connState === "closed") return true;
    if (iceState === "failed" || iceState === "closed") return true;
    if (session.dc && session.dc.readyState === "closed") return true;
    return false;
  }

  private ensureOfferSession(peer: PeerEntry): Promise<void> {
    return this.enqueuePeerOp(peer, async () => {
      if (this.closed) return;
      if (peer.session) {
        if (!this.isSessionDead(peer.session)) {
          return;
        }
        await this.disposeSession(peer, peer.session, false);
      }

      const session = this.createSession(peer, randomUUID(), "offerer");
      peer.session = session;
      const dc = session.pc.createDataChannel(WEBRTC_DATA_CHANNEL_LABEL, {
        ordered: true,
      });
      this.attachDataChannel(peer, session, dc);

      session.makingOffer = true;
      let offerSdp: string;
      try {
        const offer = await session.pc.createOffer();
        if (this.closed || session.closed || peer.session !== session) return;
        await session.pc.setLocalDescription(offer);
        if (this.closed || session.closed || peer.session !== session) return;
        offerSdp = session.pc.localDescription?.sdp ?? offer.sdp;
      } catch (err) {
        const transportErr = new TransportError(
          "WEBRTC_UNAVAILABLE",
          `WebRTC offer creation failed for ${peer.remoteNodeId}: ${err instanceof Error ? err.message : String(err)}`,
          { mode: "webrtc", cause: err },
        );
        await this.disposeSession(peer, session, true, transportErr);
        return;
      } finally {
        session.makingOffer = false;
      }

      session.sdpSent = true;
      this.dispatchSignal(peer, session, {
        frameType: "signal.offer",
        toNodeId: peer.remoteNodeId,
        signalType: "webrtc_sdp",
        payload: {
          sessionId: session.sessionId,
          type: "offer",
          sdp: offerSdp,
        },
      });
      this.flushOutboundIce(peer, session);
    });
  }

  private waitForDataChannel(peer: PeerEntry): Promise<{ dc: RTCDataChannel; sessionId: string }> {
    if (this.closed) {
      return Promise.reject(
        new TransportError("WEBRTC_UNAVAILABLE", "WebRTC peer manager is closed", {
          mode: "webrtc",
        }),
      );
    }

    if (
      peer.session &&
      !this.isSessionDead(peer.session) &&
      peer.session.dc?.readyState === "open"
    ) {
      return Promise.resolve({
        dc: peer.session.dc,
        sessionId: peer.session.sessionId,
      });
    }

    return new Promise((resolve, reject) => {
      const waiter: OpenWaiter = {
        resolve: (dc) => {
          const sessionId = peer.session?.sessionId ?? "";
          resolve({ dc, sessionId });
        },
        reject,
        timer: setTimeout(() => {
          peer.openWaiters.delete(waiter);
          const timeoutErr = new TransportError(
            "WEBRTC_UNAVAILABLE",
            `WebRTC DataChannel open timed out after ${this.connectTimeoutMs}ms for peer ${peer.remoteNodeId}`,
            { mode: "webrtc" },
          );
          if (
            peer.openWaiters.size === 0 &&
            peer.session &&
            peer.session.dc?.readyState !== "open"
          ) {
            void this.disposeSession(peer, peer.session, false, timeoutErr);
          }
          reject(timeoutErr);
        }, this.connectTimeoutMs),
      };
      peer.openWaiters.add(waiter);
      void this.ensureOfferSession(peer);
    });
  }

  handleSignal(
    fromNodeId: string,
    signalType: SignalType,
    payload: unknown,
  ): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (signalType !== "webrtc_sdp" && signalType !== "webrtc_ice") {
      return Promise.resolve();
    }
    const peer = this.getOrCreatePeer(fromNodeId);

    if (signalType === "webrtc_ice") {
      const ice = parseIcePayload(payload);
      if (!ice || !ice.candidate.candidate) {
        return Promise.resolve();
      }
      return this.enqueuePeerOp(peer, async () => {
        if (this.closed) return;
        if (peer.ignoredSessionIds.has(ice.sessionId)) return;
        if (
          peer.session &&
          !peer.session.closed &&
          peer.session.sessionId === ice.sessionId &&
          peer.session.remoteDescriptionSet
        ) {
          await peer.session.pc
            .addIceCandidate({
              candidate: ice.candidate.candidate,
              sdpMid: ice.candidate.sdpMid ?? undefined,
              sdpMLineIndex: ice.candidate.sdpMLineIndex ?? undefined,
            })
            .catch(() => {});
          return;
        }
        this.bufferInboundIce(peer, ice.sessionId, ice.candidate);
      });
    }

    const sdp = parseSdpPayload(payload);
    if (!sdp) {
      return Promise.resolve();
    }

    return this.enqueuePeerOp(peer, async () => {
      if (this.closed) return;

      if (sdp.type === "answer") {
        const session = peer.session;
        if (
          !session ||
          session.closed ||
          session.sessionId !== sdp.sessionId ||
          session.pc.signalingState !== "have-local-offer"
        ) {
          return;
        }
        try {
          await session.pc.setRemoteDescription({
            type: "answer",
            sdp: sdp.sdp,
          });
          if (this.closed || session.closed || peer.session !== session) return;
          session.remoteDescriptionSet = true;
          await this.flushInboundIce(peer, session);
        } catch (err) {
          const transportErr = new TransportError(
            "WEBRTC_UNAVAILABLE",
            `WebRTC setRemoteDescription(answer) failed for ${peer.remoteNodeId}: ${err instanceof Error ? err.message : String(err)}`,
            { mode: "webrtc", cause: err },
          );
          await this.disposeSession(peer, session, true, transportErr);
        }
        return;
      }

      if (peer.ignoredSessionIds.has(sdp.sessionId)) {
        return;
      }

      if (peer.session && !this.isSessionDead(peer.session)) {
        if (peer.session.sessionId === sdp.sessionId) {
          return;
        }
        const offerCollision =
          peer.session.makingOffer || peer.session.pc.signalingState !== "stable";
        if (offerCollision && !peer.polite) {
          this.rememberIgnoredSession(peer, sdp.sessionId);
          return;
        }
        // Polite peer yields during glare (or either peer accepts a fresh session after reconnect).
        await this.disposeSession(peer, peer.session, false);
      } else if (peer.session) {
        await this.disposeSession(peer, peer.session, false);
      }

      const session = this.createSession(peer, sdp.sessionId, "answerer");
      peer.session = session;
      session.pc.onDataChannel.subscribe((dc) => {
        if (dc.label !== WEBRTC_DATA_CHANNEL_LABEL) return;
        this.attachDataChannel(peer, session, dc);
      });

      let answerSdp: string;
      try {
        await session.pc.setRemoteDescription({
          type: "offer",
          sdp: sdp.sdp,
        });
        if (this.closed || session.closed || peer.session !== session) return;
        session.remoteDescriptionSet = true;
        await this.flushInboundIce(peer, session);

        const answer = await session.pc.createAnswer();
        if (this.closed || session.closed || peer.session !== session) return;
        await session.pc.setLocalDescription(answer);
        if (this.closed || session.closed || peer.session !== session) return;
        answerSdp = session.pc.localDescription?.sdp ?? answer.sdp;
      } catch (err) {
        const transportErr = new TransportError(
          "WEBRTC_UNAVAILABLE",
          `WebRTC answer negotiation failed for ${peer.remoteNodeId}: ${err instanceof Error ? err.message : String(err)}`,
          { mode: "webrtc", cause: err },
        );
        await this.disposeSession(peer, session, true, transportErr);
        return;
      }

      session.sdpSent = true;
      this.dispatchSignal(peer, session, {
        frameType: "signal.answer",
        toNodeId: peer.remoteNodeId,
        signalType: "webrtc_sdp",
        payload: {
          sessionId: session.sessionId,
          type: "answer",
          sdp: answerSdp,
        },
      });
      this.flushOutboundIce(peer, session);
    });
  }

  async sendPacket(remoteNodeId: string, packet: P2pPacket): Promise<void> {
    if (this.closed) {
      throw new TransportError("WEBRTC_UNAVAILABLE", "WebRTC peer manager is closed", {
        mode: "webrtc",
      });
    }
    const peer = this.getOrCreatePeer(remoteNodeId);
    const { dc, sessionId } = await this.waitForDataChannel(peer);

    if (this.closed || dc.readyState !== "open") {
      throw new TransportError(
        "WEBRTC_UNAVAILABLE",
        `WebRTC DataChannel is not open for peer ${remoteNodeId}`,
        { mode: "webrtc" },
      );
    }

    const frame: DataChannelPacketFrame = {
      type: "p2p_packet",
      packet,
    };

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(packet.id);
        reject(
          new TransportError(
            "WEBRTC_UNAVAILABLE",
            `WebRTC packet ACK timed out after ${this.ackTimeoutMs}ms for peer ${remoteNodeId}`,
            { mode: "webrtc" },
          ),
        );
      }, this.ackTimeoutMs);

      this.pendingAcks.set(packet.id, {
        remoteNodeId,
        sessionId,
        resolve,
        reject,
        timer,
      });

      try {
        dc.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.pendingAcks.delete(packet.id);
        reject(
          new TransportError(
            "WEBRTC_UNAVAILABLE",
            `WebRTC DataChannel send failed: ${err instanceof Error ? err.message : String(err)}`,
            { mode: "webrtc", cause: err },
          ),
        );
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const closeErr = new TransportError(
      "WEBRTC_UNAVAILABLE",
      "WebRTC peer manager closed",
      { mode: "webrtc" },
    );

    for (const [id, pending] of this.pendingAcks.entries()) {
      clearTimeout(pending.timer);
      this.pendingAcks.delete(id);
      pending.reject(closeErr);
    }

    const peerEntries = [...this.peers.values()];
    const closeTasks: Promise<void>[] = [];

    for (const peer of peerEntries) {
      this.rejectOpenWaiters(peer, closeErr);
      peer.pendingIceBySession.clear();
      peer.ignoredSessionIds.clear();
      if (peer.session) {
        closeTasks.push(this.disposeSession(peer, peer.session, false, closeErr));
      }
      closeTasks.push(peer.opQueue.catch(() => {}));
    }

    await Promise.allSettled(closeTasks);

    const remainingPcs = [...this.activePcs];
    this.activePcs.clear();
    await Promise.allSettled(remainingPcs.map((pc) => pc.close().catch(() => {})));
    this.peers.clear();
  }
}

export class WebRtcTransport implements PeerTransport {
  readonly mode: TransportMode = "webrtc";
  private readonly manager: WebRtcPeerManager;

  constructor(manager: WebRtcPeerManager) {
    this.manager = manager;
  }

  send(peer: TransportPeer, packet: P2pPacket): Promise<void> {
    return this.manager.sendPacket(peer.nodeId, packet);
  }
}
