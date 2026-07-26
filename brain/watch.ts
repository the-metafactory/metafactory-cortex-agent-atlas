/**
 * The COMPLETION WATCHER (W2c, issue #1; vision#9 §3 J4, §10 q2 — "does J4 poll
 * GitHub or consume an event source … poll is simpler for MVP", resolved in the
 * spec in favour of polling).
 *
 * One pass = read the plan body, resolve the issues it links to, and enqueue a
 * ✅ for anything newly closed. The ledger's batching rule (effects/discord.ts)
 * turns however many closures a pass finds into ONE post.
 *
 * ── "Newly" closed is a DURABLE fact, not a process memory ─────────────────
 * An in-process `Set` of announced issues would re-announce the entire plan
 * after every restart — a ticker of stale ✅s, which is exactly what the
 * conventions rule out ("the ledger's value is that it can be trusted
 * backwards"). So the record lives in the event log
 * (`state.hasAnnouncedCompletion` / `recordCompletionAnnounced`) and is written
 * only AFTER a post lands. Two consequences, both wanted:
 *   - a post that fails leaves nothing recorded, so the next pass retries it;
 *   - a store that cannot record an announcement cannot authorise one, so a
 *     degraded state refuses the whole pass rather than posting into a void.
 *
 * ── This path causes an effect, and it needs no ratification ───────────────
 * Worth being explicit, because "no effect without a certificate" is this
 * slice's headline rule: a ✅ is not a plan CHANGE. It changes nothing on the
 * plan body, decides nothing, and asserts only a fact GitHub already published
 * — that an issue the plan links to is closed. The gate exists to stop public
 * input from causing effects; nothing here is public input. What bounds this
 * path instead is: the plan body chooses the issues (nobody can inject a URL
 * without a ratified plan edit), GitHub ground truth chooses which are closed,
 * and config chooses the channel. An issue TITLE is untrusted text and is
 * treated as such — quoted by the ledger template, never interpreted.
 *
 * ── Bounded work per pass ──────────────────────────────────────────────────
 * A plan body is operator-sized but not operator-bounded, and each unannounced
 * URL costs a gh read. `MAX_READS_PER_PASS` caps the reads a single pass makes;
 * the remainder is simply picked up next pass, because "already announced" is
 * durable and the queue survives. No pass can turn into an unbounded fan-out.
 */

import { parseIssueUrl, type LinkedIssueReader } from "./gh";
import { planBodyRevision } from "./plan-revision";
import type { AtlasProposals } from "./state";
import type { PlanWriter } from "./effects/gh";
import type { CompletionItem, DiscordLedger, FlushOutcome } from "./effects/discord";

function warn(msg: string): void {
  process.stderr.write(`atlas: watch: ${msg}\n`);
}

/** Live gh reads per pass. The rest waits for the next one. */
const MAX_READS_PER_PASS = 50;
/** Defensive cap on how many URLs are extracted from one body. */
const MAX_LINKED_URLS = 500;

/** Poll cadence bounds. Below a minute is a hammer; above a day is not a watcher. */
const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;
const MIN_POLL_INTERVAL_MS = 60_000;
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * `ATLAS_WATCH_INTERVAL_MS` — the poll cadence, from config, defaulted and
 * clamped. Consumed by the daemon loop in `brain/main.ts`; this module exposes
 * the value and performs ONE pass per call, so the scheduling policy and the
 * pass are independently testable (and a test never waits on a timer).
 */
export function resolvePollIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.ATLAS_WATCH_INTERVAL_MS;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_POLL_INTERVAL_MS;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, n));
}

/** Every distinct GitHub issue URL the plan body links to, in body order. */
export function extractLinkedIssueUrls(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  // Constructed per call: a `g` regex holds `lastIndex` between calls, and a
  // shared one would silently skip URLs on every second invocation.
  const re = /https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/issues\/[1-9][0-9]{0,9}/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(re)) {
    const url = m[0];
    // Re-validate through the strict parser rather than trusting the scan —
    // never trust an upstream "this was already validated" claim (gh.ts).
    if (parseIssueUrl(url) === null) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_LINKED_URLS) break;
  }
  return out;
}

export interface WatchDeps {
  readonly state: AtlasProposals;
  /** Reads the plan body — config-pinned, so the watched set comes from config too. */
  readonly plan: PlanWriter;
  /** Reads arbitrary linked issues. A READ port; it cannot write anywhere. */
  readonly gh: LinkedIssueReader;
  readonly ledger: DiscordLedger;
}

export type WatchOutcome =
  | { kind: "refused"; reason: "state-degraded" | "plan-unreadable"; detail: string }
  | {
      kind: "polled";
      /** Linked issue URLs considered this pass (excludes already-announced ones). */
      checked: number;
      /** Newly-closed issues enqueued this pass. */
      enqueued: number;
      /** What the flush did — `posted` carries the single batched post's receipt. */
      flush: FlushOutcome;
      /** Announcements durably recorded (equals the flushed batch size on success). */
      recorded: number;
    };

/**
 * ONE poll pass. Never throws: a read failure is a skipped item, not an
 * exception escaping into the daemon loop.
 */
export async function pollCompletions(
  deps: WatchDeps,
  now: number = Date.now(),
): Promise<WatchOutcome> {
  if (!deps.state.isDurable()) {
    // Fail closed: an announcement that cannot be recorded must not be made.
    return {
      kind: "refused",
      reason: "state-degraded",
      detail: "durable state is unreadable; completions will not be announced",
    };
  }

  const snapshot = await deps.plan.readPlan();
  if (snapshot === null) {
    return { kind: "refused", reason: "plan-unreadable", detail: "could not read the plan body" };
  }

  // atlas#28: cache the plan body this pass just fetched — the `atlas status`
  // CLI's default (offline) view reads this back rather than making its own
  // network call. Cheap: it is the SAME read this pass already paid for, just
  // written down alongside the completion index instead of discarded.
  deps.state.recordPlanBodyCache(snapshot.body, planBodyRevision(snapshot.body));

  const urls = extractLinkedIssueUrls(snapshot.body);
  let checked = 0;
  let enqueued = 0;
  for (const url of urls) {
    if (checked >= MAX_READS_PER_PASS) break;
    if (deps.state.hasAnnouncedCompletion(url)) continue;
    checked += 1;
    let state: Awaited<ReturnType<LinkedIssueReader["getLinkedIssue"]>>;
    try {
      state = await deps.gh.getLinkedIssue(url);
    } catch (err) {
      warn(`read failed for a linked issue: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (state === null) continue;
    // atlas#28, D1(a): cache the title at the exact point it is fetched —
    // regardless of open/closed — so the status CLI's per-ticket view has
    // something better than a bare URL without a network call of its own.
    deps.state.recordLinkedIssueTitle(url, state.title);
    // A failed read is NEVER "closed". Silence beats a wrong ✅.
    if (!state.closed) continue;
    const item = toCompletionItem(url, state.title, state.referencingPrUrl);
    if (item === null) continue;
    deps.ledger.enqueueCompletion(item);
    enqueued += 1;
  }

  const flush = await deps.ledger.flushCompletions(now);
  let recorded = 0;
  if (flush.kind === "posted") {
    // Recorded only AFTER the post landed, and per item, so a partial failure
    // re-announces at most the items whose record did not stick.
    for (const item of flush.items) {
      deps.state.recordCompletionAnnounced(item.url, flush.receipt.messageId);
      recorded += 1;
    }
  }
  // atlas#28: written on EVERY completed pass (not only when something was
  // found) — the freshness fact "the watcher last ran at T" must exist even
  // on a pass with nothing to announce.
  deps.state.recordWatchPass(now);
  return { kind: "polled", checked, enqueued, flush, recorded };
}

function toCompletionItem(
  url: string,
  title: string,
  referencingPrUrl: string | null,
): CompletionItem | null {
  const ref = parseIssueUrl(url);
  if (ref === null) return null;
  return {
    repo: `${ref.owner}/${ref.repo}`,
    number: ref.number,
    // Untrusted; the ledger template sanitises and quotes it. Capped here too,
    // so a pathological title cannot crowd out the rest of a batched post.
    title: typeof title === "string" ? title.slice(0, 200) : "",
    url,
    closingPrUrl: referencingPrUrl,
  };
}
