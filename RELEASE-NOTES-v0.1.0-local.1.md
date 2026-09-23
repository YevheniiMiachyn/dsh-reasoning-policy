# Release notes — v0.1.0-local.1

**Package:** `dsh-reasoning-policy`
**Date:** 2026-09-23
**Status:** production-validated on a local deployment.

---

## Added

* **Adaptive fast / normal / deep reasoning policy** for DSH agent turns, mounted
  as a Cordis plugin from a profile patch. No registry install, no build step, no
  dependencies, no `node_modules` patch.
* **Request-scoped effort selection.** The plugin returns a value from the
  `agent/request` waterfall; it does not mutate the settings document, the global
  model selection, session history, tool schemas or `maxTokens`.
* **`off -> none` support for local reasoning models.** The fast tier maps to the
  wire spelling `reasoning_effort: "none"`, which selects thinking-off through the
  serving front-end's existing API.
* **Prefix-preserving tier pair.** `off` and `medium` share one prompt prefix, so
  alternating between the fast and normal tiers costs 2–6 tokens instead of a full
  ~12.2k-token re-prefill. The deep tier (`xhigh`) carries a different prefix and
  is therefore opt-in only.
* **User override preservation.** A seed that differs from the configured default
  is returned untouched, so a per-session or composer selection always wins, and a
  session still carrying an older effort keeps behaving as before.
* **Cloud-safety fence.** Only requests whose `provider` matches the configured
  value are re-priced; every other provider passes through byte for byte.
* **Opt-in debug logging** (`debug: true` or `DSH_REASONING_POLICY_DEBUG=1`), one
  line per request, no prompt content.
* **Tests** — 18 tests, no devDependencies, `npm test`.

## Performance

Measured on a local deployment: real agent prompt of **20,720 tokens**, 31 tools,
warm prefix, single 20 GB GPU.

| measurement | result |
|---|---|
| first visible text, fast tier | **median 423 ms** |
| across 8 production-shaped repetitions | **397–454 ms** |
| reasoning content at the fast tier | **0 characters** |
| 0 stalls across the run | 8/8 streamed cleanly |

Tool turn at the fast tier:

| measurement | result |
|---|---|
| first tool-call frame | **~2.95 s** |
| tool execution | **~0.8 s** |
| complete answer | **~5.18 s** |
| result correctness / cache reuse | correct, prefix fully reused |

Comparison against the previous configuration, same prompt, same server:

| configuration | request → first visible text |
|---|---|
| `reasoning_effort=low` with no cap (previous default) | **6,039 ms** |
| this release, fast tier | **423 ms** |

Everyday tier switch (`off` → `medium`) in production: `cache_n = 12,225`,
`prompt_n = 32`, `prompt_ms = 431` — i.e. free, not a re-prefill.

## Compatibility

Tested with:

* **`unsloth/Qwen3.8-27B-GGUF`** served by Unsloth Studio (llama.cpp b11115
  backend) over its local OpenAI-compatible API, with DSH provider id `unsloth`.

**No broader compatibility is claimed.** The measured prefix-sharing behaviour that
the fast/normal pair depends on is a property of a specific chat template, and the
deep tier's `xhigh` spelling must be offered by the model's
`reasoningEfforts` map. On a different model or template, verify the prefix
families before relying on the tier switch being cheap — the README explains which
pair to use and why. The cloud-safety fence and the user-override logic are
template-independent.

Requires Node 22+ for `node --test`.

## Known limitations

Neither of the following is caused by this plugin, and neither is fixed by it.

* **Single llama-server slot contention.** With `--parallel 1`, any background
  generation delays an interactive turn regardless of the chosen effort. One
  observed interactive turn took ~165 s of wall time while its own two requests
  consumed only ~6.2 s and ~2.0 s of server time; the remainder queued behind
  unrelated generations of ~12,397 and ~3,180 tokens.
* **Intermittent Node `fetch`/undici streaming delay.** ~35% of observed streamed
  requests issued from Node's `fetch`/undici showed a flat ~5.0 s delay, while
  `curl.exe` sending the identical request did not. Root cause was not established;
  it is a client-side observation outside this plugin's scope, but visible in
  production because DSH is a Node application.

See `docs/PROMOTION-RECORD-0.1.0-local.1.md` for the full stage evidence,
including the wire formats, the prefix-switch measurements and the one
misdiagnosis that was recorded and reverted.
