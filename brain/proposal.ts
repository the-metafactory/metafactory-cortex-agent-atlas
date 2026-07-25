/**
 * Atlas proposal pipeline — the single entry point that ties intake.ts →
 * validate.ts → state.ts → templates.ts together (W2a, the-metafactory/
 * vision#9 §3 J1, §5). This is the front door: every comment on the plan
 * issue (or #iteration-plan — the surface adapter that delivers comments
 * here is a later slice's job) is processed by calling `processComment`
 * exactly once.
 *
 * ── Zero effects, by construction ───────────────────────────────────────
 * This module has no `send`/`post` capability at all — it returns an
 * `Outcome` describing what a future slice (with an actual effect channel)
 * WOULD do; it never does it itself. The only externally visible actions are:
 *   - reads through `ReadOnlyGh` (validate.ts's two methods — no writes exist
 *     on that interface to call even by accident)
 *   - state transitions through `AtlasProposals` (state.ts) — and only for
 *     comments that at least LOOK like a genuine ADD/REMOVE attempt; ordinary
 *     text creates no work item at all.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 * `id` is the caller-supplied stable key for this comment (see `CommentInput`
 * — a redelivered/reprocessed event must never create a second work item or
 * emit a second reply). `state.ts`'s `createIntake` is itself idempotent
 * (no-op if the row already exists), and this module additionally
 * short-circuits to `{ kind: "duplicate" }` when a prior outcome is already
 * on record, so the pipeline never re-validates or re-declines a comment it
 * has already resolved.
 */

import { parseComment, type ParsedProposal } from "./intake";
import { validateProposal } from "./validate";
import type { ReadOnlyGh } from "./gh";
import { AtlasProposals } from "./state";
import { declinedReply, malformedReply, surfacedSummary } from "./templates";

export interface CommentInput {
  /** Stable, globally unique id for this comment (e.g. `owner/repo#<comment-id>`). */
  id: string;
  body: string;
  /** The commenting user's GitHub login — captured for credit (issue #2 item 2). */
  authorLogin: string;
}

export type ProposalOutcome =
  | { kind: "ignored" }
  | { kind: "duplicate" }
  | { kind: "declined"; reply: string; failedCheck: string }
  | { kind: "surfaced"; reply: string; displayId: number; proposal: ParsedProposal };

export async function processComment(
  input: CommentInput,
  gh: ReadOnlyGh,
  state: AtlasProposals,
): Promise<ProposalOutcome> {
  // Idempotency: a comment this pipeline has already resolved (in any
  // terminal or in-flight phase) is never reprocessed — no second reply, no
  // second state mutation, regardless of why processComment was called again.
  if (state.get(input.id) !== null) {
    return { kind: "duplicate" };
  }

  const result = parseComment(input.body);

  if (result.kind === "ignored") {
    // Not a proposal attempt at all — zero state, zero reply. See
    // intake.ts's file header for why this is the correct default.
    return { kind: "ignored" };
  }

  if (result.kind === "malformed") {
    // A genuine attempt (exact verb + colon) that never reached a valid
    // shape. Recorded straight to `declined` — there is no valid proposal to
    // hold in `intake`/`validated` first.
    const reply = malformedReply(result.verb, result.reason);
    state.createIntake(input.id, result.verb, "", null, `(malformed: ${result.reason})`, input.authorLogin);
    state.markDeclined(input.id, `malformed: ${result.reason}`);
    return { kind: "declined", reply, failedCheck: `malformed: ${result.reason}` };
  }

  // result.kind === "parsed"
  const proposal = result.proposal;
  state.createIntake(
    input.id,
    proposal.verb,
    proposal.url,
    proposal.section,
    proposal.why,
    input.authorLogin,
  );

  const verdict = await validateProposal(proposal, gh);

  if (!verdict.ok) {
    state.markDeclined(input.id, verdict.reason);
    return { kind: "declined", reply: declinedReply(proposal, verdict.reason), failedCheck: verdict.reason };
  }

  state.markValidated(input.id, verdict.issueOpen);
  const displayId = state.markSurfaced(input.id);
  if (displayId === null) {
    // Precondition violation (row vanished or was never validated) — cannot
    // happen on this synchronous, single-caller path, but state.ts's
    // no-throw discipline means this must be handled, not assumed away.
    // Nothing was surfaced; treat it as an internal decline rather than
    // silently losing the proposal.
    const failedCheck = "internal: state transition out of sync";
    state.markDeclined(input.id, failedCheck);
    return {
      kind: "declined",
      reply: `This ${proposal.verb} proposal for ${proposal.url} could not be processed and was not added to the queue.`,
      failedCheck,
    };
  }
  const summary = surfacedSummary(displayId, proposal, input.authorLogin);
  state.recordSummary(input.id, summary);

  return { kind: "surfaced", reply: summary, displayId, proposal };
}
