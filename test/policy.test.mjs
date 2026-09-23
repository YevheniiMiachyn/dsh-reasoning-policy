/**
 * Unit tests for the pure reasoning policy.
 *
 *   node --test test/policy.test.mjs
 *
 * These pin the two properties the stage depends on: an explicit user selection
 * is never rewritten, and only genuinely reasoning-shaped turns escalate.
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

test('the deep tier is reached only through levels config', () => {
  const args = { seedEffort: EFFORT_NORMAL, defaultEffort: EFFORT_NORMAL, policyWrote: undefined }
  assert.equal(decideEffort({ ...args, text: 'Think carefully about this.' }).effort, EFFORT_DEEP)
  // A task stays in the free-to-switch normal tier even when deep is configured.
  assert.equal(decideEffort({ ...args, text: 'Debug this race condition.' }).effort, EFFORT_NORMAL)
  // Re-tuned entirely by configuration.
  assert.equal(
    decideEffort({ ...args, text: 'Think carefully.', levels: { deep: 'medium' } }).effort,
    'medium',
  )
})

test('a long conversational message is a task, not chat', () => {
  assert.equal(classifyTurn('x'.repeat(500)), 'task')
})

test('decideEffort never rewrites a selection it did not make', () => {
  // Nothing written yet and a seed that is not the default: this can only be an
  // explicit choice (also the post-restart case), so it is left alone.
  assert.deepEqual(
    decideEffort({ seedEffort: EFFORT_DEEP, defaultEffort: EFFORT_NORMAL, policyWrote: undefined, text: 'Hi.' }),
    { effort: EFFORT_DEEP, reason: 'user-explicit', klass: null },
  )
  assert.deepEqual(
    decideEffort({ seedEffort: EFFORT_FAST, defaultEffort: EFFORT_NORMAL, policyWrote: undefined, text: 'Think carefully about this.' }),
    { effort: EFFORT_FAST, reason: 'user-explicit', klass: null },
  )
  // `low` is a level this policy never writes at all.
  assert.equal(
    decideEffort({ seedEffort: 'low', defaultEffort: EFFORT_NORMAL, policyWrote: EFFORT_FAST, text: 'Hi.' }).reason,
    'user-explicit',
  )
})

test('a seed this policy wrote is re-decided, not mistaken for the user', () => {
  // Regression: turn 1 wrote `off`; turn 2 then SEEDS `off` from the session's
  // own request header. That is our output, so a deep request must still
  // escalate instead of being frozen at the fast level forever.
  const decided = decideEffort({
    seedEffort: EFFORT_FAST,
    defaultEffort: EFFORT_NORMAL,
    policyWrote: EFFORT_FAST,
    text: 'Think carefully about this race condition.',
  })
  assert.equal(decided.effort, EFFORT_DEEP)
  assert.equal(decided.reason, 'explicit-deep')
  // ...and the next simple turn comes back down from the deep seed.
  assert.equal(
    decideEffort({ seedEffort: EFFORT_DEEP, defaultEffort: EFFORT_NORMAL, policyWrote: EFFORT_DEEP, text: 'Hi.' }).effort,
    EFFORT_FAST,
  )
})

test('decideEffort routes the default seed by classification', () => {
  const base = { defaultEffort: EFFORT_NORMAL, policyWrote: undefined }
  assert.equal(decideEffort({ ...base, seedEffort: EFFORT_NORMAL, text: 'Hi.' }).effort, EFFORT_FAST)
  assert.equal(decideEffort({ ...base, seedEffort: EFFORT_NORMAL, text: 'x'.repeat(500) }).effort, EFFORT_NORMAL)
  // A named reasoning task gets real thinking, but stays in the tier that shares
  // the fast prefix — only an explicit request for reasoning pays the switch.
  assert.equal(decideEffort({ ...base, seedEffort: EFFORT_NORMAL, text: 'Debug this race condition.' }).effort, EFFORT_NORMAL)
  assert.equal(decideEffort({ ...base, seedEffort: EFFORT_NORMAL, text: 'Think carefully about this.' }).effort, EFFORT_DEEP)
})

test('decideEffort declines when it cannot tell explicit from default', () => {
  const noDefault = decideEffort({ seedEffort: 'low', defaultEffort: undefined, policyWrote: undefined, text: 'Hi.' })
  assert.equal(noDefault.effort, 'low')
  assert.equal(noDefault.reason, 'seed-unknown')

  const noSeed = decideEffort({ seedEffort: undefined, defaultEffort: EFFORT_NORMAL, policyWrote: undefined, text: 'Think carefully.' })
  assert.equal(noSeed.effort, undefined)
  assert.equal(noSeed.reason, 'seed-unknown')
})
