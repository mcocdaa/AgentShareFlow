import type { P2pPacket, TransportMode } from "./protocol.js";
import { assertSafeExternalUrl, type DnsLookupFn } from "./ssrf.js";

export type TransportErrorCode =
  | "DIRECT_FAILED"
  | "WEBRTC_UNAVAILABLE"
  | "RELAY_DISABLED"
  | "RELAY_FAILED"
  | "ALL_TRANSPORTS_FAILED";

export interface TransportPeer {
  nodeId: string;
  handle?: string;
  directUrl: string | null;
}

export interface TransportAttempt {
  mode: TransportMode;
  ok: boolean;
  code?: TransportErrorCode;
  error?: string;
  durationMs: number;
}

export interface TransportSendResult {
  mode: TransportMode;
  attempts: TransportAttempt[];
}

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly mode?: TransportMode;
  readonly attempts?: TransportAttempt[];

  constructor(
    code: TransportErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      mode?: TransportMode;
      attempts?: TransportAttempt[];
    },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "TransportError";
    this.code = code;
    this.mode = options?.mode;
    this.attempts = options?.attempts;
  }
}

export interface PeerTransport {
  readonly mode: TransportMode;
  send(peer: TransportPeer, packet: P2pPacket): Promise<void>;
}

export interface DirectHttpTransportOptions {
  timeoutMs?: number;
  allowPrivate?: boolean;
  fetchImpl?: typeof fetch;
  lookupFn?: DnsLookupFn;
}

export class DirectHttpTransport implements PeerTransport {
  readonly mode: TransportMode = "direct";
  private readonly timeoutMs: number;
  private readonly allowPrivate: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly lookupFn?: DnsLookupFn;

  constructor(options: DirectHttpTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.allowPrivate = options.allowPrivate ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookupFn = options.lookupFn;
  }

  async send(peer: TransportPeer, packet: P2pPacket): Promise<void> {
    if (!peer.directUrl) {
      throw new TransportError(
        "DIRECT_FAILED",
        `Peer ${peer.nodeId} has no directUrl configured`,
        { mode: "direct" },
      );
    }

    const endpoint = `${peer.directUrl.replace(/\/+$/, "")}/p2p/v2/message`;
    let safeUrl: URL;
    try {
      safeUrl = await assertSafeExternalUrl(endpoint, {
        allowPrivate: this.allowPrivate,
        lookupFn: this.lookupFn,
      });
    } catch (err) {
      throw new TransportError(
        "DIRECT_FAILED",
        err instanceof Error ? err.message : String(err),
        { mode: "direct", cause: err },
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl(safeUrl.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(packet),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new TransportError(
        "DIRECT_FAILED",
        `Direct HTTP request failed: ${err instanceof Error ? err.message : String(err)}`,
        { mode: "direct", cause: err },
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw new TransportError(
        "DIRECT_FAILED",
        `Direct HTTP endpoint attempted a redirect (HTTP ${response.status})`,
        { mode: "direct" },
      );
    }

    if (!response.ok) {
      throw new TransportError(
        "DIRECT_FAILED",
        `Direct HTTP delivery failed with HTTP ${response.status}`,
        { mode: "direct" },
      );
    }
  }
}

export class WebRtcTransportStub implements PeerTransport {
  readonly mode: TransportMode = "webrtc";
  private readonly reason: string;

  constructor(reason = "WebRTC data channel transport is not available in this runtime") {
    this.reason = reason;
  }

  async send(_peer: TransportPeer, _packet: P2pPacket): Promise<void> {
    throw new TransportError("WEBRTC_UNAVAILABLE", this.reason, {
      mode: "webrtc",
    });
  }
}

export interface RelayTransportOptions {
  enabled?: boolean | (() => boolean);
  forward: (toNodeId: string, packet: P2pPacket) => Promise<void>;
}

export class RelayTransport implements PeerTransport {
  readonly mode: TransportMode = "relay";
  private enabledOption: boolean | (() => boolean);
  private readonly forwardFn: (toNodeId: string, packet: P2pPacket) => Promise<void>;

  constructor(options: RelayTransportOptions) {
    this.enabledOption = options.enabled ?? true;
    this.forwardFn = options.forward;
  }

  isEnabled(): boolean {
    return typeof this.enabledOption === "function"
      ? this.enabledOption()
      : this.enabledOption;
  }

  setEnabled(enabled: boolean): void {
    this.enabledOption = enabled;
  }

  async send(peer: TransportPeer, packet: P2pPacket): Promise<void> {
    if (!this.isEnabled()) {
      throw new TransportError(
        "RELAY_DISABLED",
        "Relay transport is disabled",
        { mode: "relay" },
      );
    }

    try {
      await this.forwardFn(peer.nodeId, packet);
    } catch (err) {
      if (err instanceof TransportError) {
        throw err;
      }
      throw new TransportError(
        "RELAY_FAILED",
        `Relay forwarding failed: ${err instanceof Error ? err.message : String(err)}`,
        { mode: "relay", cause: err },
      );
    }
  }
}

export interface FallbackTransportRouterOptions {
  direct?: PeerTransport;
  webrtc?: PeerTransport;
  relay?: PeerTransport;
}

export class FallbackTransportRouter {
  private readonly direct: PeerTransport;
  private readonly webrtc: PeerTransport;
  private readonly relay?: PeerTransport;

  constructor(options: FallbackTransportRouterOptions = {}) {
    this.direct = options.direct ?? new DirectHttpTransport();
    this.webrtc = options.webrtc ?? new WebRtcTransportStub();
    this.relay = options.relay;
  }

  async send(
    peer: TransportPeer,
    packet: P2pPacket,
    opts?: { forceRelay?: boolean },
  ): Promise<TransportSendResult> {
    const attempts: TransportAttempt[] = [];
    const chain: PeerTransport[] = opts?.forceRelay
      ? this.relay
        ? [this.relay]
        : []
      : [this.direct, this.webrtc, ...(this.relay ? [this.relay] : [])];

    if (chain.length === 0) {
      attempts.push({
        mode: "relay",
        ok: false,
        code: "RELAY_DISABLED",
        error: "Relay transport is not configured",
        durationMs: 0,
      });
      throw new TransportError(
        "RELAY_DISABLED",
        "Relay transport is not configured",
        { mode: "relay", attempts },
      );
    }

    let lastError: TransportError | undefined;
    for (const transport of chain) {
      const startedAt = Date.now();
      try {
        await transport.send(peer, packet);
        attempts.push({
          mode: transport.mode,
          ok: true,
          durationMs: Date.now() - startedAt,
        });
        return { mode: transport.mode, attempts };
      } catch (err) {
        const transportErr =
          err instanceof TransportError
            ? err
            : new TransportError(
                transport.mode === "direct"
                  ? "DIRECT_FAILED"
                  : transport.mode === "webrtc"
                    ? "WEBRTC_UNAVAILABLE"
                    : "RELAY_FAILED",
                err instanceof Error ? err.message : String(err),
                { mode: transport.mode, cause: err },
              );
        lastError = transportErr;
        attempts.push({
          mode: transport.mode,
          ok: false,
          code: transportErr.code,
          error: transportErr.message,
          durationMs: Date.now() - startedAt,
        });
      }
    }

    if (opts?.forceRelay && lastError) {
      throw new TransportError(lastError.code, lastError.message, {
        mode: lastError.mode,
        attempts,
        cause: lastError,
      });
    }

    const summary = attempts
      .map((a) => `${a.mode}:${a.code ?? "FAILED"}(${a.error ?? ""})`)
      .join("; ");
    throw new TransportError(
      "ALL_TRANSPORTS_FAILED",
      `All transports failed for peer ${peer.nodeId}: ${summary}`,
      { attempts, cause: lastError },
    );
  }
}
