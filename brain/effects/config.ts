/**
 * The EFFECT UNIVERSE, as configuration (W2c, issue #1; the-metafactory/
 * vision#9 §6 "Capabilities & least privilege", persona.md's closing line:
 * *"your effect universe is bounded by config, never by content"*).
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 * Every slice before this one was read-only or state-internal. This is the
 * slice where Atlas first gains the ability to CHANGE something, so the first
 * question a reviewer will ask is "what can it change, and who decides?". The
 * answer is: exactly one GitHub issue body (plus comments and PRs on that one
 * repo) and exactly one Discord channel, and the deployment decides — here, at
 * load, from the daemon environment, once.
 *
 * The adapters take a resolved `EffectsConfig` by construction and have no
 * other way to learn a repo or a channel: neither `effects/gh.ts` nor
 * `effects/discord.ts` reads `process.env`, and neither accepts a repo/channel
 * argument on any method. A proposal's text — the why-field, the section name,
 * the URL — is DATA that flows into a body or a post; it is never a target.
 * `apply.test.ts`'s "targets come from config" cases assert exactly that by
 * feeding a proposal whose text names a different repo and channel and
 * checking the emitted argv and the posted channel id are unchanged.
 *
 * ── Refusals are NAMED, and a refusal disables the effect layer ─────────────
 * Same posture as identity.ts: a missing or malformed value is a named refusal,
 * not a repaired default, and the collapsed `…FromEnv` form returns `null` with
 * a loud stderr line. `null` here means Atlas can still intake, surface and
 * ratify — it simply cannot ACT, and says so, rather than acting somewhere
 * half-configured. (The failure mode this pack most fears is a silently dead
 * gate; the mirror-image fear is a silently mis-aimed effect.)
 *
 * ── `trustedAdapterInstances` (atlas#24) ────────────────────────────────────
 * `protocol.ts`'s `TaskSource.adapter_instance` is the one field cortex sets
 * ONLY on a genuine live-surface task (`dispatchInboundToBrain` in cortex's
 * `src/cortex.ts`, from the real adapter connection's own `instanceId`). It is
 * declared OPTIONAL on the wire because the mirror rule tolerates a malformed
 * or forged envelope — but nothing upstream of this brain enforces that only
 * cortex's own inbound-surface path can publish onto the `brain.>` subject a
 * `task` event arrives on. Verified against cortex directly: the consumer that
 * builds `source` from an arbitrary bus envelope (`deriveTaskSource`,
 * `src/bus/brain-consumer.ts`) runs no origin check, the daemon's own bot
 * credential is minted with no `--pub`/`--sub` scope
 * (`network-make-live-adapters.ts`), and no account-level default restricts a
 * second bot under the same agents account either. So `source.adapter_instance`
 * is NOT independently authenticated by the bus — it is exactly as trustworthy
 * as `source.channel`, which is to say: only as far as "the deployment decided
 * to admit it", never further.
 *
 * `trustedAdapterInstances` is that decision, made explicit and config-pinned,
 * the same way `channelId` already is. It is REQUIRED — there is no default
 * that silently disables the check — because an opt-in flag nobody sets is
 * this repo's most repeated defect (an inert control that only LOOKS active).
 * `runtime.ts`'s `serveTask` refuses (config-pinned admission, same disposition
 * as a wrong channel) any task whose `source.adapter_instance` is absent or is
 * not a MEMBER of this set — compared with `===`, never normalised, exactly
 * like `channelId`.
 *
 * ── There is NOT one formula for the expected value — there are THREE
 *    (found in adversarial review, atlas#24 B1) ─────────────────────────────
 * `cortex.PlatformAdapter.instanceId` resolves differently depending on the
 * cortex TOPOLOGY Atlas is deployed under, verified against cortex directly:
 *
 *   1. Per-stack (regular, non-gateway) boot — `src/runner/surface-adapter-
 *      boot.ts`: `instance.instanceId ?? \`${agent.name}-discord-${guildId}\``.
 *      For Atlas that is `atlas-discord-<guildId>`. `src/cortex.ts`'s boot
 *      assertion (gatewayAdapterInstanceCollisions) THROWS if a per-stack
 *      adapter's instanceId collides with the gateway's own `{platform}:
 *      {demuxKey}` form — so on THIS topology, the `discord:<guildId>` form
 *      below is not just wrong, it is a shape cortex itself forbids here.
 *   2. Gateway, one bot token shared across multiple guilds — cortex's
 *      Discord adapter's token-grouping (`groupDiscordBindingsByToken`):
 *      `discord:token:<sha256(token, stack)[0:12]>`. A 48-bit digest of a
 *      SECRET (the bot token) — this is the one form that is genuinely hard
 *      to derive from public information, and the one to prefer if the
 *      topology offers it.
 *   3. Gateway, exactly one guild per bot token — same grouping function's
 *      single-guild fallback: `discord:<guildId>`.
 *
 * A deployment must know which of the three applies — guessing wrong is
 * SILENT (see `runtime.ts`'s header and `startup.ts`: the trusted set now
 * appears in the ARMED line specifically so a mismatch is a visible, not a
 * per-message-stderr, fact). The reliable way to determine it: read the real
 * `adapter_instance` off ONE genuine live inbound task (a log line, or a
 * temporary debug tap) rather than computing the formula by hand — this pack
 * does not know, and cannot know from its own config, which topology the
 * deployment runs under.
 *
 * ── What this control ACTUALLY buys, stated precisely (M1, atlas#24) ───────
 * `deriveTaskSource` (cortex `src/bus/brain-consumer.ts`) reads
 * `adapter_instance` out of the SAME attacker-controlled
 * `payload.response_routing` it reads `channel` from — so this is NOT a
 * secret-based control for shapes 1 and 3 above: shape 3's guild id is
 * visible to every member of the guild, and a forger who already had to know
 * `ATLAS_CHANNEL_ID` (a snowflake in that SAME guild) gains almost nothing by
 * also needing the guild id — same visibility, same guild. Shape 1's
 * `atlas-discord-<guildId>` is even less protected: the agent name is public
 * (this repo is public). Only shape 2's token digest is a real secret (it is
 * keyed on the bot token, which the forger does not have).
 *
 * So: for shapes 1 and 3, what this buys is real but modest — it kills the
 * LAZY replay (the omit-the-field shape an actual adversarial review found
 * admitted), it kills accidental cross-wiring between two adapter instances
 * that both happen to reach this brain, and it forces a forger who DOES know
 * the guild to be deliberate about including a plausible value rather than
 * getting in for free. It does NOT stop someone who already knows which
 * guild Atlas is bound to. Where the topology offers shape 2, prefer it: that
 * is the one case where this check is close to a real secret, not merely a
 * config-pinned admission fact like `channelId`.
 *
 * `runtime.ts`'s `serveTask` does not depend on this file dropping blank
 * tokens to stay fail-closed — it separately refuses an empty
 * `source.adapter_instance` outright (atlas#24 M3), so a trust-path guarantee
 * never rests on an invariant recorded only here.
 *
 * This closes the "trivially forged/replayed envelope" gap (the wire's own
 * e2e fixture used to omit the field entirely and still be admitted) without
 * claiming to close the deeper one — an attacker who can ALSO get a
 * credential onto the bus's agents account. That deeper gap is a NATS
 * subject-permission / account-isolation question for arc/cortex (filed
 * upstream as arc#378 / cortex#2465), out of this
 * repo's reach; it is recorded, not silently assumed away (see the PR/issue
 * this shipped with).
 */

import type { PlanCoordinates } from "../gh";

function warn(msg: string): void {
  process.stderr.write(`atlas: effects-config: ${msg}\n`);
}

/** `owner/repo` — the same shape gh's `--repo` flag takes. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * A channel id is an OPAQUE platform identifier, exactly like a platform user
 * id in identity.ts: compared with `===`, never normalised, never coerced to a
 * number. It is bounded and whitespace-free so it can never smuggle a second
 * argument into anything, but its INTERNAL shape is deliberately unconstrained
 * — a test fixture's `chan-fixture-0000` and a live snowflake are both just
 * strings, and this repo is public, so fixtures must be able to use the former.
 */
const CHANNEL_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** A git branch name Atlas is willing to push. No refspec syntax, no leading dash. */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;

/**
 * An adapter-instance id is an OPAQUE, bounded identifier — the same posture
 * as `CHANNEL_ID_RE` above, deliberately as strict: this is a SIBLING
 * trust-boundary field (atlas#24), not a looser one. Must start with an
 * alphanumeric — which structurally excludes the installer-placeholder shape
 * `__NAME__` (always starts with `_`, atlas#24 N1) — then only
 * `[A-Za-z0-9._:-]`, up to 128 chars: headroom over every real cortex shape
 * (`discord:token:<12 hex>`, `atlas-discord-<snowflake>`, `discord:<guildId>`
 * — see the header note on the three topologies) without being unbounded.
 */
const ADAPTER_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * `platform:instance` ids, COMMA-separated only (atlas#24 M4 — deliberately
 * NOT whitespace too, unlike `identity.ts`'s `parsePlatformActors`). An
 * adversarial review found that splitting on whitespace as well meant an
 * operator's copy-paste error — a stray space or tab inside what they meant
 * as ONE id — silently WIDENED the trusted set into two tokens, neither of
 * which is the id they intended. Comma-only splitting means a value with
 * internal whitespace stays exactly ONE token, which then simply fails
 * `ADAPTER_INSTANCE_RE` below (real cortex ids never contain whitespace)
 * instead of being silently split into something that admits more than the
 * operator wrote.
 *
 * Blank tokens (an empty entry from `",,"` or a whitespace-only value) are
 * DROPPED, not counted as usable — a stray comma must never widen the set,
 * and `makeEffectsConfig` refuses `missing-adapter-instances` if dropping them
 * leaves nothing at all. A non-blank token that fails `ADAPTER_INSTANCE_RE`
 * refuses the WHOLE config (`malformed-adapter-instance`) instead of being
 * silently dropped (which would fail closed by accident) or silently kept
 * (which could fail closed OR open depending on luck) — same rigor
 * `CHANNEL_ID_RE` already applies to the sibling field.
 */
function parseAdapterInstances(
  raw: string | undefined,
): { kind: "ok"; instances: ReadonlySet<string> } | { kind: "malformed"; token: string } {
  const out = new Set<string>();
  if (typeof raw === "string" && raw.length > 0) {
    for (const rawToken of raw.split(",")) {
      const token = rawToken.trim();
      if (token.length === 0) continue;
      if (!ADAPTER_INSTANCE_RE.test(token)) return { kind: "malformed", token };
      out.add(token);
    }
  }
  return { kind: "ok", instances: out };
}

export interface EffectsConfig {
  /** The ONE repo + issue Atlas may write to. */
  readonly plan: PlanCoordinates;
  /** The canonical https URL of the plan issue — the "map link" every ledger post carries. */
  readonly planUrl: string;
  /** The ONE Discord channel Atlas may post to. */
  readonly channelId: string;
  /** Base branch for doc-change PRs (J6). Never pushed to directly. */
  readonly baseBranch: string;
  /**
   * A local working copy of the plan repo, for the doc-change PR path (J6).
   * `null` disables branch pushes and PR creation entirely — fail closed: an
   * unset checkout is "Atlas cannot do doc changes here", never "Atlas guesses
   * a directory".
   */
  readonly checkoutDir: string | null;
  /**
   * Adapter-instance ids `runtime.ts`'s admission check accepts a task from
   * (atlas#24). Opaque strings, compared with `===` — see the header note.
   * Always non-empty on an `ok` config: an empty set would admit nothing,
   * which is exactly what `missing-adapter-instances` refuses instead.
   */
  readonly trustedAdapterInstances: ReadonlySet<string>;
}

export type EffectsConfigRefusal =
  /** `ATLAS_PLAN_REPO` missing/blank. */
  | "missing-plan-repo"
  /** `ATLAS_PLAN_REPO` is not `owner/repo`. */
  | "malformed-plan-repo"
  /** `ATLAS_PLAN_ISSUE` missing, non-numeric, or not a positive safe integer. */
  | "missing-plan-issue"
  /** `ATLAS_CHANNEL_ID` missing/blank. */
  | "missing-channel-id"
  /** `ATLAS_CHANNEL_ID` carries whitespace or is over-long. */
  | "malformed-channel-id"
  /** `ATLAS_PLAN_BASE_BRANCH` is not a plain branch name. */
  | "malformed-base-branch"
  /** `ATLAS_TRUSTED_ADAPTER_INSTANCES` missing, blank, or yields no usable id (atlas#24). */
  | "missing-adapter-instances"
  /** A non-blank `ATLAS_TRUSTED_ADAPTER_INSTANCES` token fails `ADAPTER_INSTANCE_RE` (atlas#24 M4/N1). */
  | "malformed-adapter-instance";

export type EffectsConfigLoad =
  | { kind: "ok"; config: EffectsConfig }
  | { kind: "refused"; reason: EffectsConfigRefusal; detail: string };

export function makeEffectsConfig(input: {
  planRepo: string;
  planIssue: string | number;
  channelId: string;
  adapterInstances: string;
  baseBranch?: string | undefined;
  checkoutDir?: string | undefined;
}): EffectsConfigLoad {
  const repo = typeof input.planRepo === "string" ? input.planRepo.trim() : "";
  if (repo.length === 0) {
    return { kind: "refused", reason: "missing-plan-repo", detail: "no plan repo was configured" };
  }
  if (!REPO_RE.test(repo)) {
    return {
      kind: "refused",
      reason: "malformed-plan-repo",
      // The VALUE is echoed because it came from the operator's own
      // environment, not from a proposal — this is a config diagnostic, and an
      // operator debugging a typo needs to see what they typed.
      detail: `plan repo ${JSON.stringify(repo)} is not owner/repo`,
    };
  }

  const issue = Number(typeof input.planIssue === "string" ? input.planIssue.trim() : input.planIssue);
  if (!Number.isSafeInteger(issue) || issue <= 0) {
    return {
      kind: "refused",
      reason: "missing-plan-issue",
      detail: "the plan issue number is missing or not a positive integer",
    };
  }

  const channelId = typeof input.channelId === "string" ? input.channelId.trim() : "";
  if (channelId.length === 0) {
    return { kind: "refused", reason: "missing-channel-id", detail: "no channel id was configured" };
  }
  if (!CHANNEL_ID_RE.test(channelId)) {
    return {
      kind: "refused",
      reason: "malformed-channel-id",
      detail: "the configured channel id is over-long or contains unsupported characters",
    };
  }

  const baseBranch = (input.baseBranch ?? "main").trim();
  if (!BRANCH_RE.test(baseBranch)) {
    return {
      kind: "refused",
      reason: "malformed-base-branch",
      detail: `base branch ${JSON.stringify(baseBranch)} is not a plain branch name`,
    };
  }

  // atlas#24 — required, same posture as channelId: no default that would
  // silently admit every adapter instance.
  const adapterInstancesParsed = parseAdapterInstances(
    typeof input.adapterInstances === "string" ? input.adapterInstances : "",
  );
  if (adapterInstancesParsed.kind === "malformed") {
    return {
      kind: "refused",
      reason: "malformed-adapter-instance",
      // The VALUE is echoed for the same reason `malformed-plan-repo` echoes
      // its value: this came from the operator's own environment, not from a
      // proposal, so a typo needs to be visible to debug.
      detail: `adapter instance id ${JSON.stringify(adapterInstancesParsed.token)} is not a valid identifier`,
    };
  }
  const trustedAdapterInstances = adapterInstancesParsed.instances;
  if (trustedAdapterInstances.size === 0) {
    return {
      kind: "refused",
      reason: "missing-adapter-instances",
      detail: "no trusted adapter instance id was configured",
    };
  }

  const checkoutRaw = typeof input.checkoutDir === "string" ? input.checkoutDir.trim() : "";

  return {
    kind: "ok",
    config: Object.freeze({
      plan: Object.freeze({ repo, issue }),
      planUrl: `https://github.com/${repo}/issues/${issue}`,
      channelId,
      baseBranch,
      checkoutDir: checkoutRaw.length > 0 ? checkoutRaw : null,
      trustedAdapterInstances,
    }),
  };
}

/**
 * Build the effect config from the daemon environment:
 *
 *   ATLAS_PLAN_REPO                  `owner/repo` of the plan issue (agent.yaml `plan.repo`)
 *   ATLAS_PLAN_ISSUE                 the plan issue number      (agent.yaml `plan.issue`)
 *   ATLAS_CHANNEL_ID                 the ONE channel Atlas posts to (agent.yaml
 *                                    `presence.discord.channelId`)
 *   ATLAS_TRUSTED_ADAPTER_INSTANCES  adapter-instance id(s) `runtime.ts` admits a task
 *                                    from (atlas#24); comma/whitespace-separated
 *   ATLAS_PLAN_BASE_BRANCH           optional, default `main`
 *   ATLAS_PLAN_CHECKOUT              optional local clone for doc-change PRs (J6)
 */
export function loadEffectsConfig(
  env: Record<string, string | undefined> = process.env,
): EffectsConfigLoad {
  return makeEffectsConfig({
    planRepo: env.ATLAS_PLAN_REPO ?? "",
    planIssue: env.ATLAS_PLAN_ISSUE ?? "",
    channelId: env.ATLAS_CHANNEL_ID ?? "",
    adapterInstances: env.ATLAS_TRUSTED_ADAPTER_INSTANCES ?? "",
    baseBranch: env.ATLAS_PLAN_BASE_BRANCH,
    checkoutDir: env.ATLAS_PLAN_CHECKOUT,
  });
}

/**
 * `loadEffectsConfig`, collapsed to the fail-closed value the effect layer
 * consumes. `null` means "Atlas cannot act": no plan edit, no ledger post, no
 * PR. The named reason goes to stderr rather than being thrown away.
 */
export function loadEffectsConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): EffectsConfig | null {
  const result = loadEffectsConfig(env);
  if (result.kind === "ok") return result.config;
  warn(
    `REFUSED (${result.reason}) — Atlas has NO effect target and will not edit the ` +
      `plan or post to the channel. ${result.detail}`,
  );
  return null;
}
