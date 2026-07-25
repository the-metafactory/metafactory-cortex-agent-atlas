/**
 * The ratification CERTIFICATE — the type-level enforcement of the epic's
 * hardest invariant (issue #3 acceptance bullet 6, spec §5): *no `applied`
 * transition is reachable in code without a stored ratification event.*
 *
 * ── Why a branded type and not a boolean/flag ────────────────────────────────
 * A boolean ("this was ratified, honest") is a claim a caller can fabricate by
 * accident — a refactor, a defaulted parameter, a `true` typed in the wrong
 * place. The invariant here must survive a careless caller, because the caller
 * that matters (W2c, the effects slice) is the one that edits the public plan
 * body and posts to the public channel. So:
 *
 *   1. `RatificationCertificate` carries a brand keyed on a `unique symbol`
 *      that is DECLARED but never EXPORTED from this module. No code outside
 *      this file can name that key, so no object literal, JSON.parse result,
 *      or cast-from-interface outside this file produces a value TypeScript
 *      accepts as a certificate.
 *
 *      This is a SPEED BUMP, not a wall, and the limits are worth naming
 *      precisely (an adversarial review found them): `as unknown as` is the
 *      obvious escape hatch, but so are `structuredClone(cert)` and
 *      `Object.assign({}, cert)` — both are typed generically enough to
 *      return the branded type with no cast at all, and `Object.assign`
 *      additionally erases every `readonly`. So the type is the first line of
 *      defence and nothing more.
 *   2. Therefore the brand is ALSO enforced at runtime, by identity: `mint`
 *      records each certificate it creates in a module-private `WeakSet`, and
 *      `certificateMatchesStorage` refuses any object that is not in it. A
 *      clone, a spread, a hand-built literal and a `JSON.parse` round-trip are
 *      all different objects, so none of them are in the set. There is no
 *      exported way to add to it.
 *   3. The ONLY exported producer is `requireRatification`, and it does not
 *      take the caller's word for anything: it re-reads the DURABLE record
 *      through the `RatificationReader` port and mints a certificate only from
 *      what storage actually says. A certificate is therefore not "permission
 *      granted", it is "a stored ratification event was observed just now".
 *   4. `state.ts`'s `markApplied` takes ONLY a certificate (there is no
 *      overload taking a bare work-item id) PLUS the CONFIGURED ratifier, and
 *      STILL re-reads storage and compares it field-by-field before
 *      transitioning — see `certificateMatchesStorage`. The expected-ratifier
 *      parameter closes the gap that a certificate on its own says a
 *      ratification happened, but not that the RIGHT person made it; a caller
 *      cannot forget to check, because it cannot call without supplying the
 *      answer.
 *
 *      That parameter was a bare `string` until issue #7, which made it
 *      VACUOUSLY satisfiable: `markApplied(cert, cert.ratifierPrincipalId)`
 *      returned `true`, so the most natural W2c call-site typo answered the
 *      question from the very certificate under inspection, with no type or
 *      lint signal. It is now identity.ts's `ConfiguredRatifier` — a branded
 *      witness minted only when a config is built — so that call no longer
 *      compiles, and a hand-cast look-alike is refused by the same WeakSet
 *      discipline this file uses for certificates.
 *
 * ── Why the port instead of importing state.ts ─────────────────────────────
 * `RatificationReader` is deliberately the narrowest possible view of the
 * store (one read method). It keeps this module all but dependency-free — the
 * ONLY import is identity.ts's configured-ratifier witness, and identity.ts is
 * itself a leaf that imports nothing — so `state.ts` still imports these types
 * rather than the other way round, the dependency graph is still a DAG, and the
 * certificate's provenance rules cannot be diluted by a cycle.
 */

import { isConfiguredRatifier, type ConfiguredRatifier } from "./identity";

/**
 * Declared, never exported. The key of the brand below. Outside this module
 * the property is unnameable, so the interface is structurally unsatisfiable
 * by any honest value construction.
 */
declare const RATIFICATION_BRAND: unique symbol;

/**
 * Proof that a ratification event for a specific work item was observed in
 * durable storage. Unforgeable outside this module (see file header) and
 * required by every code path that produces a real effect.
 */
export interface RatificationCertificate {
  readonly [RATIFICATION_BRAND]: "atlas.ratification.v1";
  readonly workItemId: string;
  /** The human-facing `RATIFY <id>` number this certificate belongs to. */
  readonly displayId: number;
  /** The principal id (from the cortex principal-map), never a display name. */
  readonly ratifierPrincipalId: string;
  readonly ratifierPlatform: string;
  /** The AUTHENTICATED platform user id that carried the verb. */
  readonly ratifierPlatformId: string;
  /** The platform message id the verb arrived on — the audit receipt. */
  readonly messageId: string;
  readonly ratifiedAt: number;
}

/**
 * The durable shape written into the work item's notes (`$.ratification`) and
 * mirrored in the `work_item_ratified` event payload. Plain data — it crosses
 * a JSON boundary, so every field is re-validated on read (see state.ts's
 * `parseStoredRatification`).
 */
export interface StoredRatification {
  readonly principal: string;
  readonly platform: string;
  readonly platformId: string;
  readonly messageId: string;
  readonly displayId: number;
  readonly ts: number;
}

/**
 * The narrowest view of the store this module needs. `AtlasProposals`
 * satisfies it structurally; a test can satisfy it with four lines.
 */
export interface RatificationReader {
  /**
   * The durable ratification for a work item, or `null` when there is none.
   * Implementations MUST require BOTH the stored `$.ratification` note and a
   * matching append-only `work_item_ratified` event — one without the other
   * is drift, and drift on this path fails closed.
   */
  readRatification(workItemId: string): StoredRatification | null;
}

/**
 * The one and only way to obtain a `RatificationCertificate`. Returns `null`
 * — never throws, matching the no-throw-on-precondition discipline the rest
 * of this brain follows — when storage has no ratification for the id, which
 * includes every "the DB is degraded/memory-only" case (see state.ts's
 * `MemoryProposals`: degraded mode deliberately records no ratification, so it
 * can mint no certificate, so it can cause no effect).
 */
export function requireRatification(
  reader: RatificationReader,
  workItemId: string,
): RatificationCertificate | null {
  const stored = reader.readRatification(workItemId);
  if (stored === null) return null;
  return mint(workItemId, stored);
}

/**
 * Every certificate this module has ever minted, by object identity. A
 * `WeakSet` so certificates stay garbage-collectable, and module-private so
 * there is no exported way to add to it: a clone, a spread, an `Object.assign`
 * result, a `JSON.parse` round-trip and a hand-written literal are all
 * different objects, and none of them are members.
 */
const MINTED = new WeakSet<object>();

/**
 * True iff `cert` is a certificate this process minted AND it still matches
 * what storage says, field for field, AND the ratifier is the principal the
 * caller expects. The runtime backstop for the type-level guarantee — called
 * by `markApplied` immediately before the transition, so a certificate that
 * was valid minutes ago cannot authorise an apply against a record that has
 * since changed, and a certificate naming the wrong ratifier cannot authorise
 * one at all.
 *
 * `expectedRatifier` is REQUIRED, not optional, and is a `ConfiguredRatifier`
 * rather than a string. A certificate on its own attests that a ratification is
 * stored; only the CONFIGURATION knows which principal the gate is armed for,
 * so only the configuration can close the remaining question. Requiring the
 * branded witness means the answer cannot be sourced from the certificate under
 * inspection (`markApplied(cert, cert.ratifierPrincipalId)` does not compile),
 * and a cast-alike is refused here by identity.ts's own WeakSet.
 */
export function certificateMatchesStorage(
  reader: RatificationReader,
  cert: RatificationCertificate,
  expectedRatifier: ConfiguredRatifier,
): boolean {
  if (!MINTED.has(cert)) return false;
  if (!isConfiguredRatifier(expectedRatifier)) return false;
  const expectedRatifierPrincipalId = expectedRatifier.principalId;
  if (
    typeof expectedRatifierPrincipalId !== "string" ||
    expectedRatifierPrincipalId.length === 0 ||
    cert.ratifierPrincipalId !== expectedRatifierPrincipalId
  ) {
    return false;
  }
  const stored = reader.readRatification(cert.workItemId);
  if (stored === null) return false;
  return (
    stored.principal === cert.ratifierPrincipalId &&
    stored.platform === cert.ratifierPlatform &&
    stored.platformId === cert.ratifierPlatformId &&
    stored.messageId === cert.messageId &&
    stored.displayId === cert.displayId &&
    stored.ts === cert.ratifiedAt
  );
}

/** Module-private. Never exported — see file header, points 2 and 3. */
function mint(workItemId: string, stored: StoredRatification): RatificationCertificate {
  const cert = Object.freeze({
    workItemId,
    displayId: stored.displayId,
    ratifierPrincipalId: stored.principal,
    ratifierPlatform: stored.platform,
    ratifierPlatformId: stored.platformId,
    messageId: stored.messageId,
    ratifiedAt: stored.ts,
  });
  MINTED.add(cert);
  // The single cast in the codebase that produces a branded certificate. It is
  // reachable only from `requireRatification`, only after a durable read.
  return cert as unknown as RatificationCertificate;
}
