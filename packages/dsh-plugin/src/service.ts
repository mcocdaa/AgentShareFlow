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
import { ShareClient, TunnelClient, type TunnelFrame } from '@agentshare/core'
import { basename } from 'node:path'

const VISITOR_IDLE_MS = 30 * 60 * 1000

const READONLY_TOOL_DENY_EXACT = new Set([
  'bash',
  'pwsh',
  'str_replace_editor',
  'job_kill',
  'ralph',
  'spawn_teammate',
  'send_message',
  'interrupt_agent',
  'create_goal',
  'ask_user_question',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
])

const READONLY_TOOL_DENY_PREFIX = ['terminal_', 'job_', 'team_task_', 'cordis_']

function isBlockedTool(name: string): boolean {
  return (
    READONLY_TOOL_DENY_EXACT.has(name) ||
    READONLY_TOOL_DENY_PREFIX.some((prefix) => name.startsWith(prefix))
  )
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
      url: client.shareUrl(share.id),
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
      return
    }
    if (frame.type === 'end' && visitor.buffer.length > 0) {
      const content = visitor.buffer
      visitor.buffer = ''
      void share.tunnel.send({ type: 'agent_done', shareId: share.id, sessionId, content })
      this.touchVisitor(visitor)
    }
  }

  onAgentError(agent: Agent, error: unknown): void {
    const found = this.findVisitor(agent)
    if (found === undefined) return
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
          isBlockedTool(execution.name)
            ? `agentshare: ${execution.name} is disabled in shared sessions`
            : undefined,
        )
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
