/**
 * Unit tests for the pure reasoning policy.
 *
 *   node --test test/policy.test.mjs
 *
 * These pin the properties the stage depends on: a level somebody selected is never
 * rewritten (whatever it is called, and whether or not the reply will be spoken), only a
 * request with NO selected level adapts, and only genuinely reasoning-shaped turns escalate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyTurn,
  decideEffort,
  latestUserText,
  EFFORT_DEEP,
  EFFORT_FAST,
  EFFORT_NORMAL,
} from '../lib/policy.js'

test('latestUserText reads only human-authored messages', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', source: { kind: 'plugin', plugin: 'dsh-system-prompt' }, content: [{ type: 'text', text: 'runtime context' }] },
    { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'catalog' }] },
    { role: 'user', source: { kind: 'user', rpcId: 'x' }, content: [{ type: 'text', text: "What's my PC GPU?" }] },
  ]
  assert.equal(latestUserText(messages), "What's my PC GPU?")
})

test('latestUserText returns undefined when a step adds no human message', () => {
  assert.equal(latestUserText([
    { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'context' }] },
  ]), undefined)
  assert.equal(latestUserText(undefined), undefined)
})

test('greetings and lookups classify simple', () => {
  for (const text of ['Hi.', "What's my PC GPU?", 'Open the file.', 'Check whether this service is running.', 'Turn off the garage light.', 'How long should I cook this?']) {
    assert.equal(classifyTurn(text), 'simple', text)
  }
})

test('a request to reason classifies explicit (the only deep tier)', () => {
  for (const text of [
    'Think carefully about this implementation.',
    'Please reason through the failure modes here.',
    'Explain in detail how the cache invalidation works.',
    'Take your time and prove the invariant holds.',
    'Walk me through the tradeoffs step by step.',
  ]) {
    assert.equal(classifyTurn(text), 'explicit', text)
  }
})

test('a reasoning-shaped task classifies task, not explicit', () => {
  // These are the brief's own examples of work that needs real reasoning, and
  // measurement showed the normal level already answers them with ~4k characters
  // of thinking — the deep level is a separate, opt-in extra.
  for (const text of [
    'Debug this race condition.',
    'Analyze these logs and find the root cause.',
    'Compare these architectures.',
    'Design a migration strategy.',
    'Why does the connection pool exhaust itself under load?',
  ]) {
    assert.equal(classifyTurn(text), 'task', text)
  }
})

test('a long conversational message is a task, not chat', () => {
  assert.equal(classifyTurn('x'.repeat(500)), 'task')
})

test('the deep tier is reached only through levels config, and only when no level was selected', () => {
  const args = { seedEffort: undefined }
  assert.equal(decideEffort({ ...args, text: 'Think carefully about this.' }).effort, EFFORT_DEEP)
  // A task stays in the free-to-switch normal tier even when deep is configured.
  assert.equal(decideEffort({ ...args, text: 'Debug this race condition.' }).effort, EFFORT_NORMAL)
  // Re-tuned entirely by configuration.
  assert.equal(
    decideEffort({ ...args, text: 'Think carefully.', levels: { deep: 'medium' } }).effort,
    'medium',
  )
})

test('every selected level is respected, whatever the text says (never off for a spoken reply)', () => {
  // The regression this guards: a default of `low` read as an explicit choice used to leave the policy
  // inert, and a policy that classified `medium` could rewrite a user's Medium to Off. Now a selection is
  // a selection: Off, Low, Medium and High come back exactly as they went in, for every kind of turn.
  const turns = ['Hi.', "What's my PC GPU?", 'Debug this race condition.', 'Think carefully about this.', 'x'.repeat(500)]
  for (const seedEffort of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    for (const text of turns) {
      const decided = decideEffort({ seedEffort, text })
      assert.equal(decided.effort, seedEffort, `${seedEffort} was changed for ${JSON.stringify(text.slice(0, 20))}`)
      assert.equal(decided.reason, 'explicit-respected')
      assert.equal(decided.klass, null)
    }
  }
})

test('with no level selected the turn is routed by classification', () => {
  const base = { seedEffort: undefined }
  assert.equal(decideEffort({ ...base, text: 'Hi.' }).effort, EFFORT_FAST)
  assert.equal(decideEffort({ ...base, text: 'x'.repeat(500) }).effort, EFFORT_NORMAL)
  // A named reasoning task gets real thinking, but stays in the tier that shares
  // the fast prefix — only an explicit request for reasoning pays the switch.
  assert.equal(decideEffort({ ...base, text: 'Debug this race condition.' }).effort, EFFORT_NORMAL)
  assert.equal(decideEffort({ ...base, text: 'Think carefully about this.' }).effort, EFFORT_DEEP)
})

test('with no level selected and no classified turn nothing is guessed', () => {
  const none = decideEffort({ seedEffort: undefined, text: undefined })
  assert.equal(none.effort, undefined)
  assert.equal(none.reason, 'no-turn-text')
})

test('the decision never depends on persisted history', () => {
  // A seed that equals a tier this policy once wrote is just a selected level now: `off` stays `off`
  // for a deep request, because only a request with no selected level asks for adaptation.
  assert.equal(decideEffort({ seedEffort: EFFORT_FAST, text: 'Think carefully about this.' }).effort, EFFORT_FAST)
  assert.equal(decideEffort({ seedEffort: EFFORT_DEEP, text: 'Hi.' }).effort, EFFORT_DEEP)
})
