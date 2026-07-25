/**
 * Atlas validate — checks an already-shape-valid `ParsedProposal` against
 * GitHub ground truth (W2a, the-metafactory/vision#9 §3 J1). This file never
 * sees comments that failed intake.ts's grammar — that population is handled
 * entirely in intake.ts / proposal.ts and never reaches here.
 *
 * ── Check order (first failure wins, exactly one reason reported) ──────────
 *   1. the URL resolves to a real issue                → "issue not found"
 *   2. ADD:    the issue is open                        → "issue not open"
 *      REMOVE: the URL is currently on the plan body     → "not on the plan"
 *   3. ADD only: the URL is NOT already on the plan body → "already on the plan"
 *      (REMOVE has no analogous third check — presence on the plan body IS
 *      its check 2, so there is nothing further to verify)
 *
 * `getPlanBody()` is called lazily — only once we know we need it — so a
 * not-found URL costs exactly one gh call, not two. See gh.test.ts /
 * validate.test.ts for the exact call-count assertions per case.
 */

import type { ParsedProposal } from "./intake";
import type { ReadOnlyGh } from "./gh";

export type ValidationFailureReason =
  | "issue not found"
  | "issue not open"
  | "already on the plan"
  | "not on the plan";

export type ValidationResult =
  // `issueOpen` rides along on success so callers (proposal.ts → state.ts's
  // markValidated annotation) don't need a second gh.getIssue call just to
  // record the ground-truth read they already have — for REMOVE this can
  // legitimately be `false` (removing a since-closed item is still valid).
  | { ok: true; issueOpen: boolean }
  | { ok: false; reason: ValidationFailureReason };

export async function validateProposal(
  proposal: ParsedProposal,
  gh: ReadOnlyGh,
): Promise<ValidationResult> {
  const info = await gh.getIssue(proposal.url);
  if (info === null || !info.exists) {
    return { ok: false, reason: "issue not found" };
  }

  if (proposal.verb === "ADD") {
    if (!info.open) {
      return { ok: false, reason: "issue not open" };
    }
    const body = await gh.getPlanBody();
    if (body.includes(proposal.url)) {
      return { ok: false, reason: "already on the plan" };
    }
    return { ok: true, issueOpen: true };
  }

  // REMOVE — no open/closed requirement (see ITERATION.md: removals include
  // "superseded, refuted, out of iteration", not only closed issues).
  const body = await gh.getPlanBody();
  if (!body.includes(proposal.url)) {
    return { ok: false, reason: "not on the plan" };
  }
  return { ok: true, issueOpen: info.open };
}
