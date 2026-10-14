import type { Context } from "hono";
import { getAuth } from "@hono/oidc-auth";
import { authenticate, type TokenLookupDb } from "./auth.js";
import { ownerFromClaims, type OidcConfig } from "./oidc.js";

export async function resolveOwner(
  c: Context,
  oidc: OidcConfig | undefined,
  db?: TokenLookupDb,
): Promise<string | undefined> {
  const contextDb =
    db ??
    (typeof c.get === "function"
      ? ((c.get as (key: string) => TokenLookupDb | undefined)("db"))
      : undefined);
  const tokenOwner = authenticate(c.req.header("authorization"), process.env, contextDb)?.owner;
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
