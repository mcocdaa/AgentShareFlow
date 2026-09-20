import { Hono } from "hono";
import { type RegistryDb, type OrgRole } from "./db.js";
import { resolveOwner } from "./identity.js";
import type { OidcConfig } from "./oidc.js";
import { OWNER_PATTERN } from "@agentshare/core";

export function orgRoutes(db: RegistryDb, oidc?: OidcConfig): Hono {
  const app = new Hono();

  // Create an organization
  app.post("/orgs", async (c) => {
    const caller = await resolveOwner(c, oidc);
    if (!caller) return c.json({ error: "unauthorized" }, 401);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : name;
    const description = typeof body.description === "string" ? body.description.trim() : "";

    if (!name || !OWNER_PATTERN.test(name)) {
      return c.json(
        { error: "invalid organization name, must match lowercase alphanumeric/hyphen, max 39 chars" },
        400,
      );
    }

    if (db.getOrg(name)) {
      return c.json({ error: `organization "${name}" already exists` }, 409);
    }

    const now = new Date().toISOString();
    db.createOrg(name, displayName, description, caller, now);

    return c.json(
      {
        org: {
          name,
          display_name: displayName,
          description,
          created_at: now,
        },
        role: "owner",
      },
      201,
    );
  });

  // List organizations the caller belongs to
  app.get("/orgs", async (c) => {
    const caller = await resolveOwner(c, oidc);
    if (!caller) return c.json({ error: "unauthorized" }, 401);

    const list = db.listUserOrgs(caller);
    return c.json({ organizations: list });
  });

  // Get organization details and member list
  app.get("/orgs/:name", async (c) => {
    const caller = await resolveOwner(c, oidc);
    const orgName = c.req.param("name").toLowerCase();
    const org = db.getOrg(orgName);
    if (!org) return c.json({ error: "organization not found" }, 404);

    const callerRole = caller ? db.getOrgMemberRole(orgName, caller) : null;
    const members = callerRole !== null ? db.listOrgMembers(orgName) : [];

    return c.json({
      org,
      role: callerRole,
      members: callerRole !== null ? members : undefined,
    });
  });

  // Add or update an organization member
  app.post("/orgs/:name/members", async (c) => {
    const caller = await resolveOwner(c, oidc);
    if (!caller) return c.json({ error: "unauthorized" }, 401);

    const orgName = c.req.param("name").toLowerCase();
    const org = db.getOrg(orgName);
    if (!org) return c.json({ error: "organization not found" }, 404);

    const callerRole = db.getOrgMemberRole(orgName, caller);
    if (callerRole !== "owner" && callerRole !== "admin") {
      return c.json({ error: "forbidden: requires organization owner or admin role" }, 403);
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const memberIdentity = typeof body.memberIdentity === "string" ? body.memberIdentity.trim() : "";
    const role = (
      typeof body.role === "string" && ["owner", "admin", "member", "viewer"].includes(body.role)
        ? body.role
        : "member"
    ) as OrgRole;

    if (!memberIdentity) {
      return c.json({ error: "memberIdentity is required" }, 400);
    }

    const now = new Date().toISOString();
    db.addOrUpdateOrgMember(orgName, memberIdentity, role, now);

    return c.json({
      ok: true,
      org_name: orgName,
      member_identity: memberIdentity,
      role,
      updated_at: now,
    });
  });

  // Remove a member from the organization
  app.delete("/orgs/:name/members/:identity", async (c) => {
    const caller = await resolveOwner(c, oidc);
    if (!caller) return c.json({ error: "unauthorized" }, 401);

    const orgName = c.req.param("name").toLowerCase();
    const targetIdentity = c.req.param("identity");
    const org = db.getOrg(orgName);
    if (!org) return c.json({ error: "organization not found" }, 404);

    const callerRole = db.getOrgMemberRole(orgName, caller);
    if (callerRole !== "owner" && callerRole !== "admin" && caller !== targetIdentity) {
      return c.json({ error: "forbidden: requires organization owner or admin role" }, 403);
    }

    // Protect last owner
    const members = db.listOrgMembers(orgName);
    const targetMember = members.find((m) => m.member_identity === targetIdentity);
    if (targetMember?.role === "owner") {
      const ownerCount = members.filter((m) => m.role === "owner").length;
      if (ownerCount <= 1) {
        return c.json({ error: "cannot remove the only owner of the organization" }, 400);
      }
    }

    db.removeOrgMember(orgName, targetIdentity);
    return c.json({ ok: true, removed: targetIdentity });
  });

  return app;
}
