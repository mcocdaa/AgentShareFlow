import type { Context } from "hono";
import { getAuth } from "@hono/oidc-auth";
import { authenticate } from "./auth.js";
import { ownerFromClaims, type OidcConfig } from "./oidc.js";

export async function resolveOwner(
  c: Context,
  oidc: OidcConfig | undefined,
): Promise<string | undefined> {
  const tokenOwner = authenticate(c.req.header("authorization"))?.owner;
  if (tokenOwner !== undefined) return tokenOwner;
  if (oidc === undefined) return undefined;
  try {
    const auth = await getAuth(c);
    if (auth === null) return undefined;
    return ownerFromClaims(auth, oidc);
  } catch {
    return undefined;
  }
}
