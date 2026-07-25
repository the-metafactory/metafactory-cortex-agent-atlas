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
 * The one line. ARMED requires BOTH a loaded identity config AND durable state
 * — a gate that cannot durably record its own decision mints no certificate and
 * therefore authorises no effect (`state.ts`'s degraded path refuses every
 * RATIFY/DECLINE), so calling that "armed" would be the line lying.
 */
export function buildStartupLine(facts: StartupFacts): string {
  const parts: string[] = [];

  const identityOk = facts.identity.kind === "ok";
  const armed = identityOk && facts.stateDurable;

  if (armed) {
    parts.push(
      `atlas: GATE ARMED — ratifier principal ${maskId(facts.ratifierPrincipal)} ` +
        `(${facts.ratifierIdCount} platform id(s); ${facts.selfIdCount} self id(s))`,
    );
  } else if (!identityOk) {
    const refusal = facts.identity.kind === "refused" ? facts.identity.reason : "unknown";
    const detail = facts.identity.kind === "refused" ? facts.identity.detail : "";
    parts.push(
      `atlas: GATE UNARMED (${refusal}) — every RATIFY/DECLINE will be IGNORED. ${detail}`,
    );
  } else {
    parts.push(
      "atlas: GATE UNARMED (state-degraded) — the identity config loaded, but durable state " +
        "did not open, so no ratification can be recorded or certified and every " +
        "RATIFY/DECLINE will be refused",
    );
  }

  if (facts.effects.kind === "ok") {
    const cfg = facts.effects.config;
    parts.push(
      `effects: plan=${cfg.plan.repo}#${cfg.plan.issue} channel=${maskId(cfg.channelId)} ` +
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
