/**
 * THE RECONCILE LOOP (W3a, issue #2; the-metafactory/vision#9 §3 J5, §5; the
 * vision repo's CLAUDE.md "Keeping the ledger current", rules 2-4).
 *
 * This is the module that makes the ledger trustworthy ACROSS GAPS. Everything
 * before it assumed the happy path held: a ratification produced an apply, an
 * apply produced a ledger entry, a closure produced a ✅. W2c already proved
 * that assumption breaks — `applyRatified` PARKS in `applied` when the ledger
 * post fails, deliberately, because the alternative was un-editing a public
 * plan on the strength of a Discord outage. Recovering that park is this file's
 * job, and this file is the DESIGNATED recovery path for it.
 *
 * ── The three detectors ────────────────────────────────────────────────────
 *   (b) `applied` work items with no ledger entry — the parked population.
 *   (a) plan-linked issues whose ✅ never went out, or whose ✅ has vanished
 *       from the channel.
 *   (c) plan-body revisions Atlas cannot account for — an edit with no ➕/➖.
 * (b) is listed first because it is the dangerous one; see the next section.
 *
 * ── SILENCE IS THE DEFAULT, and it is a hard rule ──────────────────────────
 * A pass that finds nothing posts NOTHING. Not a heartbeat, not an "all clear",
 * not an empty digest. The channel is a ledger, not a status feed, and the only
 * way a ledger stays readable backwards is if every line in it is an event.
 *
 * Note precisely what silence is a statement about: THE CHANNEL. A clean pass
 * still writes one `reconcile_completed` event, because the drift count is the
 * health metric the weekly retro reports, and a metric only written when it is
 * non-zero cannot be shown to trend to zero.
 *
 * ── THE DOUBLE-POST QUESTION ───────────────────────────────────────────────
 * Two parked shapes both read as `applied`, and from storage alone they are
 * identical (same status, same ratification, same `applied` receipt, no
 * `posted` receipt):
 *   - the ledger post never landed        → a catch-up line is the fix;
 *   - the ledger post LANDED and only its receipt failed to record
 *     (`apply.ts`'s `postLanded: true`)   → a catch-up line is a LIE, appended
 *                                           to an append-only public record.
 * A missed catch-up line is recoverable — the next pass, or a human, can still
 * say it. A duplicate ledger entry corrupts the record permanently, because
 * rule 4 forbids editing one away. So the whole design of this decision fails
 * toward NOT posting. Four sources answer it, in this order:
 *
 *   1. `work_item_posted` — the receipt recorded. Such an item is `posted`, not
 *      `applied`, so it is not in this population at all.
 *   2. `ledger_post_unrecorded` — the DURABLE marker `apply.ts` now writes on
 *      the `postLanded: true` branch, at the moment the fact is known rather
 *      than inferred later. Present ⇒ a post may exist ⇒ never itemised.
 *   3. The CHANNEL cross-check — does a ➕/➖ post for this proposal exist? Used
 *      SUBTRACTIVELY ONLY: finding one removes the item; failing to find one
 *      adds nothing, because a bounded read that missed it and a post that was
 *      never made look the same.
 *   4. Otherwise: itemise. This is the only branch that speaks, and it is
 *      reached only when Atlas's own durable record — the primary index the
 *      issue names — positively says no post was made.
 *
 * The residual risk is stated rather than hidden: a crash in the window between
 * a ledger post landing and marker (2) committing leaves an item that looks
 * like case 4. Cross-check (3) covers that window when a channel reader is
 * configured. Without one, that narrow window is the one way a duplicate could
 * occur, and it is why (3) exists at all.
 *
 * ── CONVERGENCE ────────────────────────────────────────────────────────────
 * Every itemised drift gets a durable `reconcile_catchup_recorded` row keyed on
 * the drift's identity, written ONLY after the catch-up post lands. Every
 * detector filters on that key first. So a second pass over an unchanged world
 * finds nothing and stays silent — asserted directly in `reconcile.test.ts`.
 * Records are written only for lines the post ACTUALLY carried
 * (`postCatchUp().rendered`), so a length-budgeted overflow waits for the next
 * pass instead of being marked covered and never spoken.
 *
 * ── READ-ONLY, except the catch-up post and the records of it ──────────────
 * No phase transition is reachable from this file. No certificate is minted or
 * consumed — a catch-up is a ledger line about work that already happened, not
 * an authorisation for new work, so the certificate discipline established in
 * #7/W2c is untouched rather than widened. The writes are exactly:
 * `reconcile_catchup_recorded`, `reconcile_completed`, and (for a completion
 * this post just caught up on) `completion_announced`, which exists so
 * `watch.ts` does not then post a SECOND ✅ for the same closure.
 *
 * ── Fail-closed on degraded storage ────────────────────────────────────────
 * No durable state ⇒ no pass. Not a best-effort pass, not a pass with fewer
 * checks: nothing, plus a named refusal the caller can report. Every question
 * this file asks is "is there a record of X", and a store that cannot answer
 * that has no honest answer to give — the same three-state posture #6/W2c
 * established for the gate's lookup.
 *
 * ── Untrusted input is DATA ────────────────────────────────────────────────
 * Plan body text and issue titles are quoted into catch-up lines and never
 * interpreted; the channel cross-check is anchored at position 0 for exactly
 * this reason (see `messageRecordsPlanChange`).
 */

import { sanitizeForDisplay } from "./templates";
import { extractLinkedIssueUrls } from "./watch";
import { messageRecordsPlanChange, type DiscordLedger, type LedgerMessage, type LedgerReader } from "./effects/discord";
import { regeneratePlanDashboard } from "./dashboard";
import type { EffectsConfig } from "./effects/config";
import type { PlanWriter } from "./effects/gh";
import type { LinkedIssueReader, LinkedIssueState } from "./gh";
import type { AtlasProposals, ProposalRecord } from "./state";

function warn(msg: string): void {
  process.stderr.write(`atlas: reconcile: ${msg}\n`);
}

/** `reconcile_interval` — 21600s, expressed in ms. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 21_600_000;
const MIN_RECONCILE_INTERVAL_MS = 60_000;
const MAX_RECONCILE_INTERVAL_MS = 7 * 24 * 60 * 60_000;

/** Live gh reads per pass — the same bound `watch.ts` applies, same reason. */
const MAX_READS_PER_PASS = 50;
/** How far back the channel cross-check looks. Bounded; see `readChannelWindow`. */
const CHANNEL_WINDOW = 100;
/** Drift items considered for ONE catch-up post. The rest wait for the next pass. */
const MAX_CATCHUP_ITEMS = 20;
/** At most one retry, then leave the drift standing. Same posture as `apply.ts`. */
const CATCHUP_POST_ATTEMPTS = 2;

/**
 * `ATLAS_RECONCILE_INTERVAL_MS` — the `reconcile_interval` config from issue
 * #2, in milliseconds, defaulted to 21600s and clamped. Consumed by the daemon
 * loop in `brain/main.ts`; this module performs ONE pass per call, so the
 * scheduling policy and the pass stay independently testable and no test ever
 * waits on a timer. Exactly the split `resolvePollIntervalMs` uses.
 */
export function resolveReconcileIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.ATLAS_RECONCILE_INTERVAL_MS;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_RECONCILE_INTERVAL_MS;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) return DEFAULT_RECONCILE_INTERVAL_MS;
  return Math.min(MAX_RECONCILE_INTERVAL_MS, Math.max(MIN_RECONCILE_INTERVAL_MS, n));
}

export type DriftKind =
  /** A plan-body change landed with no ➕/➖ ledger entry (parked in `applied`). */
  | "applied-unposted"
  /** A plan-linked issue closed and no ✅ ever went out. */
  | "completion-unposted"
  /** A ✅ Atlas recorded is no longer in the channel. The kill test. */
  | "completion-missing"
  /** The plan body carries a revision Atlas cannot account for. */
  | "plan-revised";

export interface DriftItem {
  readonly kind: DriftKind;
  /** The convergence key. Stable for a given drift; recorded once it is said. */
  readonly key: string;
  /** The catch-up line. Untrusted text already quoted; re-sanitised on the way out. */
  readonly line: string;
  /** The issue URL, for the completion kinds — `null` otherwise. */
  readonly url: string | null;
}

export type ReconcileOutcome =
  | { kind: "refused"; reason: "state-degraded" | "plan-unreadable"; detail: string }
  /** Nothing to say. NOTHING WAS POSTED. */
  | {
      kind: "clean";
      /** Linked issues that cost a live gh read this pass. */
      checked: number;
      /** Drift candidates deliberately NOT itemised — see the header's four sources. */
      suppressed: number;
      revision: string;
    }
  /** Drift found, ONE catch-up post landed, every stated item recorded. */
  | {
      kind: "caught-up";
      items: readonly DriftItem[];
      /** Items found but held back for the next pass (post-length budget). */
      deferred: number;
      messageId: string;
      checked: number;
      suppressed: number;
      revision: string;
      /** The label's anchor — the last ledger entry Atlas could see. */
      since: string;
    }
  /**
   * Drift found, the catch-up post did NOT land. Nothing recorded — not even
   * the pass — so the next reconcile re-detects exactly the same drift and
   * tries again. A failed post must never look like a completed catch-up.
   */
  | { kind: "post-failed"; items: readonly DriftItem[]; attempts: number };

export interface ReconcileDeps {
  readonly state: AtlasProposals;
  /** Reads the plan body. Config-pinned; the watched set comes from config too. */
  readonly plan: PlanWriter;
  /** Reads arbitrary linked issues. A READ port; it cannot write anywhere. */
  readonly gh: LinkedIssueReader;
  /** The ONE channel. Used only to post the catch-up. */
  readonly ledger: DiscordLedger;
  readonly effects: EffectsConfig;
  /**
   * The channel cross-check. OPTIONAL — Atlas's own event log is the primary
   * index, and this loop is fully functional without a reader. Where it is
   * absent the double-post decision rests entirely on the durable marker, and
   * the deleted-✅ detector cannot fire at all (it has nothing to compare
   * against, and inventing drift from a read that did not happen would be the
   * exact failure mode this file is built to avoid).
   */
  readonly channel?: LedgerReader | null;
  /**
   * Where `plan-dashboard.md` lives. `null`/absent skips the redraw — the
   * dashboard is derived, so a pass is still a valid pass without it.
   */
  readonly instanceDir?: string | null;
}

/** One reconcile pass. Never throws. */
export async function reconcilePlan(
  deps: ReconcileDeps,
  now: number = Date.now(),
): Promise<ReconcileOutcome> {
  // ── 1. Durable state, or NOTHING — and say so ────────────────────────────
  if (!deps.state.isDurable()) {
    const degradation = deps.state.degradation();
    const detail =
      `durable state is unreadable; reconcile did nothing — no channel read, no ` +
      `catch-up, no records. Cause: ${degradation?.reason ?? "unknown"}`;
    warn(detail);
    return { kind: "refused", reason: "state-degraded", detail };
  }

  // ── 2. The map, which is ground truth ────────────────────────────────────
  const snapshot = await deps.plan.readPlan();
  if (snapshot === null) {
    return {
      kind: "refused",
      reason: "plan-unreadable",
      detail: "could not read the plan body; reconcile did nothing",
    };
  }
  const revision = snapshot.revisedAt;

  const firstPass = !deps.state.hasReconciled();
  const lastLedger = deps.state.lastLedgerEntryTs();
  const window = await readChannelWindow(deps.channel ?? null);

  const drift: DriftItem[] = [];
  let suppressed = 0;
  const suppress = (): void => {
    suppressed += 1;
  };

  // ── 3(b). Applied-but-unposted: the parked population ────────────────────
  // First, because it is the branch where being wrong is worst.
  for (const record of deps.state.appliedUnposted()) {
    const key = `applied-unposted:${record.id}`;
    if (deps.state.hasReconcileCatchUp(key)) {
      suppress();
      continue;
    }
    // Source 2: the durable marker. "The post landed, only its receipt did not."
    if (deps.state.hasLedgerPostUnrecorded(record.id)) {
      suppress();
      continue;
    }
    // Source 3: the channel, SUBTRACTIVELY.
    if (window !== null && planChangeIsInChannel(window.messages, record)) {
      suppress();
      continue;
    }
    drift.push({
      kind: "applied-unposted",
      key,
      url: record.url,
      line:
        `${record.verb === "ADD" ? "➕" : "➖"} ledger entry missing for proposal ` +
        `#${record.displayId ?? 0}: ${record.verb} ${record.url}` +
        `${record.applied === null ? "" : ` · plan revision ${record.applied.revision}`}`,
    });
  }

  // ── 3(a). Completions: never posted, or posted and now gone ──────────────
  let checked = 0;
  for (const url of extractLinkedIssueUrls(snapshot.body)) {
    const announcement = deps.state.completionAnnouncement(url);
    if (announcement === null) {
      if (checked >= MAX_READS_PER_PASS) continue;
      // No anchor ⇒ no claim. Without a previous ledger entry there is nothing
      // to say the watcher "should already have" announced this closure, and
      // a reconcile that races the watcher is a reconcile that duplicates it.
      if (lastLedger === null) continue;
      checked += 1;
      const state = await safeLinkedRead(deps.gh, url);
      if (state === null || !state.closed) continue; // a failed read is never a closure
      const closedAt = parseIsoMs(state.closedAt);
      // Only drift once a ledger entry has landed AFTER this closure: that is
      // what proves the watcher had its chance and this one was missed, rather
      // than that its next pass simply has not run yet.
      if (closedAt === null || closedAt >= lastLedger) continue;
      const key = `completion-unposted:${url}`;
      if (deps.state.hasReconcileCatchUp(key)) {
        suppress();
        continue;
      }
      drift.push({
        kind: "completion-unposted",
        key,
        url,
        line: `✅ never posted for ${url} — "${sanitizeForDisplay(state.title)}" is closed on GitHub`,
      });
      continue;
    }
    // Announced. Is that post still in the channel? This is the ONLY question
    // in this file a channel read may answer in the ADDING direction, and it is
    // fenced twice: no reader ⇒ no claim, and a record older than the window
    // ⇒ no claim (absent from a bounded window means "scrolled past", not
    // "deleted", and a ledger must not accuse the channel on that evidence).
    if (window === null) continue;
    if (window.messages.some((m) => m.id === announcement.messageId)) continue;
    if (announcement.ts < window.coversFrom) continue;
    const key = `completion-missing:${url}:${announcement.messageId}`;
    if (deps.state.hasReconcileCatchUp(key)) {
      suppress();
      continue;
    }
    drift.push({
      kind: "completion-missing",
      key,
      url,
      line: `✅ post for ${url} is no longer in the channel — re-stating it here`,
    });
  }

  // ── 3(c). A plan-body revision with no matching ➕/➖ event ────────────────
  if (!firstPass && typeof revision === "string" && revision.length > 0) {
    if (!deps.state.observedPlanRevisions().has(revision)) {
      const key = `plan-revised:${revision}`;
      if (deps.state.hasReconcileCatchUp(key)) {
        suppress();
      } else {
        drift.push({
          kind: "plan-revised",
          key,
          url: null,
          line:
            `✋ plan body revised outside Atlas — revision ${revision} has no ➕/➖ ` +
            `ledger entry`,
        });
      }
    }
  }

  // ── 4. Silence, if there is nothing to say ───────────────────────────────
  if (drift.length === 0) {
    // The observed revision is written down even on a clean pass: that is what
    // makes detector (c) converge, and it is a state write, not a channel one.
    deps.state.recordReconcilePass(0, revision, null);
    await redrawDashboard(deps, now);
    return { kind: "clean", checked, suppressed, revision };
  }

  // ── 5. ONE post ──────────────────────────────────────────────────────────
  const stated = drift.slice(0, MAX_CATCHUP_ITEMS);
  const since = lastLedger === null ? "(no previous ledger entry)" : new Date(lastLedger).toISOString();
  let attempts = 0;
  let posted: Awaited<ReturnType<DiscordLedger["postCatchUp"]>> = null;
  while (attempts < CATCHUP_POST_ATTEMPTS && posted === null) {
    attempts += 1;
    posted = await deps.ledger.postCatchUp(
      stated.map((d) => d.line),
      since,
    );
  }
  if (posted === null) {
    warn(
      `catch-up post failed after ${attempts} attempt(s) with ${drift.length} drift item(s) — ` +
        `NOTHING recorded; the next pass re-detects the same drift`,
    );
    return { kind: "post-failed", items: drift, attempts };
  }

  // ── 6. Record only what the post ACTUALLY said ───────────────────────────
  const covered = stated.slice(0, Math.max(0, Math.min(posted.rendered, stated.length)));
  for (const item of covered) {
    deps.state.recordReconcileCatchUp(item.key, posted.receipt.messageId);
    if (item.kind === "completion-unposted" && item.url !== null) {
      // The catch-up line IS this closure's ledger entry. Recording it here is
      // what stops `watch.ts` posting a SECOND ✅ for the same issue on its next
      // pass — the duplicate this file exists to prevent, arriving from the
      // other direction.
      deps.state.recordCompletionAnnounced(item.url, posted.receipt.messageId);
    }
  }
  deps.state.recordReconcilePass(covered.length, revision, posted.receipt.messageId);
  await redrawDashboard(deps, now);
  return {
    kind: "caught-up",
    items: covered,
    deferred: drift.length - covered.length,
    messageId: posted.receipt.messageId,
    checked,
    suppressed,
    revision,
    since,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface ChannelWindow {
  readonly messages: readonly LedgerMessage[];
  /**
   * The oldest instant this window PROVABLY covers — the fence that keeps
   * "absent from a bounded read" from being mistaken for "deleted".
   *
   * Two cases give `-Infinity`, i.e. "covers all history", and both are exact
   * rather than generous: the read came back SHORT of the limit (so the reader
   * handed over everything it has), and the read came back empty (the same
   * statement, in the limit). Only a read that FILLED the limit is truncated,
   * and then the fence is the oldest message actually seen.
   */
  readonly coversFrom: number;
}

/**
 * Read the cross-check window ONCE per pass. `null` for "no reader configured"
 * AND for "the read failed" — deliberately the same value, because both mean
 * the same thing to every caller: the channel has told us nothing, so nothing
 * may be concluded from it.
 */
async function readChannelWindow(reader: LedgerReader | null): Promise<ChannelWindow | null> {
  if (reader === null) return null;
  let messages: readonly LedgerMessage[] | null;
  try {
    messages = await reader.recentMessages(CHANNEL_WINDOW);
  } catch (err) {
    warn(`channel cross-check failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (messages === null || !Array.isArray(messages)) return null;
  const usable = messages.filter(
    (m): m is LedgerMessage =>
      m !== null &&
      typeof m === "object" &&
      typeof m.id === "string" &&
      typeof m.content === "string" &&
      typeof m.createdAt === "number" &&
      Number.isFinite(m.createdAt),
  );
  // A read that did not FILL the limit is a read that returned everything the
  // reader has — so it covers all history, and an id absent from it really is
  // absent rather than merely out of view. This is the case the kill test runs
  // in, and it is exact rather than generous.
  if (usable.length < CHANNEL_WINDOW) {
    return { messages: usable, coversFrom: Number.NEGATIVE_INFINITY };
  }
  const oldest = usable.reduce((min, m) => Math.min(min, m.createdAt), Number.POSITIVE_INFINITY);
  return { messages: usable, coversFrom: Number.isFinite(oldest) ? oldest : Number.POSITIVE_INFINITY };
}

/** Subtractive cross-check: is this proposal's ➕/➖ entry already in the channel? */
function planChangeIsInChannel(
  messages: readonly LedgerMessage[],
  record: ProposalRecord,
): boolean {
  const displayId = record.displayId;
  if (displayId === null) return false;
  return messages.some((m) => messageRecordsPlanChange(m.content, displayId, record.url));
}

async function safeLinkedRead(
  gh: LinkedIssueReader,
  url: string,
): Promise<LinkedIssueState | null> {
  try {
    return await gh.getLinkedIssue(url);
  } catch (err) {
    warn(`linked-issue read failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function parseIsoMs(iso: string | null): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Fire the plan-dashboard redraw. Never fatal — see `dashboard.ts`'s header. */
async function redrawDashboard(deps: ReconcileDeps, now: number): Promise<void> {
  const dir = deps.instanceDir ?? null;
  if (dir === null || dir.length === 0) return;
  const outcome = await regeneratePlanDashboard(
    { state: deps.state, plan: deps.plan, dir, planUrl: deps.effects.planUrl },
    now,
  );
  if (outcome.kind === "skipped") warn(`dashboard not redrawn (${outcome.reason}): ${outcome.detail}`);
}
