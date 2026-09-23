/**
 * Integration test for the plugin's wiring, without DSH.
 *
 * A fake Cordis context captures the two registered listeners, so the real
 * `apply()` and the real handlers run — only the surrounding harness is fake.
 * This is what proves the behaviour DSH will see on restart.
 *
 *   node --test test/plugin.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject } from '../lib/index.js'

/** Build a fake ctx and return its registered listeners. */
function harness(config = {}) {
  const handlers = new Map()
  const ctx = { on: (event, fn) => { handlers.set(event, fn) }, logger: { info: () => {} } }
  apply(ctx, { provider: 'unsloth', defaultEffort: 'medium', debug: false, ...config })
  return handlers
}

/** A resolved LlmCallConfig as the seed the agent loop would offer. */
const seed = (reasoningEffort, extra = {}) => () => Promise.resolve({
  provider: 'unsloth',
  model: 'unsloth/Qwen3.8-27B-GGUF',
  reasoningEffort,
  ...extra,
})

/** Drive one agent/pre-step with a human message. */
async function say(handlers, agent, text, step = 1) {
  await handlers.get('agent/pre-step')({ agent, step }, async () => ({
    kind: 'enter',
    messages: [
      { role: 'user', source: { kind: 'plugin', plugin: 'dsh-system-prompt' }, content: [{ type: 'text', text: 'runtime context' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    ],
  }))
}

/** Drive one agent/request and return the resulting config. */
function request(handlers, agent, effort, turn = 1, step = 1) {
  return handlers.get('agent/request').call({}, { agent, turn, step }, seed(effort))
}

test('exports a mountable Cordis plugin', () => {
  assert.equal(name, 'akeno-reasoning-policy')
  assert.deepEqual(inject, [])
})

test('all three tiers are reachable turn by turn, though each turn seeds the next', async () => {
  const handlers = harness()
  const agent = {}

  // 1. Greeting -> fast tier.
  await say(handlers, agent, 'Hi.')
  const fast = await request(handlers, agent, 'medium')
  assert.equal(fast.reasoningEffort, 'off', 'a greeting must not think')

  // 2. A reasoning-shaped task, seeded by our own `off` -> normal tier.
  //    Normal shares the fast prompt prefix, so this switch is effectively free.
  await say(handlers, agent, 'Debug this race condition.')
  const task = await request(handlers, agent, fast.reasoningEffort)
  assert.equal(task.reasoningEffort, 'medium', 'a reasoning-shaped task must think')

  // 3. An explicit request for reasoning, seeded by our own `medium` -> deep tier.
  await say(handlers, agent, 'Think carefully about this race condition.')
  const deep = await request(handlers, agent, task.reasoningEffort)
  assert.equal(deep.reasoningEffort, 'xhigh', 'an explicit reasoning request must escalate')

  // 4. ...and a following simple turn comes back down.
  await say(handlers, agent, "What's my PC GPU?")
  const again = await request(handlers, agent, deep.reasoningEffort)
  assert.equal(again.reasoningEffort, 'off')
})

test('a long task message keeps ordinary thinking rather than the fast path', async () => {
  const handlers = harness()
  const agent = {}
  await say(handlers, agent, 'y'.repeat(600))
  assert.equal((await request(handlers, agent, 'medium')).reasoningEffort, 'medium')
})

test('an untouched seed equal to the default is classified, a foreign one is not', async () => {
  const handlers = harness()
  const agent = {}
  await say(handlers, agent, 'Hi.')
  // `low` is a level this policy never writes, so it must be left alone.
  assert.equal((await request(handlers, agent, 'low')).reasoningEffort, 'low')
})

test('a cloud provider is passed through untouched', async () => {
  const handlers = harness()
  const agent = {}
  await say(handlers, agent, 'Debug this race condition.')
  const resolved = await handlers.get('agent/request').call({}, { agent, turn: 1, step: 1 }, () => Promise.resolve({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  }))
  assert.equal(resolved.provider, 'deepseek-official')
  assert.equal(resolved.reasoningEffort, 'high', 'the policy must never re-price a cloud route')
})

test('a request with no classified turn is left exactly as seeded', async () => {
  const handlers = harness()
  assert.equal((await request(handlers, {}, 'medium')).reasoningEffort, 'medium')
})

test('other config keys on the resolved config survive the rewrite', async () => {
  const handlers = harness()
  const agent = {}
  await say(handlers, agent, 'Hi.')
  const resolved = await handlers.get('agent/request').call({}, { agent, turn: 1, step: 1 },
    seed('medium', { maxTokens: 16384, temperature: 0.7 }))
  assert.equal(resolved.maxTokens, 16384)
  assert.equal(resolved.temperature, 0.7)
  assert.equal(resolved.reasoningEffort, 'off')
})
