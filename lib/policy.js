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
 * EXPLICIT VERSUS INHERITED. Whether a level was chosen cannot be recovered by
 * comparing values: a profile default, a composer pick and this policy's own
 * earlier output can all be the same string, and two earlier versions of this
 * function guessed wrong in opposite directions (a default of `low` was read as
 * a user's choice and left the policy inert; a persisted `off` written by the
 * policy was read as a user's choice and froze the session). So the question is
 * not asked of the value at all. DSH already carries the distinction: a model
 * selection either names a level or names none (the picker's "provider default"),
 * and in the second case the request reaches this hook with NO effort:
 *
 *  - a seed that names a level (off, low, medium, high, xhigh, ...) -> somebody
 *    selected it: returned untouched, always, whatever the text is and whether
 *    or not the reply will be spoken.
 *  - no seed                                                        -> nobody
 *    selected a level, so adaptive reasoning is what was asked for: classify the
 *    turn and answer with the fast, normal or deep tier.
 *
 * The saved preference is never written. The plugin only ever answers one
 * request with one effort, and it only chooses when no level was chosen.
 *
 * @param options - the decision inputs.
 * @param options.seedEffort - the effort the request would use without this policy; undefined when none was selected.
 * @param options.text - the current turn's human text, if known.
 * @param options.levels - the effort each tier maps to, so configuration (not code) decides it.
 * @returns the effort to request plus a machine-readable reason for logging.
 */
export function decideEffort({ seedEffort, text, levels }) {
  const tiers = {
    fast: levels?.fast ?? EFFORT_FAST,
    normal: levels?.normal ?? EFFORT_NORMAL,
    deep: levels?.deep ?? EFFORT_DEEP,
  }
  if (seedEffort !== undefined) {
    return { effort: seedEffort, reason: 'explicit-respected', klass: null }
  }
  if (text === undefined) {
    // Nothing to classify yet: leave the request exactly as DSH proposed it.
    return { effort: undefined, reason: 'no-turn-text', klass: null }
  }
  const klass = classifyTurn(text)
  if (klass === 'explicit') return { effort: tiers.deep, reason: 'explicit-deep', klass }
  if (klass === 'task') return { effort: tiers.normal, reason: 'complex-task', klass }
  return { effort: tiers.fast, reason: 'simple-default', klass }
}
