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

/**
 * ── atlas#34: what a GitHub-authored checkbox tick means ────────────────────
 *
 * GitHub itself ticks a plan's task-list checkbox (`- [ ]` → `- [x]`) the
 * moment a linked issue in the SAME repo closes. Neither Atlas (`apply.ts`
 * never writes `[x]`) nor the shadow harness does this — so the plan body
 * genuinely changes with no matching ➕/➖ ledger entry, and closing linked
 * issues is the plan's ordinary, healthy lifecycle. Reported as drift on every
 * closure, that is the same cry-wolf failure atlas#26 fixed, arriving by a
 * different route: atlas#26 made the revision identity mean "the body really
 * changed"; it never claimed every real change is suspicious.
 *
 * THE DECISION (recorded once, here, so it is never re-litigated in two
 * files that could drift apart): **(c) with (b) as the fallback
 * classification.** A checkbox tick corroborated by Atlas's OWN completion
 * index (`state.hasAnnouncedCompletion` — the exact signal `watch.ts`
 * maintains and `dashboard.ts` already reads, see below) is accounted for:
 * no drift, no post, the revision is recorded and the ledger moves on. A tick
 * that is NOT corroborated — a box ticked while Atlas does not yet believe the
 * referenced issue is closed — is still reported. That is either a race (the
 * watcher has not caught up yet; see the grace-period note below) or a human
 * misrepresenting plan state, and the latter is exactly what the detector
 * exists to catch.
 *
 * Option (a) — normalising checkbox state out of the revision identity
 * entirely — was rejected. It is cheaper, but it makes Atlas permanently
 * BLIND to an uncorroborated tick: a box ticked by hand while the issue stays
 * open would never be seen again, by anyone, ever. (c)/(b) cost one extra
 * lookup against a signal Atlas already maintains, and keep the detector's
 * teeth. `reconcile.ts`'s detector (c) is a mutation-tested guarantee of
 * this — see its test suite's "slide to option (a)" mutation.
 *
 * ── THE SINGLE STATEMENT reconciling `dashboard.ts` and `reconcile.ts` ─────
 * Before this fix the two disagreed: `dashboard.ts` already treated a ticked
 * checkbox as a legitimate closedness signal it CONSUMES (its "open" count
 * falls the moment a box is ticked, same as when `completion_announced`
 * fires); `reconcile.ts` treated the identical byte change as unconditionally
 * suspicious. They now agree, stated ONCE, here, rather than implied in two
 * files: **a ticked checkbox means "closed" exactly when it is corroborated
 * by Atlas's own completion index — the same index in both places, consulted
 * the same way (`hasAnnouncedCompletion` / dashboard's `announced`).**
 * `dashboard.ts` already had no other way to read a tick (it has no notion of
 * "suspicious", only "open" vs "closed"); `reconcile.ts` now defers to the
 * same reading before it will call a tick drift. Neither file restates this
 * paragraph — both cross-reference it.
 *
 * ── Ordering / the race, and why an uncorroborated tick is DEFERRED once ───
 * `watch.ts` polls on its own interval (default 15 min) and reconcile polls on
 * its own, much coarser one (default 6h) — so a tick can land, and reconcile
 * can run, BEFORE the watcher has had its next chance to notice the closure
 * and record it in the completion index. Reporting drift in that window would
 * be exactly the cry-wolf regression atlas#26 was filed to prevent, just
 * relocated: a legitimate GitHub-driven tick, flagged only because Atlas asked
 * too early.
 *
 * So an uncorroborated checkbox-only revision is not reported the FIRST time
 * it is seen — it is silently DEFERRED (recorded as "seen, pending", but
 * deliberately NOT accepted into the accounted-revision set, so the very same
 * revision is re-examined on the next pass rather than being permanently
 * excused). Two things can happen next:
 *   - the watcher catches up and announces the completion before the next
 *     reconcile pass: the SAME revision is now corroborated, and this time it
 *     is accounted for silently — the race resolved itself, and nobody ever
 *     saw a false alarm;
 *   - it is still uncorroborated on the NEXT pass over the SAME revision:
 *     having already been given one full reconcile interval's grace (far
 *     longer than the watcher needs), it is now reported as drift.
 * A single deferral, not an unbounded one: an uncorroborated tick that never
 * resolves is still caught, just one pass later than a non-checkbox edit
 * would be — the cost of not crying wolf on the far more common legitimate
 * case. This is the detail that keeps the fix from being option (a) wearing
 * option (c)'s clothes: a tick that is NEVER corroborated is reported, not
 * silently absorbed.
 */

/** A markdown task-list checkbox marker at the start of a line: `- [ ]`/`- [x]`/`* [X]`/`+ [ ]`. */
const CHECKBOX_MARKER_RE = /^(\s*[-*+][ \t]+)\[[ xX]\]/;
/** The same marker, TICKED specifically. */
const CHECKBOX_TICKED_RE = /^\s*[-*+][ \t]+\[[xX]\]/;
/** The same URL grammar `watch.ts`/`dashboard.ts` extract linked issues with. */
const ISSUE_URL_RE =
  /https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/issues\/[1-9][0-9]{0,9}/g;

/**
 * `body` with every task-list checkbox marker collapsed to a single canonical
 * form (`[ ]`), regardless of its ticked state. Two bodies that are byte-
 * identical except for checkbox state normalise to the SAME text; anything
 * else that differs — added/removed lines, edited prose, a new linked issue —
 * still differs after normalisation. That is the whole trick: it lets a hash
 * comparison answer "did anything OTHER than checkbox state change?" without
 * ever storing or diffing a plan body's raw text.
 */
export function planBodyChecklistNormalized(body: string): string {
  const normalized = typeof body === "string" ? body.replace(/\r\n/g, "\n") : "";
  return normalized
    .split("\n")
    .map((line) => line.replace(CHECKBOX_MARKER_RE, "$1[ ]"))
    .join("\n");
}

/**
 * The checkbox-insensitive twin of `planBodyRevision`. Two revisions produced
 * by this function are equal iff the two bodies are identical except for
 * task-list checkbox markers — which is exactly the comparison detector (c)
 * needs to tell "only GitHub's tick changed this" from "something else did".
 */
export function planBodyRevisionNormalized(body: string): string {
  return planBodyRevision(planBodyChecklistNormalized(typeof body === "string" ? body : ""));
}

/** Every DISTINCT GitHub issue URL currently ticked as done in `body`'s task list. */
export function tickedLinkedIssueUrls(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    if (!CHECKBOX_TICKED_RE.test(line)) continue;
    for (const m of line.matchAll(new RegExp(ISSUE_URL_RE.source, "g"))) {
      const url = m[0];
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/**
 * The last plan-body revision reconcile has been able to account for — either
 * because it examined it directly (a previous `reconcile_completed` pass) or
 * because an Atlas apply produced it (`work_item_resolved`). `normalized` is
 * `null` when that revision predates atlas#34 (recorded before this field
 * existed) — a caller cannot classify a checkbox-only diff against a baseline
 * whose normalised form was never recorded, so `null` here must be treated the
 * SAME as "no baseline at all", not as "matches anything".
 */
export interface PlanRevisionBaseline {
  readonly normalized: string | null;
}

export type PlanRevisionClassification =
  /** No baseline to diff against, or the diff touches more than checkboxes. */
  | { kind: "unclassified" }
  /**
   * Every difference from the baseline is a checkbox marker. `uncorroborated`
   * lists the ticked, issue-linked lines Atlas's completion index does NOT yet
   * back — empty means every tick is accounted for.
   */
  | { kind: "checkbox-only"; uncorroborated: readonly string[] };

/**
 * Classify the diff between `baseline` (the last body reconcile accounted
 * for) and `body` (the current one). Pure and total — no state, no network —
 * so the interesting cases are unit-testable against fixed strings.
 */
export function classifyPlanRevision(
  body: string,
  revisionNormalized: string,
  baseline: PlanRevisionBaseline | null,
  isCorroborated: (issueUrl: string) => boolean,
): PlanRevisionClassification {
  if (baseline === null || baseline.normalized === null || baseline.normalized !== revisionNormalized) {
    return { kind: "unclassified" };
  }
  const uncorroborated = tickedLinkedIssueUrls(body).filter((url) => !isCorroborated(url));
  return { kind: "checkbox-only", uncorroborated };
}
