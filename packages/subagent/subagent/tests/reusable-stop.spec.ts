/** Reusable tree stopping over production AgentLoop, Session, and JSONL persistence. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, { SubagentError } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { SubagentResult, SubagentRun } from '../src/types.ts'
import { managerState } from './manager-internals.ts'
import { requireLocalActivation } from '../src/activation.ts'
import { TestSessionQuery } from './test-session-query.ts'

const complete: SubagentResult = { output: [], stopReason: 'completed' }
const message = (text: string) => [{ type: 'text' as const, text }]
const signal = () => new AbortController().signal

async function setup(script: ConstructorParameters<typeof MockAdapter>[0] = [], capacitySource?: Volatile<number>) {
  const ctx = new Context()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-reusable-stop-'))
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  if (capacitySource === undefined) await ctx.plugin(SubagentRuntime)
  else {
    const capacity = capacitySource
    class CapacityRuntime extends SubagentRuntime {
      constructor(context: Context, config: Config) {
        super(context, { ...config, maxActiveSubagents: capacity })
      }
    }
    await ctx.plugin(CapacityRuntime)
  }
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.on('agent/pre-step', ({ agent }, next) => agent.session.header.origin === 'subagent'
    ? next() : Promise.resolve({ kind: 'reject' as const }))
  const root = await ctx.agents.create({
    sessionId: SessionId(`root-${randomUUID()}`), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: directory },
  })
  await ctx.sessionPersistence.flush()
  const start = (parent: Agent = root.agent, callerSignal = signal()) => ctx.subagents.startActivation({
    provider: 'spawn', label: 'local work', parent, prompt: message('work'), signal: callerSignal, delivery: 'parent', maxDepth: 4,
  })
  return { ctx, root, adapter, start }
}

async function coldChild(h: Awaited<ReturnType<typeof setup>>): Promise<SessionId> {
  const first = await h.start()
  await first.result
  expect(h.ctx.agents.get(first.childId)).toBeUndefined()
  await h.root.agent.whenIdle()
  return first.childId
}

function external(ctx: Context, start: () => Promise<SubagentRun>) {
  const provider = `external-${randomUUID()}`
  ctx.subagents.registerProvider({
    name: provider, inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }, start,
  })
  return (parent: Agent) => ctx.subagents.startActivation({
    provider, label: 'external work', parent, prompt: message('work'), signal: signal(), delivery: 'caller',
  })
}

it.each(['fresh', 'cold'] as const)('waits for %s factory handover, releases it, and delegates again on the same root', async mode => {
  const h = await setup(mode === 'cold' ? [textResponse('first'), textResponse('later')] : [textResponse('later')])
  const childId = mode === 'cold' ? await coldChild(h) : undefined
  const entered = Promise.withResolvers<Agent>(), release = Promise.withResolvers<void>()
  let factorySignal: AbortSignal | undefined
  const off = h.ctx.on('agent/created', async ({ agent, signal: initializingSignal }) => {
    if (agent.session.header.origin !== 'subagent') return
    factorySignal = initializingSignal
    entered.resolve(agent)
    await release.promise
  })
  const starting = childId === undefined ? h.start()
    : h.ctx.subagents.sendMessage(h.root.agent, childId, message('resume'), { signal: signal() })
  const rejected = expect(starting).rejects.toMatchObject({ code: 'DRAINING' })
  try {
    const child = await entered.promise
    let stopped = false
    const stopping = h.ctx.subagents.stopDescendants([h.root.agent]).then(() => { stopped = true })
    expect(factorySignal?.aborted).toBe(false)
    await expect(h.start()).rejects.toMatchObject({ code: 'DRAINING' })
    expect(stopped).toBe(false)
    release.resolve()
    await rejected
    await stopping
    off()
    expect(h.ctx.agents.get(child.id)).toBeUndefined()
    expect(h.ctx.agents.get(h.root.agent.id)).toBe(h.root.agent)
    const next = await h.start()
    await expect(next.result).resolves.toMatchObject({ output: [{ type: 'text', text: 'later' }] })
  } finally { release.resolve(); off() }
})

it('maps a pre-acquisition capacity source failure without inventing cleanup debt and resumes after recovery', async () => {
  const unavailable = new Error('capacity source unavailable')
  let failing = false
  const h = await setup([textResponse('first'), textResponse('after recovery')], {
    get: () => { if (failing) throw unavailable; return 8 },
  })
  const childId = await coldChild(h)
  failing = true
  await expect(h.ctx.subagents.sendMessage(h.root.agent, childId, message('resume'), { signal: signal() }))
    .rejects.toMatchObject({ code: 'NOT_RESUMABLE', cause: unavailable })
  expect(h.ctx.agents.get(childId)).toBeUndefined()
  await expect(h.ctx.subagents.stopDescendants([h.root.agent])).resolves.toBeUndefined()
  failing = false
  await h.ctx.subagents.sendMessage(h.root.agent, childId, message('retry after recovery'), { signal: signal() })
  await h.ctx.subagents.waitForTreeWork(h.root.agent)
  expect(h.ctx.agents.get(childId)).toBeUndefined()
  expect(h.adapter.requests).toHaveLength(2)
})

it('keeps the setup directory signal live during stop and joins the returned handle rollback', async () => {
  const h = await setup([textResponse('later')])
  const entered = Promise.withResolvers<AbortSignal | undefined>(), release = Promise.withResolvers<void>()
  const directories = h.ctx.workingDirectory, set = directories.set.bind(directories)
  const setupDirectory = vi.spyOn(directories, 'set').mockImplementationOnce(async (agent, path, directorySignal) => {
    entered.resolve(directorySignal)
    await release.promise
    directorySignal?.throwIfAborted()
    return set(agent, path, directorySignal)
  })
  const starting = h.start(), rejected = expect(starting).rejects.toMatchObject({ code: 'DRAINING' })
  try {
    const directorySignal = await entered.promise
    const stopping = h.ctx.subagents.stopDescendants([h.root.agent])
    expect(directorySignal).toBeDefined()
    expect(directorySignal?.aborted).toBe(false)
    release.resolve()
    await rejected
    await stopping
    expect(h.ctx.agents.list()).toEqual([h.root.agent])
    const next = await h.start()
    await expect(next.result).resolves.toMatchObject({ stopReason: 'completed' })
  } finally { release.resolve(); setupDirectory.mockRestore() }
})

it.each([
  ['fresh', 'caller abort'], ['cold', 'caller abort'], ['fresh', 'factory rejection'], ['cold', 'factory rejection'],
] as const)('retains unknown %s %s across stop and root replacement without masking its cause', async (mode, failureMode) => {
  const h = await setup(mode === 'cold' ? [textResponse('first')] : [])
  const childId = mode === 'cold' ? await coldChild(h) : undefined
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), caller = new AbortController()
  const original = new Error(failureMode)
  const off = h.ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') return
    entered.resolve()
    await release.promise
    if (failureMode === 'factory rejection') throw original
  })
  const starting = childId === undefined ? h.start(h.root.agent, caller.signal)
    : h.ctx.subagents.sendMessage(h.root.agent, childId, message('resume'), { signal: caller.signal })
  const failed = starting.catch((error: unknown) => error)
  try {
    await entered.promise
    const stopping = h.ctx.subagents.stopDescendants([h.root.agent])
    const stopped = expect(stopping).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    if (failureMode === 'caller abort') caller.abort(original)
    release.resolve()
    const error = await failed
    expect(error).toBeInstanceOf(SubagentError)
    expect(error).toMatchObject({ code: 'ACTIVATION_CLEANUP_UNKNOWN', cause: original })
    await stopped
    off()
    await expect(h.ctx.subagents.stopDescendants([h.root.agent])).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    await h.root.dispose()
    const restored = await h.ctx.agents.resume({ resumeSessionId: h.root.agent.id, agentOptions: { provider: 'mock', model: 'mock' } })
    expect(restored.agent).not.toBe(h.root.agent)
    expect(restored.agent.id).toBe(h.root.agent.id)
    await expect(h.ctx.subagents.stopDescendants([restored.agent])).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    await expect(h.start(restored.agent)).rejects.toMatchObject({ code: 'DRAINING' })
  } finally { release.resolve(); off() }
})

it('retains rollback failure that preceded stop, including after root disposal and same-Session resume', async () => {
  const h = await setup()
  const releaseError = new Error('external rollback release failed')
  const dispose = vi.fn(async () => { throw releaseError })
  const start = external(h.ctx, async () => ({ id: h.root.agent.id, result: Promise.resolve(complete), dispose }))
  const ended = vi.fn()
  h.ctx.on('subagent/end', ended)
  await expect(start(h.root.agent)).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
  expect(dispose).toHaveBeenCalledTimes(1)
  await expect(h.ctx.subagents.stopDescendants([h.root.agent])).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
  await h.root.dispose()
  const restored = await h.ctx.agents.resume({ resumeSessionId: h.root.agent.id, agentOptions: { provider: 'mock', model: 'mock' } })
  await expect(h.ctx.subagents.stopDescendants([restored.agent])).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
  await expect(start(restored.agent)).rejects.toMatchObject({ code: 'DRAINING' })
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(ended).not.toHaveBeenCalled()
})

it('wakes an existing tree waiter when unpublished rollback fails without releasing ownership', async () => {
  const h = await setup()
  const entered = Promise.withResolvers<void>(), published = Promise.withResolvers<SubagentRun>()
  const releasing = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  const childId = SessionId('unpublished-release-failed'), releaseError = new Error('unpublished release refused')
  const run: SubagentRun = { id: childId, result: new Promise(() => {}), dispose: () => { releasing.resolve(); return released.promise } }
  const start = external(h.ctx, () => { entered.resolve(); return published.promise })
  const starting = start(h.root.agent)
  const startFailure = expect(starting).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
  let restore: (() => void) | undefined
  try {
    await entered.promise
    const stopping = h.ctx.subagents.stopDescendants([h.root.agent])
    const stopFailure = expect(stopping).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    published.resolve(run)
    await releasing.promise
    const resident = managerState(h.ctx).resident.get(childId)!
    const joined = vi.spyOn(resident.result.promise, 'catch'), ended = vi.fn()
    restore = () => { joined.mockRestore() }
    h.ctx.on('subagent/end', ended)
    const waiting = h.ctx.subagents.waitForTreeWork(h.root.agent)
    const waitFailure = expect(waiting).rejects.toMatchObject({ code: 'ACTIVATION_CLEANUP_UNKNOWN' })
    await vi.waitFor(() => { expect(joined).toHaveBeenCalled() })
    released.reject(releaseError)
    await Promise.all([startFailure, stopFailure, waitFailure])
    expect(managerState(h.ctx).resident.get(childId)).toBe(resident)
    expect(ended).not.toHaveBeenCalled()
    await expect(h.start()).rejects.toMatchObject({ code: 'DRAINING' })
  } finally {
    published.resolve(run)
    released.reject(releaseError)
    restore?.()
  }
})

it('reports failed external release without waiting for its never-settling result or publishing an end', async () => {
  const h = await setup()
  const result = Promise.withResolvers<SubagentResult>()
  const dispose = vi.fn(async () => { throw new Error('release refused') })
  const start = external(h.ctx, async () => ({ id: SessionId('unreleased-external'), result: result.promise, dispose }))
  const activation = await start(h.root.agent), ended = vi.fn()
  h.ctx.on('subagent/end', ended)
  const activationFailure = expect(activation.result).rejects.toBeInstanceOf(SubagentError)
  await expect(h.ctx.subagents.stopDescendants([h.root.agent])).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
  await activationFailure
  await expect(h.ctx.subagents.waitForTreeWork(h.root.agent)).rejects.toMatchObject({ code: 'ACTIVATION_CLEANUP_UNKNOWN' })
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(ended).not.toHaveBeenCalled()
  await expect(h.ctx.subagents.stopDescendants([h.root.agent])).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
  expect(dispose).toHaveBeenCalledTimes(1)
})

it.each(['pending', 'rejected'] as const)('reports a released external %s result separately, tolerates late rejection, and reopens admission', async mode => {
  const h = await setup([textResponse('later')])
  const result = Promise.withResolvers<SubagentResult>(), release = Promise.withResolvers<void>()
  const dispose = vi.fn(() => release.promise)
  const start = external(h.ctx, async () => ({ id: SessionId('released-external'), result: result.promise, dispose }))
  const activation = await start(h.root.agent), ended = vi.fn(), unhandled = vi.fn()
  h.ctx.on('subagent/end', ended)
  process.on('unhandledRejection', unhandled)
  try {
    const providerFailure = new Error('provider result failed')
    const activationFailure = mode === 'pending'
      ? expect(activation.result).rejects.toMatchObject({ code: 'ACTIVATION_RESULT_UNAVAILABLE' })
      : expect(activation.result).rejects.toBe(providerFailure)
    const stopping = h.ctx.subagents.stopDescendants([h.root.agent])
    const stopFailure = expect(stopping).rejects.toMatchObject({ code: 'ACTIVATION_RESULT_FAILED' })
    await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(1) })
    if (mode === 'rejected') result.reject(providerFailure)
    release.resolve()
    await stopFailure
    await activationFailure
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ stopReason: 'error' }))
    if (mode === 'pending') result.reject(new Error('late provider rejection'))
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(unhandled).not.toHaveBeenCalled()
    expect(ended).toHaveBeenCalledTimes(1)
    await expect(h.ctx.subagents.stopDescendants([h.root.agent])).resolves.toBeUndefined()
    expect(dispose).toHaveBeenCalledTimes(1)
    const next = await h.start()
    await expect(next.result).resolves.toMatchObject({ output: [{ type: 'text', text: 'later' }] })
  } finally { release.resolve(); process.off('unhandledRejection', unhandled) }
})

it('releases a child and grandchild once under concurrent stop, preserves other roots, and injects without waking', async () => {
  const h = await setup(['hang', 'hang', 'hang', 'hang'])
  const child = await h.start(), childAgent = h.ctx.agents.get(child.childId)!
  const grandchild = await h.start(childAgent)
  const other = await h.ctx.agents.create({ sessionId: SessionId('other-root'), agentOptions: { provider: 'mock', model: 'mock' } })
  const independent = await h.start(other.agent)
  await vi.waitFor(() => { expect(h.adapter.requests).toHaveLength(3) })
  const resident = managerState(h.ctx).resident
  const childDisposal = vi.spyOn(requireLocalActivation(resident.get(child.childId)!).handle, 'dispose')
  const grandchildDisposal = vi.spyOn(requireLocalActivation(resident.get(grandchild.childId)!).handle, 'dispose')
  const wake = vi.spyOn(h.root.agent, 'followup'), steer = vi.spyOn(h.root.agent, 'steer'), injected = vi.spyOn(h.root.agent, 'inject')
  await h.ctx.subagents.stopDescendants([childAgent])
  expect(h.ctx.agents.get(grandchild.childId)).toBeDefined()
  await Promise.all([h.ctx.subagents.stopDescendants([h.root.agent]), h.ctx.subagents.stopDescendants([h.root.agent])])
  expect(h.ctx.agents.get(child.childId)).toBeUndefined()
  expect(h.ctx.agents.get(grandchild.childId)).toBeUndefined()
  expect(h.ctx.agents.get(independent.childId)).toBeDefined()
  expect(childDisposal).toHaveBeenCalledTimes(1)
  expect(grandchildDisposal).toHaveBeenCalledTimes(1)
  expect(wake).not.toHaveBeenCalled()
  expect(steer).not.toHaveBeenCalled()
  expect(injected).toHaveBeenCalled()
  expect(h.root.agent.status).toBe('idle')
  const next = await h.start()
  await h.ctx.subagents.stopDescendants([h.root.agent, other.agent])
  await Promise.all([child.result, grandchild.result, independent.result, next.result])
})
