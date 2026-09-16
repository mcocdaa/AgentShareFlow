import { z } from "zod";

export const PACK_SPEC = "agent-pack/v0";

export const HARNESSES = ["agents", "claude", "codex", "opencode", "openclaw", "hermes"] as const;
export type Harness = (typeof HARNESSES)[number];

export const PACK_MODES = ["offline", "endpoint", "runtime"] as const;
export type PackMode = (typeof PACK_MODES)[number];

export const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const PACK_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const urlString = () =>
  z.string().refine((value) => URL.canParse(value), { message: "must be a valid URL" });

export const EndpointSchema = z.object({
  type: z.enum(["mcp", "a2a"]),
  url: urlString(),
  agentCard: urlString().optional(),
});
export type AgentEndpoint = z.infer<typeof EndpointSchema>;

export const RuntimeSchema = z
  .object({
    image: z.string().min(1).optional(),
    dockerfile: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    protocol: z.enum(["mcp", "a2a"]).default("mcp"),
  })
  .refine((runtime) => Boolean(runtime.image) !== Boolean(runtime.dockerfile), {
    message: "exactly one of image or dockerfile is required",
  });
export type AgentRuntime = z.infer<typeof RuntimeSchema>;

export const AgentManifestSchema = z
  .object({
    spec: z.literal(PACK_SPEC),
    name: z
      .string()
      .regex(PACK_NAME_PATTERN, "lowercase alphanumeric/hyphen, max 64 chars"),
    version: z.string().regex(SEMVER_PATTERN, "must be semver, e.g. 0.1.0"),
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(1024),
    mode: z.enum(PACK_MODES),
    tags: z.array(z.string().min(1).max(32)).max(16).default([]),
    license: z.string().max(120).optional(),
    compatibility: z.array(z.enum(HARNESSES)).min(1).default(["agents"]),
    skills: z.array(z.string().min(1)).default([]),
    instructions: z.array(z.string().min(1)).default([]),
    mcp: z.object({ config: z.string().min(1) }).optional(),
    endpoint: EndpointSchema.optional(),
    runtime: RuntimeSchema.optional(),
    secrets: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, "use ENV_STYLE names, e.g. GITHUB_TOKEN"))
      .max(32)
      .default([]),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.mode === "endpoint" && !manifest.endpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: "endpoint is required when mode is endpoint",
      });
    }
    if (manifest.mode === "runtime" && !manifest.runtime) {
      ctx.addIssue({
        code: "custom",
        path: ["runtime"],
        message: "runtime is required when mode is runtime",
      });
    }
    if (manifest.mode === "offline" && (manifest.endpoint || manifest.runtime)) {
      ctx.addIssue({
        code: "custom",
        path: ["mode"],
        message: "offline packs must not declare endpoint or runtime",
      });
    }
  });

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export function parseManifest(input: unknown): AgentManifest {
  return AgentManifestSchema.parse(input);
}

export function formatIssues(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
