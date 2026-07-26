/**
 * The plan-body revision identity (atlas#26).
 *
 * ── The defect this exists to fix ────────────────────────────────────────────
 * Reconcile's detector (c) ("a plan-body revision with no matching ➕/➖
 * event") used to identify a revision by GitHub's issue `updatedAt`
 * (`reconcile.ts`, `apply.ts`). That field advances on ANY activity on the
 * issue — comments, label/assignee changes, state changes, and
 * cross-references from other issues and PRs — not only on body edits. So a
 * public, comment-friendly plan issue produced a false "plan body revised
 * outside Atlas" finding on every ordinary discussion.
 *
 * The fix: derive the revision from the BODY ITSELF. Two reads of an
 * unedited body always hash to the same value regardless of how many times
 * `updatedAt` moved in between, and a real out-of-band edit still changes
 * the hash — so the detector keeps meaning exactly what it needs to mean:
 * "this body differs from the one I last accounted for".
 *
 * ONE implementation, used by both `reconcile.ts` (reads) and `apply.ts`
 * (writes) — never two, so the two sides of the atomic pair can never
 * disagree about what a revision is.
 */

import { createHash } from "node:crypto";

/**
 * Every value this module produces starts with this prefix. It is also the
 * migration signal (atlas#26): a stored revision that does NOT start with
 * this prefix predates the fix — it is a legacy `updatedAt` ISO timestamp,
 * not a body hash — and reconcile's migration path (see `reconcile.ts`,
 * detector (c)) keys off exactly that distinction to re-baseline instead of
 * reporting drift.
 */
export const PLAN_REVISION_PREFIX = "sha256:";

/**
 * Derive a plan-body revision from the body text. Line endings are
 * normalised first (`\r\n` → `\n`) so a benign CRLF/LF round-trip through
 * GitHub's API is never mistaken for a body change.
 */
export function planBodyRevision(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  return `${PLAN_REVISION_PREFIX}${digest}`;
}

/**
 * True when `revision` was produced by `planBodyRevision` — as opposed to a
 * legacy GitHub `updatedAt` timestamp recorded before atlas#26's fix.
 */
export function isHashedPlanRevision(revision: string): boolean {
  return typeof revision === "string" && revision.startsWith(PLAN_REVISION_PREFIX);
}
