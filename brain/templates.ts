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
    `To ratify: RATIFY ${displayId}`,
    `To decline: DECLINE ${displayId} <why>`,
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
    `Format: "${verb}: <github issue url> — <why>".`
  );
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
