import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { ShareService, HandoffService } from './service.ts'

export const name = 'agentshare'

export const inject = ['commands', 'tools', 'credentials', 'agents']

export interface Config {
  registry: string
  tokenEnv: string
  title?: string
}

export const Config: z<Config> = z.object({
  registry: z.string().default('http://localhost:8787'),
  tokenEnv: z.string().role('credential-ref').default('AGENTSHARE_TOKEN'),
  title: z.string(),
})

export function apply(ctx: Context, config: Config): void {
  const service = new ShareService(ctx, {
    registry: config.registry,
    tokenEnv: config.tokenEnv,
    ...config.title === undefined ? {} : { title: config.title },
  })
  const handoff = new HandoffService()

  const failure = (error: unknown): string => error instanceof Error ? error.message : String(error)

  ctx.effect(() => ctx.commands.register({
    name: 'share',
    description: 'Share this session as a live link (/share, or /share handoff to attach the pending handoff)',
    input: { hint: 'Optional: "handoff" attaches the reviewed handoff draft' },
    handler: async ({ agent, rawInput }) => {
      try {
        const withHandoff = rawInput.trim() === 'handoff'
        const pending = withHandoff ? handoff.pendingFor(agent) : undefined
        if (withHandoff && pending === undefined) {
          return { kind: 'error', text: 'no pending handoff draft; ask the agent to call handoff_draft first' }
        }
        const share = await service.shareFromAgent(agent, pending)
        return {
          kind: 'success',
          text: `agentshare link: ${share.url}${pending === undefined ? '' : ' (handoff attached)'}`,
        }
      } catch (error) {
        return { kind: 'error', text: failure(error) }
      }
    },
  }), 'agentshare: /share')

  ctx.effect(() => ctx.commands.register({
    name: 'shares',
    description: 'List active AgentShare links',
    handler: () => {
      const active = service.listActive()
      if (active.length === 0) return { kind: 'success', text: 'no active shares' }
      return {
        kind: 'success',
        text: active.map(share => `${share.id}  visitors:${share.visitors}  ${share.url}`).join('\n'),
      }
    },
  }), 'agentshare: /shares')

  ctx.effect(() => ctx.commands.register({
    name: 'unshare',
    description: 'Revoke an AgentShare link (/unshare [id], defaults to the most recent)',
    handler: async ({ rawInput }) => {
      const id = rawInput.trim()
      const active = service.listActive()
      if (active.length === 0) return { kind: 'error', text: 'no active shares' }
      const target = id === '' ? active[active.length - 1] : active.find(share => share.id === id)
      if (target === undefined) return { kind: 'error', text: `unknown share: ${id}` }
      await service.revokeShare(target.id)
      return { kind: 'success', text: `revoked ${target.id}` }
    },
  }), 'agentshare: /unshare')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'share_create',
    description: 'Share this session as a live read-only link so someone else can ask this agent questions. '
      + 'Returns the share id and URL. Use when the user asks to hand off or share this session. '
      + 'Set includeHandoff only when the user explicitly asks to publish the reviewed handoff draft with the link.',
    parameters: {
      includeHandoff: {
        type: 'boolean',
        description: 'Attach the pending handoff draft reviewed via handoff_draft. Defaults to false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          url: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { id: string, url: string }) => [
        { type: 'text' as const, text: `Share link: ${value.url}` },
      ],
    },
    execute: async (args: { includeHandoff?: boolean }, exec) => {
      const owner = exec.agent
      if (owner === undefined) throw new Error('share_create requires an agent context')
      const pending = args.includeHandoff === true ? handoff.pendingFor(owner) : undefined
      if (args.includeHandoff === true && pending === undefined) {
        throw new Error('no pending handoff draft; call handoff_draft first')
      }
      return await service.shareFromAgent(owner, pending)
    },
  })), 'agentshare: share_create')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'handoff_draft',
    description: 'Prepare a local handoff draft from selected session context, without writing or publishing it. '
      + 'Include goal, doneWhen, context (constraints, environment, sources), decisions (id, summary, rationale, evidence), '
      + 'tasks (id, summary, status: in-progress/blocked/done, howToVerify), outcomes, authorizations and openQuestions. '
      + 'Evidence and outcomes use {label, kind: path/url/transcript/note, ref}. Cite only actual sources; do not invent rationale. '
      + 'Never include credentials or private material not selected by the user. Authorization names only; no permissions transfer. '
      + 'Return the full preview for user review; only the user can confirm export using /handoff <digest>.',
    parameters: {
      json: {
        type: 'string',
        required: true,
        description: 'JSON object with spec="handoff/v0", lowercase-hyphen id, title and goal; optional fields as described above. Maximum 256 KiB.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args, exec) => {
      if (exec.agent === undefined) throw new Error('handoff_draft requires an agent context')
      return await Promise.resolve(handoff.prepare(exec.agent, args.json))
    },
  })), 'agentshare: handoff_draft')

  ctx.effect(() => ctx.commands.register({
    name: 'handoff',
    description: 'Preview the pending handoff, or confirm export with /handoff <digest>',
    input: { hint: 'Leave empty to preview; paste the reviewed digest to export' },
    handler: async ({ agent, rawInput }) => {
      try {
        const digest = rawInput.trim()
        const text = digest === '' ? handoff.preview(agent) : await handoff.confirm(agent, digest)
        return { kind: 'success', text }
      } catch (error) {
        return { kind: 'error', text: failure(error) }
      }
    },
  }), 'agentshare: /handoff')

  ctx.effect(() => ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    service.onAssistantStream(agent, frame)
  }), 'agentshare: stream forwarding')

  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    service.onAgentStatus(agent, status)
  }), 'agentshare: turn completion')

  ctx.effect(() => ctx.on('agent/error', ({ agent, error }) => {
    service.onAgentError(agent, error)
  }), 'agentshare: error forwarding')

  ctx.effect(() => () => {
    handoff.clear()
    void service.stopAll()
  }, 'agentshare: shutdown')
}
