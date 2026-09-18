import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentOptions,
  type AssistantStreamFrame,
  type CreateAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { ShareClient, TunnelClient, formatHandoffIssues, parseHandoff, renderHandoffMarkdown, writeHandoffFiles, type TunnelFrame } from '@agentshare/core'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'

const VISITOR_IDLE_MS = 30 * 60 * 1000

const READONLY_TOOL_ALLOW = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'skill',
  'present',
  'lsp',
  'get_goal',
  'list_agents',
  'list_subagent_models',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  'session_search',
  'session_trace',
])

function isAllowedTool(name: string): boolean {
  return READONLY_TOOL_ALLOW.has(name)
}

export interface ShareServiceConfig {
  registry: string
  tokenEnv: string
  title?: string
}

interface VisitorSession {
  agent: Agent
  handle: AgentHandle
  buffer: string
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

interface ShareSource {
  presetId?: string
  cwd?: string
  parentSessionId: SessionId
  seed: SessionEvent[]
  route?: AgentOptions
}

export function ownerAgentRoute(agent: Agent): AgentOptions {
  const requestConfig = agent.session.requestHeader()?.config
  if (requestConfig === undefined) return { ...agent.options }
  const { provider: _provider, model: _model, reasoningEffort: _effort, ...rest } = agent.options
  return {
    ...rest,
    provider: requestConfig.provider,
    model: requestConfig.model,
    ...requestConfig.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: requestConfig.reasoningEffort },
  }
}

interface ActiveShare {
  id: string
  url: string
  client: ShareClient
  tunnel: TunnelClient
  source: ShareSource
  visitors: Map<string, VisitorSession>
}

function completedTurnPrefix(agent: Agent): SessionEvent[] {
  // Deprecated synchronous history read, same waiver as subagent-fork-in-process: the fork needs a
  // balanced completed-turn prefix and no non-deprecated range reader exists yet.
  const events = agent.session.snapshotEvents()
  const lastEnd = events.findLast(event => event.type === 'turn/end')
  if (lastEnd === undefined) return []
  return events.slice(0, lastEnd.seq + 1)
}

const sharedAgents = new WeakSet<Agent>()

interface HandoffDraft {
  json: ReturnType<typeof parseHandoff>
  markdown: string
  digest: string
  cwd: string
}

export class HandoffService {
  private drafts = new WeakMap<Agent, HandoffDraft>()

  clear(): void {
    this.drafts = new WeakMap()
  }

  prepare(agent: Agent, raw: string): string {
    this.assertOwner(agent)
    this.drafts.delete(agent)
    const cwd = agent.session.header.cwd
    if (cwd === undefined) throw new Error('session has no cwd to export into')
    if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) throw new Error('handoff exceeds 256 KiB')
    const json = parseHandoff(JSON.parse(raw))
    json.createdAt ??= new Date().toISOString()
    for (const authorization of json.authorizations) {
      if (authorization.status === 'inherited') authorization.status = 'reauthorize'
    }
    const markdown = renderHandoffMarkdown(json)
    const digest = createHash('sha256').update(JSON.stringify({ json, cwd })).digest('hex')
    this.drafts.set(agent, { json, markdown, digest, cwd })
    return this.preview(agent)
  }

  preview(agent: Agent): string {
    this.assertOwner(agent)
    const draft = this.drafts.get(agent)
    if (draft === undefined) throw new Error('no pending draft; ask the agent to call handoff_draft first')
    return `${draft.markdown}\nExport destination: ${draft.cwd}\nReview for secrets and private information. References are not copied or verified; no permissions transfer.\nConfirm with /handoff ${draft.digest}`
  }

  async confirm(agent: Agent, digest: string): Promise<string> {
    this.assertOwner(agent)
    const draft = this.drafts.get(agent)
    if (draft === undefined) throw new Error('no pending draft; ask the agent to call handoff_draft first')
    if (digest !== draft.digest) throw new Error('draft changed or confirmation mismatch; run /handoff to review')
    if (agent.session.header.cwd !== draft.cwd) throw new Error('session directory changed; prepare a new draft')
    this.drafts.delete(agent)
    try {
      const written = await writeHandoffFiles(draft.json, { dir: draft.cwd })
      return `handoff exported:\n${written.jsonPath}\n${written.markdownPath}`
    } catch (error) {
      throw new Error(`handoff export failed; prepare a new draft: ${formatHandoffIssues(error)}`)
    }
  }

  private assertOwner(agent: Agent): void {
    if (sharedAgents.has(agent)) throw new Error('handoff is not available in shared sessions')
  }
}

export function markSharedAgent(agent: Agent): void {
  sharedAgents.add(agent)
}

export class ShareService {
  private readonly shares = new Map<string, ActiveShare>()

  constructor(
    private readonly ctx: Context,
    private readonly config: ShareServiceConfig,
  ) {}

  async shareFromAgent(agent: Agent): Promise<{ id: string, url: string }> {
    const token = await this.resolveToken()
    const client = new ShareClient({ registry: this.config.registry, token })
    const header = agent.session.header
    const project = header.cwd === undefined ? undefined : basename(header.cwd)
    const share = await client.createShare({
      title: this.config.title ?? `agent · ${project ?? String(header.id)}`,
      ...project === undefined ? {} : { project },
    })

    const presets = this.ctx.get('agentPresets')
    const presetId = presets?.composedPreset(agent.ctx)
    const source: ShareSource = {
      ...presetId === undefined ? {} : { presetId },
      ...header.cwd === undefined ? {} : { cwd: header.cwd },
      parentSessionId: header.id,
      seed: completedTurnPrefix(agent),
      route: ownerAgentRoute(agent),
    }

    const tunnel = new TunnelClient({
      registry: this.config.registry,
      shareId: share.id,
      token,
      onFrame: frame => this.onFrame(share.id, frame),
    })
    const active: ActiveShare = {
      id: share.id,
      url: share.url ?? client.shareUrl(share.id),
      client,
      tunnel,
      source,
      visitors: new Map(),
    }
    this.shares.set(share.id, active)
    tunnel.start()
    return { id: share.id, url: active.url }
  }

  listActive(): Array<{ id: string, url: string, visitors: number }> {
    return [...this.shares.values()].map(share => ({
      id: share.id,
      url: share.url,
      visitors: share.visitors.size,
    }))
  }

  async revokeShare(shareId: string): Promise<boolean> {
    const active = this.shares.get(shareId)
    if (active === undefined) return false
    await active.client.revokeShare(shareId).catch(() => undefined)
    await this.stopShare(shareId)
    return true
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.shares.keys()]) await this.stopShare(id)
  }

  onAssistantStream(agent: Agent, frame: AssistantStreamFrame): void {
    const found = this.findVisitor(agent)
    if (found === undefined) return
    const { share, sessionId, visitor } = found
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      visitor.buffer += frame.chunk.text
      void share.tunnel.send({
        type: 'agent_chunk',
        shareId: share.id,
        sessionId,
        content: frame.chunk.text,
      })
    }
  }

  onAgentStatus(agent: Agent, status: string): void {
    if (status !== 'idle') return
    const found = this.findVisitor(agent)
    if (found === undefined) return
    const { share, sessionId, visitor } = found
    if (visitor.buffer.length === 0) return
    const content = visitor.buffer
    visitor.buffer = ''
    void share.tunnel.send({ type: 'agent_done', shareId: share.id, sessionId, content })
    this.touchVisitor(visitor)
  }

  onAgentError(agent: Agent, error: unknown): void {
    const found = this.findVisitor(agent)
    if (found === undefined) return
    found.visitor.buffer = ''
    void found.share.tunnel.send({
      type: 'agent_error',
      shareId: found.share.id,
      sessionId: found.sessionId,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  private async stopShare(shareId: string): Promise<void> {
    const active = this.shares.get(shareId)
    if (active === undefined) return
    this.shares.delete(shareId)
    await active.tunnel.stop()
    for (const visitor of active.visitors.values()) {
      if (visitor.idleTimer !== undefined) clearTimeout(visitor.idleTimer)
      await visitor.handle.dispose().catch(() => undefined)
    }
    active.visitors.clear()
  }

  private findVisitor(agent: Agent): { share: ActiveShare, sessionId: string, visitor: VisitorSession } | undefined {
    for (const share of this.shares.values()) {
      for (const [sessionId, visitor] of share.visitors) {
        if (visitor.agent === agent) return { share, sessionId, visitor }
      }
    }
    return undefined
  }

  private touchVisitor(visitor: VisitorSession): void {
    if (visitor.idleTimer !== undefined) clearTimeout(visitor.idleTimer)
    visitor.idleTimer = setTimeout(() => {
      void visitor.handle.dispose().catch(() => undefined)
    }, VISITOR_IDLE_MS)
    visitor.idleTimer.unref?.()
  }

  private async onFrame(shareId: string, frame: TunnelFrame): Promise<void> {
    const share = this.shares.get(shareId)
    if (share === undefined) return
    if (frame.type !== 'visitor_message') return
    const visitor = await this.ensureVisitor(share, frame.sessionId)
    visitor.buffer = ''
    visitor.agent.followup(createUserMessage({
      content: [{ type: 'text', text: frame.content }],
      source: { kind: 'user' },
    }))
    this.touchVisitor(visitor)
  }

  private async ensureVisitor(share: ActiveShare, sessionId: string): Promise<VisitorSession> {
    const existing = share.visitors.get(sessionId)
    if (existing !== undefined) return existing

    const seed = share.source.seed
    const options = {
      sessionId: sessionId as unknown as SessionId,
      ...share.source.route === undefined ? {} : { agentOptions: share.source.route },
      meta: {
        ...share.source.cwd === undefined ? {} : { cwd: share.source.cwd },
        ...share.source.presetId === undefined ? {} : { agentPreset: share.source.presetId },
        parentSession: share.source.parentSessionId,
        isSeeded: seed.length > 0,
      },
      ...seed.length === 0
        ? {}
        : { seed, inheritedEventCount: seed.length as unknown as SessionLogOffset },
      setup: async (agentCtx: Context, agent: Agent) => {
        markSharedAgent(agent)
        const presets = agentCtx.get('agentPresets')
        if (presets !== undefined && share.source.presetId !== undefined) {
          await presets.mount(agentCtx, share.source.presetId)
        }
        const route = share.source.route
        if (route?.provider !== undefined && route.model !== undefined) {
          installModelSelection(agentCtx, {
            current: {
              provider: route.provider,
              model: route.model,
              ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
            },
            assembled: undefined,
          })
        }
        agentCtx.tools.guard((execution) =>
          isAllowedTool(execution.name)
            ? undefined
            : `agentshare: ${execution.name} is not available in shared sessions`,
        )
        agentCtx.tools.restrict({ deny: ['share_create', 'handoff_draft'] })
        agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' })
      },
    } as CreateAgentOptions

    const handle = await this.ctx.agents.create(options)
    const visitor: VisitorSession = {
      agent: handle.agent,
      handle,
      buffer: '',
      idleTimer: undefined,
    }
    share.visitors.set(sessionId, visitor)
    this.touchVisitor(visitor)
    void share.tunnel.send({
      type: 'fork_created',
      shareId: share.id,
      sessionId,
      dshSessionId: String(handle.agent.id),
    })
    return visitor
  }

  private async resolveToken(): Promise<string> {
    const credential = await this.ctx.credentials.resolve(credentialRef(this.config.tokenEnv))
    if (credential === undefined || credential.value === '') {
      throw new Error(`credential ${this.config.tokenEnv} is not set`)
    }
    return credential.value
  }
}
