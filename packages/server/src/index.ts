export interface StartServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  publicUrl?: string;
  relayEnabled?: boolean;
}

export interface StartedServer {
  port: number;
  url: string;
  wsUrl: string;
  close(): Promise<void>;
}

export async function startServer(_options: StartServerOptions = {}): Promise<StartedServer> {
  throw new Error("Server not yet implemented");
}
