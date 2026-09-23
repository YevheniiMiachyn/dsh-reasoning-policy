# dsh-akeno-reasoning-policy

A **request-scoped adaptive reasoning policy** for DeepSeek Harness (DSH) agent
turns on a **local** OpenAI-compatible reasoning model.

It makes ordinary turns answer immediately without taking reasoning away from
requests that need it, and it does so **without changing the prompt prefix**, so
the multi-thousand-token KV-cache prefix that the rest of the stack works hard to
keep resident is never invalidated.

Licence: MIT.

---

## 1. Purpose

The plugin listens to two DSH hooks and chooses the `reasoningEffort` for **one
request at a time**:

| hook | what it does |
|---|---|
| `agent/pre-step` | observes the assembled step and remembers the current turn's human text — nothing else |
| `agent/request` | returns the same `LlmCallConfig` with `reasoningEffort` picked for this request |

Everything else — the model default in the settings document, session history,
global model selection, tool schemas, `maxTokens` — is left exactly as DSH
resolved it.

### The problem it solves

On a warm prefix the prompt itself and the visible answer cost only a few hundred
milliseconds. The remaining seconds are **hidden reasoning tokens**: a reasoning
model writes a few hundred tokens of `thinking` before the first visible
character. Measured on a real agent prompt (~12.2k tokens, 31 tools) against a
local Qwen3.8-27B:

| | request → first visible text |
|---|---|
| `reasoning_effort=low`, no cap (previous default) | **6,039 ms** |
| thinking off (`none`) | **423 ms** median |

## 2. Tiers

| tier | picked when | effort | wire `reasoning_effort` | switch cost |
|---|---|---|---|---|
| **fast** | greeting, lookup, short conversational turn | `off` | `none` — thinking off | — |
| **normal** | the turn *names a reasoning-shaped task* (`debug`, `analyze`, `root cause`, `compare`, `design a`, `why does …`), or is long | `medium` | `medium` — thinking on, no instruction sentence | **2–6 tokens** |
| **deep** | the user asked for *reasoning itself* (`think carefully`, `reason through`, `step by step`, `prove`, `explain in detail`, `take your time`) | `xhigh` | `xhigh` — the "think carefully" instruction | one re-prefill |

Splitting *task* from *explicit* is measured, not stylistic: on the same concrete
concurrency question the **normal** tier produced ~4,000 characters of reasoning
and a correct one-step answer, while the **deep** tier produced ~6,300 at 1.5×
the wall time. Normal is already real reasoning, so deep is reserved for a user
who literally asks for it — and because normal sits in the *cheap* prefix family,
the everyday escalation from a greeting to a task costs nothing.

## 3. Important design properties

* **Request-scoped.** The policy returns a value from the `agent/request`
  waterfall. It never mutates the settings document, the global model selection,
  the session store, or any file.
* **Does not mutate the global model selection per request.** Only the returned
  `LlmCallConfig` changes, and only its `reasoningEffort` key.
* **Local-model focused.** Only `config.provider` routes are touched. Any other
  provider — including a cloud route — is returned untouched, byte for byte.
* **A user's explicit reasoning choice is respected.** The policy only ever
  rewrites a seed equal to the configured default. Anything else can only have
  come from an explicit per-session or composer selection, so it is returned
  as-is.
* **No cloud routing.** The plugin cannot introduce a provider; it only picks an
  effort on a provider that was already chosen.
* **Tool-compatible.** Thinking off did not damage tool dispatch: 4/4 replay runs
  emitted a well-formed tool call with parseable arguments and zero reasoning
  tokens, reaching the first tool-call frame in **647 ms** against **3,451 ms**
  with thinking on. `maxTokens` and every other config key survive the rewrite.
* **Preserves prompt-prefix reuse between `off` and `medium`.** This is the
  property the whole design rests on — see below.

### Why `off` and `medium` are the pair worth toggling

A chat template may write a *"Reasoning effort is set to …"* sentence as the
**first content of the system message**. When it does, the prompt prefix depends
on the effort, and switching effort normally costs a full re-prefill:

| knob | prefix shared with `low` | cost of switching |
|---|---|---|
| `low` | 100% | — |
| `medium` | 3 tokens from `low`, but **100% from `off`** | 2–6 tokens from `off` |
| `xhigh` | 9 tokens | full re-prefill of the ~12.2k prefix (~19 s) |
| `chat_template_kwargs.enable_thinking=false` | 3 tokens | full re-prefill |
| top-level `reasoning_budget_tokens` / `thinking_budget_tokens` | **100%** | free — but some serving front-ends drop the field |

`medium` and thinking-off both omit that sentence, so they **share one prefix** and
differ only in the generation prompt's tail. Alternating between them on the real
12.2k body measured `cache_n = 12,206…12,208` and `prompt_n = 2…6` in **both**
directions — effectively free.

That pair is therefore the whole mechanism, and it is why the tier default has to
be `medium` rather than `low`: `low` carries its own prefix and would pay a
re-prefill on every toggle.

> **Do not** re-tune the fast/normal pair to `low`/`xhigh`, or to
> `enable_thinking=false`, on a model whose template behaves as above. Either
> change silently converts every tier switch into a full prompt re-evaluation.

## 4. Installation / Cordis mounting

No registry install and no `node_modules` patch. Mount the package's entry file
from a DSH profile's Cordis patch file. A generic example:

```yaml
# <DSH_HOME>/profiles/<profile>/cordis.patch.yml
{
  insert: [
    {
      id: akeno-reasoning-policy,
      name: "<path-to>/dsh-akeno-reasoning-policy/lib/index.js",
      config: {
        provider: unsloth,
        defaultEffort: medium,
        fastEffort: off,
        deepEffort: xhigh,
        debug: false
      }
    }
  ]
}
```

`name` takes an absolute path to this package's `lib/index.js`. Extracting the
package next to your other local plugin packages and pointing `name` at it is
enough — the entry file is plain ESM with no build step and no dependencies.

The model must then **offer the levels the policy will select**. In the settings
document for that provider:

```yaml
          reasoningEfforts:
            off: none      # fast   — wire "none", shares the medium prefix
            medium: medium # normal — recommended session default
            xhigh: xhigh   # deep
```

and set the agent default effort to the **normal** tier:

```yaml
    agent-default-model:
      reasoningEffort: medium
```

Restart DSH after changing either file. Node caches ES modules, so plugin source
edits and patch rewrites are **not** picked up without a restart.

### Example: the tested local deployment

For reference only — nothing below is required. The stage that produced the
numbers in this README ran on Windows 11 with a single 20 GB AMD GPU, using:

* DSH web profile with the plugin mounted from
  `<DSH_HOME>/profiles/web/cordis.patch.yml` by absolute path
* Unsloth Studio serving a local `unsloth/Qwen3.8-27B-GGUF` model on
  `http://127.0.0.1:8888/v1` (llama.cpp b11115 backend)
* `--parallel 1`, `Q4`-class KV cache, ~80k context target, fully GPU-resident model
* provider id `unsloth`, model id `unsloth/Qwen3.8-27B-GGUF`

## 5. Configuration

All four keys are optional; the shipped defaults are shown.

| key | default | meaning |
|---|---|---|
| `provider` | `unsloth` | only `LlmCallConfig`s whose `provider` equals this are re-priced. Everything else passes through untouched, which is the cloud-safety fence. |
| `defaultEffort` | `medium` | the effort a request seeds when nobody has chosen. Must equal the session default in the settings document, or the policy has nothing to compare a seed against and declines to act. This is also the **normal** tier. |
| `fastEffort` | `off` | the **fast** tier. Must be a level that shares the normal tier's prompt prefix. |
| `deepEffort` | `xhigh` | the **deep** tier. Reached only when the user asks for reasoning itself. |
| `debug` | `false` | emit one log line per request. Also enabled by `DSH_AKENO_REASONING_DEBUG=1`. No prompt content is logged. |

Debug output looks like:

```
AKENO REASONING turn=1 step=1 policy=fast reason=simple-default class=simple wireThinking=off
```

Note that `defaultEffort` doubles as the normal tier, so changing it changes both
the seed comparison and the tier mapping. If your template's prefix families
differ from the measured one, the safest re-tune is to set `fastEffort` and
`defaultEffort` to two levels that share a prefix on your model, and leave
`deepEffort` as the expensive opt-in.

### User override

Selecting a level by hand always wins, and an older session still carrying a
foreign level (for example `low`) keeps behaving exactly as it did.

This is subtler than it looks. A chosen effort is persisted into the session's own
request header and comes back as the **next turn's seed**, so the policy's own
output is indistinguishable from a user's selection by value alone. The plugin
therefore remembers what it last returned per agent (in a `WeakMap`, so no session
is kept alive). Without that memory, the first fast turn would write `off`, the
next turn would seed `off`, and the policy would mistake its own output for the
user's — permanently disabling escalation. A regression test pins this.

The memory is process-local on purpose: after a restart the plugin forgets, treats
an inherited seed as the user's, and leaves that session exactly as it was.

## 6. Tests

No devDependencies. Requires Node 22+ (`node --test`).

```powershell
# everything
npm test

# or individually
node --test test/policy.test.mjs
node --test test/plugin.test.mjs
```

`policy.test.mjs` covers the pure decision logic; `plugin.test.mjs` drives the
real `apply()` and both real handlers against a fake Cordis context, so the
wiring DSH will see is what is tested.

## 7. Limitations

Two known issues were observed during the production stage. **Neither is caused by
this plugin**, and neither is fixed by it.

1. **Single-slot background inference contention.** The tested deployment runs the
   local server with `--parallel 1`, so the plugin's chosen effort does not control
   queueing. One observed interactive turn took ~165 s of wall time while its own
   two requests consumed only ~6.2 s and ~2.0 s of server time; the remainder was
   queued behind unrelated background generations of ~12,397 and ~3,180 tokens. On
   a single-slot server, any background generation — memory consolidation, an
   embedding pass, another client — delays an interactive turn regardless of this
   policy.
2. **Intermittent Node `fetch`/undici streaming delay.** ~35% of observed streamed
   requests issued from Node's `fetch`/undici experienced a flat ~5.0 s delay
   before the stream produced data. `curl.exe` issuing the **identical** request
   did not, and the server was not at fault. Root cause was not established. DSH
   is a Node application, so this delay is visible in production even though it
   originates client-side and outside this plugin's scope.

Further notes:

* The policy classifies **text**, not intent. A vague request ("Debug this race
  condition." with nothing attached) can trigger an agentic workspace search
  lasting many steps. Measurement showed that behaviour is driven by the request,
  not by the reasoning level — holding the scenario fixed and varying only the
  effort left the deep tier answering a concrete question in one step.
* `agent/pre-step` and `agent/request` are DSH hook names and are not a stable
  public API. A DSH change to either may require an update.

## Removing it

Delete the plugin entry from the profile patch and restart DSH. No core file, no
`node_modules` package, and no session history is modified.
