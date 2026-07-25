/**
 * THE WEEKLY RETRO (W3a, issue #2 item 3; the agent-state `retros/` convention).
 *
 * Four counters for one ISO week, all of them read straight off the append-only
 * event log:
 *
 *   proposals in       — `work_item_created`
 *   ratified/declined  — `work_item_ratified` / `work_item_resolved` by reason
 *   posts made         — ➕/➖ receipts + ✅ announcements + catch-up posts
 *   drift found        — the sum of every reconcile pass's drift count
 *
 * ── The drift counter is the health metric, and that is why it is here ─────
 * Issue #2: *"drift found by reconcile (count should trend to zero — it's the
 * health metric)"*. The number is only meaningful as a TREND, which means a
 * week with zero drift has to produce a row saying zero rather than no row at
 * all. That is exactly why `reconcile.ts` writes a `reconcile_completed` event
 * on a clean pass even though it posts nothing: silence is a rule about the
 * channel, never about the log this file reads.
 *
 * ── Why `<week>-atlas.md` and not `<week>.md` ──────────────────────────────
 * Same collision, same resolution as `dashboard.ts`'s: agent-state's own
 * `scripts/retro.ts weekly` writes `retros/<YYYY-Www>.md` from its generic
 * event tallies, and an operator running it must not silently erase Atlas's
 * plan-steward counters (or vice versa). The two files sit side by side and
 * sort together. Flagged in the slice report rather than taken silently.
 *
 * ── Idempotent ─────────────────────────────────────────────────────────────
 * Re-running for the same week over the same events produces the same bytes
 * apart from the generated-at line — the property agent-state's own workflow
 * requires of a retro, and the reason it is cheap to regenerate rather than
 * hand-edited.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AtlasProposals } from "./state";

function warn(msg: string): void {
  process.stderr.write(`atlas: retro: ${msg}\n`);
}

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

export interface RetroWindow {
  /** Monday 00:00 UTC, inclusive. */
  readonly startMs: number;
  /** The following Monday 00:00 UTC, exclusive. */
  readonly endMs: number;
  /** ISO-8601 `YYYY-Www`. */
  readonly label: string;
}

export interface RetroCounters {
  readonly proposalsIn: number;
  readonly ratified: number;
  readonly declined: number;
  readonly postsMade: number;
  readonly driftFound: number;
}

/** Midnight UTC on the Monday of `ms`'s ISO week. */
function isoWeekStart(ms: number): number {
  const d = new Date(ms);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  // getUTCDay: 0 = Sunday. ISO weeks start on Monday, so Sunday is day 7.
  const isoDay = new Date(utcMidnight).getUTCDay() === 0 ? 7 : new Date(utcMidnight).getUTCDay();
  return utcMidnight - (isoDay - 1) * MS_PER_DAY;
}

/**
 * ISO-8601 week label for a Monday. Week 1 is the week containing the Thursday
 * closest to Jan 1 — computed from that Thursday rather than from Jan 1, which
 * is what makes the last days of December fall in week 1 of the next year.
 */
export function isoWeekLabel(mondayMs: number): string {
  const thursday = new Date(mondayMs + 3 * MS_PER_DAY);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / MS_PER_WEEK) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * The window to report on. `offsetWeeks = -1` (the default) is the PREVIOUS
 * completed week — the same default agent-state's own retro workflow uses, and
 * for the same reason: a mid-week partial is not a retro.
 */
export function retroWindow(now: number = Date.now(), offsetWeeks = -1): RetroWindow {
  const startMs = isoWeekStart(now) + offsetWeeks * MS_PER_WEEK;
  return { startMs, endMs: startMs + MS_PER_WEEK, label: isoWeekLabel(startMs) };
}

/** Read the four counters (five numbers) for one window. */
export function retroCounters(state: AtlasProposals, window: RetroWindow): RetroCounters {
  const types = state.countEventTypes(window.startMs, window.endMs);
  const reasons = state.countResolvedReasons(window.startMs, window.endMs);
  const n = (v: number | undefined): number => (typeof v === "number" && v > 0 ? v : 0);
  return {
    proposalsIn: n(types.work_item_created),
    ratified: n(types.work_item_ratified),
    // Both decline paths, because both end a proposal: the ratifier's DECLINE
    // and the validator's ground-truth refusal. Conflating them with `applied`
    // (the third `work_item_resolved` reason) is what `countResolvedReasons`
    // exists to prevent.
    declined: n(reasons.declined) + n(reasons.validation),
    postsMade:
      n(types.work_item_posted) +
      n(types.completion_announced) +
      state.countCatchUpPosts(window.startMs, window.endMs),
    driftFound: state.sumReconcileDrift(window.startMs, window.endMs),
  };
}

/** The rendered markdown. Pure — testable without a store or a filesystem. */
export function renderRetro(
  window: RetroWindow,
  counters: RetroCounters,
  generatedAt: number,
): string {
  return (
    [
      `# Atlas — plan-steward retro · ${window.label}`,
      "",
      `_Generated: ${new Date(generatedAt).toISOString()}_`,
      `_Window: ${new Date(window.startMs).toISOString()} → ${new Date(window.endMs).toISOString()}_`,
      "",
      "| Counter | Count |",
      "| --- | ---: |",
      `| Proposals in | ${counters.proposalsIn} |`,
      `| Ratified | ${counters.ratified} |`,
      `| Declined | ${counters.declined} |`,
      `| Posts made | ${counters.postsMade} |`,
      `| Drift found by reconcile | ${counters.driftFound} |`,
      "",
      "_Drift is the health metric: it should trend to zero. A non-zero count means",
      "the ledger fell behind the map and a catch-up put it back — the loop working,",
      "not the loop failing. A count that does not fall over successive weeks means",
      "something upstream keeps breaking the atomic pair._",
      "",
      "<!-- GENERATED FILE. `brain/retro.ts`. Idempotent: regenerate rather than edit. -->",
    ].join("\n") + "\n"
  );
}

export type RetroOutcome =
  | { kind: "written"; path: string; label: string; counters: RetroCounters }
  | { kind: "skipped"; reason: "state-degraded" | "write-failed"; detail: string };

/**
 * Write `retros/<YYYY-Www>-atlas.md` into the instance dir. Never throws.
 *
 * A degraded store SKIPS rather than writing a retro of zeroes: a file that
 * says "0 proposals, 0 drift" is a claim about the week, and a store that
 * cannot read its own event log has no standing to make it. Same fail-closed
 * posture as the dashboard.
 */
export function writeWeeklyRetro(
  state: AtlasProposals,
  dir: string,
  now: number = Date.now(),
  offsetWeeks = -1,
): RetroOutcome {
  if (!state.isDurable()) {
    return {
      kind: "skipped",
      reason: "state-degraded",
      detail: "durable state is unreadable; a retro of zeroes would be a false claim",
    };
  }
  const window = retroWindow(now, offsetWeeks);
  const counters = retroCounters(state, window);
  const markdown = renderRetro(window, counters, now);
  const retroDir = join(dir, "retros");
  const path = join(retroDir, `${window.label}-atlas.md`);
  try {
    mkdirSync(retroDir, { recursive: true });
    writeFileSync(path, markdown, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warn(`could not write ${path}: ${detail}`);
    return { kind: "skipped", reason: "write-failed", detail };
  }
  return { kind: "written", path, label: window.label, counters };
}
