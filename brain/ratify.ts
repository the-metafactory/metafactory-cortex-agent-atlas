/**
 * Atlas's RATIFICATION GATE (W2b, issue #3; the-metafactory/vision#9 §2
 * constitution rule 3, §3 J2, §7). This is the single boundary between
 * arbitrary public input and real effects on a public plan. Everything in this
 * file is written to fail closed.
 *
 * ── The order of checks is the security property ────────────────────────────
 * `processGateMessage` runs these in this order, and the order is not an
 * implementation detail — it is the design:
 *
 *   0. Is the gate configured at all?      no  → refuse everything
 *   1. Is the author ATLAS ITSELF?         yes → refuse, audit, STOP
 *   2. Has this message id been decided?   yes → refuse (replay)
 *   3. Does the author's AUTHENTICATED platform id resolve, via the cortex
 *      principal-map, to the ONE configured ratifier principal?   no → refuse
 *   4. ... and only NOW is the message body parsed.
 *
 * Step 1 before step 4 is issue #3 item 3, verbatim ("rejected BEFORE parse").
 * The practical consequence: there is no parse path — no verb, no id, no
 * whitespace trick, no unicode variant — that an Atlas-authored message can
 * take to reach a transition, because the parser is never called on it. The
 * self-block is not a rule the parser enforces; it is a rule that makes the
 * parser unreachable. Likewise step 3 before step 4 means untrusted bodies are
 * never parsed at all: the parser is dead code for everyone but the principal.
 *
 * ── Constitution rule 3: what is ACTUALLY enforced (issue #7, finding 6) ────
 * Step 1 also runs before step 3, which matters for a specific
 * misconfiguration: if a config somehow listed Atlas's own platform id among
 * the ratifier principal's `platform_ids`, the self-block still wins. (Tested —
 * see "self-block wins over a misconfigured principal-map".)
 *
 * That ordering used to be the WHOLE of the claim, and the claim was overstated.
 * It held only while `ATLAS_SELF_PLATFORM_IDS` was correct and current, and
 * nothing checked the self set and the ratifier map were disjoint. With a STALE
 * self id (bot-token rotation, a re-invite, or an operator projecting the
 * application id instead of the bot user id) plus Atlas's CURRENT id among the
 * ratifier's `platform_ids`, this function returned `{kind: "ratified"}` for a
 * message Atlas authored — two individually defensible config facts composing
 * into a rule-3 violation. So, precisely:
 *
 *   ENFORCED (structural). A config in which any (platform, id) appears in BOTH
 *   `ATLAS_SELF_PLATFORM_IDS` and the ratifier's `platform_ids` is REFUSED at
 *   load with the named reason `self-and-ratifier-platform-ids-overlap`
 *   (identity.ts). A refused config is `null` here, so the gate is not armed and
 *   every verb is ignored. The check is not order-dependent and cannot be
 *   "configured around", because the config does not load at all.
 *
 *   ENFORCED (ordering, defence in depth). If such a config is nevertheless
 *   constructed in-process (the ports seam, `identityConfigFromPorts`), step 1
 *   still refuses Atlas-authored messages before parse — and
 *   `authorizeRatifierAction` re-checks the self-block a second time before any
 *   transition can be authorised.
 *
 *   NOT ENFORCED, and not enforceable here. If `ATLAS_SELF_PLATFORM_IDS` names
 *   an id Atlas no longer posts under, while its CURRENT id is a legitimate,
 *   non-overlapping entry in the ratifier's `platform_ids`, nothing static can
 *   see it: the config never states Atlas's true current id, so there is no
 *   disagreement to detect. Closing that requires the surface adapter to assert
 *   at start-up that the id it is authenticated as is in the self set — a
 *   wiring-time check, on a wiring site (`brain/main.ts`) this pack does not yet
 *   have. Recorded here so the claim is not read as stronger than it is.
 *
 * ── Identity: authenticated ids only ────────────────────────────────────────
 * The ONLY identity input to any decision is `authorPlatform` + `authorId`,
 * the platform-authenticated user id, resolved through the `PrincipalResolver`
 * port (identity.ts explains what the cortex principal-map actually is).
 * `authorDisplayName` is accepted on the input type — because the host has it
 * and audit records benefit from it — and is read by exactly one line in this
 * file, the audit-payload builder. It never reaches a comparison. Display
 * names are attacker-chosen strings; on Discord anyone can rename themselves to
 * the principal's exact display name in one click.
 *
 * ── Replies: never an oracle, never an amplifier ────────────────────────────
 * Only the configured principal can cause Atlas to emit a reply from this
 * file. Everyone else — including someone posting a perfectly well-formed
 * `RATIFY 1` — gets `{ kind: "ignored" }`: no reply, no transition, and no
 * distinguishable response between "wrong person", "no such id", and "not a
 * command". A rejected outsider learns nothing about the queue's contents and
 * cannot use Atlas to spam the channel.
 *
 * ── Replies must also be TRUE (issue #6) ────────────────────────────────────
 * Failing closed is not the same as being honest, and the two were not both
 * held. An independent adversarial review confirmed two cases where a storage
 * error made this file tell the principal something untrue — a `null` from the
 * state layer was read as "nothing happened" when it could equally mean
 * "committed, but I could not read it back" or "I cannot see storage at all".
 * So there are now three distinct outcomes where there was one, and each says
 * only what is actually known:
 *
 *   nothing committed, queue readable   → `stale`                (absent)
 *   nothing committed, queue unreadable → `state-unavailable`    (degraded)
 *   COMMITTED, certificate unreadable   → `ratified-not-certified`
 *
 * The effects posture is unchanged by all of this: a certificate is minted
 * only from a durable read, and the third outcome above deliberately carries
 * none. Nothing here became more permissive; the replies became true.
 *
 * ── This file still causes no effects ───────────────────────────────────────
 * As with W2a, this module returns descriptions of replies; it has no posting
 * capability, no gh handle, and no import that could acquire one. The one
 * thing it produces that a later slice acts on is a `RatificationCertificate`
 * — and that certificate is minted by `ratification.ts` from a durable
 * read-back, never from this file's own belief that the gate passed.
 */

import { authorizeRatifierAction, type RatifyIdentityConfig } from "./identity";
import {
  requireRatification,
  type RatificationCertificate,
} from "./ratification";
import { gateMessageKey, type AtlasProposals } from "./state";
import {
  commandTooLongReply,
  declinedByRatifierAck,
  nothingToRatifyReply,
  ratifiedAck,
  ratifiedNotCertifiedReply,
  stateDegradedReply,
} from "./templates";

// ── Bounds ──────────────────────────────────────────────────────────────────
/** Bounded prefix scan — O(1) shape probe regardless of body size. */
const PREFIX_SCAN_LEN = 40;
const MAX_BODY_LEN = 10_000;
const MAX_REASON_LEN = 2_000;

/**
 * The grammar. Both are ASCII literals, anchored, case-sensitive.
 *
 * Deliberate choices, each one a rejected attack:
 *   - `^` + a bounded run of ASCII whitespace: the verb must be the LEADING
 *     token sequence. "I think you should RATIFY 3 later" never matches.
 *   - `[ \t\r\n]` rather than `\s`: `\s` in JavaScript matches NBSP (U+00A0),
 *     line/paragraph separators, and other unicode spaces, which would let a
 *     look-alike-whitespace prefix reach the verb. ASCII only, and note that
 *     zero-width characters (U+200B, U+FEFF) are not whitespace under EITHER
 *     class, so `​RATIFY 3` fails closed too.
 *   - The verb is a literal, and NOTHING in this file calls `.normalize()`,
 *     `.toUpperCase()`, `.toLowerCase()`, or any similarity function. So
 *     `ratify`, `Ratify`, `RATİFY` (U+0130), `ＲＡＴＩＦＹ` (fullwidth) and
 *     Cyrillic-homoglyph spellings are all simply not this verb.
 *   - `[ \t]+` between verb and id — not `\s+`. A newline may not separate a
 *     verb from its argument; that is a shape a quoted message can produce.
 *   - `[1-9][0-9]{0,8}`: ASCII digits only (so `RATIFY ３` fails), no leading
 *     zeros (`RATIFY 03` fails), no sign, no decimal point, and bounded so the
 *     value is always a safe integer.
 *   - RATIFY is terminated by `$` after optional trailing whitespace, so it
 *     takes NO trailing content at all: `RATIFY 3 later`, `RATIFY 1 2`,
 *     `RATIFY ALL` and `RATIFY 3; RATIFY 4` are all non-commands. (`$` without
 *     the `m` flag matches only true end-of-input in JavaScript, so there is
 *     no trailing-newline smuggling as there would be in Perl/Python.)
 *   - DECLINE's reason group is `[\s\S]+`, unbounded HERE because the whole
 *     body is already bounded by `MAX_BODY_LEN` above and the reason is
 *     truncated to `MAX_REASON_LEN` after the match. An explicit `{1,4000}`
 *     here was WRONG twice over (adversarial review): a 4001-char reason under
 *     the 10 000-char body cap silently failed to match, so the principal's
 *     long decline became `not-a-command` — total silence, no reply, no
 *     audit; and the bounded-repetition group adjacent to the greedy `[ \t]+`
 *     backtracked superlinearly (~50 ms on a ~10 KB crafted body). With a
 *     plain `+` anchored at `$`, the match is one forward pass.
 *   - No pattern here carries the `g` or `y` flag, so none of them holds
 *     `lastIndex` state between calls.
 */
const RATIFY_RE = /^[ \t\r\n]{0,20}RATIFY[ \t]+([1-9][0-9]{0,8})[ \t\r\n]*$/;
const DECLINE_RE = /^[ \t\r\n]{0,20}DECLINE[ \t]+([1-9][0-9]{0,8})[ \t]+([\s\S]+)$/;

/** The O(1) probe: does this even open with a verb token? Audit-gating + fast reject. */
const VERB_SHAPE_RE = /^[ \t\r\n]{0,20}(RATIFY|DECLINE)[ \t]/;

/**
 * A DECLINE whose reason STARTS with a bare integer is ambiguous — "DECLINE 1
 * 2 because…" could plausibly mean two ids. Ambiguity on this path is refused
 * rather than resolved. (RATIFY needs no such rule: its `$` anchor already
 * makes a second id a parse failure.)
 */
const LEADING_BARE_INTEGER_RE = /^[0-9]+(?:[ \t\r\n]|$)/;

export type RatifyVerb = "RATIFY" | "DECLINE";

export type ParsedCommand =
  | { verb: "RATIFY"; displayId: number }
  | { verb: "DECLINE"; displayId: number; reason: string };

export type CommandParseResult =
  | { kind: "not-a-command" }
  /**
   * Opens with a real verb token but exceeds `MAX_BODY_LEN`. A distinct result
   * from `not-a-command` on purpose: an earlier version collapsed the two, so
   * an over-cap DECLINE from the principal produced TOTAL SILENCE — no
   * transition, no reply, no audit. Moving that cliff from 4 000 to 10 000
   * (the first fix) only relocated it; giving the case its own outcome removes
   * it, because the caller can now answer instead of ignoring.
   */
  | { kind: "too-long"; verb: RatifyVerb }
  | { kind: "command"; command: ParsedCommand };

/**
 * Parse a message body into a gate command. Pure, total, never throws.
 *
 * Exported for direct testing — but note that in the live path this is only
 * ever reached for messages already proven to come from the configured
 * principal (see the file header). A parser bug is therefore not by itself a
 * privilege escalation; it is still treated as one for review purposes.
 */
export function parseGateCommand(body: string): CommandParseResult {
  if (typeof body !== "string" || body.length === 0) return { kind: "not-a-command" };

  // Bounded probe first: a 5 MB message that doesn't open with a verb costs
  // the same as a 5-byte one.
  const shape = VERB_SHAPE_RE.exec(body.slice(0, PREFIX_SCAN_LEN));
  if (shape === null) return { kind: "not-a-command" };
  if (body.length > MAX_BODY_LEN) {
    // A genuine attempt that is simply too big — answerable, not ignorable.
    return { kind: "too-long", verb: shape[1] as RatifyVerb };
  }

  const ratify = RATIFY_RE.exec(body);
  if (ratify !== null) {
    const displayId = toDisplayId(ratify[1]);
    if (displayId === null) return { kind: "not-a-command" };
    return { kind: "command", command: { verb: "RATIFY", displayId } };
  }

  const decline = DECLINE_RE.exec(body);
  if (decline !== null) {
    const displayId = toDisplayId(decline[1]);
    if (displayId === null) return { kind: "not-a-command" };
    const rawReason = decline[2] ?? "";
    if (LEADING_BARE_INTEGER_RE.test(rawReason)) return { kind: "not-a-command" };
    const reason = rawReason.trim();
    if (reason.length === 0) return { kind: "not-a-command" };
    return {
      kind: "command",
      command: { verb: "DECLINE", displayId, reason: reason.slice(0, MAX_REASON_LEN) },
    };
  }

  return { kind: "not-a-command" };
}

function toDisplayId(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

// ── Gate input / output ─────────────────────────────────────────────────────

export interface GateMessage {
  /** Stable platform message id. The audit receipt AND the replay key. */
  id: string;
  body: string;
  /** Platform name as the principal-map keys it, e.g. `discord`. */
  authorPlatform: string;
  /** The platform-AUTHENTICATED user id. The only identity input to any decision. */
  authorId: string;
  /**
   * Display name. Attacker-controlled on every platform Atlas speaks. Carried
   * for the audit record ONLY — grep this file: it appears in exactly one
   * expression, and that expression builds an event payload.
   */
  authorDisplayName?: string | undefined;
  /**
   * Optionally, the principal the HOST resolved for this author (cortex sets
   * this from the same principal-map). When present it is CROSS-CHECKED
   * against our own resolution and a disagreement fails closed. It is never
   * used as a substitute for our own resolution — a host-supplied "yes, this
   * is the principal" alone can never open the gate.
   */
  hostResolvedPrincipal?: string | null | undefined;
}

export type GateRejectReason =
  /** No principal-map / no configured ratifier / no self-identity. */
  | "gate-unconfigured"
  /** Constitution rule 3 — Atlas authored it. */
  | "self-authored"
  /** This platform message already produced a gate decision. */
  | "replayed-message"
  /** The author's platform id is in no principal's `platform_ids`. */
  | "unmapped-author"
  /** Resolved to a principal, but not the configured ratifier. */
  | "not-the-ratifier"
  /** Our resolution and the host's disagree. */
  | "principal-mismatch"
  /** From the principal, but not a gate verb. */
  | "not-a-command"
  /** From the principal, a real verb, but the body exceeds the cap. */
  | "command-too-long";

export type GateOutcome =
  /** No reply, no transition. Every rejection an outsider can trigger lands here. */
  | { kind: "ignored"; reason: GateRejectReason }
  /** From the principal, for an id that is not currently surfaced. Reply, no transition. */
  | { kind: "stale"; displayId: number; verb: RatifyVerb; reply: string }
  /** From the principal, a real verb, but over the body cap. Reply, no transition. */
  | { kind: "too-long"; verb: RatifyVerb; reply: string }
  /** The gate passed but the store could not durably record it. Reply, no transition. */
  | { kind: "state-unavailable"; displayId: number; verb: RatifyVerb; reply: string }
  /**
   * The ratification DID durably commit, but the certificate read-back failed,
   * so no certificate exists and no effect can follow (issue #6, finding 3).
   * A transition happened; the reply says so. Deliberately carries NO
   * certificate field — there is no shape of this outcome that authorises an
   * effect.
   */
  | { kind: "ratified-not-certified"; workItemId: string; displayId: number; reply: string }
  | {
      kind: "ratified";
      workItemId: string;
      displayId: number;
      certificate: RatificationCertificate;
      reply: string;
    }
  | { kind: "declined"; workItemId: string; displayId: number; reason: string; reply: string };

/**
 * The gate. Call once per inbound message on the plan thread / #iteration-plan
 * / principal DM (spec §3 J2 names those as the accepted channels; WHICH
 * channels are delivered here is the surface adapter's decision, not this
 * file's — this file's job is to be safe no matter what arrives).
 *
 * `config` is `RatifyIdentityConfig | null` on purpose: "the principal-map
 * isn't available" is a first-class, testable input, not an exception, and it
 * resolves to a refusal like everything else.
 */
export function processGateMessage(
  msg: GateMessage,
  config: RatifyIdentityConfig | null,
  state: AtlasProposals,
): GateOutcome {
  // ── 0. Unconfigured gate ────────────────────────────────────────────────
  // No principal-map, no ratifier, no self-identity → nothing can ratify.
  // Note this is checked before the self-block only because without a config
  // there is no self-identity to check against; the outcome is a refusal
  // either way, so no verb can pass.
  if (config === null) {
    return { kind: "ignored", reason: "gate-unconfigured" };
  }
  if (
    typeof msg.authorPlatform !== "string" ||
    typeof msg.authorId !== "string" ||
    msg.authorPlatform.length === 0 ||
    msg.authorId.length === 0
  ) {
    // An author we cannot identify at all. Never parsed, never audited
    // (unbounded), never actioned.
    return { kind: "ignored", reason: "unmapped-author" };
  }

  // ── 1. Constitution rule 3, structurally: Atlas cannot ratify Atlas ──────
  // BEFORE parse. Before principal resolution. Before anything.
  //
  // `isSelf` and `resolve` below are INJECTED implementations, so they are
  // called defensively: a resolver that throws must fail closed, not propagate
  // an exception out of the gate and leave the caller to guess. The shipped
  // implementations are total; a future one (a live cortex config read) may
  // not be.
  const gateKey = gateMessageKey(
    msg.authorPlatform,
    msg.authorId,
    typeof msg.id === "string" ? msg.id : "",
  );
  const isSelf = safely(() => config.self.isSelf(msg.authorPlatform, msg.authorId), true);
  if (isSelf.value) {
    // `isSelf.threw` changes the AUDIT, never the decision — a throwing check
    // still refuses. But it must not write a DURABLE row: a throwing `isSelf`
    // makes EVERY author report as Atlas, and `self-authored` is durably
    // audited, so an outsider would once again drive unbounded durable writes
    // — re-opening the precise vector `DURABLY_AUDITED` exists to close.
    // (Adversarial review demonstrated 200 outsider messages → 200 rows
    // through this path: one fix composing badly with another.)
    auditRejection(state, msg, gateKey, "self-authored", isSelf.threw);
    return { kind: "ignored", reason: "self-authored" };
  }

  // ── 2. Replay defence at the message level ──────────────────────────────
  // (The work-item level is covered structurally by
  // `findSurfacedByDisplayId`'s `status = 'waiting_human'` filter.)
  if (typeof msg.id !== "string" || msg.id.length === 0 || gateKey.length === 0) {
    return { kind: "ignored", reason: "replayed-message" };
  }
  if (state.hasSeenGateMessage(gateKey)) {
    return { kind: "ignored", reason: "replayed-message" };
  }

  // ── 3. Identity, by authenticated platform id only ──────────────────────
  const resolved = safely(
    () => config.principals.resolve(msg.authorPlatform, msg.authorId),
    null,
  ).value;
  if (resolved === null) {
    auditRejection(state, msg, gateKey, "unmapped-author");
    return { kind: "ignored", reason: "unmapped-author" };
  }
  if (resolved !== config.ratifier.principalId) {
    auditRejection(state, msg, gateKey, "not-the-ratifier");
    return { kind: "ignored", reason: "not-the-ratifier" };
  }
  // Defence in depth: if the host told us who this is, both answers must agree.
  // A host that disagrees with the map is a bug or a compromise; either way,
  // stop. (`undefined` = the host offered no opinion, which is not a
  // disagreement. `null` = the host resolved nobody, which IS one.)
  if (msg.hostResolvedPrincipal !== undefined && msg.hostResolvedPrincipal !== resolved) {
    auditRejection(state, msg, gateKey, "principal-mismatch");
    return { kind: "ignored", reason: "principal-mismatch" };
  }

  // ── 4. Only now: parse. ─────────────────────────────────────────────────
  const parsed = parseGateCommand(msg.body);
  if (parsed.kind === "not-a-command") {
    // Ordinary chat from the principal. Silence is correct.
    return { kind: "ignored", reason: "not-a-command" };
  }
  if (parsed.kind === "too-long") {
    // A real attempt Atlas simply cannot accept. The principal gets told, not
    // ignored — silence here is indistinguishable from "Atlas never saw it".
    recordGateDecision(state, msg, gateKey, "gate_command_too_long", { verb: parsed.verb });
    return {
      kind: "too-long",
      verb: parsed.verb,
      reply: commandTooLongReply(parsed.verb, MAX_BODY_LEN),
    };
  }
  const command = parsed.command;

  const lookup = state.lookupSurfacedByDisplayId(command.displayId);
  if (lookup.kind === "unavailable") {
    // Atlas cannot READ the queue. That is a fact about Atlas, not about the
    // queue, and it must not be reported as one (issue #6, finding 2): a
    // single events-table read failure used to land here as
    // `nothingToRatifyReply` — "no proposal with that number is currently
    // awaiting a decision. Nothing was changed." — about a row sitting in
    // `waiting_human` on disk, and kept saying it for every subsequent verb
    // until restart. Same refusal, same absence of effect; honest reply.
    process.stderr.write(
      `atlas: ratify: refusing ${command.verb} ${command.displayId} — state unreadable: ${lookup.reason}\n`,
    );
    return notRecorded(state, msg, gateKey, command.displayId, command.verb);
  }
  if (lookup.kind === "absent") {
    // Unknown id, already ratified, already declined, already applied, or
    // still in intake/validated — one branch, because the query's status
    // filter makes them one case. No transition, one templated reply (the
    // author is the principal, so a reply is not an amplification vector).
    const reply = nothingToRatifyReply(command.verb, command.displayId);
    recordGateDecision(state, msg, gateKey, "gate_nothing_to_ratify", {
      verb: command.verb,
      display_id: command.displayId,
    });
    return { kind: "stale", displayId: command.displayId, verb: command.verb, reply };
  }
  const target = lookup.record;

  // ── 5. Mint the transition authority (issue #7, finding 4) ───────────────
  // The state layer will not accept an identity claim any more — it accepts a
  // `GateAuthority` and reads the identity off it. `authorizeRatifierAction`
  // re-runs the self-block and the principal-map resolution ITSELF rather than
  // trusting the checks above, so the authority attests to what it verified
  // rather than to what its caller says it verified. Nothing is passed in that
  // could name a principal: the recorded principal comes from `config`.
  //
  // Unreachable in practice (steps 1 and 3 already passed on the same inputs),
  // so a `null` here means the injected resolvers disagreed with themselves
  // between two calls. That is a refusal, and no write has been attempted, so
  // `notRecorded`'s two claims — nothing changed, still awaiting a decision —
  // are both true.
  const authority = authorizeRatifierAction(config, {
    platform: msg.authorPlatform,
    platformId: msg.authorId,
    messageId: msg.id,
  });
  if (authority === null) {
    process.stderr.write(
      `atlas: ratify: refusing ${command.verb} ${command.displayId} — identity re-check did not grant a gate authority\n`,
    );
    return notRecorded(state, msg, gateKey, command.displayId, command.verb);
  }

  if (command.verb === "DECLINE") {
    const ok = state.markDeclinedByRatifier(target.id, authority, command.reason);
    if (!ok) {
      return notRecorded(state, msg, gateKey, command.displayId, "DECLINE");
    }
    return {
      kind: "declined",
      workItemId: target.id,
      displayId: command.displayId,
      reason: command.reason,
      reply: declinedByRatifierAck(command.displayId, target, command.reason),
    };
  }

  // RATIFY — surfaced → ratified.
  const stored = state.markRatified(target.id, authority);
  if (stored === null) {
    return notRecorded(state, msg, gateKey, command.displayId, "RATIFY");
  }
  // The certificate is minted from a fresh durable read, NOT from `stored` and
  // certainly not from this function's belief that the gate passed. If that
  // read comes back empty the transition happened but the evidence did not
  // survive — so no certificate, so no effect. Fail closed.
  const certificate = requireRatification(state, target.id);
  if (certificate === null) {
    // FAIL CLOSED on the effect, but do NOT reuse `notRecorded` here (issue
    // #6, finding 3 — the same split brain, one layer up from state.ts).
    // `stored !== null` above means `markRatified` returned a value it read
    // back INSIDE its own committing transaction: the ratification is durably
    // committed, full stop. This is therefore a second, post-commit fallible
    // read, and `stateDegradedReply`'s "Nothing was changed and the proposal
    // is still awaiting a decision; send the verb again" would be false on all
    // three counts. Say what actually happened instead.
    recordGateDecision(state, msg, gateKey, "gate_state_unavailable", {
      verb: "RATIFY",
      display_id: command.displayId,
      ratification_committed: true,
    });
    process.stderr.write(
      `atlas: ratify: RATIFY ${command.displayId} committed but could not be read back — no certificate minted, no effect will follow\n`,
    );
    return {
      kind: "ratified-not-certified",
      workItemId: target.id,
      displayId: command.displayId,
      reply: ratifiedNotCertifiedReply(command.displayId),
    };
  }
  return {
    kind: "ratified",
    workItemId: target.id,
    displayId: command.displayId,
    certificate,
    reply: ratifiedAck(command.displayId, target),
  };
}

/**
 * The gate passed but the transition did not happen. Deliberately NOT named
 * "degraded": a degraded store is the common cause but not the only one (a
 * precondition the state layer refuses also lands here, as does "the queue is
 * unreadable"), and the reply must not assert a cause it cannot know. What it
 * CAN assert, and what matters, is that nothing changed and the proposal is
 * still awaiting a decision.
 *
 * ── Both of those claims are now GUARANTEED, not merely intended ────────────
 * Every caller of this helper is a path on which no write committed:
 *   - `markDeclinedByRatifier === false` — its writes and its return value are
 *     one transaction; a throw rolls back and `run` reports false.
 *   - `markRatified === null` — since issue #6 its read-back happens inside the
 *     committing transaction, so a failure un-writes rather than contradicts.
 *   - `lookup.kind === "unavailable"` — a read, no writes attempted.
 *   - `authorizeRatifierAction === null` (issue #7) — an identity re-check that
 *     granted nothing. Pure computation over the config; it touches no store.
 * The one path where a write DID commit (`markRatified` succeeded but the
 * certificate read-back failed) deliberately does NOT come here; it has its own
 * outcome and its own truthful template. If a future caller is added, check it
 * against that list before routing it here.
 */
function notRecorded(
  state: AtlasProposals,
  msg: GateMessage,
  gateKey: string,
  displayId: number,
  verb: RatifyVerb,
): GateOutcome {
  recordGateDecision(state, msg, gateKey, "gate_state_unavailable", {
    verb,
    display_id: displayId,
  });
  return {
    kind: "state-unavailable",
    displayId,
    verb,
    reply: stateDegradedReply(verb, displayId),
  };
}

/**
 * Audit a refused attempt.
 *
 * ── What gets a DURABLE row, and why not everything ─────────────────────────
 * `recordGateEvent` is a durable write driven by inbound messages, so anything
 * an outsider can trigger is an unbounded DB-growth vector — and, because
 * `hasSeenGateMessage` scans that same table with a JSON predicate no index
 * covers, growth an attacker controls is ALSO a per-message slowdown for
 * everyone (measured by adversarial review at ~7000× on 100k rows). An earlier
 * version gated only on verb SHAPE, which narrowed the population to "anyone
 * willing to type RATIFY 1" — not a bound at all.
 *
 * So the durable audit is restricted to the two refusals whose volume is
 * bounded by a trusted party:
 *   - `self-authored`   — bounded by Atlas's own posting rate, and required
 *                          explicitly by issue #3 ("rejected, event logged").
 *   - `principal-mismatch` — only reachable when our own map DID resolve the
 *                          author to the configured ratifier, so bounded by
 *                          the principal.
 * The unbounded pair (`unmapped-author`, `not-the-ratifier`) goes to stderr:
 * operator-visible, rotated by the daemon's log handling, no DB growth, no
 * scan cost, and no attacker-controlled `n`.
 *
 * Shape is inspected here, outside step 4, purely to keep even the stderr line
 * off ordinary chat. The DECISION was already made and returned by the caller
 * regardless of anything this function finds.
 */
const DURABLY_AUDITED: ReadonlySet<GateRejectReason> = new Set<GateRejectReason>([
  "self-authored",
  "principal-mismatch",
]);

function auditRejection(
  state: AtlasProposals,
  msg: GateMessage,
  gateKey: string,
  reason: GateRejectReason,
  /**
   * Set when this refusal came from a `safely` FALLBACK rather than a real
   * answer. Such a refusal is correct but not attributable — and, critically,
   * its population is attacker-sized rather than trusted-party-sized, so it
   * must never take the durable branch.
   */
  fromFailClosedFallback = false,
): void {
  if (typeof msg.body !== "string") return;
  if (!VERB_SHAPE_RE.test(msg.body.slice(0, PREFIX_SCAN_LEN))) return;

  if (fromFailClosedFallback || !DURABLY_AUDITED.has(reason)) {
    process.stderr.write(
      `atlas: ratify: refused (${reason}) from ${msg.authorPlatform}:${msg.authorId}\n`,
    );
    return;
  }
  // One audit row per message, even under redelivery. (The self-block runs
  // BEFORE the replay check — issue #3 item 3 is explicit that the author
  // check is first — so without this, a redelivered Atlas message would be
  // audited twice.)
  if (gateKey.length === 0 || state.hasSeenGateMessage(gateKey)) return;
  state.recordGateEvent("ratification_gate_rejected", {
    reason,
    gate_message_id: gateKey,
    author_platform: msg.authorPlatform,
    author_platform_id: msg.authorId,
    // The ONLY read of the display name in this file. Recorded so an audit can
    // show what an impersonation attempt called itself; never compared.
    author_display_name: msg.authorDisplayName ?? "",
  });
}

/** Audit a decision that produced a reply but no work-item transition. */
function recordGateDecision(
  state: AtlasProposals,
  msg: GateMessage,
  gateKey: string,
  type: string,
  extra: Record<string, unknown>,
): void {
  state.recordGateEvent(type, {
    ...extra,
    gate_message_id: gateKey,
    author_platform: msg.authorPlatform,
    author_platform_id: msg.authorId,
  });
}

/**
 * Call an INJECTED predicate and fail closed on any throw. `fallback` is
 * always the refusing answer (`true` for "is this Atlas?", `null` for "which
 * principal is this?"), so a resolver that blows up denies rather than
 * escaping as an exception the caller has to remember to catch.
 *
 * Returns `{ value, threw }` rather than a bare value because callers need to
 * distinguish the two: the DECISION is the same either way, but a fallback
 * answer is not evidence of anything and must not be recorded as though it
 * were. See `auditRejection`'s `fromFailClosedFallback`.
 */
function safely<T>(fn: () => T, fallback: T): { value: T; threw: boolean } {
  try {
    return { value: fn(), threw: false };
  } catch (err) {
    process.stderr.write(
      `atlas: ratify: identity check threw, failing closed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { value: fallback, threw: true };
  }
}
