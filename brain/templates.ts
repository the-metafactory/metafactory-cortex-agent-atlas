/**
 * Atlas reply templates — plain text only, no compose/voice in this slice
 * (compose is W3b's job; "template text is fine" per issue #2 item 3). These
 * functions never send anything — they return strings; proposal.ts's caller
 * decides what (if anything) happens to the result. There is no effect
 * capability wired into this slice at all.
 *
 * ── Displaying the why-field safely ──────────────────────────────────────
 * `why` is untrusted, arbitrary internet text (see intake.ts's file header).
 * `sanitizeForDisplay` applies two defensive transforms before it is quoted
 * into a human-facing summary:
 *   1. Collapse all newlines/CR to a single space — a multi-line why-field
 *      containing something that LOOKS like a second `ADD:`/`RATIFY` line
 *      can never render as a believable second line of protocol text.
 *   2. Strip backtick runs — prevents the quoted text from opening a
 *      Markdown code fence and visually escaping its own quote marks when
 *      this summary is eventually posted somewhere that renders Markdown
 *      (a later slice's job, but the text is built here).
 * This is display hygiene, not interpretation: the underlying `why` value
 * stored in state (state.ts) and returned by intake.ts is NEVER mutated —
 * only the copy placed in these templates is transformed.
 */

import type { ParsedProposal, ProposalVerb } from "./intake";
import type { ProposalRecord } from "./state";
import type { ValidationFailureReason } from "./validate";

const MAX_DISPLAY_WHY_LEN = 500;

export function sanitizeForDisplay(text: string): string {
  const collapsed = text.replace(/[\r\n]+/g, " ").replace(/`+/g, "'");
  return collapsed.length > MAX_DISPLAY_WHY_LEN
    ? `${collapsed.slice(0, MAX_DISPLAY_WHY_LEN)}…`
    : collapsed;
}

/**
 * The `surfaced` summary — a numbered proposal a human reads and, if they
 * agree, ratifies with the exact verb named here. Composed/voiced prose is a
 * later slice (W3b); this is deterministic template text, always available
 * even with compose disabled (spec §8: "the full loop runs with compose
 * disabled — hybrid is voice, not dependency").
 */
export function surfacedSummary(
  displayId: number,
  proposal: ParsedProposal,
  proposerLogin: string,
): string {
  const sectionLine =
    proposal.section !== null
      ? `Section: ${proposal.section}`
      : "Section: (not specified — a steward may confer with the proposer)";
  return [
    `Proposal #${displayId} — ${proposal.verb}: ${proposal.url}`,
    sectionLine,
    `Proposed by @${proposerLogin}: "${sanitizeForDisplay(proposal.why)}"`,
    "",
    `To ratify: @atlas RATIFY ${displayId}`,
    `To decline: @atlas DECLINE ${displayId} <why>`,
  ].join("\n");
}

/**
 * The one templated decline reply for a proposal that reached validate.ts
 * but failed a ground-truth check (issue #2 item 4: "ONE templated response
 * naming the failed check").
 */
export function declinedReply(proposal: ParsedProposal, reason: ValidationFailureReason): string {
  return (
    `This ${proposal.verb} proposal for ${proposal.url} could not be validated ` +
    `(${reason}) and was not added to the queue.`
  );
}

/**
 * The one templated decline reply for a comment that opened with a real verb
 * but never reached a valid shape at all (intake.ts's "malformed" outcome).
 */
export function malformedReply(verb: ProposalVerb, reason: string): string {
  return (
    `This looked like a ${verb} proposal but couldn't be parsed (${reason}). ` +
    `Format: "@atlas ${verb}: <github issue url> — <why>". ` +
    `Or say "@atlas HELP" to see every command Atlas answers.`
  );
}

// ── HELP (atlas#45) ─────────────────────────────────────────────────────────

/**
 * The `HELP` verb's one reply. Deterministic template text, no compose/voice
 * call — Atlas has no compose voice wired at all in this pack, so a template
 * is the only kind of reply it could produce here regardless.
 *
 * ── Identity-neutral by CONSTRUCTION, not by convention ─────────────────────
 * This function takes NO argument — there is no identity, no principal-check
 * result, no sender-specific fact it could branch on even by accident. Every
 * admitted sender — the configured principal, a known proposer, a total
 * stranger — reaches this exact same string. That is the whole point (see
 * the issue's warning): a help text that says "you may RATIFY" to one reader
 * and "you may propose" to another turns Atlas into an oracle for "am I the
 * principal?", which is precisely the fact the ratification gate exists to
 * protect. So this text describes the PROTOCOL ("the configured principal
 * may RATIFY/DECLINE") and never the reader ("you may…").
 *
 * ── The three causes of silence, named because they are indistinguishable
 *    from outside (issue #45, echoing atlas#17/#22/#24/#25) ─────────────────
 * A user who posts and hears nothing cannot tell "never arrived" from "not
 * admitted" from "not parsed" from "Atlas is down" — so this text enumerates
 * the three causes THIS pack can actually name, rather than leaving the
 * reader guessing which is true. "Not admitted" reflects what is currently
 * enforced on `runtime.ts`'s `serveTask`: channel/thread admission (atlas#22)
 * AND the adapter-instance check (atlas#24) — two dimensions, both silent,
 * both named here rather than only the older, single-dimension version.
 *
 * ── Examples are asserted against the real parsers, not eyeballed ──────────
 * Every `@atlas …` line below is extracted and parsed by
 * `help.test.ts` with `parseComment`/`parseGateCommand` — the same functions
 * `docs-grammar.test.ts` and `templates.test.ts` hold the README and the
 * other templates to — after stripping the mention exactly as the adapter
 * does. A change here that breaks one of those shapes turns that test red.
 */
export function helpText(): string {
  return [
    "Atlas answers four commands, always after an @-mention:",
    "",
    "  @atlas ADD: <github issue url> — <why>",
    "  @atlas REMOVE: <github issue url> — <why>",
    "  @atlas RATIFY <id>",
    "  @atlas DECLINE <id> <reason>",
    "",
    "ADD/REMOVE propose a plan change and come from anyone. RATIFY/DECLINE " +
      "decide a proposal, and only reach the gate from the one configured " +
      "plan-steward principal — everyone else's RATIFY/DECLINE is ignored, " +
      "by design, which is also why this reply cannot say who that is.",
    "",
    "A message that gets no reply at all is exactly one of three things:",
    "  1. it never arrived — Atlas is only ever delivered a message that " +
      "@-mentions it",
    "  2. it wasn't admitted — the channel or thread it came from isn't one " +
      "Atlas listens in, or it came from an adapter instance Atlas doesn't " +
      "recognize",
    "  3. it wasn't parsed — the command has to be the very first thing on " +
      "the line",
    "",
    'Say "@atlas HELP" (or "@atlas help") any time to see this again.',
  ].join("\n");
}

// ── W2b, the ratification gate (issue #3) ──────────────────────────────────
//
// Every template below is reachable ONLY by the configured principal (see
// ratify.ts's file header: no other author can cause Atlas to emit from this
// path). They still route the proposal's `why` through `sanitizeForDisplay`,
// because the proposal text is public input even when the reply's recipient
// is not — the principal's own acknowledgement is exactly where a spoofed
// "second protocol line" would be most convincing.

/**
 * The acknowledgement for `surfaced → ratified`. Deliberately says what has
 * and has NOT happened: on this slice, ratification records the decision; the
 * plan edit and the ledger post are W2c's atomic pair (spec §3 J3). Claiming
 * the effect here would be the reply lying about the system's state.
 */
export function ratifiedAck(displayId: number, record: ProposalRecord): string {
  return [
    `Ratified #${displayId} — ${record.verb}: ${record.url}`,
    `Recorded against your identity. Proposed by @${record.proposer}: "${sanitizeForDisplay(record.why)}"`,
    `The plan update and ledger entry follow as one action.`,
  ].join("\n");
}

/** The acknowledgement for `surfaced → declined`, quoting the principal's reason. */
export function declinedByRatifierAck(
  displayId: number,
  record: ProposalRecord,
  reason: string,
): string {
  return [
    `Declined #${displayId} — ${record.verb}: ${record.url}`,
    `Reason recorded: "${sanitizeForDisplay(reason)}"`,
    `Nothing was changed on the plan. @${record.proposer} — the proposal is closed.`,
  ].join("\n");
}

/**
 * Replay / staleness (issue #3 item 5). One reply for every "not currently
 * surfaced" case — already ratified, already declined, already applied, still
 * in intake/validated, or simply unknown — and deliberately the SAME text for
 * all of them: distinguishing them would turn the gate into an oracle for the
 * queue's contents.
 */
export function nothingToRatifyReply(verb: "RATIFY" | "DECLINE", displayId: number): string {
  return (
    `Nothing to ${verb === "RATIFY" ? "ratify" : "decline"} for #${displayId} — ` +
    `no proposal with that number is currently awaiting a decision. ` +
    `Nothing was changed.`
  );
}

/**
 * A real verb from the principal in a message too large for the gate to
 * accept. Exists so this case is ANSWERED rather than ignored: an unactionable
 * command that produces silence is indistinguishable, from the principal's
 * side, from one Atlas never received. (Adversarial review: the original cap
 * dropped an over-long DECLINE with no reply and no audit; raising the cap
 * only moved the cliff, so the case needed an answer, not a bigger number.)
 */
export function commandTooLongReply(verb: "RATIFY" | "DECLINE", maxLen: number): string {
  const hint =
    verb === "RATIFY"
      ? "a ratification needs only the id"
      : "a decline needs only the id and a brief reason";
  return (
    `That ${verb} was too long for Atlas to accept (limit ${maxLen} characters) ` +
    `and was not actioned. Nothing was changed — send it again shorter; ${hint}.`
  );
}

/**
 * The gate passed but the transition was not durably recorded — the
 * fail-closed branch (see state.ts's `MemoryProposals` block comment).
 *
 * Deliberately does NOT name a cause. A degraded store is the usual reason,
 * but the same branch catches a precondition the state layer refused, and
 * asserting "the store is unavailable" when it is healthy would be the reply
 * lying to the principal (adversarial review caught exactly that). What is
 * always true — and all the principal needs — is that nothing changed, the
 * proposal is still awaiting a decision, and the verb can simply be repeated.
 */
export function stateDegradedReply(verb: "RATIFY" | "DECLINE", displayId: number): string {
  return (
    `Could not record ${verb} ${displayId} — there is no durable record of who ` +
    `authorised it, so Atlas has not acted on it. Nothing was changed and the ` +
    `proposal is still awaiting a decision; send the verb again. If it keeps ` +
    `failing, check Atlas's state store.`
  );
}

/**
 * The ratification DID durably commit, but Atlas could not then re-read it to
 * mint the certificate every effect requires (issue #6, finding 3).
 *
 * This template exists because the alternative was a lie. The old code sent
 * `stateDegradedReply` here — "Nothing was changed and the proposal is still
 * awaiting a decision; send the verb again" — while storage held a committed
 * `work_item_ratified` event. Two things were wrong with that, and the second
 * is the nastier one: the proposal is NO LONGER awaiting a decision, so
 * re-sending the verb (as that reply instructs) gets `nothingToRatifyReply`,
 * i.e. "no proposal with that number is currently awaiting a decision" — the
 * principal is walked from one false statement to a second, contradictory one.
 *
 * So this reply asserts exactly the three facts that are true, and nothing
 * beyond them: the decision is recorded; no plan edit or ledger post has
 * happened; do not re-send. Fail-closed on effects is untouched — no
 * certificate was minted, so there is nothing for W2c to act on.
 */
export function ratifiedNotCertifiedReply(displayId: number): string {
  return (
    `RATIFY ${displayId} IS recorded — your decision was durably stored against ` +
    `your identity. Atlas then could not read that record back, so it has NOT ` +
    `updated the plan or posted a ledger entry, and it will not act until the ` +
    `record is readable again. Do NOT send the verb again — #${displayId} is no ` +
    `longer awaiting a decision. Check Atlas's state store.`
  );
}
