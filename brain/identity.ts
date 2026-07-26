/**
 * Atlas identity resolution for the ratification gate (W2b, issue #3 item 2;
 * spec §7 "Principal identity for RATIFY is checked against the configured
 * principal mapping (cortex principal-map), not display names").
 *
 * ── What the "cortex principal-map" actually is ─────────────────────────────
 * Verified against cortex directly (src/common/policy/policy-gate.ts): there
 * is no file called `principal-map`. The map is `policy.principals[]` in the
 * cortex config, indexed at runtime by `PlatformPrincipalIndex`, whose key is
 * exactly `` `${platform}:${platformId}` `` and whose values are principal
 * ids. Two facts about that structure are load-bearing here:
 *
 *   - A `PolicyPrincipal` has NO name/display_name field at all. There is
 *     nothing in the map to resolve a display name against, by construction.
 *     Display names live on `InboundMessage.authorName`, documented in cortex
 *     as "display name for prompt context" — never an identity input.
 *   - `platform_ids` holds opaque, platform-authenticated ids (Discord
 *     snowflakes). cortex's own schema refuses to let one (platform, id) tuple
 *     belong to two principals.
 *
 * `PrincipalResolver` below is the port with exactly that contract. The MVP
 * implementation (`StaticPrincipalMap`) is built from the ONE principal the
 * deployment names (spec §10 q3: "MVP ships with one"), projected into the
 * brain's environment stack-side — the same `__PLACEHOLDER__` discipline
 * escort uses for its Discord identifiers, and the reason this brain declares
 * `secrets: []`. A later slice may swap in a live `PlatformPrincipalIndex`
 * read without touching ratify.ts, because ratify.ts depends on this port and
 * not on where the rows came from.
 *
 * ── Exact match, no normalisation, ever ─────────────────────────────────────
 * Both the platform name and the platform id are compared with `===` against
 * values captured at construction. Nothing here lowercases, trims, unicode-
 * normalises, or numerically coerces an id: a Discord snowflake is a STRING,
 * and `"007" == 7` style coercion is precisely the class of bug that turns an
 * identity check into a suggestion. A host that hands us `"Discord"` when the
 * map says `"discord"` therefore fails CLOSED (resolves to nobody) rather than
 * being helpfully corrected — on this path, unhelpful is correct.
 *
 * ── This module is the ONLY place an identity conclusion can be minted ──────
 * (issue #7, findings 4 and 6.) Two branded witnesses live here, both built on
 * the same idiom the ratification certificate uses — an unexported
 * `unique symbol` brand plus a module-private `WeakSet` — because both encode
 * a claim that must not be constructible by a caller that simply asserts it:
 *
 *   - `ConfiguredRatifier` — "this principal id came from the deployment's
 *     identity CONFIGURATION". It exists so `markApplied`'s expected-ratifier
 *     argument cannot be satisfied from the certificate under inspection:
 *     `markApplied(cert, cert.ratifierPrincipalId)` no longer type-checks,
 *     because a `string` is not a `ConfiguredRatifier`, and a hand-cast
 *     look-alike is not in the WeakSet.
 *   - `GateAuthority` — "these identity checks were really run, just now, for
 *     this actor, against this config". It exists so `markRatified` /
 *     `markDeclinedByRatifier` cannot be driven by a caller that never went
 *     through the gate: the principal a ratification is recorded under is now
 *     READ OFF the authority (i.e. off the configuration), never taken from a
 *     caller-supplied string.
 *
 * Neither witness has an exported mint. `authorizeRatifierAction` is the only
 * producer of a `GateAuthority`, and it re-runs the self-block and the
 * principal-map resolution itself rather than believing its caller — so
 * "the gate is the only place identity CAN be checked" is now a property of
 * the code, not of the fact that nobody else happens to call it.
 *
 * ── Self / ratifier disjointness is checked at LOAD (issue #7, finding 6) ────
 * Constitution rule 3 ("Atlas can never ratify Atlas") used to be conditional
 * on `ATLAS_SELF_PLATFORM_IDS` being correct: nothing checked that the self set
 * and the ratifier's `platform_ids` were disjoint, so two individually
 * defensible config facts could compose into a rule-3 violation. Any id present
 * in BOTH sets now REFUSES the whole config with a named reason, so a
 * deployment cannot be talked into a config where the question "is this Atlas
 * or is this the ratifier?" has two answers. See `loadIdentityConfig`.
 */

/**
 * Where a refusal / diagnostic from this module goes. Prefixed like the rest of
 * the brain's stderr so an operator can grep one token.
 */
function warn(msg: string): void {
  process.stderr.write(`atlas: identity: ${msg}\n`);
}

export interface PlatformActor {
  readonly platform: string;
  /** The AUTHENTICATED platform user id. Never a display name, never a role. */
  readonly id: string;
}

/**
 * Platform user id → principal id. The ONLY identity question this brain is
 * allowed to ask. There is deliberately no `resolveByName`, no `resolveByRole`
 * and no fuzzy variant on this interface: an absent method cannot be called by
 * a future careless caller.
 */
export interface PrincipalResolver {
  /** `null` for anything not explicitly mapped. Never throws. */
  resolve(platform: string, platformId: string): string | null;
  /** Is this principal id present in the map at all? Used to reject a gate configured against a principal nobody can be. */
  knows(principalId: string): boolean;
}

/** Is this actor Atlas itself? Constitution rule 3's structural half. */
export interface SelfIdentity {
  isSelf(platform: string, platformId: string): boolean;
}

/**
 * The map key. LENGTH-PREFIXED, not `${platform}:${platformId}`.
 *
 * cortex's own `PlatformPrincipalIndex` uses the plain colon form, and for
 * Discord snowflakes (digits only) that is unambiguous. It is not unambiguous
 * in general: with a plain colon, ("web", "urn:mf:1") and ("web:urn", "mf:1")
 * collapse to the same key — and `parsePlatformActors` below deliberately
 * SUPPORTS colon-bearing ids. Since identity.ts's whole promise is "exact
 * match, no normalisation, ever", a many-to-one key would be that promise
 * quietly not holding. Prefixing the platform's length makes the encoding
 * injective. (Found by adversarial review; not reachable on Discord today.)
 *
 * The disjointness check below compares SETS OF THIS KEY, so "the same id"
 * means the same (platform, id) tuple — the same thing the resolver and the
 * self-check mean by it, and not a looser string comparison that would flag
 * an unrelated id that happens to be shared across two platforms.
 */
function key(platform: string, platformId: string): string {
  return `${platform.length}:${platform}:${platformId}`;
}

/** Reject blank/whitespace-only components — a blank id must never match. */
function usable(actor: PlatformActor): boolean {
  return (
    typeof actor.platform === "string" &&
    typeof actor.id === "string" &&
    actor.platform.trim().length > 0 &&
    actor.id.trim().length > 0 &&
    actor.platform === actor.platform.trim() &&
    actor.id === actor.id.trim()
  );
}

/**
 * The MVP principal-map: a frozen set of (platform, id) → principal entries.
 * Unusable entries (blank, padded) are dropped at construction rather than
 * stored and skipped later — an entry that cannot be matched safely should not
 * exist in the map at all.
 */
export class StaticPrincipalMap implements PrincipalResolver {
  private readonly byPlatformId: ReadonlyMap<string, string>;
  private readonly principals: ReadonlySet<string>;

  constructor(entries: ReadonlyArray<{ actor: PlatformActor; principalId: string }>) {
    const m = new Map<string, string>();
    const p = new Set<string>();
    for (const entry of entries) {
      if (!usable(entry.actor)) continue;
      if (typeof entry.principalId !== "string" || entry.principalId.trim().length === 0) continue;
      if (entry.principalId !== entry.principalId.trim()) continue;
      const k = key(entry.actor.platform, entry.actor.id);
      // First declaration wins — mirrors cortex's PlatformPrincipalIndex
      // (`if (!m.has(key))`), so a duplicated tuple can never be re-pointed at
      // a different principal by appending to the config.
      if (!m.has(k)) m.set(k, entry.principalId);
      p.add(entry.principalId);
    }
    this.byPlatformId = m;
    this.principals = p;
  }

  resolve(platform: string, platformId: string): string | null {
    if (typeof platform !== "string" || typeof platformId !== "string") return null;
    if (platform.length === 0 || platformId.length === 0) return null;
    return this.byPlatformId.get(key(platform, platformId)) ?? null;
  }

  knows(principalId: string): boolean {
    return typeof principalId === "string" && this.principals.has(principalId);
  }
}

/** Atlas's own platform identities — the ids its own posts are authored by. */
export class StaticSelfIdentity implements SelfIdentity {
  private readonly ids: ReadonlySet<string>;

  constructor(actors: ReadonlyArray<PlatformActor>) {
    const s = new Set<string>();
    for (const a of actors) {
      if (!usable(a)) continue;
      s.add(key(a.platform, a.id));
    }
    this.ids = s;
  }

  isSelf(platform: string, platformId: string): boolean {
    if (typeof platform !== "string" || typeof platformId !== "string") return false;
    if (platform.length === 0 || platformId.length === 0) return false;
    return this.ids.has(key(platform, platformId));
  }
}

/**
 * A self-identity that recognises nobody. Used ONLY as the explicit,
 * documented choice in tests that are not exercising the self-block — never as
 * a production default, because "Atlas has no identity configured" must be a
 * gate-unconfigured failure, not a silently disabled constitution rule.
 */
export class NoSelfIdentity implements SelfIdentity {
  isSelf(): boolean {
    return false;
  }
}

/**
 * `platform:id` pairs, comma or whitespace separated, e.g.
 * `discord:<SNOWFLAKE>,discord:<SNOWFLAKE>`. Anything that
 * isn't exactly one `platform:id` pair is DROPPED, not guessed at. Note the
 * split is on the FIRST colon only, so an id containing a colon survives
 * intact rather than being silently truncated.
 */
export function parsePlatformActors(raw: string | undefined): PlatformActor[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const out: PlatformActor[] = [];
  for (const token of raw.split(/[,\s]+/)) {
    if (token.length === 0) continue;
    const colon = token.indexOf(":");
    if (colon <= 0 || colon === token.length - 1) continue;
    const platform = token.slice(0, colon);
    const id = token.slice(colon + 1);
    const actor = { platform, id };
    if (!usable(actor)) continue;
    out.push(actor);
  }
  return out;
}

// ── The configured-ratifier witness (issue #7, finding 4b) ──────────────────

/**
 * Declared, never exported — the same idiom as `ratification.ts`'s certificate
 * brand, and for the same reason: outside this module the property is
 * unnameable, so no object literal, `JSON.parse` result, or cast-from-interface
 * elsewhere produces a value TypeScript accepts.
 */
declare const CONFIGURED_RATIFIER_BRAND: unique symbol;

/**
 * "This principal id came from the deployment's identity configuration."
 *
 * The point of the type is what it makes IMPOSSIBLE at the call site.
 * `markApplied`'s second argument used to be a bare `string`, so the most
 * natural W2c typo — `markApplied(cert, cert.ratifierPrincipalId)` — satisfied
 * the expected-ratifier check self-referentially, with no type or lint signal.
 * That call no longer compiles: a `string` is not a `ConfiguredRatifier`, and
 * the only values of this type are the ones minted below, when a config is
 * built. Compile-time prevention first; the WeakSet is the runtime backstop for
 * a deliberate `as unknown as` cast, exactly as it is for the certificate.
 */
export interface ConfiguredRatifier {
  readonly [CONFIGURED_RATIFIER_BRAND]: "atlas.configured-ratifier.v1";
  /** The principal id the gate is configured for. Readable; not constructible. */
  readonly principalId: string;
}

/** Every configured-ratifier witness this module has minted, by object identity. */
const CONFIGURED_RATIFIERS = new WeakSet<object>();

/** True iff `v` is a witness THIS module minted (not a cast-alike). */
export function isConfiguredRatifier(v: unknown): v is ConfiguredRatifier {
  return typeof v === "object" && v !== null && CONFIGURED_RATIFIERS.has(v);
}

/** Module-private. There is deliberately no exported way to mint one. */
function mintConfiguredRatifier(principalId: string): ConfiguredRatifier {
  const witness = Object.freeze({ principalId });
  CONFIGURED_RATIFIERS.add(witness);
  return witness as unknown as ConfiguredRatifier;
}

// ── The gate-authority witness (issue #7, finding 4) ────────────────────────

/** Declared, never exported. See the note on `CONFIGURED_RATIFIER_BRAND`. */
declare const GATE_AUTHORITY_BRAND: unique symbol;

/**
 * Proof that the gate's identity checks were run — here, now, against a real
 * config — and that this actor IS the configured ratifier.
 *
 * `principal` is derived from the CONFIG (`config.ratifier.principalId`), never
 * from anything the caller passed in. That is the whole point: `markRatified`
 * used to take a caller-supplied `principal` string with zero validation, so a
 * caller that never touched ratify.ts, identity.ts or a `GateMessage` could
 * record a ratification by any principal it cared to name, then mint a genuine
 * certificate from it. It cannot any more: the state layer will not accept
 * anything but one of these, and one of these cannot be obtained without
 * passing the checks.
 */
export interface GateAuthority {
  readonly [GATE_AUTHORITY_BRAND]: "atlas.gate-authority.v1";
  /** The configured ratifier principal id — read off the config, not the caller. */
  readonly principal: string;
  readonly platform: string;
  /** The AUTHENTICATED platform user id that carried the verb. */
  readonly platformId: string;
  /** The platform message id the verb arrived on — the audit receipt. */
  readonly messageId: string;
}

/** Every authority this module has granted, by object identity. */
const GRANTED_AUTHORITIES = new WeakSet<object>();

/** True iff `v` is an authority THIS module granted (not a cast-alike). */
export function isGateAuthority(v: unknown): v is GateAuthority {
  return typeof v === "object" && v !== null && GRANTED_AUTHORITIES.has(v);
}

/**
 * The ONE producer of a `GateAuthority`, and the only way any caller can reach
 * a `waiting_human` → ratified/declined transition.
 *
 * It does not take the caller's word for anything it can check itself:
 *
 *   1. the config must carry a real configured-ratifier witness;
 *   2. the actor's platform + id + message id must be non-empty strings;
 *   3. constitution rule 3 FIRST — an actor Atlas recognises as itself is
 *      refused before the principal-map is even consulted, so the ordering
 *      that makes rule 3 unconfigurable-around in `processGateMessage` is
 *      reproduced here rather than assumed;
 *   4. the principal-map must resolve the actor to EXACTLY the configured
 *      ratifier principal.
 *
 * Injected ports may throw (a future live cortex-config read might); a throw is
 * a refusal, never an exception escaping into the caller. `null` is the only
 * failure value — matching the no-throw-on-precondition discipline the rest of
 * this brain follows.
 *
 * This deliberately DUPLICATES checks `processGateMessage` already ran. That is
 * the design: the authority must attest to checks it performed, not to checks
 * its caller claims to have performed, or it is back to being a promise.
 */
export function authorizeRatifierAction(
  config: RatifyIdentityConfig | null,
  actor: { platform: string; platformId: string; messageId: string },
): GateAuthority | null {
  if (config === null || typeof config !== "object") return null;
  if (!isConfiguredRatifier(config.ratifier)) return null;
  const principalId = config.ratifier.principalId;
  if (typeof principalId !== "string" || principalId.length === 0) return null;

  const platform = actor?.platform;
  const platformId = actor?.platformId;
  const messageId = actor?.messageId;
  if (
    typeof platform !== "string" ||
    typeof platformId !== "string" ||
    typeof messageId !== "string" ||
    platform.length === 0 ||
    platformId.length === 0 ||
    messageId.length === 0
  ) {
    return null;
  }

  // Rule 3 first. A throwing self-check answers "yes, this is Atlas", which
  // refuses — the same fail-closed fallback `processGateMessage` uses.
  let isSelf = true;
  try {
    isSelf = config.self.isSelf(platform, platformId) === true;
  } catch {
    isSelf = true;
  }
  if (isSelf) return null;

  let resolved: string | null = null;
  try {
    resolved = config.principals.resolve(platform, platformId);
  } catch {
    resolved = null;
  }
  if (resolved === null || resolved !== principalId) return null;

  const authority = Object.freeze({
    // From the CONFIG, never from the caller.
    principal: principalId,
    platform,
    platformId,
    messageId,
  });
  GRANTED_AUTHORITIES.add(authority);
  return authority as unknown as GateAuthority;
}

/**
 * The gate's identity configuration. Held by ratify.ts; `null` anywhere on
 * this path means the gate is UNCONFIGURED and every verb is refused.
 *
 * `ratifier` is a branded witness rather than a bare `string` (issue #7): the
 * expected-ratifier check downstream must be answerable only from
 * CONFIGURATION, and a plain field would be satisfiable from the certificate
 * being checked.
 */
export interface RatifyIdentityConfig {
  readonly ratifier: ConfiguredRatifier;
  readonly principals: PrincipalResolver;
  readonly self: SelfIdentity;
}

/** Why a config was refused. Each value is a named, greppable cause. */
export type IdentityConfigRefusal =
  /** `ATLAS_RATIFIER_PRINCIPAL` missing or blank. */
  | "missing-ratifier-principal"
  /** `ATLAS_RATIFIER_PLATFORM_IDS` yielded no usable `platform:id` pair. */
  | "no-usable-ratifier-platform-ids"
  /** `ATLAS_SELF_PLATFORM_IDS` yielded no usable `platform:id` pair. */
  | "no-usable-self-platform-ids"
  /** The named principal is in no map entry — a gate nobody could satisfy. */
  | "ratifier-principal-unmapped"
  /**
   * An id appears in BOTH Atlas's own set and the ratifier's `platform_ids`.
   * Constitution rule 3 and the principal-map disagree about who that identity
   * is; a deployment in that state is refused rather than resolved.
   */
  | "self-and-ratifier-platform-ids-overlap";

/** The result of building a config: the config, or a NAMED refusal. */
export type IdentityConfigLoad =
  | { kind: "ok"; config: RatifyIdentityConfig }
  | { kind: "refused"; reason: IdentityConfigRefusal; detail: string };

/**
 * Build a config from ACTOR LISTS — the shape the environment (and any future
 * live cortex-config read) produces, and the only shape in which self/ratifier
 * disjointness is decidable: the check needs to enumerate both sets, which an
 * arbitrary `PrincipalResolver`/`SelfIdentity` port cannot be asked to do.
 *
 * Refuses, with a named reason, rather than repairing anything.
 */
export function makeIdentityConfig(input: {
  ratifierPrincipalId: string;
  ratifierActors: ReadonlyArray<PlatformActor>;
  selfActors: ReadonlyArray<PlatformActor>;
}): IdentityConfigLoad {
  const principalId = typeof input.ratifierPrincipalId === "string" ? input.ratifierPrincipalId.trim() : "";
  if (principalId.length === 0) {
    return {
      kind: "refused",
      reason: "missing-ratifier-principal",
      detail: "no ratifier principal id was configured",
    };
  }

  const ratifierActors = input.ratifierActors.filter(usable);
  if (ratifierActors.length === 0) {
    return {
      kind: "refused",
      reason: "no-usable-ratifier-platform-ids",
      detail: `no usable platform:id pair for principal ${principalId}`,
    };
  }

  const selfActors = input.selfActors.filter(usable);
  if (selfActors.length === 0) {
    return {
      kind: "refused",
      reason: "no-usable-self-platform-ids",
      detail: "Atlas's own platform ids are unset — constitution rule 3 would be unenforceable",
    };
  }

  // ── The disjointness check (issue #7, finding 6) ──────────────────────────
  // Two individually defensible facts — "this is Atlas" and "this is the
  // ratifier" — must never be asserted about the SAME (platform, id). If they
  // are, rule 3 is only holding because `processGateMessage` happens to check
  // the self-block first; that ordering is deliberate and tested, but it should
  // not be the ONLY thing standing between a config edit and Atlas ratifying
  // Atlas. Refuse the config instead.
  const selfKeys = new Set(selfActors.map((a) => key(a.platform, a.id)));
  const overlapping = ratifierActors.filter((a) => selfKeys.has(key(a.platform, a.id)));
  if (overlapping.length > 0) {
    const listed = overlapping.map((a) => `${a.platform}:${a.id}`).join(", ");
    return {
      kind: "refused",
      reason: "self-and-ratifier-platform-ids-overlap",
      detail:
        `${listed} is listed BOTH as Atlas's own identity and among principal ` +
        `${principalId}'s platform ids; constitution rule 3 cannot be enforced ` +
        `against a config that says the same identity is both`,
    };
  }

  const principals = new StaticPrincipalMap(
    ratifierActors.map((actor) => ({ actor, principalId })),
  );
  if (!principals.knows(principalId)) {
    return {
      kind: "refused",
      reason: "ratifier-principal-unmapped",
      detail: `principal ${principalId} is in no map entry`,
    };
  }

  return {
    kind: "ok",
    config: {
      ratifier: mintConfiguredRatifier(principalId),
      principals,
      self: new StaticSelfIdentity(selfActors),
    },
  };
}

/**
 * Build a config around INJECTED ports.
 *
 * The seam for tests and for a future live `PlatformPrincipalIndex` read.
 * Deliberately named for what it cannot do: a port is a function, not a set, so
 * the self/ratifier disjointness check above is not decidable here and is NOT
 * performed. Production configuration comes from `loadIdentityConfig`, which
 * goes through `makeIdentityConfig` and therefore IS checked; anything reaching
 * for this function is choosing to skip that check and should say why. (Same
 * posture as `NoSelfIdentity` above: an explicit, documented test affordance,
 * never a production default.)
 */
export function identityConfigFromPorts(input: {
  ratifierPrincipalId: string;
  principals: PrincipalResolver;
  self: SelfIdentity;
}): RatifyIdentityConfig | null {
  const principalId =
    typeof input.ratifierPrincipalId === "string" ? input.ratifierPrincipalId.trim() : "";
  if (principalId.length === 0) return null;
  return {
    ratifier: mintConfiguredRatifier(principalId),
    principals: input.principals,
    self: input.self,
  };
}

/**
 * Build the identity config from the daemon environment:
 *
 *   ATLAS_RATIFIER_PRINCIPAL     principal id, e.g. `<principal-id>` — MUST match the
 *                                `policy.principals[].id` in the cortex config
 *   ATLAS_RATIFIER_PLATFORM_IDS  that principal's `platform_ids`, projected as
 *                                `discord:<snowflake>` pairs
 *   ATLAS_SELF_PLATFORM_IDS      Atlas's OWN platform ids (constitution rule 3)
 *
 * Refuses — with a named reason — if any of the three is missing or yields
 * nothing usable, if the named principal maps to nobody, or if the self set and
 * the ratifier's platform ids OVERLAP. In particular, an unset
 * `ATLAS_SELF_PLATFORM_IDS` is a hard failure and not an empty set: a
 * deployment that has not told Atlas which identity is its own cannot be
 * allowed to run a gate whose third rule is "Atlas's own messages can never
 * satisfy it".
 */
export function loadIdentityConfig(
  env: Record<string, string | undefined> = process.env,
): IdentityConfigLoad {
  return makeIdentityConfig({
    ratifierPrincipalId: (env.ATLAS_RATIFIER_PRINCIPAL ?? "").trim(),
    ratifierActors: parsePlatformActors(env.ATLAS_RATIFIER_PLATFORM_IDS),
    selfActors: parsePlatformActors(env.ATLAS_SELF_PLATFORM_IDS),
  });
}

// ── Principal-only admission (atlas#47) ─────────────────────────────────────

/**
 * Is this authenticated (platform, id) the SAME identity the ratification
 * gate would recognise as its ONE configured principal?
 *
 * This is the entire contract of `ATLAS_PRINCIPAL_ONLY` (`runtime.ts`'s fourth
 * admission dimension): "the author is in the ratifier's set", nothing more.
 * It is deliberately built from the EXACT two fields `processGateMessage`'s own
 * step 3 compares (`config.principals.resolve(...)` against
 * `config.ratifier.principalId`) rather than a second lookup, so "who may
 * ratify" and "who Atlas admits" cannot silently drift apart — the failure
 * class named in atlas#47 (and the same one #28/#34 name for other pairs of
 * "the same fact, asked twice").
 *
 * There is no self-block here, and none is needed: `makeIdentityConfig`
 * refuses at load if any (platform, id) appears in BOTH
 * `ATLAS_SELF_PLATFORM_IDS` and the ratifier's `platform_ids`
 * (`self-and-ratifier-platform-ids-overlap`), so a config that reaches this
 * function already guarantees Atlas's own id can never resolve to the
 * configured principal. Re-checking it here would be a second enforcement of
 * a property the config's own admission already makes structurally true —
 * exactly the kind of duplicated-instead-of-shared check this function exists
 * to avoid introducing elsewhere.
 *
 * Fail-closed on a throwing resolver, same posture as `ratify.ts`'s `safely()`
 * — a broken `PrincipalResolver` denies rather than propagating.
 */
export function isConfiguredPrincipal(
  config: RatifyIdentityConfig,
  platform: string,
  platformId: string,
): boolean {
  if (typeof platform !== "string" || typeof platformId !== "string") return false;
  if (platform.length === 0 || platformId.length === 0) return false;
  let resolved: string | null = null;
  try {
    resolved = config.principals.resolve(platform, platformId);
  } catch {
    resolved = null;
  }
  return resolved !== null && resolved === config.ratifier.principalId;
}

/**
 * `loadIdentityConfig`, collapsed to the fail-closed value the gate consumes.
 * `null` means "no gate": `processGateMessage` refuses every verb. The named
 * reason is not thrown away — it goes to stderr, because the failure mode this
 * pack most fears is a SILENTLY dead gate.
 */
export function loadIdentityConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RatifyIdentityConfig | null {
  const result = loadIdentityConfig(env);
  if (result.kind === "ok") return result.config;
  warn(
    `REFUSED (${result.reason}) — the ratification gate is NOT armed and every ` +
      `RATIFY/DECLINE will be ignored. ${result.detail}`,
  );
  return null;
}
