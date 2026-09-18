import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { boot } from '../../../boot/app-boot/src/index.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HandoffService, markSharedAgent } from '../src/service.ts'

const input = {
  spec: 'handoff/v0',
  id: 'handoff-test',
  title: 'Selected work',
  goal: 'Continue the selected task',
  tasks: [{ id: 't1', summary: 'Run checks', status: 'blocked' }],
  authorizations: [{ name: 'GITHUB_TOKEN', status: 'inherited' }],
}

function agentAt(cwd?: string): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

function digest(preview: string): string {
  const match = preview.match(/Confirm with \/handoff ([a-f0-9]{64})$/)
  assert.ok(match)
  return match[1]!
}

test('preview writes nothing; confirmed files match the reviewed content', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const service = new HandoffService()
  const owner = agentAt(cwd)
  const preview = service.prepare(owner, JSON.stringify(input))
  assert.deepEqual(await fs.readdir(cwd), [])
  assert.equal(service.preview(owner), preview)
  assert.match(preview, /需重新授权：GITHUB_TOKEN/)
  assert.match(preview, /Run checks（阻塞）/)
  await assert.rejects(service.confirm(owner, 'wrong'), /mismatch/)
  assert.deepEqual(await fs.readdir(cwd), [])
  const result = await service.confirm(owner, digest(preview))
  const [, jsonPath, markdownPath] = result.split('\n')
  assert.ok(jsonPath)
  assert.ok(markdownPath)
  const json = JSON.parse(await fs.readFile(jsonPath, 'utf8'))
  assert.equal(json.goal, input.goal)
  assert.equal(json.authorizations[0].status, 'reauthorize')
  assert.ok(json.createdAt)
  assert.ok(preview.startsWith(await fs.readFile(markdownPath, 'utf8')))
  await assert.rejects(service.confirm(owner, digest(preview)), /no pending/)
})

test('replacement invalidates old confirmation and invalid input clears the draft', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const service = new HandoffService()
  const owner = agentAt(cwd)
  const old = digest(service.prepare(owner, JSON.stringify(input)))
  service.prepare(owner, JSON.stringify({ ...input, goal: 'Changed goal' }))
  await assert.rejects(service.confirm(owner, old), /mismatch/)
  assert.throws(() => service.prepare(owner, '{'), SyntaxError)
  assert.throws(() => service.preview(owner), /no pending/)
  assert.deepEqual(await fs.readdir(cwd), [])
})

test('isolates agents, rejects shared sessions and clears pending drafts', async () => {
  const service = new HandoffService()
  const owner = agentAt(os.tmpdir())
  const other = agentAt(os.tmpdir())
  const confirmation = digest(service.prepare(owner, JSON.stringify(input)))
  await assert.rejects(service.confirm(other, confirmation), /no pending/)
  markSharedAgent(owner)
  assert.throws(() => service.prepare(owner, JSON.stringify(input)), /shared sessions/)
  assert.throws(() => service.preview(owner), /shared sessions/)
  await assert.rejects(service.confirm(owner, confirmation), /shared sessions/)
  service.prepare(other, JSON.stringify(input))
  service.clear()
  assert.throws(() => service.preview(other), /no pending/)
  assert.throws(() => service.prepare(agentAt(), JSON.stringify(input)), /no cwd/)
})

test('rejects oversized input and directory changes', async () => {
  const service = new HandoffService()
  const owner = agentAt(os.tmpdir())
  assert.throws(() => service.prepare(owner, '中'.repeat(100_000)), /256 KiB/)
  const confirmation = digest(service.prepare(owner, JSON.stringify(input)))
  Object.assign(owner.session.header, { cwd: path.join(os.tmpdir(), 'changed') })
  await assert.rejects(service.confirm(owner, confirmation), /directory changed/)
})

test('Loader registers the tool and command and exports through their public executors', { timeout: 30_000 }, async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-loader-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const modules = [
    'llm/llm', 'core/session', 'session/session-projection', 'core/system-prompt',
    'core/tools', 'core/agent', 'core/agent-loop', 'interaction/commands',
  ]
  const config = modules.map(module => ({
    name: fileURLToPath(new URL(`../../../${module}/lib/index.js`, import.meta.url)),
    ...(module === 'core/agent-loop' ? { config: { agents: [] } } : {}),
  }))
  const configPath = path.join(cwd, 'cordis.yml')
  await fs.writeFile(configPath, JSON.stringify([
    ...config,
    {
      name: fileURLToPath(new URL('../../../credentials/credentials-local/lib/index.js', import.meta.url)),
      config: { path: path.join(cwd, 'credentials.yml'), watch: false },
    },
    { name: fileURLToPath(new URL('../src/index.ts', import.meta.url)) },
  ]))
  const ctx = await boot('handoff-loader-test', configPath)
  t.after(() => ctx.fiber.dispose())
  const handle = await ctx.agents.create({ sessionId: SessionId(`handoff-test-${Date.now()}`), meta: { cwd } })
  t.after(() => handle.dispose())
  const agent = handle.agent
  const signal = new AbortController().signal
  assert.ok(agent.ctx.tools.schemas().some(tool => tool.name === 'handoff_draft'))
  const before = await fs.readdir(cwd)
  const prepared = await agent.ctx.tools.execute({
    signal, agent, callId: ToolCallId('handoff-loader-draft'),
    name: 'handoff_draft', arguments: { json: JSON.stringify(input) },
  })
  assert.equal(prepared.isError, false, JSON.stringify(prepared))
  const preview = prepared.content.filter(block => block.type === 'text').map(block => block.text).join('')
  const confirmation = digest(preview)
  assert.deepEqual(await fs.readdir(cwd), before)
  const reviewed = await ctx.commands.execute(agent, '/handoff', [], signal)
  assert.equal(reviewed?.result.kind, 'success')
  assert.equal(reviewed?.result.text, preview)
  const rejected = await ctx.commands.execute(agent, '/handoff wrong', [], signal)
  assert.equal(rejected?.result.kind, 'error')
  assert.deepEqual(await fs.readdir(cwd), before)
  const exported = await ctx.commands.execute(agent, `/handoff ${confirmation}`, [], signal)
  assert.equal(exported?.result.kind, 'success')
  const [, jsonPath, markdownPath] = exported!.result.text!.split('\n')
  const json = JSON.parse(await fs.readFile(jsonPath!, 'utf8'))
  assert.equal(json.goal, input.goal)
  assert.ok(preview.startsWith(await fs.readFile(markdownPath!, 'utf8')))
  const repeated = await ctx.commands.execute(agent, `/handoff ${confirmation}`, [], signal)
  assert.equal(repeated?.result.kind, 'error')
})
