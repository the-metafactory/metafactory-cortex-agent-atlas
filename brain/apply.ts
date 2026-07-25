/**
 * THE ATOMIC PAIR (W2c, issue #1; vision#9 §3 J3; vision CLAUDE.md's
 * map-and-ledger rule: *"Updating the plan issue and posting the corresponding
 * ledger entry are one action, not two tasks"*).
 *
 * This is the first module in the pack that changes something outside Atlas.
 * Everything before it — intake, validation, surfacing, the ratification gate —
 * was read-only or state-internal. So the order of operations below is the
 * design, in the same way the order of checks in ratify.ts is the design.
 *
 * ── The order, and why each step is where it is ────────────────────────────
 *   0. Refuse unless the effect layer is CONFIGURED (one repo, one channel).
 *   1. Refuse unless durable state is readable. No audit trail, no effect.
 *   2. Refuse unless the work item is really in `ratified`.
 *   3. Refuse unless the CERTIFICATE still matches durable storage — checked
 *      HERE, before anything is read from GitHub and long before anything is
 *      written. `markApplied` re-checks it inside its own transaction, but that
 *      check happens AFTER the plan body has already been edited, so it cannot
 *      be the thing that makes "no effect without a certificate" true. This
 *      step is. (`apply.test.ts` proves it with a forged certificate and an
 *      assertion that ZERO gh calls were made.)
 *   4. Read the plan body. Compute a MINIMAL text edit. Write it back.
 *   5. Record `applied` with the body-revision receipt.
 *   6. Post the ledger entry (≤1 retry).
 *   7. Record `posted` with the message-id receipt.
 *
 * ── Why the map is edited BEFORE the state transition ──────────────────────
 * Because the map is the ground truth and Atlas's state is a bookkeeping
 * shadow of it (vision CLAUDE.md: "when the snapshot and the map disagree, the
 * map wins"). If the transition came first, a failed edit would leave Atlas
 * claiming a change that the plan does not contain — a state that ASSERTS
 * something false about a public artifact. In this order the only failure state
 * is Atlas being behind the map, which is recoverable by re-running: the edit
 * is idempotent (an ADD whose URL is already on the plan is a no-op that still
 * yields a revision receipt), so a retry converges instead of double-applying.
 *
 * ── Partial failure PARKS; it never rolls back ─────────────────────────────
 * If the ledger post fails after the body edit, the work item stays in
 * `applied` and this function says so. That is the design, not a gap: a
 * "rollback" would mean a second edit to the public plan body, undoing a change
 * the principal ratified, on the strength of a Discord outage. W3a's reconcile
 * loop is the recovery path — and `applied` (see state.ts's `rowPhase`) is
 * precisely the population it goes looking for.
 *
 * ── Where the ConfiguredRatifier comes from ────────────────────────────────
 * `markApplied` and `markPosted` require identity.ts's branded
 * `ConfiguredRatifier`, which has no exported mint: the ONLY way to hold one is
 * to hold a `RatifyIdentityConfig` built by `loadIdentityConfig` /
 * `identityConfigFromPorts` and read its `.ratifier` field. So this module takes
 * the whole identity config as a dependency and passes `deps.identity.ratifier`
 * through. That is the plumbing issue #7 intended: the expected-ratifier answer
 * has to travel from the DEPLOYMENT'S CONFIG all the way to the transition, and
 * cannot be sourced from the certificate under inspection, because
 * `markApplied(cert, cert.ratifierPrincipalId)` does not type-check. There is no
 * cast anywhere in this file.
 */

import { certificateMatchesStorage, type RatificationCertificate } from "./ratification";
import type { RatifyIdentityConfig } from "./identity";
import type { AtlasProposals, ProposalRecord } from "./state";
import type { EffectsConfig } from "./effects/config";
import type { PlanWriter } from "./effects/gh";
import type { DiscordLedger } from "./effects/discord";

function warn(msg: string): void {
  process.stderr.write(`atlas: apply: ${msg}\n`);
}

/** At most one retry, then park. No timers, no backoff loop, no storm. */
const LEDGER_POST_ATTEMPTS = 2;

export interface ApplyDeps {
  readonly state: AtlasProposals;
  /** The identity config — the ONLY source of a `ConfiguredRatifier`. See the header. */
  readonly identity: RatifyIdentityConfig;
  readonly effects: EffectsConfig;
  readonly gh: PlanWriter;
  readonly ledger: DiscordLedger;
}

export type ApplyRefusal =
  /** The work item id on the certificate is not in storage. */
  | "unknown-work-item"
  /** Durable state is unreadable — no audit trail, therefore no effect. */
  | "state-degraded"
  /** Not in `ratified` (already applied/posted, declined, or never ratified). */
  | "not-ratified"
  /** The certificate no longer matches durable storage, or was never ours. */
  | "certificate-invalid"
  /** The plan body could not be read. Nothing was attempted. */
  | "plan-unreadable"
  /** The edit could not be computed — see `PlanEditRefusal`. Nothing was written. */
  | "edit-refused"
  /** The write (or its receipt read-back) failed. State stays `ratified`. */
  | "plan-write-failed"
  /** The plan WAS edited but the `applied` transition did not record. Drift; W3a. */
  | "apply-not-recorded";

export type ApplyOutcome =
  | { kind: "refused"; reason: ApplyRefusal; detail: string }
  /**
   * The plan body carries the change and the ledger entry landed. Both
   * receipts recorded. This is the only success.
   */
  | {
      kind: "posted";
      workItemId: string;
      revision: string;
      messageId: string;
      /** False when the body already carried the change (an idempotent re-run). */
      bodyChanged: boolean;
    }
  /**
   * Half (a) happened, half (b) did not. PARKED in `applied` — deliberately,
   * see the file header. `postedRecorded` distinguishes the two shapes of this:
   * the post never landed, or it landed and its receipt did not record (which
   * a reconcile must treat as "may double-post", not as "never posted").
   */
  | {
      kind: "applied-not-posted";
      workItemId: string;
      revision: string;
      attempts: number;
      /** True when the post DID land but `markPosted` refused the receipt. */
      postLanded: boolean;
    };

/**
 * Apply ONE ratified proposal: edit the plan body, post the ledger entry.
 *
 * The certificate is the only identifier of the work item — there is no
 * `applyRatified(workItemId: string)` overload, deliberately, exactly as there
 * is no `markApplied(id: string)` one.
 */
export async function applyRatified(
  cert: RatificationCertificate,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  // ── 1. Durable state, or nothing ─────────────────────────────────────────
  if (!deps.state.isDurable()) {
    return refuse("state-degraded", "durable state is unreadable; no effect may follow");
  }

  // ── 2. The work item must really be `ratified` ───────────────────────────
  const record = deps.state.get(cert.workItemId);
  if (record === null) {
    return refuse("unknown-work-item", "no work item for this certificate");
  }
  if (record.phase !== "ratified") {
    // Covers replay (already `applied`/`posted`) as one branch with "never
    // ratified" — the same collapsing ratify.ts does for its stale cases.
    return refuse("not-ratified", `work item is ${record.phase}, not ratified`);
  }

  // ── 3. The certificate, BEFORE any effect ────────────────────────────────
  // This is the check that makes "no effect without a ratification certificate"
  // true. `markApplied` re-checks the same thing later, but by then the plan
  // body has already been edited.
  if (!certificateMatchesStorage(deps.state, cert, deps.identity.ratifier)) {
    return refuse("certificate-invalid", "certificate does not match durable storage");
  }

  // ── 4. Read → compute → write ────────────────────────────────────────────
  const before = await deps.gh.readPlan();
  if (before === null) {
    return refuse("plan-unreadable", "could not read the plan issue body");
  }

  const edit = planBodyEdit(before.body, {
    verb: record.verb,
    url: record.url,
    section: record.section,
  });
  if (edit.kind === "refused") {
    // A ratified proposal Atlas cannot place. It stays `ratified` — visible,
    // re-runnable once a steward names the section — and nothing was written.
    warn(`edit refused for ${record.id}: ${edit.reason}`);
    return refuse("edit-refused", edit.reason);
  }

  let revision = before.revisedAt;
  const bodyChanged = edit.kind === "changed";
  if (edit.kind === "changed") {
    const after = await deps.gh.writePlanBody(edit.body);
    if (after === null) {
      // Either the edit failed, or it succeeded and its receipt read-back did.
      // Both are reported the same way and both are safe: the work item stays
      // `ratified`, and a re-run reads the body again — finding the change
      // already present, which is the `unchanged` branch above.
      return refuse("plan-write-failed", "the plan body edit did not produce a revision receipt");
    }
    revision = after.revisedAt;
  }

  // ── 5. Record `applied` with the body-revision receipt ───────────────────
  const applied = deps.state.markApplied(cert, deps.identity.ratifier, {
    revision,
    ts: Date.now(),
  });
  if (!applied) {
    // The map changed and Atlas could not write that down. Loud, because this
    // is exactly the drift W3a reconciles, and because posting the ledger entry
    // now would compound one unrecorded fact with another.
    warn(
      `PLAN EDITED BUT NOT RECORDED for ${record.id} (revision ${revision}) — ` +
        `the map is ahead of Atlas's state; reconcile is the recovery path`,
    );
    return refuse("apply-not-recorded", `plan revision ${revision} was not recorded`);
  }

  // ── 6. The ledger entry — ≤1 retry, then park ────────────────────────────
  // ONE retry, no backoff, no timer: the failure this is insuring against is a
  // dropped call, and anything more is a retry storm against a channel Atlas
  // shares with people. The honest cost of retrying at all: a transport that
  // DELIVERED and then failed to report the message id turns the retry into a
  // duplicate ledger entry. That is the right trade here — a duplicate ledger
  // line is visible and correctable by an append-only correction post (rule 4),
  // whereas a silently unposted change breaks the map-and-ledger rule until a
  // reconcile notices. Recorded so a reviewer weighs it rather than discovers it.
  let attempts = 0;
  let receipt: Awaited<ReturnType<DiscordLedger["postPlanChange"]>> = null;
  while (attempts < LEDGER_POST_ATTEMPTS && receipt === null) {
    attempts += 1;
    receipt = await deps.ledger.postPlanChange({
      verb: record.verb,
      url: record.url,
      section: record.section,
      proposer: record.proposer,
      why: record.why,
      displayId: record.displayId ?? cert.displayId,
      revision,
    });
  }
  if (receipt === null) {
    warn(
      `ledger post failed after ${attempts} attempt(s) for ${record.id} — parking in ` +
        `applied (revision ${revision}); reconcile is the recovery path`,
    );
    return {
      kind: "applied-not-posted",
      workItemId: record.id,
      revision,
      attempts,
      postLanded: false,
    };
  }

  // ── 7. Record `posted` ───────────────────────────────────────────────────
  const recorded = deps.state.markPosted(cert, deps.identity.ratifier, {
    messageId: receipt.messageId,
    channelId: receipt.channelId,
    ts: receipt.postedAt,
  });
  if (!recorded) {
    // W3a (issue #2): WRITE THE DISTINCTION DOWN, here, where it is known.
    //
    // Both failure branches above park the work item in `applied`, and from
    // storage the two are indistinguishable — same status, same ratification,
    // same `applied` receipt, no `posted` receipt. But they mean opposite
    // things to a reconcile: the branch above never posted, and THIS branch
    // did. Leaving the difference in this function's return value alone meant
    // it died with the process, and a later reconcile had to guess. Guessing
    // wrong here appends a false line to a public append-only ledger.
    //
    // So the marker is recorded before returning. It is deliberately a bare
    // audit event and not a phase change: nothing about the work item's state
    // has changed, only what Atlas knows about the post. If this write ALSO
    // fails (a genuinely degraded store), reconcile's channel cross-check is
    // the second line of defence for the same fact.
    deps.state.recordLedgerPostUnrecorded(record.id, receipt.messageId);
    warn(
      `ledger post ${receipt.messageId} landed but its receipt did not record for ` +
        `${record.id} — the work item stays applied; recorded a post-landed marker so ` +
        `reconcile does not double-post it`,
    );
    return {
      kind: "applied-not-posted",
      workItemId: record.id,
      revision,
      attempts,
      postLanded: true,
    };
  }

  return {
    kind: "posted",
    workItemId: record.id,
    revision,
    messageId: receipt.messageId,
    bodyChanged,
  };
}

function refuse(reason: ApplyRefusal, detail: string): ApplyOutcome {
  return { kind: "refused", reason, detail };
}

// ── The minimal text edit ────────────────────────────────────────────────────

export type PlanEditRefusal =
  /** An ADD with no named section — Atlas will not guess where an item belongs. */
  | "section-unresolved"
  /** The named section is not in the plan body. */
  | "section-not-found"
  /** The named section name matches more than one heading. */
  | "section-ambiguous"
  /** A REMOVE whose URL is present, but not in the named section. */
  | "target-outside-section"
  /** A REMOVE whose URL appears on more than one line — which line was meant? */
  | "target-ambiguous";

export type PlanEditResult =
  | { kind: "changed"; body: string }
  /** The body already says what the proposal asks for. Idempotent re-run. */
  | { kind: "unchanged" }
  | { kind: "refused"; reason: PlanEditRefusal };

export interface PlanEditRequest {
  readonly verb: "ADD" | "REMOVE";
  readonly url: string;
  readonly section: string | null;
}

/**
 * Compute the minimal edit for one ADD/REMOVE against a plan body.
 *
 * PURE and exported, so the exact textual behaviour is testable without a
 * GitHub token, and so `apply.ts`'s effect path has nothing to decide.
 *
 * Minimal means minimal: lines are inserted or deleted whole, everything else
 * in the body — including the parts of the touched section — is byte-identical,
 * and the body is re-joined on the same `\n` boundaries it was split on (a
 * CRLF body keeps its CRLFs because the `\r` rides along on each line).
 *
 * Ambiguity is REFUSED, never resolved. A steward can name the section; Atlas
 * cannot pick one.
 */
export function planBodyEdit(body: string, req: PlanEditRequest): PlanEditResult {
  if (typeof body !== "string") return { kind: "refused", reason: "section-not-found" };
  if (typeof req.url !== "string" || req.url.length === 0) {
    return { kind: "refused", reason: "target-ambiguous" };
  }
  const lines = body.split("\n");
  const mentions = lines
    .map((line, i) => (lineMentionsUrl(line, req.url) ? i : -1))
    .filter((i) => i >= 0);

  if (req.verb === "ADD") {
    // Already on the plan → nothing to do. This is what makes a re-run after a
    // failed receipt read-back safe rather than double-applying.
    if (mentions.length > 0) return { kind: "unchanged" };
    if (req.section === null) return { kind: "refused", reason: "section-unresolved" };
    const section = findSection(lines, req.section);
    if (section.kind !== "found") return { kind: "refused", reason: section.reason };
    const at = insertionPoint(lines, section.start, section.end);
    const inserted = `- [ ] ${req.url}${lineEnding(lines, at)}`;
    const next = [...lines.slice(0, at), inserted, ...lines.slice(at)];
    return { kind: "changed", body: next.join("\n") };
  }

  // REMOVE
  if (mentions.length === 0) return { kind: "unchanged" }; // already off the plan
  let target: number;
  if (req.section === null) {
    if (mentions.length > 1) return { kind: "refused", reason: "target-ambiguous" };
    target = mentions[0]!;
  } else {
    const section = findSection(lines, req.section);
    if (section.kind !== "found") return { kind: "refused", reason: section.reason };
    const inSection = mentions.filter((i) => i >= section.start && i < section.end);
    if (inSection.length === 0) return { kind: "refused", reason: "target-outside-section" };
    if (inSection.length > 1) return { kind: "refused", reason: "target-ambiguous" };
    target = inSection[0]!;
  }
  const next = [...lines.slice(0, target), ...lines.slice(target + 1)];
  return { kind: "changed", body: next.join("\n") };
}

/**
 * Does this line reference exactly this issue URL?
 *
 * The trailing-digit guard is load-bearing: a plain `includes` would let
 * `…/issues/1` match a line carrying `…/issues/10`, so a REMOVE of #1 could
 * delete #10's line — a silent, wrong, public edit. Found by writing the test
 * first.
 */
function lineMentionsUrl(line: string, url: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf(url, from);
    if (at < 0) return false;
    const after = line[at + url.length];
    if (after === undefined || !/[0-9]/.test(after)) return true;
    from = at + 1;
  }
}

type SectionSpan =
  | { kind: "found"; start: number; end: number }
  | { kind: "refused"; reason: "section-not-found" | "section-ambiguous" };

const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*\r?$/;

/**
 * Locate `[start, end)` — the CONTENT lines of the named section, i.e. every
 * line after its heading up to (not including) the next heading of the same or
 * a higher level. A subsection therefore belongs to its parent, which is what a
 * proposer naming the parent section means.
 *
 * Matching is exact on the trimmed heading text first; only if that finds
 * nothing does it fall back to a case-insensitive match, and only when that is
 * UNIQUE. Two headings that differ only in case are an ambiguity a human should
 * resolve, not a tie Atlas breaks.
 */
function findSection(lines: readonly string[], name: string): SectionSpan {
  const wanted = name.trim();
  if (wanted.length === 0) return { kind: "refused", reason: "section-not-found" };
  const headings: Array<{ index: number; level: number; text: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = HEADING_RE.exec(lines[i]!);
    if (m === null) continue;
    headings.push({ index: i, level: m[1]!.length, text: m[2]!.trim() });
  }
  let matches = headings.filter((h) => h.text === wanted);
  if (matches.length === 0) {
    const lower = wanted.toLowerCase();
    matches = headings.filter((h) => h.text.toLowerCase() === lower);
  }
  if (matches.length === 0) return { kind: "refused", reason: "section-not-found" };
  if (matches.length > 1) return { kind: "refused", reason: "section-ambiguous" };
  const heading = matches[0]!;
  const next = headings.find((h) => h.index > heading.index && h.level <= heading.level);
  return {
    kind: "found",
    start: heading.index + 1,
    end: next === undefined ? lines.length : next.index,
  };
}

/**
 * Where a new item goes inside `[start, end)`: immediately after the LAST list
 * item, so the addition joins the existing task list instead of landing after
 * the section's trailing blank line or prose. With no list items, it goes after
 * the last non-blank line — still inside the section, never in the next one.
 */
function insertionPoint(lines: readonly string[], start: number, end: number): number {
  let lastItem = -1;
  let lastContent = -1;
  for (let i = start; i < end; i += 1) {
    const line = lines[i]!;
    if (/^\s*[-*+][ \t]/.test(line)) lastItem = i;
    if (line.trim().length > 0) lastContent = i;
  }
  if (lastItem >= 0) return lastItem + 1;
  if (lastContent >= 0) return lastContent + 1;
  return start;
}

/** Match the neighbouring line's ending so a CRLF body stays a CRLF body. */
function lineEnding(lines: readonly string[], at: number): string {
  const neighbour = lines[at - 1] ?? lines[at] ?? "";
  return neighbour.endsWith("\r") ? "\r" : "";
}
