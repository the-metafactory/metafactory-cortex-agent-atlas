/**
 * `atlas status` — the pure envelope builder (atlas#28).
 *
 * ── Status has two sources, and their disagreement IS the status ───────────
 * There are two legitimate answers to "how many are open": the LEDGER (plan
 * body checkboxes + Atlas's own `completion_announced` index + work-item
 * phases — zero cost, up to one watcher pass stale) and LIVE (GitHub's actual
 * issue state right now — N API calls, no staleness). This file never
 * silently prefers one: the ledger view is the default envelope, and `--live`
 * adds a SEPARATE `live` block plus a `divergence` list rather than replacing
 * anything. Collapsing them would throw away the one finding a reconcile-style
 * tool exists to surface.
 *
 * ── This is the ONLY caller of `dashboard.ts`'s aggregation, never a second
 *    implementation of it ─────────────────────────────────────────────────
 * `planSections`, `bodyTotals` and `planTickets` (brain/dashboard.ts) already
 * compute "what counts as open" — purely, from a plan body plus work-item
 * records plus the announced-completion index. Every number in this file's
 * envelope is read OFF those three functions' output; nothing here re-walks
 * the plan body's headings or checkboxes. A second definition of "open" would
 * drift from the dashboard's, and then the ledger's digests and the agent's
 * answers would disagree about the same plan with no way for a reader to know
 * which is wrong.
 *
 * ── Every answer carries its own freshness ──────────────────────────────────
 * The plan revision it was derived from, the last watcher pass, the last
 * reconcile pass (and whether it found drift), the last ledger entry, and
 * whether the daemon looks to be running — every one of those, every time,
 * both in the JSON and in the human rendering. A status answer with no "as
 * of" invites false confidence, and this output gets pasted into channels.
 *
 * ── Pure, and that is the whole point ───────────────────────────────────────
 * Every function here is a plain data transform: given a plan body, work-item
 * records, cached titles, freshness facts and (optionally) a live-state map,
 * produce the `atlas.plan.status.v1` envelope or the human rendering of it.
 * No SQLite, no `gh`, no clock read (the "now" a caller wants baked in is
 * always a parameter). The impure assembly — opening the read-only store,
 * resolving env, spawning `gh` for `--live` — lives in `status-cli.ts`, which
 * imports ONLY this file's pure surface plus the read-only store accessor.
 */

import { bodyTotals, planSections, planTickets, type PlanDashboardInput } from "./dashboard";
import { parseIssueUrl } from "./gh";
import type { ProposalPhase, ProposalRecord } from "./state";

export const STATUS_SCHEMA = "atlas.plan.status.v1" as const;

export interface StatusPlan {
  readonly url: string;
  readonly revision: string;
  readonly title: string;
}

export interface StatusReconcileFreshness {
  readonly at: string;
  readonly drift: number;
}

export interface StatusFreshness {
  readonly generatedAt: string;
  readonly lastWatcherPass: string | null;
  readonly lastReconcile: StatusReconcileFreshness | null;
  readonly lastLedgerEntry: string | null;
  /**
   * `false` ⇒ the ledger view may be arbitrarily stale. A HEURISTIC (see
   * `status-cli.ts`'s `estimateDaemonRunning`), never a hard guarantee —
   * there is no daemon heartbeat file or PID this tool may safely read
   * without constructing exactly the kind of runtime coupling issue #28's
   * read-only-by-construction principle forbids. Always shown alongside the
   * raw `lastWatcherPass` timestamp so a reader is never left trusting the
   * derived boolean alone.
   */
  readonly daemonRunning: boolean;
}

export interface StatusTotals {
  readonly linked: number;
  readonly open: number;
  readonly closed: number;
  readonly running: number;
  readonly held: number;
}

export interface StatusLive {
  readonly open: number;
  readonly closed: number;
  readonly checkedAt: string;
}

export interface DivergenceItem {
  readonly ticket: string;
  readonly ledger: "open" | "closed";
  readonly live: "open" | "closed";
  readonly since: string | null;
}

export interface TicketProposalInfo {
  readonly phase: ProposalPhase;
  readonly proposedBy: string;
  readonly ratifiedBy: string | null;
  readonly at: string | null;
}

export interface TicketStatus {
  readonly url: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly sections: readonly string[];
  readonly planState: "ticked" | "unticked";
  readonly ledgerState: "announced-complete" | "not-announced";
  readonly liveState: "open" | "closed" | null;
  readonly proposal: TicketProposalInfo | null;
}

export interface SectionStatus {
  readonly title: string;
  readonly level: number;
  readonly total: number;
  readonly open: number;
  readonly running: number;
  readonly held: number;
  readonly tickets: readonly TicketStatus[];
}

export interface StatusEnvelope {
  readonly schema: typeof STATUS_SCHEMA;
  readonly plan: StatusPlan;
  readonly freshness: StatusFreshness;
  readonly totals: StatusTotals;
  readonly live: StatusLive | null;
  readonly divergence: readonly DivergenceItem[];
  readonly sections: readonly SectionStatus[];
  readonly tickets: readonly TicketStatus[];
}

/** One linked issue's state as read LIVE from GitHub, keyed by its URL. */
export interface LiveTicketState {
  readonly closed: boolean;
  /** ISO 8601, when known and closed. `null` otherwise. */
  readonly closedAt: string | null;
}

export interface BuildStatusInput {
  readonly planUrl: string;
  readonly revision: string;
  /** The cached (or freshly read) plan body. */
  readonly body: string;
  readonly records: readonly ProposalRecord[];
  readonly announced: (url: string) => boolean;
  /** Cached linked-issue title, or `null` if never fetched. */
  readonly titleOf: (url: string) => string | null;
  readonly now: number;
  readonly freshness: {
    readonly lastWatcherPassTs: number | null;
    readonly lastReconcile: { ts: number; driftCount: number } | null;
    readonly lastLedgerEntryTs: number | null;
    readonly daemonRunning: boolean;
  };
  /** Present only with `--live` — per-URL live state, and when the check ran. */
  readonly live: { readonly states: ReadonlyMap<string, LiveTicketState>; readonly checkedAt: number } | null;
}

function iso(ts: number | null): string | null {
  return ts === null ? null : new Date(ts).toISOString();
}

/** The plan's own display title: the first (document-order) heading, or "". */
function planTitleFrom(sections: readonly { readonly title: string }[]): string {
  return sections.length > 0 ? sections[0]!.title : "";
}

function ticketRef(url: string): { repo: string; number: number } {
  const parsed = parseIssueUrl(url);
  return parsed === null ? { repo: "", number: 0 } : { repo: `${parsed.owner}/${parsed.repo}`, number: parsed.number };
}

/** Most recent proposal record for this URL — `records` is newest-first (`recentProposals`). */
function proposalFor(url: string, records: readonly ProposalRecord[]): TicketProposalInfo | null {
  const record = records.find((r) => r.url === url);
  if (record === undefined) return null;
  const at = record.posted?.ts ?? record.applied?.ts ?? record.ratification?.ts ?? null;
  return {
    phase: record.phase,
    proposedBy: record.proposer,
    ratifiedBy: record.ratification?.principal ?? null,
    at: iso(at),
  };
}

/**
 * The envelope. PURE — every input is already resolved (cached body, cached
 * titles, freshness facts, an optional pre-fetched live map); this function
 * makes no I/O decision of its own. Every count comes from `dashboard.ts`'s
 * `planSections`/`bodyTotals`/`planTickets` — see the file header.
 */
export function buildStatusEnvelope(input: BuildStatusInput): StatusEnvelope {
  const dashInput: PlanDashboardInput = {
    body: input.body,
    records: input.records,
    announced: input.announced,
    planUrl: input.planUrl,
    generatedAt: input.now,
  };

  const sectionSummaries = planSections(dashInput);
  const totalsRaw = bodyTotals(dashInput);
  const ticketSummaries = planTickets(dashInput);

  const tickets: TicketStatus[] = ticketSummaries.map((t) => {
    const ref = ticketRef(t.url);
    const live = input.live?.states.get(t.url) ?? null;
    return {
      url: t.url,
      repo: ref.repo,
      number: ref.number,
      title: input.titleOf(t.url) ?? "",
      sections: t.sections,
      planState: t.tickedInBody ? "ticked" : "unticked",
      ledgerState: input.announced(t.url) ? "announced-complete" : "not-announced",
      liveState: live === null ? null : live.closed ? "closed" : "open",
      proposal: proposalFor(t.url, input.records),
    };
  });
  const ticketsByUrl = new Map(tickets.map((t) => [t.url, t] as const));

  const sections: SectionStatus[] = sectionSummaries.map((s) => ({
    title: s.title,
    level: s.level,
    total: s.total,
    open: s.open,
    running: s.running,
    held: s.held,
    tickets: ticketSummaries
      .filter((t) => t.sections.includes(s.title))
      .map((t) => ticketsByUrl.get(t.url))
      .filter((t): t is TicketStatus => t !== undefined),
  }));

  const live: StatusLive | null =
    input.live === null
      ? null
      : {
          open: [...input.live.states.values()].filter((v) => !v.closed).length,
          closed: [...input.live.states.values()].filter((v) => v.closed).length,
          checkedAt: iso(input.live.checkedAt)!,
        };

  const divergence: DivergenceItem[] = [];
  if (input.live !== null) {
    for (const t of tickets) {
      if (t.liveState === null) continue;
      const ledgerState: "open" | "closed" = t.planState === "ticked" || t.ledgerState === "announced-complete"
        ? "closed"
        : "open";
      if (ledgerState === t.liveState) continue;
      const liveRaw = input.live.states.get(t.url) ?? null;
      divergence.push({
        ticket: `${t.repo}#${t.number}`,
        ledger: ledgerState,
        live: t.liveState,
        since: liveRaw?.closedAt ?? null,
      });
    }
  }

  return {
    schema: STATUS_SCHEMA,
    plan: {
      url: input.planUrl,
      revision: input.revision,
      title: planTitleFrom(sectionSummaries),
    },
    freshness: {
      generatedAt: iso(input.now)!,
      lastWatcherPass: iso(input.freshness.lastWatcherPassTs),
      lastReconcile:
        input.freshness.lastReconcile === null
          ? null
          : { at: iso(input.freshness.lastReconcile.ts)!, drift: input.freshness.lastReconcile.driftCount },
      lastLedgerEntry: iso(input.freshness.lastLedgerEntryTs),
      daemonRunning: input.freshness.daemonRunning,
    },
    totals: {
      linked: totalsRaw.total,
      open: totalsRaw.open,
      closed: totalsRaw.total - totalsRaw.open,
      running: totalsRaw.running,
      held: totalsRaw.held,
    },
    live,
    divergence,
    sections,
    tickets,
  };
}

// ── Filters — `--section` / `--ticket` / `--held` / `--running` ────────────

export type ResolveResult<T> =
  | { kind: "found"; value: T }
  | { kind: "not-found" };

/** Case-insensitive, trimmed — the same comparison `dashboard.ts`'s `recordBelongsTo` uses. */
export function resolveSection(
  envelope: StatusEnvelope,
  name: string,
): ResolveResult<SectionStatus> {
  const needle = name.trim().toLowerCase();
  const match = envelope.sections.find((s) => s.title.trim().toLowerCase() === needle);
  return match === undefined ? { kind: "not-found" } : { kind: "found", value: match };
}

/** A `--ticket` reference: `owner/repo#123`, a bare `#123` (needs a repo hint), or a full URL. */
export function parseTicketRef(ref: string): { repo: string | null; number: number } | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("https://")) {
    const parsed = parseIssueUrl(trimmed);
    return parsed === null ? null : { repo: `${parsed.owner}/${parsed.repo}`, number: parsed.number };
  }
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)?)#([1-9][0-9]{0,9})$/.exec(trimmed);
  if (m === null) return null;
  const repoPart = m[1]!.includes("/") ? m[1]! : null;
  return { repo: repoPart, number: Number(m[2]) };
}

export function resolveTicket(envelope: StatusEnvelope, ref: string): ResolveResult<TicketStatus> {
  const parsed = parseTicketRef(ref);
  if (parsed === null) return { kind: "not-found" };
  const match = envelope.tickets.find(
    (t) => t.number === parsed.number && (parsed.repo === null || t.repo === parsed.repo),
  );
  return match === undefined ? { kind: "not-found" } : { kind: "found", value: match };
}

export function filterHeld(envelope: StatusEnvelope): readonly TicketStatus[] {
  return envelope.tickets.filter((t) => t.proposal?.phase === "surfaced");
}

export function filterRunning(envelope: StatusEnvelope): readonly TicketStatus[] {
  return envelope.tickets.filter((t) => t.proposal?.phase === "ratified" || t.proposal?.phase === "applied");
}

// ── argv parsing ─────────────────────────────────────────────────────────────

export interface StatusArgs {
  readonly section: string | null;
  readonly ticket: string | null;
  readonly held: boolean;
  readonly running: boolean;
  readonly json: boolean;
  readonly live: boolean;
  readonly plan: string | null;
}

export type StatusArgsResult = { kind: "ok"; args: StatusArgs } | { kind: "error"; message: string };

const FLAGS_TAKING_A_VALUE = new Set(["--section", "--ticket", "--plan"]);

/** Total, and refuses anything it does not recognise rather than ignoring it. */
export function parseStatusArgs(argv: readonly string[]): StatusArgsResult {
  let section: string | null = null;
  let ticket: string | null = null;
  let held = false;
  let running = false;
  let json = false;
  let live = false;
  let plan: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (FLAGS_TAKING_A_VALUE.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) return { kind: "error", message: `${arg} requires a value` };
      i += 1;
      if (arg === "--section") section = value;
      else if (arg === "--ticket") ticket = value;
      else plan = value;
      continue;
    }
    switch (arg) {
      case "--held":
        held = true;
        break;
      case "--running":
        running = true;
        break;
      case "--json":
        json = true;
        break;
      case "--live":
        live = true;
        break;
      default:
        return { kind: "error", message: `unrecognised argument: ${arg}` };
    }
  }
  if (section !== null && ticket !== null) {
    return { kind: "error", message: "--section and --ticket are mutually exclusive" };
  }
  return { kind: "ok", args: { section, ticket, held, running, json, live, plan } };
}

// ── human rendering ──────────────────────────────────────────────────────────

function freshnessLines(f: StatusFreshness, revision: string): string[] {
  const lines: string[] = [];
  lines.push(`As of ${f.generatedAt} · plan revision ${shortRevision(revision)}`);
  lines.push(
    `Watcher last ran: ${f.lastWatcherPass ?? "never"} · ` +
      `Reconcile last ran: ${f.lastReconcile === null ? "never" : `${f.lastReconcile.at} (drift ${f.lastReconcile.drift})`} · ` +
      `Last ledger entry: ${f.lastLedgerEntry ?? "never"}`,
  );
  lines.push(f.daemonRunning ? "Daemon: running" : "DAEMON NOT RUNNING — this view may be arbitrarily stale");
  return lines;
}

/** `sha256:<64 hex>` is unreadable in a channel; show a short, still-distinct prefix. */
function shortRevision(revision: string): string {
  if (revision.length === 0) return "(none)";
  return revision.startsWith("sha256:") ? revision.slice(0, "sha256:".length + 12) : revision;
}

function ticketLine(t: TicketStatus, indent: string): string {
  const marker = t.proposal?.phase === "surfaced" ? " ✋" : t.proposal?.phase === "ratified" || t.proposal?.phase === "applied" ? " 🏃" : "";
  const live = t.liveState === null ? "" : ` · live:${t.liveState}`;
  return `${indent}- ${t.repo}#${t.number} [${t.planState}, ${t.ledgerState}${live}]${marker} ${t.title}`.trimEnd();
}

/** The full, unfiltered human rendering. `renderStatusFiltered` covers the flag-scoped views. */
export function renderStatusHuman(envelope: StatusEnvelope): string {
  const lines: string[] = [];
  lines.push(`Plan: ${envelope.plan.title || "(untitled)"} — ${envelope.plan.url}`);
  lines.push(...freshnessLines(envelope.freshness, envelope.plan.revision));
  lines.push("");
  lines.push(
    `${envelope.totals.linked} linked · ${envelope.totals.open} open · ${envelope.totals.closed} closed` +
      ` · 🏃 ${envelope.totals.running} · ✋ ${envelope.totals.held}${envelope.totals.linked === 0 ? "" : "        (ledger)"}`,
  );
  if (envelope.live !== null) {
    lines.push(`${" ".repeat(String(envelope.totals.linked).length + 9)}${envelope.live.closed} closed          (GitHub, live)`);
    if (envelope.divergence.length === 0) {
      lines.push("No divergence between the ledger and GitHub.");
    } else {
      lines.push(`⚠ ${envelope.divergence.length} divergence(s):`);
      for (const d of envelope.divergence) {
        lines.push(`  - ${d.ticket}: ledger says ${d.ledger}, GitHub says ${d.live}${d.since === null ? "" : ` (since ${d.since})`}`);
      }
    }
  }
  lines.push("");
  if (envelope.sections.length === 0) {
    lines.push("No sections — the plan body carries no markdown headings.");
  } else {
    for (const s of envelope.sections) {
      const markers: string[] = [];
      if (s.running > 0) markers.push(`🏃 ${s.running}`);
      if (s.held > 0) markers.push(`✋ ${s.held}`);
      const tail = markers.length > 0 ? ` · ${markers.join(" · ")}` : "";
      lines.push(`- **${s.title}** — ${s.open}/${s.total} open${tail}`);
      for (const t of s.tickets) lines.push(ticketLine(t, "  "));
    }
  }
  return `${lines.join("\n")}\n`;
}

/** A miss on `--section`/`--ticket` is an explicit refusal, never an empty success. */
export function renderNotFound(kind: "section" | "ticket", needle: string): string {
  return `atlas status: no ${kind} matching ${JSON.stringify(needle)} in this plan\n`;
}

export function renderTicketList(tickets: readonly TicketStatus[], label: string): string {
  if (tickets.length === 0) return `Nothing ${label}.\n`;
  const lines = [`${tickets.length} ${label}:`];
  for (const t of tickets) lines.push(ticketLine(t, ""));
  return `${lines.join("\n")}\n`;
}

export function renderSectionHuman(section: SectionStatus): string {
  const markers: string[] = [];
  if (section.running > 0) markers.push(`🏃 ${section.running}`);
  if (section.held > 0) markers.push(`✋ ${section.held}`);
  const tail = markers.length > 0 ? ` · ${markers.join(" · ")}` : "";
  const lines = [`**${section.title}** — ${section.open}/${section.total} open${tail}`];
  for (const t of section.tickets) lines.push(ticketLine(t, "  "));
  return `${lines.join("\n")}\n`;
}

export function renderTicketHuman(ticket: TicketStatus): string {
  const lines = [
    `${ticket.repo}#${ticket.number} — ${ticket.title || "(no cached title)"}`,
    `plan: ${ticket.planState} · ledger: ${ticket.ledgerState}${ticket.liveState === null ? "" : ` · live: ${ticket.liveState}`}`,
    `sections: ${ticket.sections.length > 0 ? ticket.sections.join(", ") : "(none)"}`,
  ];
  if (ticket.proposal !== null) {
    lines.push(
      `proposal: ${ticket.proposal.phase} · proposed by ${ticket.proposal.proposedBy}` +
        `${ticket.proposal.ratifiedBy === null ? "" : ` · ratified by ${ticket.proposal.ratifiedBy}`}` +
        `${ticket.proposal.at === null ? "" : ` · ${ticket.proposal.at}`}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
