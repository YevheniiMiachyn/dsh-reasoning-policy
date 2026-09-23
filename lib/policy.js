/**
 * Pure decision logic for the DSH reasoning policy.
 *
 * Kept free of any Cordis or DSH import so it can be unit-tested directly.
 *
 * WHY THE SHAPE OF THIS POLICY IS WHAT IT IS (all measured on this machine,
 * llama.cpp b11115 + Qwen3.8-27B-UD-IQ3_XXS + Unsloth Studio):
 *
 *  - The chat template writes the "Reasoning effort is set to ..." sentence as
 *    the FIRST content of the system message whenever thinking is on and the
 *    effort is low or xhigh. A medium prompt omits that sentence, and so does a
 *    thinking-off prompt. Two consequences:
 *      * `low` and `xhigh` each carry a DIFFERENT system prefix, so switching
 *        to or from either one forces llama-server to re-evaluate the whole
 *        ~12.2k-token agent prefix: measured 18.8-19.0 s at 644 tok/s.
 *      * `medium` and thinking-off share one prefix and differ only in the
 *        generation prompt's tail, so switching between THEM costs 2-6 tokens
 *        (measured, both directions, cache_n stayed 12,206-12,208).
 *  - Therefore the per-turn fast/thinking toggle must be `off` <-> `medium`.
 *    That pair is what makes an adaptive policy affordable at all.
 *  - Thinking-off does not damage tool calling here: 4/4 tool-dispatch replays
 *    produced a well-formed `pwsh` call with parseable arguments and zero
 *    reasoning tokens, at 647 ms to the first tool-call frame against 3,451 ms
 *    with thinking on.
 *
 * @module dsh-reasoning-policy/policy
 */

/** Effort meaning "do not think": the wire spelling that shares the medium prefix. */
export const EFFORT_FAST = 'off'
/** Effort used for ordinary thinking: shares its prefix with {@link EFFORT_FAST}. */
export const EFFORT_NORMAL = 'medium'
/** Effort for an explicitly deep request: a different prefix, so it is opt-in only. */
export const EFFORT_DEEP = 'xhigh'

/**
 * Phrases where the user is asking for reasoning ITSELF, rather than for a task
 * to be carried out. These are the only prompts promoted to the deep level,
 * because deep carries a different prompt prefix and so costs a full re-prefill
 * (measured 18.8-19.0 s for the ~12.2k-token agent prefix).
 */
const EXPLICIT_PATTERNS = [
  /\bthink (carefully|hard|harder|deeply|it through|through)\b/i,
  /\breason (carefully|through|about|it)\b/i,
  /\bstep[- ]by[- ]step\b/i,
  /\bwalk me through\b/i,
  /\bprove\b|\bderive\b|\bformal(ly)? (reason|verif)/i,
  /\bexplain (in detail|deeply|thoroughly)\b/i,
  /\btake your time\b|\bno rush\b/i,
]

/**
 * Phrases naming a reasoning-shaped TASK. These earn the normal level, which
 * shares its prompt prefix with the fast level, so switching into it is free.
 *
 * Measured reason for the split (concrete ABBA-deadlock scenario, same
 * question): the normal level produced 4,043 characters of reasoning and a
 * correct one-step answer; the deep level produced 6,289 for the same question
 * at 1.5x the wall time. Normal is already real reasoning — deep is the opt-in
 * extra, so it is reserved for a user who asks for it.
 */
const TASK_PATTERNS = [
  /\b(root cause|race condition|deadlock|post-?mortem|rca)\b/i,
  /\bdebug|diagnos|troubleshoot|bisect\b/i,
  /\banaly[sz]e|analysis\b/i,
  /\bdesign (a|an|the)\b/i,
  /\bmigrat(e|ion|ing)\b/i,
  /\barchitect(ure|ural)?\b/i,
  /\bcompare\b|\bcontrast\b|\btrade-?offs?\b/i,
  /\boptimi[sz]e|performance tuning|profil(e|ing)\b/i,
  /\brefactor\b/i,
  /\bstrateg(y|ies|ic)\b/i,
  /\bwhy (does|do|is|are|did|would)\b/i,
  /\bwhat would happen if\b/i,
]

/** A single user message longer than this is treated as a task, not chat. */
const COMPLEX_CHARS = 420

/** A short conversational or lookup message is never a reasoning task. */
const SIMPLE_CHARS = 200

/**
 * Extract the newest human-authored text from an assembled step.
 *
 * Only `source.kind === 'user'` counts: runtime-context snapshots, skill
 * catalogs, notices and tool results are all user-role messages on the wire but
 * none of them is the question being classified.
 *
 * @param messages - the assembled message list for one step.
 * @returns the latest human text, or undefined when this step adds none.
 */
export function latestUserText(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    if (message?.source?.kind !== 'user') continue
    const content = Array.isArray(message.content) ? message.content : []
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return undefined
}

/**
 * Classify one user turn.
 *
 * @param text - the human message text.
 * @returns `explicit` when the user asked for reasoning itself, `task` when the
 *          message names a reasoning-shaped task or is too large to be
 *          conversational, otherwise `simple`.
 */
export function classifyTurn(text) {
  const value = typeof text === 'string' ? text : ''
  if (EXPLICIT_PATTERNS.some((pattern) => pattern.test(value))) return 'explicit'
  if (TASK_PATTERNS.some((pattern) => pattern.test(value))) return 'task'
  if (value.length > COMPLEX_CHARS) return 'task'
  if (value.length <= SIMPLE_CHARS) return 'simple'
  return 'task'
}

/**
 * Choose the reasoning effort for one request.
 *
 * THE SUBTLE PART: a chosen effort is not per-turn state. The agent loop seeds
 * the next request from the session's own last `request/header`
 * (`prepareRequest`: `this.options.reasoningEffort ?? persistedReasoningEffort`),
 * so whatever this policy writes comes back as the seed of the NEXT turn. An
 * earlier version treated any seed that differed from the default as an explicit
 * user choice, which meant that after the first fast turn every later turn
 * seeded `off` and the policy could never escalate again — it had mistaken its
 * own output for the user's.
 *
 * `policyWrote` is therefore the plugin's memory of what it last returned for
 * this agent. A seed equal to it is ours and may be re-decided; a seed that is
 * neither ours nor the configured default can only have come from an explicit
 * per-session or composer selection, and is returned untouched.
 *
 * @param options - the decision inputs.
 * @param options.seedEffort - the effort the request would use without this policy.
 * @param options.defaultEffort - the session default that `seedEffort` equals when nobody chose.
 * @param options.policyWrote - the effort this plugin last returned for this agent, if any.
 * @param options.text - the current turn's human text, if known.
 * @param options.levels - the effort each tier maps to, so configuration (not code) decides it.
 * @returns the effort to request plus a machine-readable reason for logging.
 */
export function decideEffort({ seedEffort, defaultEffort, policyWrote, text, levels }) {
  const tiers = {
    fast: levels?.fast ?? EFFORT_FAST,
    normal: levels?.normal ?? EFFORT_NORMAL,
    deep: levels?.deep ?? EFFORT_DEEP,
  }
  if (seedEffort === undefined || defaultEffort === undefined) {
    // Without both halves an explicit choice cannot be told from a default one,
    // so decline to change anything rather than guess.
    return { effort: seedEffort, reason: 'seed-unknown', klass: null }
  }
  const seedIsOurs = seedEffort === policyWrote
    || (policyWrote === undefined && seedEffort === defaultEffort)
  if (!seedIsOurs) {
    return { effort: seedEffort, reason: 'user-explicit', klass: null }
  }
  const klass = classifyTurn(text)
  if (klass === 'explicit') return { effort: tiers.deep, reason: 'explicit-deep', klass }
  if (klass === 'task') return { effort: tiers.normal, reason: 'complex-task', klass }
  return { effort: tiers.fast, reason: 'simple-default', klass }
}
