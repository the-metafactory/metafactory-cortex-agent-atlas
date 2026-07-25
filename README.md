# metafactory-cortex-agent-atlas

Atlas — the Factory's product-manager agent (plan steward). A cortex agent bundle that stewards the metafactory iteration plan: intake proposals, hold a strict ratification gate, and keep the plan's ledger current.

- Design spec: https://github.com/the-metafactory/vision/issues/9
- Implementation epic: https://github.com/the-metafactory/metafactory-cortex-agent-atlas/issues/8

License: MIT

## Configuration

Atlas's brain reads its entire configuration from environment variables. Every one is declared in `agent.yaml` (`plan:`, `gate:`, `watch:`) as an `__ATLAS_*__` placeholder and in `arc-manifest.yaml` under `capabilities.secrets`. **No real id, name, or channel is ever stored in this repo.**

Read the failure column before deploying. Atlas is written to fail closed on effects — but "fail closed" is not the same as "visible". A missing gate variable does not raise, does not reply, and does not audit: it writes one line to stderr and then ignores the principal for the life of the process.

### Required — the ratification gate

The gate is the single boundary between arbitrary public input and real effects on a public plan. All three are required; none has a default.

| Variable | What it does | If missing or unusable |
|---|---|---|
| `ATLAS_RATIFIER_PRINCIPAL` | The principal id whose word ratifies. Must match a `policy.principals[].id` in the cortex config. | Refusal `missing-ratifier-principal` (or `ratifier-principal-unmapped` if it maps to nobody). **Gate not armed** — every `RATIFY`/`DECLINE` is silently ignored. |
| `ATLAS_RATIFIER_PLATFORM_IDS` | That principal's authenticated platform ids, as `platform:id` pairs, comma- or whitespace-separated (e.g. `discord:<snowflake>`). Compared with `===` — never normalised, never coerced. | Refusal `no-usable-ratifier-platform-ids`. **Gate not armed.** |
| `ATLAS_SELF_PLATFORM_IDS` | Atlas's **own** platform ids — the subject of constitution rule 3, "Atlas can never ratify Atlas". Same `platform:id` form. | Refusal `no-usable-self-platform-ids`. **Gate not armed.** Unset is a hard failure, not an empty set: a deployment that has not told Atlas which identity is its own may not run a gate whose third rule is "Atlas's own messages can never satisfy it". |

An id listed in **both** `ATLAS_SELF_PLATFORM_IDS` and `ATLAS_RATIFIER_PLATFORM_IDS` refuses the whole config with `self-and-ratifier-platform-ids-overlap`.

### Required — the effect universe

One repo, one issue, one channel. All three come from configuration, never from a proposal's content.

| Variable | What it does | If missing or unusable |
|---|---|---|
| `ATLAS_PLAN_REPO` | `owner/repo` of the plan issue. Intended value: `the-metafactory/vision`. **No code default.** | Refusal `missing-plan-repo` / `malformed-plan-repo`. Atlas still intakes, surfaces and ratifies, but **cannot edit the plan, post to the ledger, or open a PR**. |
| `ATLAS_PLAN_ISSUE` | The plan issue number — a positive integer. Intended value: `4`. **No code default.** | Refusal `missing-plan-issue`. Same consequence. |
| `ATLAS_CHANNEL_ID` | The one Discord channel the ledger posts to. An opaque string, compared with `===`. | Refusal `missing-channel-id` / `malformed-channel-id`. Same consequence. |

`ATLAS_CHANNEL_ID` has **two independent consumers**. cortex resolves the `__ATLAS_CHANNEL_ID__` placeholder in `presence.discord.channelId` to bind the Discord *surface*; the brain separately reads `ATLAS_CHANNEL_ID` from its own process environment to decide where a ledger post *goes*. One name, two wirings — satisfying one does not satisfy the other.

### Optional — defaulted

| Variable | What it does | If missing |
|---|---|---|
| `ATLAS_PLAN_BASE_BRANCH` | Base branch for doc-change PRs. Atlas never pushes to it directly. | Defaults to `main`. A value that is not a plain branch name is `malformed-base-branch`, which refuses the **entire** effect config — a typo here disables the ledger too. |
| `ATLAS_PLAN_CHECKOUT` | A local working checkout of the plan repo, used to build doc-change PR branches. | Doc-change PRs are **disabled** — fail closed: an unset checkout means "Atlas cannot do doc changes here", never "Atlas guesses a directory". Every other effect still works. |
| `ATLAS_WATCH_INTERVAL_MS` | Completion-watcher poll cadence, in milliseconds. | Defaults to `900000` (15 minutes). Any accepted value is clamped to `[60000, 86400000]`, so an out-of-range number is corrected rather than refused. |
| `ATLAS_STATE_DIR` | Instance-state directory (`state.sqlite`, events). | Defaults to `~/.config/cortex/agents/atlas`. |
| `ATLAS_AGENT_STATE_DIR` | The agent-state bundle root — used only to regenerate `dashboard.md`. | Defaults to the arc install path. A missing bundle skips dashboard regen once, with a warning. |

### `ATLAS_SELF_PLATFORM_IDS` must list Atlas's **current** ids

This is the one variable whose *staleness* is invisible. `brain/ratify.ts`'s header states the split precisely; the short form:

- **Enforced (structural).** An id appearing in both the self set and the ratifier's platform ids refuses the config at load (`self-and-ratifier-platform-ids-overlap`). Not order-dependent and not configurable-around — the config does not load at all.
- **Enforced (ordering, defence in depth).** The self-block runs before the principal-map and before the parser, and is re-checked a second time in `authorizeRatifierAction` before any transition can be authorised.
- **Not enforced, and not enforceable from configuration.** If `ATLAS_SELF_PLATFORM_IDS` names an id Atlas no longer posts under, while its *current* id is a legitimate, non-overlapping entry in the ratifier's platform ids, nothing static can see it: the config never states Atlas's true current id, so there is no disagreement to detect. Rule 3 is then silently weaker than it reads.

Closing that last case requires a start-up assertion that the id the surface is authenticated as is present in the self set — a wiring-time check, on a wiring site (`brain/main.ts`) this pack does not yet have.

**Operationally:** rotate the bot token, re-invite Atlas, or change its application, and update `ATLAS_SELF_PLATFORM_IDS` in the same change. A stale entry produces no error.

### Wiring status

Exporting these in the cortex daemon's environment is **necessary but not sufficient**. cortex spawns a brain with a minimal environment — `PATH`, `HOME`, `LANG`, `TMPDIR`, the socket variables, and nothing else except the names listed in `agent.yaml`'s `runtime.brain.secrets` (`buildEnv` in cortex's `src/brain/exec-brain-runner.ts`). The `hello` handshake carries persona and agent id only, so there is no config channel. `runtime.brain.secrets` is currently `[]`.

This section declares the contract. Wiring it — populating `runtime.brain.secrets`, plus the armed/unarmed startup line that makes an unconfigured gate visible at boot — belongs with the daemon entrypoint `brain/main.ts`, tracked on [epic #5](https://github.com/the-metafactory/metafactory-cortex-agent-atlas/issues/5).
