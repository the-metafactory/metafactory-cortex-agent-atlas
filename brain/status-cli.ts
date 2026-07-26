/**
 * `atlas status` — the impure shell (atlas#28). Everything decision-shaped
 * lives in `brain/status.ts`, which is pure; this file only resolves env,
 * opens storage, optionally reads GitHub, and prints.
 *
 * ── Read-only BY CONSTRUCTION, not by convention ────────────────────────────
 * This file constructs NO `PlanWriter`, NO effects layer, NO ledger transport
 * — not "does not call them", but *cannot*, because it never imports
 * `GhCliPlanWriter`, `DiscordLedger`, `HostLedgerTransport`, `EffectsConfig`,
 * or either of `effects/config.ts`'s config loaders. The only `gh` port in
 * scope is `GhCliReadOnly` (`brain/gh.ts`), which is a READ over an arbitrary
 * repo and was already the read-only adapter every other read-only slice
 * (intake validation, the completion watcher) uses — it is neither a
 * `PlanWriter` nor an effects layer nor a transport, so bringing it into
 * scope for `--live` does not weaken this file's constitution. `status.test.ts`
 * asserts this structurally (a source scan for the forbidden imports/tokens),
 * not by inspection of this paragraph.
 *
 * The SQLite handle is opened via `AtlasStateStore.openReadOnly` — genuinely
 * `SQLITE_OPEN_READONLY`, so a write-shaped call would throw at the SQLite
 * layer even if this file's own source scan somehow missed one. A read-only
 * handle never blocks a concurrently running daemon's WAL writer.
 *
 * ── The skill's prohibition lives one layer up, in persona.md ───────────────
 * This file NEVER falls back to `gh issue list` or any other reconstruction
 * when storage is unavailable — it prints a refusal and exits non-zero. See
 * `persona.md`'s "Status" section for the matching prohibition on the agent
 * side: Atlas states plainly that it could not be reached and stops, rather
 * than reconstructing a plausible-looking number from a different source.
 */

import { AtlasStateStore } from "./state";
import { GhCliReadOnly, parseIssueUrl, type LinkedIssueReader } from "./gh";
import { extractLinkedIssueUrls, resolvePollIntervalMs } from "./watch";
import { loadBrainEnv } from "./env";
import { defaultInstanceDir } from "./state";
import {
  buildStatusEnvelope,
  filterHeld,
  filterRunning,
  parseStatusArgs,
  renderNotFound,
  renderSectionHuman,
  renderStatusHuman,
  renderTicketHuman,
  renderTicketList,
  resolveSection,
  resolveTicket,
  type LiveTicketState,
  type StatusEnvelope,
} from "./status";

function warn(msg: string): void {
  process.stderr.write(`atlas: status: ${msg}\n`);
}

export interface RunStatusResult {
  readonly exitCode: number;
  readonly output: string;
}

/** Live gh reads this CLI will make for `--live` — mirrors `watch.ts`'s own per-pass bound. */
const MAX_LIVE_READS = 50;

/**
 * A daemon-liveness ESTIMATE, never a fact. There is no PID file or heartbeat
 * this tool may read without constructing exactly the kind of runtime
 * coupling the read-only-by-construction principle forbids — so this is
 * "has the watcher run recently enough that it is plausibly still alive",
 * bounded generously (2.5x the configured poll interval) so a briefly slow
 * pass does not read as `daemonRunning: false`. Always shown alongside the
 * raw `lastWatcherPass` timestamp (see `status.ts`'s `StatusFreshness`) so a
 * reader is never left trusting this boolean alone.
 */
export function estimateDaemonRunning(
  lastWatchPassTs: number | null,
  pollIntervalMs: number,
  now: number,
): boolean {
  if (lastWatchPassTs === null) return false;
  const staleAfterMs = pollIntervalMs * 2.5;
  return now - lastWatchPassTs < staleAfterMs;
}

/** Mirrors `brain/gh.ts`'s `resolvePlanCoordinatesFromEnv`, parametrized so this file stays testable without touching real `process.env`. */
function planCoordinatesFrom(env: Record<string, string | undefined>): { repo: string; issue: number } | null {
  const repo = env.ATLAS_PLAN_REPO;
  const issueRaw = env.ATLAS_PLAN_ISSUE;
  if (repo === undefined || repo.length === 0 || issueRaw === undefined) return null;
  const issue = Number(issueRaw);
  if (!Number.isSafeInteger(issue) || issue <= 0) return null;
  return { repo, issue };
}

function planUrlOf(coords: { repo: string; issue: number } | null): string {
  return coords === null ? "" : `https://github.com/${coords.repo}/issues/${coords.issue}`;
}

export async function runAtlasStatus(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
  /**
   * Injectable seam for the `--live` read port, defaulting to the real
   * `GhCliReadOnly` (a genuine `gh` subprocess). Tests supply a fake reader
   * so `--live` is exercisable without a network call or a real `gh` auth
   * context — the same pattern `GhCliPlanWriter`'s injectable spawn function
   * and `DiscordLedger`'s injectable transport already use elsewhere in this
   * pack. `LinkedIssueReader` is still the narrow read-only port; injecting a
   * fake here changes nothing about what this file can construct.
   */
  makeGh: (coords: { repo: string; issue: number }) => LinkedIssueReader = (coords) => new GhCliReadOnly(coords),
): Promise<RunStatusResult> {
  const parsed = parseStatusArgs(argv);
  if (parsed.kind === "error") {
    return { exitCode: 2, output: `atlas status: ${parsed.message}\n` };
  }
  const args = parsed.args;

  // Absent-keys-only overlay from the operator's own env file — same
  // resolution `main.ts` uses, so this CLI run from an interactive shell sees
  // the same configuration the daemon does.
  loadBrainEnv(env as NodeJS.ProcessEnv);

  let configuredCoords = planCoordinatesFrom(env);
  if (args.plan !== null) {
    const ref = parseIssueUrl(args.plan);
    if (ref === null) {
      return { exitCode: 2, output: `atlas status: --plan is not a GitHub issue URL: ${args.plan}\n` };
    }
    const overrideCoords = { repo: `${ref.owner}/${ref.repo}`, issue: ref.number };
    if (
      configuredCoords !== null &&
      (configuredCoords.repo !== overrideCoords.repo || configuredCoords.issue !== overrideCoords.issue)
    ) {
      // Cross-plan aggregation is explicitly out of scope (issue #28: "One
      // plan, one Atlas") — a mismatched --plan is a refusal, not a silent
      // switch to state this instance never watched.
      return {
        exitCode: 2,
        output:
          `atlas status: --plan ${args.plan} does not match this deployment's configured plan ` +
          `(${planUrlOf(configuredCoords)}) — this Atlas instance has no state for a different plan.\n`,
      };
    }
    configuredCoords = overrideCoords;
  }

  const dirEnv = env.ATLAS_STATE_DIR;
  const dir = dirEnv !== undefined && dirEnv.length > 0 ? dirEnv : defaultInstanceDir();
  const store = AtlasStateStore.openReadOnly(dir);
  if (store === null) {
    return {
      exitCode: 1,
      output: `atlas status: no local state at ${dir} — Atlas has not run here yet.\n`,
    };
  }

  try {
    const cache = store.getPlanBodyCache();
    if (cache === null) {
      return {
        exitCode: 1,
        output:
          "atlas status: no plan snapshot cached yet — the watcher has not completed a pass. " +
          "Try again once Atlas's daemon has run at least once.\n",
      };
    }

    const records = store.recentProposals();
    const lastWatcherPassTs = store.lastWatchPassTs();
    const lastReconcile = store.lastReconcilePass();
    const lastLedgerEntryTs = store.lastLedgerEntryTs();
    const pollIntervalMs = resolvePollIntervalMs(env);
    const daemonRunning = estimateDaemonRunning(lastWatcherPassTs, pollIntervalMs, now);

    let live: { states: ReadonlyMap<string, LiveTicketState>; checkedAt: number } | null = null;
    if (args.live) {
      if (configuredCoords === null) {
        return {
          exitCode: 2,
          output:
            "atlas status: --live requires ATLAS_PLAN_REPO/ATLAS_PLAN_ISSUE to be resolvable " +
            "(from the environment, the env-file overlay, or --plan).\n",
        };
      }
      const gh = makeGh(configuredCoords);
      const states = new Map<string, LiveTicketState>();
      const urls = extractLinkedIssueUrls(cache.body).slice(0, MAX_LIVE_READS);
      for (const url of urls) {
        let state: Awaited<ReturnType<LinkedIssueReader["getLinkedIssue"]>>;
        try {
          state = await gh.getLinkedIssue(url);
        } catch (err) {
          warn(`--live read failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (state !== null) states.set(url, { closed: state.closed, closedAt: state.closedAt });
      }
      live = { states, checkedAt: now };
    }

    const envelope = buildStatusEnvelope({
      planUrl: planUrlOf(configuredCoords),
      revision: cache.revision,
      body: cache.body,
      records,
      announced: (url) => store.hasAnnouncedCompletion(url),
      titleOf: (url) => store.getLinkedIssueTitle(url)?.title ?? null,
      now,
      freshness: { lastWatcherPassTs, lastReconcile, lastLedgerEntryTs, daemonRunning },
      live,
    });

    return renderResult(envelope, args);
  } finally {
    store.close();
  }
}

function renderResult(
  envelope: StatusEnvelope,
  args: { section: string | null; ticket: string | null; held: boolean; running: boolean; json: boolean },
): RunStatusResult {
  if (args.ticket !== null) {
    const found = resolveTicket(envelope, args.ticket);
    if (found.kind === "not-found") return { exitCode: 1, output: renderNotFound("ticket", args.ticket) };
    const scoped: StatusEnvelope = { ...envelope, tickets: [found.value], sections: [] };
    return {
      exitCode: 0,
      output: args.json ? `${JSON.stringify(scoped, null, 2)}\n` : `${headerFor(envelope)}\n${renderTicketHuman(found.value)}`,
    };
  }
  if (args.section !== null) {
    const found = resolveSection(envelope, args.section);
    if (found.kind === "not-found") return { exitCode: 1, output: renderNotFound("section", args.section) };
    const scoped: StatusEnvelope = { ...envelope, tickets: found.value.tickets, sections: [found.value] };
    return {
      exitCode: 0,
      output: args.json ? `${JSON.stringify(scoped, null, 2)}\n` : `${headerFor(envelope)}\n${renderSectionHuman(found.value)}`,
    };
  }
  if (args.held) {
    const list = filterHeld(envelope);
    const scoped: StatusEnvelope = { ...envelope, tickets: list, sections: [] };
    return {
      exitCode: 0,
      output: args.json ? `${JSON.stringify(scoped, null, 2)}\n` : `${headerFor(envelope)}\n${renderTicketList(list, "held (awaiting a human)")}`,
    };
  }
  if (args.running) {
    const list = filterRunning(envelope);
    const scoped: StatusEnvelope = { ...envelope, tickets: list, sections: [] };
    return {
      exitCode: 0,
      output: args.json ? `${JSON.stringify(scoped, null, 2)}\n` : `${headerFor(envelope)}\n${renderTicketList(list, "running (in flight)")}`,
    };
  }
  return {
    exitCode: 0,
    output: args.json ? `${JSON.stringify(envelope, null, 2)}\n` : renderStatusHuman(envelope),
  };
}

function headerFor(envelope: StatusEnvelope): string {
  return `Plan: ${envelope.plan.title || "(untitled)"} — ${envelope.plan.url}\n` +
    `As of ${envelope.freshness.generatedAt}${envelope.freshness.daemonRunning ? "" : " — DAEMON NOT RUNNING, this view may be stale"}`;
}
