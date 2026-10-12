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
  const lines = []
  const ctx = { on: (event, fn) => { handlers.set(event, fn) }, logger: { info: (line) => { lines.push(line) } } }
  apply(ctx, { provider: 'unsloth', debug: true, ...config })
  handlers.lines = lines
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
  assert.equal(name, 'reasoning-policy')
  assert.deepEqual(inject, [])
})

test('auto reaches all three tiers turn by turn, and DSH re-offers auto every turn', async () => {
  const handlers = harness()
  const agent = {}

  // DSH's model selection applies the picker's level to every request, so each turn is offered `auto` again.
  await say(handlers, agent, 'Hi.')
  assert.equal((await request(handlers, agent, 'auto')).reasoningEffort, 'off', 'a greeting must not think')

  await say(handlers, agent, 'Debug this race condition.')
  assert.equal((await request(handlers, agent, 'auto')).reasoningEffort, 'medium', 'a reasoning-shaped task must think')

  await say(handlers, agent, 'Think carefully about this race condition.')
  assert.equal((await request(handlers, agent, 'auto')).reasoningEffort, 'xhigh', 'an explicit reasoning request must escalate')

  await say(handlers, agent, "What's my PC GPU?")
  assert.equal((await request(handlers, agent, 'auto')).reasoningEffort, 'off')
})

test('a long task message keeps ordinary thinking rather than the fast path', async () => {
  const handlers = harness()
  const agent = {}
  await say(handlers, agent, 'y'.repeat(600))
  assert.equal((await request(handlers, agent, 'auto')).reasoningEffort, 'medium')
})

test('every selected level survives every kind of turn untouched', async () => {
  const handlers = harness()
  const turns = ['Hi.', "What's my PC GPU?", 'Debug this race condition.', 'Think carefully about this.']
  for (const level of ['off', 'low', 'medium', 'high', 'xhigh']) {
    const agent = {}
    for (const text of turns) {
      await say(handlers, agent, text)
      const resolved = await request(handlers, agent, level)
      assert.equal(resolved.reasoningEffort, level, `${level} was rewritten for ${JSON.stringify(text)}`)
    }
  }
})

test('a profile default of low is a selection, and is respected rather than treated as inert or as adaptive', async () => {
  const handlers = harness()
  const agent = {}
  await say(handlers, agent, 'Hi.')
  const resolved = await request(handlers, agent, 'low')
  assert.equal(resolved.reasoningEffort, 'low')
  assert.ok(handlers.lines.some((line) => line.includes('reason=explicit-respected')), 'the log must say the level was respected')
})

test('the policy has no memory: a restart cannot change what a selection means', async () => {
  const first = harness()
  const agent = {}
  await say(first, agent, 'Hi.')
  assert.equal((await request(first, agent, 'auto')).reasoningEffort, 'off')
  // A fresh plugin instance (a restart) offered the persisted `off` treats it as the selection it is.
  const second = harness()
  await say(second, agent, 'Think carefully about this.')
  assert.equal((await request(second, agent, 'off')).reasoningEffort, 'off')
  assert.equal((await request(second, agent, 'auto')).reasoningEffort, 'xhigh')
})

test('the saved preference is never written: the policy only returns a config', async () => {
  const handlers = harness()
  const agent = {}
  await say(handlers, agent, 'Hi.')
  const offered = Object.freeze({ provider: 'unsloth', model: 'm', reasoningEffort: 'auto' })
  const resolved = await handlers.get('agent/request').call({}, { agent, turn: 1, step: 1 }, () => Promise.resolve(offered))
  assert.equal(offered.reasoningEffort, 'auto', 'the offered config object must not be mutated')
  assert.equal(resolved.reasoningEffort, 'off')
})

test('a cloud provider is passed through untouched', async () => {
  const handlers = harness()
  const agent = {}
  await say(handlers, agent, 'Debug this race condition.')
  const resolved = await handlers.get('agent/request').call({}, { agent, turn: 1, step: 1 }, () => Promise.resolve({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'auto',
  }))
  assert.equal(resolved.provider, 'deepseek-official')
  assert.equal(resolved.reasoningEffort, 'auto', 'the policy must never re-price a cloud route')
})

test('auto with no classified turn asks for ordinary thinking, never a guessed tier', async () => {
  const handlers = harness()
  assert.equal((await request(handlers, {}, 'auto')).reasoningEffort, 'medium')
})

test('a selected level with no classified turn is left exactly as seeded', async () => {
  const handlers = harness()
  assert.equal((await request(handlers, {}, 'low')).reasoningEffort, 'low')
  assert.equal((await request(handlers, {}, undefined)).reasoningEffort, undefined)
})

test('other config keys on the resolved config survive the rewrite', async () => {
  const handlers = harness()
  const agent = {}
  await say(handlers, agent, 'Hi.')
  const resolved = await handlers.get('agent/request').call({}, { agent, turn: 1, step: 1 },
    seed('auto', { maxTokens: 16384, temperature: 0.7 }))
  assert.equal(resolved.maxTokens, 16384)
  assert.equal(resolved.temperature, 0.7)
  assert.equal(resolved.reasoningEffort, 'off')
})

test('the legacy defaultEffort key still names the normal tier', async () => {
  const handlers = harness({ defaultEffort: 'medium' })
  const agent = {}
  await say(handlers, agent, 'Debug this race condition.')
  assert.equal((await request(handlers, agent, 'auto')).reasoningEffort, 'medium')
})
