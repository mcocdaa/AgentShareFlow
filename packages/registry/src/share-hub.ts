export interface HubStream {
  write(event: string, data: unknown): void;
  close(): void;
}

export class ShareHub {
  private readonly tunnels = new Map<string, HubStream>();
  private readonly visitors = new Map<string, Map<HubStream, string | undefined>>();

  connectTunnel(shareId: string, stream: HubStream): void {
    this.tunnels.get(shareId)?.close();
    this.tunnels.set(shareId, stream);
  }

  disconnectTunnel(shareId: string, stream: HubStream): boolean {
    if (this.tunnels.get(shareId) !== stream) return false;
    this.tunnels.delete(shareId);
    return true;
  }

  hasTunnel(shareId: string): boolean {
    return this.tunnels.has(shareId);
  }

  sendToTunnel(shareId: string, data: unknown): boolean {
    const tunnel = this.tunnels.get(shareId);
    if (!tunnel) return false;
    tunnel.write("frame", data);
    return true;
  }

  addVisitor(shareId: string, stream: HubStream, sessionId?: string): void {
    let streams = this.visitors.get(shareId);
    if (!streams) {
      streams = new Map();
      this.visitors.set(shareId, streams);
    }
    streams.set(stream, sessionId);
  }

  removeVisitor(shareId: string, stream: HubStream): void {
    const streams = this.visitors.get(shareId);
    if (!streams) return;
    streams.delete(stream);
    if (streams.size === 0) this.visitors.delete(shareId);
  }

  publish(shareId: string, event: string, data: unknown, sessionId?: string): void {
    const streams = this.visitors.get(shareId);
    if (!streams) return;
    for (const [stream, subscribed] of streams) {
      if (sessionId !== undefined && subscribed !== sessionId) continue;
      try {
        stream.write(event, data);
      } catch {
        streams.delete(stream);
      }
    }
  }

  closeShare(shareId: string): void {
    this.tunnels.get(shareId)?.close();
    this.tunnels.delete(shareId);
    const streams = this.visitors.get(shareId);
    if (streams) {
      for (const stream of streams.keys()) stream.close();
      this.visitors.delete(shareId);
    }
  }
}
