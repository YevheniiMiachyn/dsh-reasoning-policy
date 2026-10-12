# Release notes — v0.2.0-local.1

**Package:** `dsh-reasoning-policy`
**Date:** 2026-10-12
**Status:** unit-tested (23/23) and verified end to end on an isolated DSH 0.2 instance, then deployed to the local
production and staging profiles.

---

## Changed (behaviour)

* **A selected reasoning level is always respected.** Off, Low, Medium, High, Xhigh and any other level are returned
  exactly as selected, whatever the turn says and whether or not the reply will be spoken. Previously `medium` was
  the adaptive level, so a user's explicit Medium could be rewritten to Off for a short turn.
* **Adaptive reasoning is "no level selected".** DSH delivers a request with no selected level (the picker's
  "Default") to the `agent/request` hook as an absent `reasoningEffort`. Only then does the policy classify the turn
  and answer with the fast (`off`), normal (`medium`) or deep (`xhigh`) tier. DSH accepts only the level names
  off, minimal, low, medium, high, xhigh and max, so adaptation cannot be a level of its own.
* **No value is compared with a "default" any more.** Two earlier rules guessed wrong in opposite directions: a
  profile default of `low` was read as a user's choice and left the policy inert, and a persisted `off` written by the
  policy was read as a user's choice and froze the session. The policy now keeps no memory of what it wrote and never
  writes the saved preference.

## Configuration

* `normalEffort` (default `medium`) names the normal tier. The earlier key `defaultEffort` is still read as an alias
  for it but no longer decides what counts as a user's choice.
* `fastEffort`, `deepEffort`, `provider` and `debug` are unchanged.

## Upgrade notes

* Nothing in the profile needs to change. To use adaptive reasoning, pick "Default" in the composer (or omit
  `reasoningEffort` from `agent-default-model`); picking any level fixes that level for every turn.
* In DSH 0.2 a level picked in the composer is written into the profile's `agent-default-model` entry, and "Default"
  removes it.
