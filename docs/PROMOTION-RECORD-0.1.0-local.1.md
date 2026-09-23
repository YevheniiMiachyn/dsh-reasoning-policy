# Promotion record — dsh-reasoning-policy 0.1.0-local.1

**Stage:** reasoning-policy
**Date:** 2026-09-23
**Status:** PROMOTED and validated in production.

**Operator:** a cloud development/operator model. The local model under test was
used **only as the runtime being measured** — every number below was served by a
local `unsloth/Qwen3.8-27B-GGUF` route on `127.0.0.1:8888`. No cloud request was
made as part of the measurements.

> This is the sanitized public copy of the internal stage record. Session
> identifiers, absolute machine paths, production config hashes tied to one
> machine, and captured prompt bodies have been removed or generalized; the
> architecture, measurements, wire formats, prefix findings, test counts and
> limitations are unchanged.

---

## 1. What changed

Two configuration files and one new local package. Nothing else.

| file | change |
|---|---|
| production profile settings document | `agent-default-model.reasoningEffort` `low` → `medium`; the model's `reasoningEfforts` map gained `off: none` |
| production profile Cordis patch (`<DSH_HOME>/profiles/web/cordis.patch.yml`) | mounts the new plugin by absolute path |
| `<local-packages>/dsh-reasoning-policy/` | new local package (no registry install, no `node_modules` patch) |

Verified by diff against pre-stage backups: the only value changes are those two,
and the `memory` and `dsh-tts` configuration blocks are **byte-identical** to the
backup. The voice plugin, the speech-to-text launcher, the TTS settings and the
tool schemas were not touched at all.

Promoted artifact sizes (source files, unchanged by release housekeeping):

| file | bytes |
|---|---|
| `package.json` | 835 |
| `lib/index.js` | 5047 |
| `lib/policy.js` | 7847 |
| `test/policy.test.mjs` | 6374 |
| `test/plugin.test.mjs` | 4881 |

Package version: `dsh-reasoning-policy@0.1.0-local.1`.
Plugin id `reasoning-policy`, mounted as `provider: unsloth`,
`defaultEffort: medium`, `fastEffort: off`, `deepEffort: xhigh`, `debug: false`.

Two file hashes are the ones that matter for rollback, because they are the two
files that define runtime behaviour and they are identical to the promoted state:

```
3AB8BC8FFEEB70009DF7B4917F4FEED3E9C7952816BE955CB474E4BD2B3AE3CA   5047  lib/index.js
58109DD7E74D12A82080BA31B55D25A5ED2CB10E5163C2EF1227D116F2296814   7847  lib/policy.js
```

## 2. Why this shape (measured, not assumed)

The chat template writes its *"Reasoning effort is set to …"* sentence as the
first content of the system message, so the prompt prefix depends on the effort.
Measured on the real ~12.2k-token agent prompt with 31 tools:

| knob | prefix shared with `low` | switch cost |
|---|---|---|
| `low` (previous default) | 100% | — |
| `medium` | 3 tokens from `low`, but **100% from `off`** | 2–6 tokens from `off` |
| `xhigh` | 9 tokens | re-prefill 14,404 tok / 26.8 s |
| `enable_thinking=false` | 3 tokens | re-prefill ~12.2k tok / ~19 s |
| `reasoning_budget_tokens` | **100%** | free — but the serving front-end drops the field |

`off` and `medium` are therefore the pair worth toggling, and `xhigh` is reserved
for a user who explicitly asks for reasoning. This is also why the session default
had to move from `low` to `medium`: `low` carries its own prefix and would pay a
full re-prefill on every fast/normal toggle.

### Why the budget field was not used

A top-level `reasoning_budget_tokens` (and its alias `thinking_budget_tokens`) is
the cache-neutral way to cap hidden reasoning, and it works against the inference
server directly. It was rejected for production because the serving front-end in
front of the server accepts only a narrow request schema and **silently drops
budget fields** — a request with `budget = 0` still produced 233 characters of
reasoning content. Fixing that would have meant bypassing the front-end's
launcher and port discovery, which was out of scope. The effort pair was chosen
instead because it is observable end-to-end and costs nothing to toggle.

## 3. Rollback

**One line for the setting half** (restores `reasoningEffort: low` and removes
`off` from the offered levels; requests then behave exactly as before the stage):

```powershell
Copy-Item <settings-document>.bak-<timestamp>-before-reasoning-policy `
          <settings-document> -Force
```

**Full removal:** also delete the `reasoning-policy` row from the profile's
`cordis.patch.yml` (a timestamped backup was taken first) and restart DSH. The
package directory can be left in place; nothing else references it.

**Bypass without a restart:** the plugin is inert for any provider other than the
configured one, so pointing a session at a different provider bypasses it
entirely.

## 4. Production validation

Wire captured from the real DSH request path (a logging reverse proxy in front of
the local endpoint, since removed):

| tier | wire `reasoning_effort` |
|---|---|
| fast | `none` |
| normal | `medium` |
| deep | `xhigh` |

The `off` → `medium` switch in production showed `cache_n = 12,225`,
`prompt_n = 32`, `prompt_ms = 431` — i.e. the everyday switch is free, not a
re-prefill. The `off` → `xhigh` switch re-prefilled 14,404 tokens in 26.8 s,
confirming why deep is opt-in.

Fast tier, real production request body, 20,720-token prompt, 8 repetitions
through `curl.exe`: **first visible text median 423 ms** (min 397, max 454),
0/8 stalls, `reasonCh = 0`.

Tool turn at the fast tier: first tool-call frame **2.95 s**, tool executed in
0.8 s, complete answer at **5.18 s**, correct result, cache fully reused.

Cold-prefix reference for scale: 12,236 tokens pre-filled in 18,911 ms
(644 tok/s), which is the cost a prefix-family switch incurs.

### Thinking-off did not degrade tool calling

Holding a tool scenario fixed and varying only the effort: 4/4 replays with
thinking off produced a well-formed tool call with parseable arguments and zero
reasoning tokens, reaching the first tool-call frame in **647 ms** against
**3,451 ms** with thinking on. In production, 2/2 tool calls under the fast tier
were correct.

### Reasoning level was not the cause of an observed tool rampage

A vague request with nothing attached sent the agent through 11 steps and 10 tool
calls (267 s). Holding the scenario fixed and varying **only** the effort showed
this is request-driven, not effort-driven: the same concrete scenario answered in
one step at the normal tier and in one step at the deep tier. The deep tier does
produce more reasoning (6,289 vs 4,043 characters on that question) but did not
cause the search.

## 5. Tests at promotion

18/18 passing under `node --test` (Node 22): 11 policy tests (pure decision logic,
classification, user-override preservation, the re-escalation regression) and 7
plugin tests (real `apply()` and both real handlers against a fake Cordis
context).

A regression test specifically pins the failure mode that was found and fixed
during the stage: because a chosen effort is persisted into the session's own
request header, an earlier version read its own output back as the user's choice
and permanently disabled escalation after the first fast turn.

## 6. Known limitations, reported not fixed

Both were observed during the stage and **neither is caused by this plugin**.

1. **Single-slot background inference contention.** The local server runs with
   `--parallel 1`. One observed interactive turn took 165 s of wall time while its
   own two requests cost only 6.2 s and 2.0 s of server time; the rest was queued
   behind other generations of 12,397 and 3,180 tokens.
2. **Intermittent Node `fetch`/undici streaming delay.** Node's `fetch`/undici
   intermittently held a streamed response for a flat ~5.0 s (~35% of requests)
   while `curl.exe` issuing the identical request never did. The server and the
   model were exonerated by that comparison; the root cause was not established.

## 7. One misdiagnosis, recorded

The ~5 s streaming delay was initially attributed to the serving front-end's KV
admission queue, and launcher environment variables were changed on the strength
of that hypothesis. The hypothesis was later **disproven** (the `curl.exe` /
Node comparison above), and the launcher script and environment were restored
byte-identically to their pre-stage state rather than leaving an unproven change
in production. Recorded here so the same hypothesis is not re-run.

## 8. Release housekeeping (post-promotion)

Performed after promotion and after the measurements above. **Documentation only —
no runtime source or test file changed.**

* added `README.md` rewrite, `LICENSE`, `.gitignore`, `RELEASE-NOTES-…`
* added this file under `docs/`
* `package.json` gained `repository` / `homepage` / `bugs` / `keywords` metadata and
  a wider `files` list; `name`, `version`, `main`, `exports`, `scripts` and all
  runtime fields are unchanged

Post-housekeeping hashes of the two behavioural files are still the ones quoted in
section 1, and the test suite still reports 18/18.
