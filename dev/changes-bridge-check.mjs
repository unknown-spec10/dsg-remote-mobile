// Bridge-level check for Batch C3 (context meter, changed files/diff, commands)
// against a fake Cordis context. Deterministic: no Host, no model, no network.
import assert from 'node:assert/strict'
import { createBridge } from '../bridge.js'

const log = { info() {}, warn() {}, error() {}, debug() {} }
const agents = new Map()
const agent = { session: { id: 's1' }, status: 'idle' }
agents.set('s1', agent)

const events = [
  { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
  { type: 'workspace/changes', seq: 42, time: 2, data: { turn: 3 } },
]
let executed = []
const services = {
  sessionController: {
    async list() {
      return { items: [{ sessionId: 's1', running: false, updatedAt: 5, projections: { values: { title: 'Demo', agentPreset: 'standard', modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' } } } } }] }
    },
    async events() {
      return { records: events }
    },
    async projections() {
      return {
        values: {
          contextPressure: { pressureTokens: 900, projectedTokens: 1200, contextWindow: 8000 },
          tokenUsage: { inputTokens: 600, outputTokens: 60, totalTokens: 660 },
        },
      }
    },
    async modelCatalog() {
      return {
        groups: [{
          id: 'deepseek',
          models: [
            {
              id: 'deepseek-v4.1-flash',
              name: 'V4.1 Flash',
              reasoning: {
                efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'Deeper' }],
                defaultEffort: 'high',
              },
            },
            { id: 'plain-model', name: 'Plain model' },
          ],
        }],
        default: { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
      }
    },
  },
  agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }),
  },
  workspaceChanges: {
    summary(sessionId, seq) {
      if (sessionId !== 's1' || seq !== 42) return undefined
      return {
        turn: 3,
        cwd: 'C:\\secret\\repo',
        total: 1,
        added: 5,
        deleted: 2,
        files: [{ path: 'C:\\secret\\repo\\src\\a.ts', display: 'src/a.ts', added: 5, deleted: 2 }],
      }
    },
    async diff(sessionId, seq, index) {
      if (sessionId !== 's1' || seq !== 42 || index !== 0) return undefined
      return {
        kind: 'text',
        path: 'C:\\secret\\repo\\src\\a.ts',
        display: 'src/a.ts',
        coarse: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' ctx', '+new'] }],
      }
    },
  },
  commands: {
    list() {
      return [
        { name: 'compact', description: 'Compact older conversation history', input: {} },
        { name: 'danger', description: 'A root-plane command the phone may run', input: {} },
        { name: 'goal', description: 'Set or view the goal', input: { hint: '[<objective>|clear]' } },
        { name: 'export', description: 'Desktop-only download', input: {} },
        {
          name: 'permission',
          description: 'Switch the permission preset',
          definitionId: '@deepseek-ai/dsh-permission-presets',
          input: { hint: '<preset>' },
        },
        {
          // Shadow/alias protection: the same first-party definition under another name.
          name: 'sandbox',
          description: 'Alias for the permission preset switch',
          definitionId: '@deepseek-ai/dsh-permission-presets',
          input: { hint: '<preset>' },
        },
      ]
    },
    async execute(_agent, line) {
      executed.push(line)
      return { commandId: 'cmd-1', result: { kind: 'success', text: 'ok' } }
    },
  },
  workspaceRegistry: {
    pinnedSessionIds: ['s1'],
    archivedSessionIds: [],
    list() {
      return [{ id: 'ws-1', title: 'Personal Agent', path: 'C:\\secret\\repo', sessionIds: ['s1'] }]
    },
  },
}

const ctx = { get: (name) => services[name], on: () => () => {} }
const bridge = createBridge(ctx, { log })
try {
  const context = await bridge.contextFor('s1')
  assert.equal(context.ok, true)
  assert.equal(context.usedTokens, 1200, 'context meter must prefer projectedTokens')
  assert.equal(context.pressureTokens, 900)
  assert.equal(context.contextWindow, 8000)
  assert.equal(context.basis, 'usage')
  assert.equal(context.tokenUsage.totalTokens, 660)

  const changes = await bridge.changesList('s1')
  assert.equal(changes.ok, true)
  assert.equal(changes.items.length, 1)
  const entry = changes.items[0]
  assert.equal(entry.seq, 42)
  assert.equal(entry.available, true)
  assert.equal(entry.files.length, 1)
  assert.equal(entry.files[0].path, 'src/a.ts', 'cwd must be stripped from the file path')
  assert.ok(!JSON.stringify(changes).includes('secret'), 'changed files must not leak the session directory')
  assert.equal(entry.files[0].index, 0)

  const diff = await bridge.changesDiff('s1', 42, 0)
  assert.equal(diff.ok, true)
  assert.equal(diff.kind, 'text')
  assert.equal(diff.path, 'src/a.ts')
  assert.deepEqual(diff.hunks[0].lines, [' ctx', '+new'])

  const gone = await bridge.changesDiff('s1', 99, 0)
  assert.equal(gone.ok, false)
  assert.equal(gone.errorCode, 'unavailable', 'a forgotten change must be unavailable, not internal')

  const commands = await bridge.listCommands('s1')
  assert.equal(commands.ok, true)
  assert.equal(commands.available, true)
  assert.deepEqual(
    commands.items.map((item) => item.name),
    ['compact', 'danger', 'goal'],
    'the phone must receive benign Host commands and neither export nor the policy-changing permission command',
  )
  const goal = commands.items.find((item) => item.name === 'goal')
  assert.equal(goal.hint, '[<objective>|clear]', 'argument hints must reach the phone')

  const unknown = await bridge.executeCommand('s1', '/nope')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.errorCode, 'forbidden', 'an unknown command must be forbidden')
  const hidden = await bridge.executeCommand('s1', '/export')
  assert.equal(hidden.ok, false)
  assert.equal(hidden.errorCode, 'forbidden', 'the desktop-only export must stay forbidden')
  const policy = await bridge.executeCommand('s1', '/permission danger-full-access')
  assert.equal(policy.ok, false)
  assert.equal(policy.errorCode, 'forbidden', 'sandbox policy must never change from the phone')
  const alias = await bridge.executeCommand('s1', '/sandbox danger-full-access')
  assert.equal(alias.ok, false)
  assert.equal(alias.errorCode, 'forbidden', 'a renamed permission command must stay forbidden')
  assert.deepEqual(executed, [], 'the Host must not execute a refused command')

  const ran = await bridge.executeCommand('s1', '/compact')
  assert.equal(ran.ok, true)
  assert.equal(ran.name, 'compact')
  assert.equal(ran.kind, 'success')
  assert.deepEqual(executed, ['/compact'])

  const withArgs = await bridge.executeCommand('s1', '/goal ship the release')
  assert.equal(withArgs.ok, true)
  assert.equal(withArgs.name, 'goal')
  assert.deepEqual(executed, ['/compact', '/goal ship the release'], 'arguments must reach the Host command line')

  const cold = await bridge.listCommands('cold')
  assert.equal(cold.ok, true)
  assert.equal(cold.available, false, 'a cold session must not list commands')
  assert.equal(cold.reason, 'not-live')

  const models = await bridge.listModels()
  const flash = models.catalog.find((entry) => entry.model === 'deepseek-v4.1-flash')
  const plain = models.catalog.find((entry) => entry.model === 'plain-model')
  assert.ok(flash.reasoning, 'models with reasoning must advertise their efforts')
  assert.deepEqual(flash.reasoning.efforts.map((effort) => effort.id), ['low', 'high'])
  assert.equal(flash.reasoning.defaultEffort, 'high')
  assert.equal(flash.reasoning.efforts[1].description, 'Deeper')
  assert.equal(plain.reasoning, undefined, 'models without a reasoning control must omit it')
  assert.equal(models.current.reasoningEffort, 'high', 'the current selection must expose its effort')

  const sessionModels = await bridge.listSessions()
  assert.equal(sessionModels[0].model.reasoningEffort, 'low', 'session model rows must carry the current reasoning effort')

  const workspaces = await bridge.listWorkspaces()
  assert.deepEqual(
    workspaces.map((workspace) => [workspace.id, workspace.title]),
    [['ws-1', 'Personal Agent']],
    'project workspaces must be exposed in registry order',
  )
  assert.deepEqual(workspaces[0].sessionIds, ['s1'])
  assert.equal(sessionModels[0].workspaceId, 'ws-1', 'a session row must name its owning project')
  assert.equal(sessionModels[0].pinned, true)

  console.log('PASS bridge context/changes/commands checks')
} finally {
  bridge.dispose?.()
}







