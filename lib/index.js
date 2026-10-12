/**
 * dsh-reasoning-policy — Cordis plugin entry.
 *
 * A request-scoped adaptive reasoning policy for the LOCAL model route. It
 * registers exactly two listeners and mutates nothing global:
 *
 *   `agent/pre-step`  observes the assembled step and remembers the current
 *                     turn's human text (and nothing else).
 *   `agent/request`   returns the same `LlmCallConfig` with `reasoningEffort`
 *                     chosen for this one request.
 *
 * It never touches the model default, the settings document, session history, or
 * any node_modules file; the returned config is the documented return value of
 * the `agent/request` waterfall, so the loop simply logs it as the request
 * header it already logs. Removing the plugin restores stock behaviour exactly.
 *
 * Only `config.provider` routes are affected, so a DeepSeek Cloud session is
 * never re-priced by this policy.
 *
 * @module dsh-reasoning-policy
 */

import { decideEffort, latestUserText, EFFORT_AUTO, EFFORT_DEEP, EFFORT_FAST, EFFORT_NORMAL } from './policy.js'

/** Stable loader/plugin id. */
export const name = 'reasoning-policy'

/**
 * Both hooks are dispatch events rather than services, so no service injection
 * is required and the plugin is unconditionally applicable.
 */
export const inject = []

/** Label one policy choice for the debug line. */
function policyLabel(effort, defaults) {
  if (effort === defaults.fastEffort) return 'fast'
  if (effort === defaults.deepEffort) return 'deep'
  return 'normal'
}

/**
 * Register the policy listeners.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - optional overrides for the shipped defaults.
 * @returns nothing.
 */
export function apply(ctx, config = {}) {
  const provider = config.provider ?? 'unsloth'
  // The level name that means "decide per turn". Any other level is a selection and is respected.
  const autoEffort = config.autoEffort ?? EFFORT_AUTO
  // `defaultEffort` is the pre-0.2 spelling of the normal tier; it no longer decides what is explicit.
  const normalEffort = config.normalEffort ?? config.defaultEffort ?? EFFORT_NORMAL
  const fastEffort = config.fastEffort ?? EFFORT_FAST
  const deepEffort = config.deepEffort ?? EFFORT_DEEP
  const debug = config.debug === true || process.env.DSH_REASONING_POLICY_DEBUG === '1'
  const defaults = { fastEffort, deepEffort }
  const log = (...args) => {
    if (!debug) return
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(...args)
    else console.log(...args)
  }

  /** Current turn's human text, per agent. A WeakMap keeps no session alive. */
  const turnText = new WeakMap()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision === null || typeof decision !== 'object') return decision
    if (decision.kind !== 'enter') return decision
    const agent = payload?.agent
    if (agent === undefined) return decision
    const text = latestUserText(decision.messages)
    // A later step of the same turn adds no new human message, so the previous
    // turn's text deliberately stays put: the whole turn shares one decision.
    if (text !== undefined) turnText.set(agent, text)
    return decision
  })

  ctx.on('agent/request', async function (payload, next) {
    const resolved = await next()
    if (resolved === null || typeof resolved !== 'object') return resolved
    if (resolved.provider !== provider) return resolved
    const agent = payload?.agent ?? this?.agent
    const text = agent === undefined ? undefined : turnText.get(agent)
    // A level that somebody selected is never touched, whatever the text is: say so in the log and return.
    if (resolved.reasoningEffort !== autoEffort) {
      log(`DSH REASONING turn=${payload?.turn ?? '?'} step=${payload?.step ?? '?'} policy=unchanged reason=${resolved.reasoningEffort === undefined ? 'seed-unknown' : 'explicit-respected'} wireThinking=${resolved.reasoningEffort ?? 'none'}`)
      return resolved
    }
    if (text === undefined) {
      // `auto` but no classified turn yet: ask for ordinary thinking rather than guess a tier.
      log(`DSH REASONING turn=${payload?.turn ?? '?'} step=${payload?.step ?? '?'} policy=normal reason=no-turn-text wireThinking=${normalEffort}`)
      return { ...resolved, reasoningEffort: normalEffort }
    }
    const decision = decideEffort({
      seedEffort: resolved.reasoningEffort,
      autoEffort,
      text,
      levels: { fast: fastEffort, normal: normalEffort, deep: deepEffort },
    })
    log(
      `DSH REASONING turn=${payload?.turn ?? '?'} step=${payload?.step ?? '?'} ` +
      `policy=${policyLabel(decision.effort, defaults)} reason=${decision.reason} ` +
      `class=${decision.klass ?? '-'} wireThinking=${decision.effort}`,
    )
    if (decision.effort === resolved.reasoningEffort) return resolved
    return { ...resolved, reasoningEffort: decision.effort }
  })

  log(`reasoning-policy active: provider=${provider} auto=${autoEffort} normal=${normalEffort} fast=${fastEffort} deep=${deepEffort}`)
}
