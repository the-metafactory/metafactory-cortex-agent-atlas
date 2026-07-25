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
 */

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

/**
 * The gate's identity configuration. Held by ratify.ts; `null` anywhere on
 * this path means the gate is UNCONFIGURED and every verb is refused.
 */
export interface RatifyIdentityConfig {
  /** The one principal id allowed to ratify (spec §10 q3 — MVP is one). */
  readonly ratifierPrincipalId: string;
  readonly principals: PrincipalResolver;
  readonly self: SelfIdentity;
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
 * Returns `null` — the fail-closed value — if ANY of the three is missing or
 * yields nothing usable. In particular, an unset `ATLAS_SELF_PLATFORM_IDS` is
 * a hard failure and not an empty set: a deployment that has not told Atlas
 * which identity is its own cannot be allowed to run a gate whose third rule
 * is "Atlas's own messages can never satisfy it".
 */
export function loadIdentityConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RatifyIdentityConfig | null {
  const principalId = (env.ATLAS_RATIFIER_PRINCIPAL ?? "").trim();
  if (principalId.length === 0) return null;

  const ratifierActors = parsePlatformActors(env.ATLAS_RATIFIER_PLATFORM_IDS);
  if (ratifierActors.length === 0) return null;

  const selfActors = parsePlatformActors(env.ATLAS_SELF_PLATFORM_IDS);
  if (selfActors.length === 0) return null;

  const principals = new StaticPrincipalMap(
    ratifierActors.map((actor) => ({ actor, principalId })),
  );
  if (!principals.knows(principalId)) return null;

  return {
    ratifierPrincipalId: principalId,
    principals,
    self: new StaticSelfIdentity(selfActors),
  };
}
