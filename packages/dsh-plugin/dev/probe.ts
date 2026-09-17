import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ShareService } from '../src/service.ts'

export const name = 'agentshare-dev-probe'
export const inject = ['agents', 'credentials', 'agentDefaultModel']

const REGISTRY = process.env.AGENTSHARE_REGISTRY ?? 'http://localhost:8787'
const TOKEN_ENV = process.env.AGENTSHARE_TOKEN_ENV ?? 'AGENTSHARE_TOKEN'

export async function apply(ctx: Context): Promise<void> {
  const service = new ShareService(ctx, { registry: REGISTRY, tokenEnv: TOKEN_ENV })
  ctx.effect(() => ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    service.onAssistantStream(agent, frame)
  }), 'agentshare-dev-probe: stream forwarding')
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    service.onAgentStatus(agent, status)
  }), 'agentshare-dev-probe: turn completion')
  ctx.effect(() => ctx.on('agent/error', ({ agent, error }) => {
    service.onAgentError(agent, error)
    console.error('[agentshare-dev-probe] agent error:', error)
  }), 'agentshare-dev-probe: error forwarding')

  await new Promise(resolve => setTimeout(resolve, 4000))
  try {
    const selection = ctx.agentDefaultModel.currentSelection()
    const current = {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
    const presets = ctx.get('agentPresets')
    const presetId = presets === undefined ? undefined : (await presets.resolve(undefined)).id
    const handle = await ctx.agents.create({
      sessionId: `agentshare-probe-${Date.now()}` as never,
      meta: { cwd: process.cwd(), ...presetId === undefined ? {} : { agentPreset: presetId } },
      agentOptions: current,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, { current, assembled: undefined })
        if (presets !== undefined && presetId !== undefined) {
          await presets.mount(agentCtx, presetId)
        }
      },
    })
    const share = await service.shareFromAgent(handle.agent)
    console.log(`[agentshare-dev-probe] share=${share.id} url=${share.url}`)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Reply with exactly: probe ready.' }],
      source: { kind: 'plugin', plugin: 'agentshare-dev-probe' },
    }))
    await handle.agent.whenIdle().catch(() => undefined)
    console.log('[agentshare-dev-probe] seeded one completed turn')

    if (process.env.AGENTSHARE_PROBE_TOOL === '1') {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Call the share_create tool now and reply with the link it returns.' }],
        source: { kind: 'plugin', plugin: 'agentshare-dev-probe' },
      }))
      await handle.agent.whenIdle().catch(() => undefined)
      console.log('[agentshare-dev-probe] share_create prompt settled')
    }
  } catch (error) {
    console.error('[agentshare-dev-probe] failed:', error)
  }
}
