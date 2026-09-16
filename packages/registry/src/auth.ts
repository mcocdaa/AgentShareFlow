export interface AuthResult {
  owner: string;
}

export function authenticate(
  header: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AuthResult | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;

  const raw = env.AGENTSHARE_TOKENS?.trim();
  const devOwner = (env.AGENTSHARE_DEV_OWNER ?? "dev").toLowerCase();

  if (!raw) return { owner: devOwner };

  for (const entry of raw.split(",")) {
    const [candidate, owner] = entry.trim().split(":");
    if (candidate === token) {
      return { owner: (owner?.trim() || devOwner).toLowerCase() };
    }
  }
  return null;
}
