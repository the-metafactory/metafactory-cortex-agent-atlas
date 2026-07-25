/**
 * THE BLAST-RADIUS FENCE for the shadow rehearsal.
 *
 * The rehearsal drives the REAL gate, the REAL intake and the REAL effect
 * adapters. The only thing standing between it and the live iteration plan is
 * configuration — and configuration is exactly what an operator gets wrong. So
 * the fence is code, it runs before anything is provisioned, and it fails the
 * suite rather than the plan.
 *
 * Two rules, both shape-based so this public repo never has to name a live id:
 *
 *   1. The plan repo may not be the repo Atlas is intended to steward, and may
 *      not belong to the org that owns it. A throwaway under a personal
 *      account is fine; anything under the product org is not.
 *   2. The ledger channel id may not be SNOWFLAKE-SHAPED. Every real Discord
 *      channel is a 17-20 digit integer; every fixture in this repo is not
 *      (`chan-fixture-0000`, per the repo's placeholder convention). Refusing
 *      the shape means the harness cannot be pointed at a real channel even by
 *      someone who pastes one in — and it needs no denylist of live ids, which
 *      is itself the thing this repo may not contain.
 *
 * These are asserted by tests that run WITHOUT the rehearsal's network gate, so
 * the fence is verified on every `bun test`, not only when the rehearsal runs.
 */

/** The org that owns the live plan. Nothing under it is a legal shadow target. */
export const PROTECTED_OWNER = "the-metafactory";

/** A real Discord snowflake: 17-20 digits and nothing else. */
const SNOWFLAKE_RE = /^[0-9]{17,20}$/;

export interface ShadowTarget {
  /** `owner/repo` the harness will let Atlas WRITE to. */
  readonly planRepo: string;
  /** The issue number the harness will let Atlas edit. */
  readonly planIssue: number;
  /** The ledger channel id the harness configures. */
  readonly channelId: string;
}

export class LiveTargetRefused extends Error {
  constructor(
    readonly reason:
      | "protected-owner"
      | "malformed-repo"
      | "malformed-issue"
      | "snowflake-channel"
      | "empty-channel",
    detail: string,
  ) {
    super(`shadow rehearsal REFUSED to run: ${detail}`);
    this.name = "LiveTargetRefused";
  }
}

/**
 * Throw unless every coordinate is unmistakably a throwaway. Called by the
 * harness before it creates so much as a temp directory.
 */
export function assertThrowawayTarget(target: ShadowTarget): void {
  const repo = typeof target.planRepo === "string" ? target.planRepo.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)) {
    throw new LiveTargetRefused("malformed-repo", `plan repo ${JSON.stringify(repo)} is not owner/repo`);
  }
  const owner = repo.slice(0, repo.indexOf("/"));
  if (owner.toLowerCase() === PROTECTED_OWNER) {
    throw new LiveTargetRefused(
      "protected-owner",
      `the shadow harness may never write to a repo under "${PROTECTED_OWNER}" — ` +
        `that is where the live plan lives. Point it at a throwaway.`,
    );
  }
  if (!Number.isSafeInteger(target.planIssue) || target.planIssue <= 0) {
    throw new LiveTargetRefused("malformed-issue", "the plan issue must be a positive integer");
  }
  const channel = typeof target.channelId === "string" ? target.channelId.trim() : "";
  if (channel.length === 0) {
    throw new LiveTargetRefused("empty-channel", "no ledger channel id was configured");
  }
  if (SNOWFLAKE_RE.test(channel)) {
    throw new LiveTargetRefused(
      "snowflake-channel",
      "the ledger channel id is snowflake-shaped — the shadow harness posts through a " +
        "FAKE host and must never be handed a real channel id",
    );
  }
}
