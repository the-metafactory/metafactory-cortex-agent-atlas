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
  | "malformed-base-branch";

export type EffectsConfigLoad =
  | { kind: "ok"; config: EffectsConfig }
  | { kind: "refused"; reason: EffectsConfigRefusal; detail: string };

export function makeEffectsConfig(input: {
  planRepo: string;
  planIssue: string | number;
  channelId: string;
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

  const checkoutRaw = typeof input.checkoutDir === "string" ? input.checkoutDir.trim() : "";

  return {
    kind: "ok",
    config: Object.freeze({
      plan: Object.freeze({ repo, issue }),
      planUrl: `https://github.com/${repo}/issues/${issue}`,
      channelId,
      baseBranch,
      checkoutDir: checkoutRaw.length > 0 ? checkoutRaw : null,
    }),
  };
}

/**
 * Build the effect config from the daemon environment:
 *
 *   ATLAS_PLAN_REPO         `owner/repo` of the plan issue (agent.yaml `plan.repo`)
 *   ATLAS_PLAN_ISSUE        the plan issue number      (agent.yaml `plan.issue`)
 *   ATLAS_CHANNEL_ID        the ONE channel Atlas posts to (agent.yaml
 *                           `presence.discord.channelId`)
 *   ATLAS_PLAN_BASE_BRANCH  optional, default `main`
 *   ATLAS_PLAN_CHECKOUT     optional local clone for doc-change PRs (J6)
 */
export function loadEffectsConfig(
  env: Record<string, string | undefined> = process.env,
): EffectsConfigLoad {
  return makeEffectsConfig({
    planRepo: env.ATLAS_PLAN_REPO ?? "",
    planIssue: env.ATLAS_PLAN_ISSUE ?? "",
    channelId: env.ATLAS_CHANNEL_ID ?? "",
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
