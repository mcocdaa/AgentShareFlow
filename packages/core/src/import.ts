import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { PACK_SPEC, PACK_NAME_PATTERN, SEMVER_PATTERN, parseManifest, type AgentManifest } from "./manifest.js";
import { MANIFEST_FILENAME } from "./pack.js";

export type ImportProvider = "smithery" | "clawhub" | "skills-sh";

export interface ImportResult {
  provider: ImportProvider;
  source: string;
  dir: string;
  manifest: AgentManifest;
  files: string[];
}

export interface ImportOptions {
  out?: string;
  name?: string;
  force?: boolean;
}

export interface ClawHubImportOptions extends ImportOptions {
  version?: string;
}

export interface SkillsShImportOptions extends ImportOptions {
  skill?: string;
}

const SMITHERY_REGISTRY = "https://registry.smithery.ai";
const CLAWHUB_API = "https://clawhub.ai";
const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SKILLS_SH_FILES = 500;

export function sanitizePackName(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/, "");
  if (!PACK_NAME_PATTERN.test(slug)) {
    throw new Error(`cannot derive a valid pack name from "${input}"; pass --name`);
  }
  return slug;
}

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function sanitizeVersion(input: string | undefined): string {
  const value = input?.trim() ?? "";
  return SEMVER_PATTERN.test(value) ? value : "0.1.0";
}

function sanitizeTags(tags: string[]): string[] {
  return tags
    .map((tag) => tag.trim().replace(/\s+/g, " "))
    .filter((tag) => tag.length > 0 && tag.length <= 32)
    .slice(0, 16);
}

export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const result: { name?: string; description?: string } = {};
  for (const line of text.slice(3, end).split("\n")) {
    const match = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1] as "name" | "description"] = value;
  }
  return result;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`request failed (${response.status}) for ${url}`);
  }
  return response;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetchWithTimeout(url, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
  return response.json();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function writePack(
  dir: string,
  rawManifest: Record<string, unknown>,
  files: Record<string, string | Uint8Array>,
  force: boolean | undefined,
): Promise<{ dir: string; manifest: AgentManifest }> {
  const resolved = path.resolve(dir);
  if (fs.existsSync(resolved)) {
    const existing = await fsp.readdir(resolved);
    if (existing.length > 0 && force !== true) {
      throw new Error(`destination already exists and is not empty: ${resolved} (pass --force)`);
    }
  }
  const manifest = parseManifest(rawManifest);
  await fsp.mkdir(resolved, { recursive: true });
  await fsp.writeFile(path.join(resolved, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [rel, content] of Object.entries(files)) {
    const segments = rel.split("/");
    if (path.isAbsolute(rel) || segments.some((segment) => segment === ".." || segment === "")) {
      throw new Error(`refusing to write unsafe path: ${rel}`);
    }
    const target = path.join(resolved, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
  return { dir: resolved, manifest };
}

function skillRoots(paths: string[]): string[] {
  const dirs = paths
    .filter((entry) => entry === "SKILL.md" || entry.endsWith("/SKILL.md"))
    .map((entry) => path.posix.dirname(entry))
    .sort();
  return [...new Set(dirs)];
}

export async function importFromSmithery(
  qualifiedName: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const json = asRecord(
    await fetchJson(`${SMITHERY_REGISTRY}/servers/${encodeURIComponent(qualifiedName)}`),
  );
  const connections = Array.isArray(json.connections) ? json.connections.map(asRecord) : [];
  const http = connections.find((connection) => connection.type === "http");
  const endpointUrl = asString(http?.deploymentUrl) ?? asString(json.deploymentUrl);
  if (endpointUrl === undefined || !URL.canParse(endpointUrl)) {
    throw new Error(`smithery server ${qualifiedName} declares no hosted http endpoint`);
  }

  const name = sanitizePackName(options.name ?? qualifiedName.split("/").pop() ?? qualifiedName);
  const displayName = asString(json.displayName) ?? name;
  const description = clamp(
    asString(json.description) ?? `${displayName} — hosted MCP server imported from Smithery.`,
    1024,
  );
  const toolNames = (Array.isArray(json.tools) ? json.tools.map(asRecord) : [])
    .map((tool) => asString(tool.name))
    .filter((tool): tool is string => tool !== undefined)
    .slice(0, 12);

  const skill = [
    "---",
    `name: ${name}`,
    `description: ${clamp(`${displayName}: ${description}`, 1024).replace(/\n+/g, " ")}`,
    "---",
    "",
    `# ${displayName}`,
    "",
    `Hosted MCP server \`${qualifiedName}\`, imported from Smithery. This pack links the endpoint; there is no local code.`,
    "",
    `- Endpoint: ${endpointUrl}`,
    `- Registry: https://smithery.ai/server/${qualifiedName}`,
    ...(toolNames.length === 0 ? [] : [`- Tools: ${toolNames.map((tool) => `\`${tool}\``).join(", ")}`]),
    "",
    "Configure your harness to use the MCP endpoint above. Treat credentials as environment variable names; never commit values.",
    "",
  ].join("\n");

  const written = await writePack(
    options.out ?? name,
    {
      spec: PACK_SPEC,
      name,
      version: "0.1.0",
      title: clamp(displayName, 120),
      description,
      mode: "endpoint",
      endpoint: { type: "mcp", url: endpointUrl },
      tags: ["smithery", "mcp"],
      skills: ["."],
      metadata: {
        provider: "smithery",
        source: `https://smithery.ai/server/${qualifiedName}`,
      },
    },
    { "SKILL.md": skill },
    options.force,
  );

  return {
    provider: "smithery",
    source: `https://smithery.ai/server/${qualifiedName}`,
    dir: written.dir,
    manifest: written.manifest,
    files: ["SKILL.md"],
  };
}

export async function importFromClawHub(
  ref: string,
  options: ClawHubImportOptions = {},
): Promise<ImportResult> {
  const parts = ref.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error("clawhub ref must look like owner/slug");
  }
  const [owner, slug] = parts as [string, string];
  const detail = asRecord(
    await fetchJson(
      `${CLAWHUB_API}/api/v1/skills/${encodeURIComponent(slug)}?ownerHandle=${encodeURIComponent(owner)}`,
    ),
  );
  const skill = asRecord(detail.skill);
  const version = sanitizeVersion(options.version ?? asString(asRecord(skill.tags).latest));

  const query = new URLSearchParams({ slug, ownerHandle: owner });
  if (options.version !== undefined) query.set("version", options.version);
  const zipResponse = await fetchWithTimeout(`${CLAWHUB_API}/api/v1/download?${query.toString()}`);
  const entries = unzipSync(new Uint8Array(await zipResponse.arrayBuffer()));

  const files: Record<string, Uint8Array> = {};
  for (const [entry, content] of Object.entries(entries)) {
    if (entry.endsWith("/") || entry === "_meta.json") continue;
    files[entry] = content;
  }
  const roots = skillRoots(Object.keys(files));
  if (roots.length === 0) throw new Error(`clawhub skill ${ref} contains no SKILL.md`);

  const name = sanitizePackName(options.name ?? slug);
  const displayName = asString(skill.displayName) ?? name;
  const skillMd = Object.entries(files).find(([entry]) => entry === "SKILL.md");
  const frontmatter =
    skillMd === undefined ? {} : parseSkillFrontmatter(new TextDecoder().decode(skillMd[1]));
  const description = clamp(
    asString(skill.summary) ??
      frontmatter.description ??
      `${displayName} — skill imported from ClawHub.`,
    1024,
  );
  const secrets = (Array.isArray(asRecord(skill.metadata).setup)
    ? (asRecord(skill.metadata).setup as unknown[]).map((entry) => asString(asRecord(entry).key))
    : []
  )
    .filter((key): key is string => key !== undefined && /^[A-Z][A-Z0-9_]*$/.test(key))
    .slice(0, 32);
  const topics = Array.isArray(skill.topics)
    ? skill.topics.filter((topic): topic is string => typeof topic === "string")
    : [];

  const written = await writePack(
    options.out ?? name,
    {
      spec: PACK_SPEC,
      name,
      version,
      title: clamp(displayName, 120),
      description,
      mode: "offline",
      tags: sanitizeTags(["clawhub", ...topics]),
      skills: roots,
      secrets,
      metadata: {
        provider: "clawhub",
        source: `https://clawhub.ai/${owner}/${slug}`,
      },
    },
    files,
    options.force,
  );

  return {
    provider: "clawhub",
    source: `https://clawhub.ai/${owner}/${slug}`,
    dir: written.dir,
    manifest: written.manifest,
    files: Object.keys(files).sort(),
  };
}

interface GitHubTreeEntry {
  path: string;
  type: string;
}

function githubHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept,
    "x-github-api-version": "2022-11-28",
    "user-agent": "agentshare-cli",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token !== undefined && token.length > 0) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function githubFetchJson(pathname: string): Promise<unknown> {
  const response = await fetchWithTimeout(`${GITHUB_API}${pathname}`, {
    headers: githubHeaders("application/vnd.github+json"),
  });
  return response.json();
}

async function githubFetchFile(
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
): Promise<Uint8Array> {
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  try {
    const response = await fetchWithTimeout(rawUrl);
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    const encoded = filePath.split("/").map(encodeURIComponent).join("/");
    const response = await fetchWithTimeout(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
      { headers: githubHeaders("application/vnd.github.raw") },
    );
    return new Uint8Array(await response.arrayBuffer());
  }
}

export async function importFromSkillsSh(
  ref: string,
  options: SkillsShImportOptions = {},
): Promise<ImportResult> {
  const parts = ref.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error("skills-sh ref must look like owner/repo");
  }
  const [owner, repo] = parts as [string, string];

  const repoInfo = asRecord(await githubFetchJson(`/repos/${owner}/${repo}`));
  const branch = asString(repoInfo.default_branch) ?? "main";
  const tree = asRecord(
    await githubFetchJson(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`),
  );
  const blobs = (Array.isArray(tree.tree) ? tree.tree : [])
    .map(asRecord)
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string") as unknown as GitHubTreeEntry[];

  const roots = skillRoots(blobs.map((entry) => entry.path));
  if (roots.length === 0) throw new Error(`${owner}/${repo} contains no SKILL.md`);

  let selected = roots;
  if (options.skill !== undefined) {
    selected = roots.filter((root) => path.posix.basename(root) === options.skill);
    if (selected.length === 0) {
      throw new Error(
        `skill "${options.skill}" not found in ${owner}/${repo}; available: ${roots
          .map((root) => path.posix.basename(root))
          .join(", ")}`,
      );
    }
    if (selected.length > 1) {
      throw new Error(`skill "${options.skill}" is ambiguous in ${owner}/${repo}`);
    }
  }

  const wanted = new Set<string>();
  for (const root of selected) {
    const prefix = root === "." ? "" : `${root}/`;
    for (const entry of blobs) {
      if (entry.path === "SKILL.md" && root === ".") {
        wanted.add(entry.path);
        continue;
      }
      if (prefix !== "" && entry.path.startsWith(prefix)) wanted.add(entry.path);
    }
  }
  if (wanted.size === 0) throw new Error(`selected skills in ${owner}/${repo} contain no files`);
  if (wanted.size > MAX_SKILLS_SH_FILES) {
    throw new Error(
      `${owner}/${repo} selected skills contain ${wanted.size} files (limit ${MAX_SKILLS_SH_FILES}); pick one skill with --skill`,
    );
  }

  const files: Record<string, Uint8Array> = {};
  for (const entry of [...wanted].sort()) {
    files[entry] = await githubFetchFile(owner, repo, branch, entry);
  }

  const single = selected.length === 1 ? selected[0]! : undefined;
  const frontmatter =
    single === undefined
      ? {}
      : parseSkillFrontmatter(new TextDecoder().decode(files[`${single === "." ? "" : `${single}/`}SKILL.md`]!));
  const names = selected.map((root) => (root === "." ? repo : path.posix.basename(root)));
  const defaultName = single === undefined ? repo : names[0]!;
  const name = sanitizePackName(options.name ?? defaultName);
  const title = clamp(frontmatter.name ?? (single === undefined ? repo : names[0]!), 120);
  const description = clamp(
    frontmatter.description ??
      `${single === undefined ? `${names.length} skills` : "Skill"} imported from ${owner}/${repo}: ${names.join(", ")}.`,
    1024,
  );

  const written = await writePack(
    options.out ?? name,
    {
      spec: PACK_SPEC,
      name,
      version: "0.1.0",
      title,
      description,
      mode: "offline",
      tags: sanitizeTags(["skills-sh", ...names.slice(0, 8)]),
      skills: selected,
      metadata: {
        provider: "skills-sh",
        source: `https://skills.sh/${owner}/${repo}${options.skill === undefined ? "" : `/${options.skill}`}`,
        repository: `https://github.com/${owner}/${repo}`,
      },
    },
    files,
    options.force,
  );

  return {
    provider: "skills-sh",
    source: `https://github.com/${owner}/${repo}`,
    dir: written.dir,
    manifest: written.manifest,
    files: Object.keys(files).sort(),
  };
}
