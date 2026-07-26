/**
 * The startup verdict — ONE line, emitted once, saying whether the ratification
 * gate is ARMED or UNARMED and what configuration produced that answer.
 *
 * ── Why this is a module and not three `stderr.write`s in main.ts ──────────
 * Epic #5 names the failure this exists to prevent: *"A deployment that forgets
 * one gets a silently dead gate with only stderr as signal."* An UNARMED Atlas
 * is not broken in any way an operator can see — it connects, it stays up, it
 * intakes nothing, and it ignores the principal. The only difference between a
 * working deployment and a dead one is a value in an environment.
 *
 * So the verdict is a first-class, PURE, tested function of the loads, rather
 * than prose scattered through a boot sequence. `buildStartupLine` takes the
 * exact `…Load` results the config modules return — including their NAMED
 * refusal reasons — and produces one line. A test can assert every combination
 * without booting anything.
 *
 * ── Exactly one line, deliberately ────────────────────────────────────────
 * Not two, not one-per-subsystem. The armed/unarmed fact and the configuration
 * that produced it belong on the same line because they are read together, and
 * because a multi-line banner is the thing operators learn to scroll past.
 *
 * ── What is masked, and what is not ───────────────────────────────────────
 * Every opaque IDENTIFIER is masked: the ratifier principal id, the channel id,
 * and the platform ids (which are reported only as COUNTS). These are exactly
 * the values this repo's confidentiality gate exists to keep out of public
 * artefacts, and a log line is copied into issues far more often than a config
 * file is.
 *
 * The plan `owner/repo#issue` is NOT masked, and that is a considered choice:
 * it is an operator-typed name rather than an identifier, it is the single most
 * useful field for answering "is this Atlas pointed at the right plan?", and
 * `effects/config.ts` already echoes it verbatim in its own malformed-value
 * diagnostic. Masking it would make the line unable to answer the question it
 * exists for.
 */

import type { EffectsConfigLoad } from "./effects/config";
import type { IdentityConfigLoad } from "./identity";

/**
 * Mask an opaque identifier for a log line: enough to correlate two sightings
 * of the same value, never enough to reconstruct it. A short value reveals
 * nothing at all rather than most of itself.
 */
export function maskId(raw: string | undefined | null): string {
  if (typeof raw !== "string") return "(unset)";
  const s = raw.trim();
  if (s.length === 0) return "(unset)";
  if (s.length <= 6) return `••••(len${s.length})`;
  return `${s.slice(0, 2)}••${s.slice(-2)}(len${s.length})`;
}

export interface StartupFacts {
  readonly identity: IdentityConfigLoad;
  readonly effects: EffectsConfigLoad;
  /** How many `platform:id` pairs each side parsed to. Counts only, never values. */
  readonly ratifierIdCount: number;
  readonly selfIdCount: number;
  /** The raw ratifier principal id, for masking here. */
  readonly ratifierPrincipal: string | undefined;
  /** True when durable state opened; false ⇒ memory-only, gate refuses. */
  readonly stateDurable: boolean;
  /** The overlay file that was read, and how many keys it FILLED. */
  readonly envPath: string | null;
  readonly envFilled: number;
}

/**
 * The one line.
 *
 * ── ARMED means "a RATIFY typed by the principal will be honoured" ─────────
 * Nothing weaker. The verdict's contract is ASYMMETRIC and that asymmetry is
 * load-bearing: the UNARMED branch says out loud that every RATIFY/DECLINE will
 * be IGNORED, so an operator reads ARMED as the promise that they will not be.
 * The line therefore may not print ARMED unless all THREE prerequisites of that
 * promise hold:
 *
 *   identity     — `ratify.ts` refuses every verb without a loaded config.
 *   storage      — a gate that cannot durably record its own decision mints no
 *                  certificate and so authorises no effect (`state.ts`'s
 *                  degraded path refuses every RATIFY/DECLINE).
 *   reachability — with no effect target, `runtime.ts`'s `serveTask`
 *                  short-circuits to `no-effect-layer` BEFORE intake and before
 *                  the gate: `processGateMessage` is never called at all. This
 *                  is now TWO admission dimensions, not one (atlas#24): a task
 *                  must match BOTH the configured channel AND a trusted
 *                  adapter instance, and either one being unreachable prints
 *                  the same `unreachable:` blocker (`missing-channel-id` /
 *                  `malformed-channel-id` / `missing-adapter-instances` /
 *                  `malformed-adapter-instance`).
 *
 * Reachability is the newest of the three and by far the most deceptive
 * (atlas#20). Identity and storage both fail INSIDE the gate, which answers the
 * principal; an unreachable gate discards the message in silence. Printing
 * ARMED over that was epic #5's silently-dead gate wearing the badge this line
 * exists to withhold.
 *
 * ── A reachable line must show EVERY admission dimension, not just the first
 *    one added (atlas#24 B1) ────────────────────────────────────────────────
 * An adversarial review reproduced this exactly: a wrong (but non-empty)
 * `ATLAS_TRUSTED_ADAPTER_INSTANCES` value made `serveTask` refuse 100% of
 * traffic while the line still printed `GATE ARMED` — because the `effects:`
 * clause below echoed `channelId` (the FIRST admission dimension) but not
 * `trustedAdapterInstances` (the second one this pack added). A per-message
 * stderr warn under an ARMED banner is not a visible failure; it is atlas#20
 * again, one dimension later. So `effects:` now echoes BOTH — a masked
 * `channelId` and a `trustedAdapterInstances` COUNT (never the values
 * themselves; see `maskId`'s note on identifiers). `startup.test.ts` pins an
 * exhaustive list of `EffectsConfig`'s own keys against what this function
 * consumes, so a THIRD admission-relevant field added later without updating
 * that list fails a test immediately — forcing the next person to decide, in
 * the open, whether it belongs in this line, rather than silently repeating
 * this finding a third time.
 *
 * The three are reported as ONE verdict rather than three claims deliberately:
 * a reader who has to assemble "armed" out of three sub-clauses scattered along
 * the line is exactly the reader who assembles it wrong. The clauses are still
 * all there (`effects: …`, `state=…`) for the operator who needs the detail —
 * but the prefix answers the question on its own, and every blocking reason is
 * named in it so one reboot surfaces all of them rather than one at a time.
 */
export function buildStartupLine(facts: StartupFacts): string {
  const parts: string[] = [];

  const identityOk = facts.identity.kind === "ok";
  const effectsOk = facts.effects.kind === "ok";

  // Every reason the gate is not armed, in the order an operator fixes them.
  const blockers: string[] = [];
  const details: string[] = [];
  if (!identityOk) {
    blockers.push(facts.identity.kind === "refused" ? facts.identity.reason : "identity-unknown");
    if (facts.identity.kind === "refused" && facts.identity.detail.length > 0) {
      details.push(facts.identity.detail);
    }
  }
  if (!facts.stateDurable) {
    blockers.push("state-degraded");
    details.push(
      "Durable state did not open, so no ratification can be recorded or certified.",
    );
  }
  if (!effectsOk) {
    // `unreachable:` and not a bare effects reason: the cost here is not that
    // Atlas cannot ACT (the `effects:` clause below already says that), it is
    // that the message never reaches the gate to be judged in the first place.
    blockers.push(
      `unreachable:${facts.effects.kind === "refused" ? facts.effects.reason : "unknown"}`,
    );
    details.push(
      "There is no effect target, so a message is refused before intake and the gate " +
        "never sees it.",
    );
  }

  if (blockers.length === 0) {
    parts.push(
      `atlas: GATE ARMED — ratifier principal ${maskId(facts.ratifierPrincipal)} ` +
        `(${facts.ratifierIdCount} platform id(s); ${facts.selfIdCount} self id(s))`,
    );
  } else {
    parts.push(
      `atlas: GATE UNARMED (${blockers.join(", ")}) — every RATIFY/DECLINE will be ` +
        `IGNORED. ${details.join(" ")}`.trimEnd(),
    );
  }

  if (facts.effects.kind === "ok") {
    const cfg = facts.effects.config;
    parts.push(
      `effects: plan=${cfg.plan.repo}#${cfg.plan.issue} channel=${maskId(cfg.channelId)} ` +
        `adapterInstances=${cfg.trustedAdapterInstances.size} ` +
        `base=${cfg.baseBranch} docPRs=${cfg.checkoutDir === null ? "disabled" : "enabled"}`,
    );
  } else {
    parts.push(
      `effects: NONE (${facts.effects.reason}) — Atlas admits no message and can edit ` +
        `nothing. ${facts.effects.detail}`,
    );
  }

  parts.push(`state=${facts.stateDurable ? "durable" : "MEMORY-ONLY"}`);

  // The two standing wiring limits, stated every boot rather than buried in a
  // design doc — they change how the ledger should be read.
  parts.push(
    "ledger=host-effect(post-window only; no channel read-back, so the deleted-post " +
      "detector is inert)",
  );

  parts.push(
    `env=${facts.envPath === null ? "none" : `${facts.envPath}(+${facts.envFilled})`}`,
  );

  return parts.join(" · ");
}
