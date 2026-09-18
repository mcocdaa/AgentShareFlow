import {
  getAuth,
  initOidcAuthMiddleware,
  oidcAuthMiddleware,
  processOAuthCallback,
  revokeSession,
} from "@hono/oidc-auth";
import { OWNER_PATTERN } from "@agentshare/core";
import { Hono } from "hono";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  authSecret: string;
  redirectUri: string;
  ownerClaim?: string;
  ownerMap?: string;
  scopes?: string;
  externalUrl?: string;
}

const OIDC_ENV_KEYS = [
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_AUTH_SECRET",
  "OIDC_REDIRECT_URI",
  "OIDC_SCOPES",
  "OIDC_AUTH_EXTERNAL_URL",
  "OIDC_OWNER_CLAIM",
  "OIDC_OWNER_MAP",
] as const;

export function oidcConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OidcConfig | undefined {
  const issuer = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  const clientSecret = env.OIDC_CLIENT_SECRET;
  const authSecret = env.OIDC_AUTH_SECRET;
  if (!issuer || !clientId || !clientSecret || !authSecret) return undefined;
  return {
    issuer,
    clientId,
    clientSecret,
    authSecret,
    redirectUri: env.OIDC_REDIRECT_URI?.trim() || "/api/v1/auth/callback",
    ...env.OIDC_SCOPES?.trim() ? { scopes: env.OIDC_SCOPES.trim() } : {},
    ...env.OIDC_AUTH_EXTERNAL_URL?.trim() ? { externalUrl: env.OIDC_AUTH_EXTERNAL_URL.trim() } : {},
    ...env.OIDC_OWNER_CLAIM?.trim() ? { ownerClaim: env.OIDC_OWNER_CLAIM.trim() } : {},
    ...env.OIDC_OWNER_MAP?.trim() ? { ownerMap: env.OIDC_OWNER_MAP.trim() } : {},
  };
}

export function applyOidcEnv(config: OidcConfig, env: NodeJS.ProcessEnv = process.env): void {
  for (const key of OIDC_ENV_KEYS) delete env[key];
  env.OIDC_ISSUER = config.issuer;
  env.OIDC_CLIENT_ID = config.clientId;
  env.OIDC_CLIENT_SECRET = config.clientSecret;
  env.OIDC_AUTH_SECRET = config.authSecret;
  env.OIDC_REDIRECT_URI = config.redirectUri;
  if (config.scopes !== undefined) env.OIDC_SCOPES = config.scopes;
  if (config.externalUrl !== undefined) env.OIDC_AUTH_EXTERNAL_URL = config.externalUrl;
  if (config.ownerClaim !== undefined) env.OIDC_OWNER_CLAIM = config.ownerClaim;
  if (config.ownerMap !== undefined) env.OIDC_OWNER_MAP = config.ownerMap;
}

export function ownerFromClaims(
  claims: Record<string, unknown>,
  config: Pick<OidcConfig, "ownerClaim" | "ownerMap">,
): string | undefined {
  const claimName = config.ownerClaim ?? "email";
  const claimValue = claims[claimName];
  const raw =
    typeof claimValue === "string" && claimValue.trim() !== ""
      ? claimValue
      : typeof claims["email"] === "string"
        ? (claims["email"] as string)
        : undefined;
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim().toLowerCase();

  if (config.ownerMap !== undefined) {
    for (const entry of config.ownerMap.split(",")) {
      const [match, owner] = entry.split(":").map((part) => part?.trim().toLowerCase() ?? "");
      if (match !== "" && match === value) {
        return owner !== undefined && OWNER_PATTERN.test(owner) ? owner : undefined;
      }
    }
  }

  const slug = value
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return OWNER_PATTERN.test(slug) ? slug : undefined;
}

export function oidcMiddleware(config: OidcConfig) {
  return initOidcAuthMiddleware({
    OIDC_ISSUER: config.issuer,
    OIDC_CLIENT_ID: config.clientId,
    OIDC_CLIENT_SECRET: config.clientSecret,
    OIDC_AUTH_SECRET: config.authSecret,
    OIDC_REDIRECT_URI: config.redirectUri,
    ...config.scopes === undefined ? {} : { OIDC_SCOPES: config.scopes },
    ...config.externalUrl === undefined ? {} : { OIDC_AUTH_EXTERNAL_URL: config.externalUrl },
  });
}

export function createOidcRoutes(config: OidcConfig): Hono {
  const app = new Hono();
  app.get("/auth/callback", (c) => processOAuthCallback(c));
  app.get("/auth/login", oidcAuthMiddleware(), (c) => c.redirect("/api/v1/me"));
  app.get("/auth/logout", async (c) => {
    await revokeSession(c);
    return c.redirect("/");
  });
  app.get("/me", oidcAuthMiddleware(), async (c) => {
    const auth = await getAuth(c);
    const owner = auth === null ? undefined : ownerFromClaims(auth, config);
    if (auth === null || owner === undefined) {
      return c.json({ error: "signed in, but no owner namespace could be derived from the claims" }, 403);
    }
    return c.json({
      owner,
      email: auth.email,
      ...typeof auth["name"] === "string" ? { name: auth["name"] } : {},
    });
  });
  return app;
}
