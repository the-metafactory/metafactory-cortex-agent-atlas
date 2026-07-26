/**
 * THE PLAN DASHBOARD (W3a, issue #2 item 2; the-metafactory/vision#9 §3 J7).
 *
 * One line per plan section — title, open/total linked issues, and the 🏃/✋
 * markers — regenerated on every state change, derived from the FETCHED PLAN
 * BODY plus work-item state. Issue #2 is emphatic about what this file is for:
 * *"This file is the ONLY source for 🏃 wave-post digests … no hand-written
 * digests anywhere"*. So it is generated, never edited, and it is generated
 * from the two things that are actually true — the live plan body, and Atlas's
 * own durable record — rather than from anyone's recollection of them.
 *
 * ── Why `plan-dashboard.md` and not `dashboard.md` ─────────────────────────
 * A DELIBERATE deviation from the issue's wording, and the reason is a
 * collision that is already live in this repo. `state.ts`'s `regenDashboard`
 * shells out to agent-state's own `scripts/dashboard.ts` on every transition,
 * and that script writes `<instanceDir>/dashboard.md` (work items by kind, open
 * items, recent events — a generic agent-state view). Writing Atlas's plan
 * dashboard to the same path would not "extend" that file, it would RACE it:
 * two writers, fired by the same transitions, each clobbering the other, and
 * whichever landed last would be what a 🏃 digest consumed. A digest source
 * that is sometimes a different document is worse than one with a slightly
 * different name.
 *
 * So the two artifacts are namespaced and both survive:
 *   `<instanceDir>/dashboard.md`      — agent-state's generic work-item view
 *   `<instanceDir>/plan-dashboard.md` — THIS: the plan's section-by-section view
 * J7's digest reads the latter. Flagged in the slice report rather than taken
 * silently.
 *
 * ── The plan body is untrusted text ────────────────────────────────────────
 * A public GitHub issue body is written by whoever can edit that issue, and its
 * section headings land in a markdown file a human reads. Every heading is put
 * through `sanitizeForDisplay` (newlines collapsed, backtick runs neutralised)
 * and then bounded — it is DATA rendered into a document, never markup and
 * never a directive. Nothing in this file interprets a heading; it only counts
 * things underneath one.
 *
 * ── "Open" is derived, not fetched ─────────────────────────────────────────
 * This function is called on every state transition, and a transition happens
 * inside a SQLite write path — so it may not go make N network calls to ask
 * GitHub whether each linked issue is closed. It uses the two closedness
 * signals that are already local and already durable:
 *   1. the plan body's own task-list checkbox (`- [x]`), which is what a human
 *      reading the plan sees; and
 *   2. Atlas's `completion_announced` index, which is the ledger's own record
 *      that the issue closed.
 * Either one counts an item as closed. Both can lag live GitHub by one watcher
 * pass, which is correct for a dashboard whose job is to describe the LEDGER's
 * view of the plan — the live view belongs to `watch.ts`, which is what
 * refreshes signal 2.
 *
 * atlas#34: this file already treats a ticked checkbox as a legitimate
 * closedness signal (signal 1, above) — `reconcile.ts`'s detector (c) used to
 * disagree, reading the identical byte change as unconditionally suspicious.
 * The two now agree; `plan-revision.ts`'s header carries the ONE canonical
 * statement of what a tick means, so it is not restated here or there.
 */

import { sanitizeForDisplay } from "./templates";
import type { ProposalRecord } from "./state";
import type { PlanWriter } from "./effects/gh";
import type { AtlasProposals } from "./state";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

function warn(msg: string): void {
  process.stderr.write(`atlas: dashboard: ${msg}\n`);
}

/** See the file header for why this is not `dashboard.md`. */
export const PLAN_DASHBOARD_FILENAME = "plan-dashboard.md";

/** Defensive bounds — a plan body is operator-sized but not operator-bounded. */
const MAX_SECTIONS = 200;
const MAX_TITLE_LEN = 120;

/** The same heading grammar `apply.ts` uses. One rule, one shape of section. */
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*\r?$/;

/** The same URL grammar `watch.ts` extracts with. */
const ISSUE_URL_RE =
  /https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/issues\/[1-9][0-9]{0,9}/g;

/** A markdown task-list item that is ticked. */
const CHECKED_RE = /^\s*[-*+][ \t]+\[[xX]\]/;

export interface PlanSectionSummary {
  /** The heading text, sanitised. Untrusted — see the file header. */
  readonly title: string;
  /** Heading level (1 = `#`), so the rendered list can be indented like the plan. */
  readonly level: number;
  /** Distinct GitHub issue URLs linked under this heading. */
  readonly total: number;
  /** Of those, the ones neither ticked in the body nor announced complete. */
  readonly open: number;
  /** 🏃 — work items for this section that are ratified or applied (in flight). */
  readonly running: number;
  /** ✋ — work items for this section that are surfaced (awaiting a human). */
  readonly held: number;
}

export interface PlanDashboardInput {
  /** The plan issue body, as fetched. */
  readonly body: string;
  /** Every live proposal work item (`state.recentProposals()`). */
  readonly records: readonly ProposalRecord[];
  /** Atlas's durable "this issue's completion was announced" index. */
  readonly announced: (url: string) => boolean;
  readonly planUrl: string;
  readonly generatedAt: number;
}

/**
 * One heading's span, computed once and shared by every reader below —
 * `planSections`, `planTickets`, and nothing else. Extracted (atlas#28) so the
 * heading/span/checkbox walk exists in exactly one place: `planTickets` needs
 * the identical per-section URL sets `planSections` already built, and a
 * second walk of the body — even one using the same regexes — is the second
 * implementation of "what counts as open" the file header warns against.
 *
 * `rawTitle` is the UNSANITIZED heading text (`recordBelongsTo` matches
 * against this — unchanged from before this was extracted); `title` is the
 * bound, sanitized display form.
 */
interface RawSection {
  readonly rawTitle: string;
  readonly title: string;
  readonly level: number;
  readonly urls: ReadonlySet<string>;
  readonly closedUrls: ReadonlySet<string>;
}

function computeRawSections(input: PlanDashboardInput): RawSection[] {
  const body = typeof input.body === "string" ? input.body : "";
  const lines = body.split("\n");
  const headings: Array<{ index: number; level: number; text: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = HEADING_RE.exec(lines[i]!);
    if (m === null) continue;
    headings.push({ index: i, level: m[1]!.length, text: m[2]!.trim() });
    if (headings.length >= MAX_SECTIONS) break;
  }

  const out: RawSection[] = [];
  for (let h = 0; h < headings.length; h += 1) {
    const heading = headings[h]!;
    // `[start, end)` — every line under this heading up to the next heading of
    // the same or a higher level. Identical span rule to `apply.ts`'s
    // `findSection`, so a proposer who names a section for an ADD and a reader
    // who looks at this dashboard are talking about the same set of lines.
    const next = headings.find((x) => x.index > heading.index && x.level <= heading.level);
    const start = heading.index + 1;
    const end = next === undefined ? lines.length : next.index;

    const urls = new Set<string>();
    const closedUrls = new Set<string>();
    for (let i = start; i < end; i += 1) {
      const line = lines[i]!;
      const ticked = CHECKED_RE.test(line);
      // Constructed per line: a `g` regex holds `lastIndex` across calls, and a
      // shared one silently skips every second match (the bug `watch.ts`'s
      // `extractLinkedIssueUrls` documents).
      for (const m of line.matchAll(new RegExp(ISSUE_URL_RE.source, "g"))) {
        const url = m[0];
        urls.add(url);
        if (ticked) closedUrls.add(url);
      }
    }
    for (const url of urls) {
      if (!closedUrls.has(url) && safeAnnounced(input.announced, url)) closedUrls.add(url);
    }

    out.push({
      rawTitle: heading.text,
      title: boundTitle(heading.text),
      level: heading.level,
      urls,
      closedUrls,
    });
  }
  return out;
}

/**
 * The section table, computed. PURE and exported so the exact numbers are
 * testable against a fixed plan body with no store, no network and no clock.
 */
export function planSections(input: PlanDashboardInput): PlanSectionSummary[] {
  const out: PlanSectionSummary[] = [];
  for (const section of computeRawSections(input)) {
    const attributed = input.records.filter((r) => recordBelongsTo(r, section.rawTitle, section.urls));
    out.push({
      title: section.title,
      level: section.level,
      total: section.urls.size,
      open: section.urls.size - section.closedUrls.size,
      running: attributed.filter((r) => r.phase === "ratified" || r.phase === "applied").length,
      held: attributed.filter((r) => r.phase === "surfaced").length,
    });
  }
  return out;
}

/**
 * Is this work item about this section? Two independent attributions, either of
 * which is sufficient:
 *   - the proposer NAMED the section (matched the way `apply.ts` matches it:
 *     trimmed, then case-insensitively), or
 *   - the item's issue URL is already linked under the heading.
 * The second catches REMOVE proposals and section-less ADDs that nonetheless
 * concern a section a reader can see, which is precisely what a dashboard is
 * for.
 */
function recordBelongsTo(
  record: ProposalRecord,
  headingText: string,
  urls: ReadonlySet<string>,
): boolean {
  if (typeof record.section === "string" && record.section.trim().length > 0) {
    const named = record.section.trim();
    if (named === headingText) return true;
    if (named.toLowerCase() === headingText.toLowerCase()) return true;
  }
  return typeof record.url === "string" && record.url.length > 0 && urls.has(record.url);
}

/** The announcement index is a caller-supplied port; a throw from it is not fatal. */
function safeAnnounced(announced: (url: string) => boolean, url: string): boolean {
  try {
    return announced(url) === true;
  } catch (err) {
    warn(`completion index threw: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * The whole-body closedness walk, shared by `bodyTotals` and `planTickets`
 * (atlas#28) — one URL set, one ticked/announced determination, in
 * first-seen document order. Extracted for the same reason
 * `computeRawSections` was: a second scan of the body is a second
 * implementation of "what counts as closed" to keep in lockstep by hand.
 */
function computeRawBodyClosedness(input: PlanDashboardInput): {
  readonly order: readonly string[];
  /** The plan body's OWN checkbox, before the announced-completion merge. */
  readonly tickedInBody: ReadonlyMap<string, boolean>;
  /** `tickedInBody` OR'd with `input.announced` — the one `bodyTotals` counts. */
  readonly closed: ReadonlyMap<string, boolean>;
} {
  const body = typeof input.body === "string" ? input.body : "";
  const order: string[] = [];
  const tickedInBody = new Map<string, boolean>();
  for (const line of body.split("\n")) {
    const ticked = CHECKED_RE.test(line);
    for (const m of line.matchAll(new RegExp(ISSUE_URL_RE.source, "g"))) {
      const url = m[0];
      if (!tickedInBody.has(url)) {
        tickedInBody.set(url, false);
        order.push(url);
      }
      if (ticked) tickedInBody.set(url, true);
    }
  }
  const closed = new Map<string, boolean>(tickedInBody);
  for (const url of order) {
    if (closed.get(url) !== true && safeAnnounced(input.announced, url)) closed.set(url, true);
  }
  return { order, tickedInBody, closed };
}

/**
 * Plan-wide counts: DISTINCT linked issues across the whole body, and each work
 * item counted once regardless of how many sections it is attributable to. This
 * is the number a 🏃 wave-post digest quotes, so it has to be the number of
 * real things — not the number of (section, thing) pairs.
 *
 * Exported (atlas#28) — the status tool's overall/`--live` totals call this
 * directly rather than re-deriving the same count from `planSections`' rows
 * (which would double-count through the parent/child span overlap; see the
 * TOTALS test below for exactly why summing section rows is wrong).
 */
export function bodyTotals(input: PlanDashboardInput): {
  total: number;
  open: number;
  running: number;
  held: number;
} {
  const { order, closed } = computeRawBodyClosedness(input);
  const closedCount = order.filter((u) => closed.get(u) === true).length;
  const seen = new Set<string>();
  let running = 0;
  let held = 0;
  for (const r of input.records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.phase === "ratified" || r.phase === "applied") running += 1;
    else if (r.phase === "surfaced") held += 1;
  }
  return { total: order.length, open: order.length - closedCount, running, held };
}

export interface PlanTicketSummary {
  /** The linked issue URL — the ticket's identity. */
  readonly url: string;
  /** The plan body's OWN checkbox for this URL — before the announced merge. */
  readonly tickedInBody: boolean;
  /** Ticked in the body OR announced complete — the SAME rule `bodyTotals` uses. */
  readonly closed: boolean;
  /**
   * Every section heading (sanitized display form, matching `planSections`'
   * own `title`) this URL is linked under, in section-document order. Empty
   * when the URL appears before any heading, or the body carries none at all
   * — present here even though `planSections` has nothing to attribute it to
   * (the per-ticket granularity `planSections`/`bodyTotals` stop short of;
   * see the file header).
   */
  readonly sections: readonly string[];
}

/**
 * One entry per DISTINCT linked issue URL, body-wide, in first-seen document
 * order. Built from the SAME two walks `planSections` and `bodyTotals` use
 * (`computeRawSections` for section attribution, `computeRawBodyClosedness`
 * for the ticked/closed bits and the canonical ordering) — never a third
 * implementation of either question, so a ticket's `closed` state and its
 * `sections` list can never disagree with what the dashboard already says
 * about the section(s), or the plan overall.
 *
 * `tickedInBody` and `closed` are BOTH exposed (atlas#28) because a caller
 * that only needs "is this closed" (this file's own `bodyTotals`) and a
 * caller that needs to show the plan body's checkbox and Atlas's own
 * completion record as two SEPARATE facts (`atlas status`'s `planState` vs
 * `ledgerState` — reconcile.ts's detector (c) is precisely about them
 * disagreeing) are both real, and collapsing them here would force the
 * second caller to re-derive one from the other by hand.
 */
export function planTickets(input: PlanDashboardInput): PlanTicketSummary[] {
  const sectionsByUrl = new Map<string, string[]>();
  for (const section of computeRawSections(input)) {
    for (const url of section.urls) {
      const list = sectionsByUrl.get(url);
      if (list === undefined) sectionsByUrl.set(url, [section.title]);
      else list.push(section.title);
    }
  }
  const { order, tickedInBody, closed } = computeRawBodyClosedness(input);
  return order.map((url) => ({
    url,
    tickedInBody: tickedInBody.get(url) === true,
    closed: closed.get(url) === true,
    sections: sectionsByUrl.get(url) ?? [],
  }));
}

function boundTitle(text: string): string {
  const safe = sanitizeForDisplay(typeof text === "string" ? text : "");
  return safe.length > MAX_TITLE_LEN ? `${safe.slice(0, MAX_TITLE_LEN)}…` : safe;
}

/**
 * The rendered markdown. Deterministic for a given input: the ONLY varying part
 * is the generated-at line, exactly as agent-state's own dashboard workflow
 * specifies ("idempotent: same state ⇒ identical file, modulo the timestamp").
 */
export function renderPlanDashboard(input: PlanDashboardInput): string {
  const sections = planSections(input);
  const generated = new Date(input.generatedAt).toISOString();
  const head = [
    "# Atlas — plan dashboard",
    "",
    `_Generated: ${generated} · derived from ${input.planUrl}_`,
    "",
    "<!-- GENERATED FILE. Regenerated on every state change by brain/dashboard.ts.",
    "     This is the ONLY source for 🏃 wave-post digests (vision#9 §3 J7).",
    "     Hand edits are lost on the next transition. -->",
    "",
    "## Sections",
    "",
  ];
  if (sections.length === 0) {
    head.push("_No sections — the plan body carries no markdown headings._");
    return `${head.join("\n")}\n`;
  }
  // Totals are computed over the WHOLE BODY, not by summing the section rows.
  // Summing them double-counts: a `#` heading spans its `##` children (the
  // same span rule `apply.ts` uses, deliberately), so a plan with one top-level
  // heading reported every issue twice and a digest built on it would overstate
  // the work by a factor of the nesting depth. Caught by the test that pins the
  // totals line.
  const totals = bodyTotals(input);
  for (const s of sections) {
    const indent = "  ".repeat(Math.max(0, s.level - 1));
    const markers: string[] = [];
    if (s.running > 0) markers.push(`🏃 ${s.running}`);
    if (s.held > 0) markers.push(`✋ ${s.held}`);
    const tail = markers.length > 0 ? ` · ${markers.join(" · ")}` : "";
    head.push(`${indent}- **${s.title}** — ${s.open}/${s.total} open${tail}`);
  }
  head.push(
    "",
    `_Totals: ${totals.open}/${totals.total} open · 🏃 ${totals.running} · ✋ ${totals.held}_`,
  );
  return `${head.join("\n")}\n`;
}

export interface PlanDashboardDeps {
  readonly state: AtlasProposals;
  /** Reads the plan body — config-pinned, exactly as `watch.ts` reads it. */
  readonly plan: PlanWriter;
  /** Where `plan-dashboard.md` is written. The agent-state instance dir. */
  readonly dir: string;
  readonly planUrl: string;
}

export type PlanDashboardOutcome =
  | { kind: "written"; path: string; sections: number }
  | { kind: "skipped"; reason: "state-degraded" | "plan-unreadable" | "write-failed"; detail: string };

/**
 * Fetch → render → write. Never throws: a dashboard is a derived view, and a
 * failure to redraw it must never take down the transition or the reconcile
 * pass that triggered it.
 *
 * A degraded store SKIPS rather than writing an empty dashboard. An empty
 * section table is a claim ("the plan has nothing in flight"), and a store that
 * cannot see its own work items has no standing to make it — the same
 * fail-closed reasoning `lookupSurfacedByDisplayId` applies to the gate.
 */
export async function regeneratePlanDashboard(
  deps: PlanDashboardDeps,
  now: number = Date.now(),
): Promise<PlanDashboardOutcome> {
  if (!deps.state.isDurable()) {
    return {
      kind: "skipped",
      reason: "state-degraded",
      detail: "durable state is unreadable; the dashboard would assert something unverified",
    };
  }
  let body: string;
  try {
    const snapshot = await deps.plan.readPlan();
    if (snapshot === null) {
      return { kind: "skipped", reason: "plan-unreadable", detail: "could not read the plan body" };
    }
    body = snapshot.body;
  } catch (err) {
    return {
      kind: "skipped",
      reason: "plan-unreadable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const input: PlanDashboardInput = {
    body,
    records: deps.state.recentProposals(),
    announced: (url) => deps.state.hasAnnouncedCompletion(url),
    planUrl: deps.planUrl,
    generatedAt: now,
  };
  const markdown = renderPlanDashboard(input);
  const path = join(deps.dir, PLAN_DASHBOARD_FILENAME);
  try {
    writeFileSync(path, markdown, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warn(`could not write ${path}: ${detail}`);
    return { kind: "skipped", reason: "write-failed", detail };
  }
  return { kind: "written", path, sections: planSections(input).length };
}
