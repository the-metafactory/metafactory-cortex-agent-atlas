/**
 * The Atlas daemon's BEHAVIOURAL shell — cortex events in, brain effects out.
 *
 * `main.ts` is the socket; this file is what the socket carries. The split is
 * escort's (`brain/main.ts` thin, `brain/handler.ts` behavioural) and exists
 * for one reason: everything below is drivable from a test without a socket, a
 * subprocess, or a live cortex.
 *
 * ── This file WIRES; it does not DECIDE ────────────────────────────────────
 * Every judgement Atlas makes already lives in a reviewed module:
 * `proposal.ts` (intake), `ratify.ts` (the gate), `apply.ts` (effects),
 * `watch.ts` and `reconcile.ts` (the loops). Not one of them is re-implemented,
 * second-guessed, or wrapped in a shortcut here. What this file owns is the
 * three questions none of them can answer alone:
 *
 *   1. WHICH inbound events reach them (admission),
 *   2. WHEN the timer-driven passes run, and
 *   3. WHETHER an effect can physically leave right now (the post window).
 *
 * ── The post window, and why the schedulers care ───────────────────────────
 * `cortex-brain/v1` has no free-standing post: every effect must correlate to a
 * task the host currently owns (see `transport.ts`). A task opens when cortex
 * delivers it and closes when Atlas emits `result`. So a reconcile that runs on
 * a 6-hour timer at 03:00, with nobody talking to Atlas, CANNOT post its
 * catch-up.
 *
 * That is handled honestly rather than hidden. The passes still run on their
 * intervals — detection and state convergence are the bulk of their value, and
 * both loops are built to record NOTHING when their post fails
 * (`reconcile.ts`'s `post-failed` records not even the pass; `watch.ts` keeps
 * its queue and only records after a landed post). A pass that could not speak
 * sets a DUE flag, and the next task window re-runs it with the window open.
 * The result is: correct always, prompt when there is traffic, and never a
 * claim that something was said when it was not.
 *
 * ── Admission is config-pinned (and state-pinned, atlas#22) ────────────────
 * A task is served only when its HOST-RESOLVED `source.channel` is either
 *
 *   1. the configured ledger channel, or
 *   2. a thread ATLAS ITSELF OPENED and durably recorded opening
 *      (`state.isOwnedThread`, the `owned_threads` table).
 *
 * Atlas's presence already binds it to one channel, so (1) is defence in depth
 * — but it is the difference between "the adapter is expected not to deliver
 * that" and "Atlas will not act on it". A non-admitted task is answered with
 * silence (a `log` effect, no `post`): replying would let anyone anywhere make
 * Atlas speak.
 *
 * (2) exists because the shipped Discord adapter sets `source.channel` to the
 * THREAD's own snowflake and sends no parent-channel signal at all (see
 * `protocol.ts`'s `TaskSource`) — so before atlas#22 a reply typed in a thread
 * was refused in silence, including a `RATIFY` the agent had itself invited.
 * "A thread under my channel" is a question this protocol cannot answer; "a
 * thread I opened" is one only Atlas's own write record can answer, which is
 * exactly what it is. Three properties of that record are load-bearing:
 *
 *   - it is written ONLY from a host-resolved `thread_created.thread_id`
 *     correlated to a `create_private_thread` THIS process emitted;
 *   - it is DURABLE, so a restart does not make Atlas deaf in a thread it is
 *     still talking in (`state.ts`'s `OWNED_THREADS_SCHEMA`);
 *   - it widens WHERE Atlas listens and nothing else. Identity is unchanged:
 *     `ratify.ts` authorises on the platform-authenticated author id against
 *     the configured principal map, never on which room the message arrived
 *     in. A thread is not an authority.
 *
 * The adapter-instance check (atlas#24) applies to BOTH, unchanged and in the
 * same silence.
 *
 * A SECOND admission check, same disposition, same silence (atlas#24):
 * `source.adapter_instance` must be a member of `effects.trustedAdapterInstances`.
 * Verified against cortex directly — see `effects/config.ts`'s header — nothing
 * on the bus stops an envelope published straight onto `brain.>` (bypassing
 * every real adapter) from also carrying a channel id that matches, so the
 * channel check ALONE is not the defence-in-depth it reads as. The adapter
 * instance is host-set only on a genuine live-surface task; requiring it (and
 * requiring it to be a RECOGNISED one) is what actually makes "the adapter is
 * expected not to deliver that" a claim about the WIRE and not just about
 * `source.channel`, which a forged envelope can set to anything it likes.
 *
 * ── Untrusted input is DATA ────────────────────────────────────────────────
 * `payload.text` is written by arbitrary internet users. It is passed to
 * `processComment` / `processGateMessage` as an opaque body and NOWHERE else —
 * never into a `result` summary, never into a log line, never into any
 * structural field of any effect. Identity comes only from `source.surface` +
 * `source.user` — HOST-SET on the real inbound-surface path, but (atlas#24)
 * only as trustworthy as the two admission checks above make them: this file
 * does not treat `source.*` as authenticated by construction, only as admitted
 * by config.
 */

import { applyRatified } from "./apply";
import { regeneratePlanDashboard } from "./dashboard";
import type { EffectsConfig } from "./effects/config";
import type { DiscordLedger } from "./effects/discord";
import type { PlanWriter } from "./effects/gh";
import type { LinkedIssueReader, ReadOnlyGh } from "./gh";
import type { RatifyIdentityConfig } from "./identity";
import { processComment } from "./proposal";
import type { BrainEffect, BrainEvent, TaskEvent } from "./protocol";
import { processGateMessage } from "./ratify";
import { reconcilePlan } from "./reconcile";
import type { AtlasProposals } from "./state";
import type { HostLedgerTransport } from "./transport";
import { pollCompletions } from "./watch";

function warn(msg: string): void {
  process.stderr.write(`atlas: runtime: ${msg}\n`);
}

/**
 * Everything that only exists once Atlas has an effect target. Absent (`null`)
 * when `loadEffectsConfigFromEnv` refused: Atlas then admits nothing and says
 * so, rather than intaking proposals it could never act on.
 */
export interface EffectLayer {
  readonly effects: EffectsConfig;
  readonly plan: PlanWriter;
  readonly linked: LinkedIssueReader;
  readonly ledger: DiscordLedger;
  readonly transport: HostLedgerTransport;
}

export interface AtlasRuntimeDeps {
  /** Writes one effect line. Owned by `main.ts` (socket) or a test (array). */
  readonly send: (effect: BrainEffect) => void;
  readonly state: AtlasProposals;
  /** `null` ⇒ the gate is UNARMED; `ratify.ts` refuses every verb. */
  readonly identity: RatifyIdentityConfig | null;
  /** The intake validation read port. */
  readonly gh: ReadOnlyGh;
  readonly effectLayer: EffectLayer | null;
  /** Where `plan-dashboard.md` is redrawn. `null` skips the redraw. */
  readonly instanceDir: string | null;
  readonly watchIntervalMs: number;
  readonly reconcileIntervalMs: number;
  /**
   * How long to wait for the host's answer to a `create_private_thread`
   * before giving up and conversing in the bound channel instead (atlas#25).
   *
   * A wait is safe by contract: cortex PAUSES the task's liveness timeout
   * while a thread create is in flight (`daemon-brain-host.ts`, the same pause
   * `ask_principal` gets), so this cannot race the host into failing the task.
   * It is bounded anyway — a host that never answers must not hold a user's
   * task open forever, and the fallback (post in the channel) is exactly
   * today's behaviour, never a lost reply.
   */
  readonly threadWaitMs?: number;
  /** Injectable clock/timers so no test ever waits on a real interval. */
  readonly now?: () => number;
  readonly setIntervalFn?: (fn: () => void, ms: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
}

/**
 * The default bound on waiting for a `thread_created` / `effect_rejected`.
 * Generous, because the host is doing a real Discord REST round trip with the
 * liveness timer paused; bounded, because a silent host must not hold a user's
 * task open. Overridable per-runtime (`AtlasRuntimeDeps.threadWaitMs`) so no
 * test ever waits on it.
 */
const DEFAULT_THREAD_WAIT_MS = 10_000;

/** What one served task did. Recorded for the `result` summary and for tests. */
export type TaskDisposition =
  | "not-admitted"
  | "no-effect-layer"
  | "proposal-surfaced"
  | "proposal-declined"
  | "proposal-duplicate"
  | "gate-ratified"
  | "gate-declined"
  | "gate-replied"
  | "gate-ignored";

/** The answer to one `create_private_thread` request. Never throws. */
type ThreadOutcome =
  | { kind: "created"; threadId: string }
  | { kind: "refused"; detail: string };

export class AtlasRuntime {
  private readonly deps: AtlasRuntimeDeps;
  private readonly now: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly threadWaitMs: number;

  /**
   * In-flight `create_private_thread` correlation: task id → the resolver its
   * answer settles. TRANSIENT per-task plumbing (escort's `pendingThreads`),
   * never member/thread state — the durable half is `owned_threads` in
   * `state.ts`, written only once the host has answered.
   *
   * An answer for a task id that is NOT in this map is dropped and logged: it
   * is either stale, cancelled, or an event Atlas never asked for, and none of
   * those may write the registry that decides what Atlas admits.
   */
  private readonly pendingThreads = new Map<string, (outcome: ThreadOutcome) => void>();

  /**
   * Serialises EVERYTHING — served tasks and scheduled passes alike — onto one
   * chain. Two reasons, both load-bearing: a pass and a task both mutate the
   * same durable state and the same in-memory completion queue, and the post
   * window is a single global resource (there is one socket and one live task).
   * Concurrency here would be a correctness bug, not a performance win.
   */
  private queue: Promise<void> = Promise.resolve();
  private timers: unknown[] = [];
  private stopped = false;

  /**
   * A pass whose post could not leave. Re-run inside the next post window.
   * Set ONLY on a post failure — never on a refusal (`state-degraded`,
   * `plan-unreadable`), because retrying those inside a window would just fail
   * the same way while holding up a user's task.
   */
  private due = { watch: false, reconcile: false };

  /**
   * Set by `state.ts`'s `onTransition` hook — the derived plan dashboard is out
   * of date. Redrawn at the END of a served task rather than inside the hook:
   * the hook fires synchronously from inside a state transaction, and a redraw
   * needs an async plan read. Coalescing here bounds it at ONE extra read per
   * task no matter how many transitions that task caused.
   */
  private dashboardStale = false;

  /** Observable counters — asserted by tests, reported in the shutdown line. */
  readonly stats = {
    tasks: 0,
    notAdmitted: 0,
    surfaced: 0,
    ratified: 0,
    applied: 0,
    applyRefused: 0,
    watchPasses: 0,
    reconcilePasses: 0,
    effectRejections: 0,
    /** Threads the host opened for Atlas AND Atlas durably recorded owning. */
    threadsOpened: 0,
  };

  constructor(deps: AtlasRuntimeDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.setIntervalFn =
      deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms) as unknown);
    this.clearIntervalFn =
      deps.clearIntervalFn ?? ((h) => { clearInterval(h as ReturnType<typeof setInterval>); });
    this.threadWaitMs =
      typeof deps.threadWaitMs === "number" && deps.threadWaitMs > 0
        ? deps.threadWaitMs
        : DEFAULT_THREAD_WAIT_MS;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Arm the schedulers and reconcile ON WAKE.
   *
   * The wake pass runs with the window CLOSED (no task can be in flight before
   * the first one arrives), which is exactly right: it re-derives the truth
   * from the plan body and Atlas's own event log, converges the observed
   * revision, and redraws the dashboard. If it finds drift it cannot announce,
   * it says so and flags itself due — the first inbound task carries the
   * catch-up out.
   */
  start(): void {
    if (this.stopped) return;
    this.enqueue(() => this.reconcilePass("wake"));
    this.timers.push(
      this.setIntervalFn(() => {
        this.enqueue(() => this.reconcilePass("interval"));
      }, this.deps.reconcileIntervalMs),
    );
    this.timers.push(
      this.setIntervalFn(() => {
        this.enqueue(() => this.watchPass("interval"));
      }, this.deps.watchIntervalMs),
    );
  }

  /** Disarm the schedulers. In-flight work is left to finish; see `drained`. */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers) this.clearIntervalFn(t);
    this.timers = [];
  }

  /** Resolves once every queued task/pass has settled. */
  async drained(): Promise<void> {
    // Await the chain twice: work enqueued by work already on the chain lands
    // behind it, and one await would return before that tail ran.
    await this.queue;
    await this.queue;
  }

  // ── Event intake ──────────────────────────────────────────────────────────

  /**
   * Route one cortex → brain event. Synchronous and total: the socket's data
   * callback must never block and must never throw. Real work is enqueued.
   */
  onEvent(event: BrainEvent): void {
    switch (event.type) {
      case "hello":
        // Host-authoritative identity. Logged, never trusted for anything —
        // it is a cortex agent id ("atlas"), not a platform identity, so it
        // cannot serve as the constitution-rule-3 self-check.
        process.stderr.write(
          `atlas: hello — host says agent="${event.agent}" protocol=${event.protocol}\n`,
        );
        return;
      case "task":
        this.stats.tasks += 1;
        this.enqueue(() => this.serveTask(event));
        return;
      case "message":
        // A follow-up in an open task's thread. Atlas settles every task in the
        // same turn it receives it, so by the time one of these could arrive
        // the task is closed and no effect could ride it. Dropped LOUDLY rather
        // than silently: if these ever start appearing, the task model changed.
        warn(`dropping a follow-up message for already-settled task ${event.task_id}`);
        return;
      case "effect_rejected":
        this.stats.effectRejections += 1;
        this.deps.effectLayer?.transport.noteRejection(event.task_id, event.effect);
        // A refused thread create is a FIRST-CLASS outcome, not an error: the
        // serving task is waiting on exactly this answer and falls back to the
        // bound channel when it arrives (see `openThread`). Settled
        // SYNCHRONOUSLY here, never through `enqueue` — the task that is
        // waiting holds the queue, so queueing the answer behind it would
        // deadlock until the wait times out.
        if (event.effect === "create_private_thread") {
          this.settleThread(event.task_id, {
            kind: "refused",
            detail: `${event.reason.kind}: ${event.reason.detail}`,
          });
        }
        warn(
          `HOST REFUSED effect "${event.effect}" on task ${event.task_id} ` +
            `(${event.reason.kind}): ${event.reason.detail}`,
        );
        return;
      case "thread_created":
        // The host opened the thread Atlas asked for (cortex#2206). Correlated
        // by task id against `pendingThreads`: an id Atlas never requested
        // settles nothing and writes nothing — the registry that decides what
        // Atlas admits is not writable by an uncorrelated event.
        if (!this.settleThread(event.task_id, { kind: "created", threadId: event.thread_id })) {
          warn(
            `ignoring "thread_created" for task ${event.task_id} — ` +
              `Atlas has no create_private_thread in flight for it`,
          );
        }
        return;
      case "cancel":
        // Drop any in-flight thread correlation: the task is going away, and a
        // thread recorded against an abandoned task would be one Atlas listens
        // in but never spoke in.
        this.settleThread(event.task_id, { kind: "refused", detail: "task cancelled by host" });
        warn(`cancel for task ${event.task_id} — nothing long-running to abandon`);
        return;
      case "gate_verdict":
      case "composed":
        // Atlas emits none of the effects these answer (see protocol.ts). An
        // arrival means a host/agent-identity mix-up, which is worth a line.
        warn(`unexpected "${event.type}" event — Atlas emits no effect that asks for one`);
        return;
      case "shutdown":
        // Owned by main.ts (it must drain, flush the socket and exit).
        return;
      default: {
        const _never: never = event;
        void _never;
        return;
      }
    }
  }

  // ── Serving one task ──────────────────────────────────────────────────────

  private async serveTask(task: TaskEvent): Promise<void> {
    const layer = this.deps.effectLayer;
    const source = task.source;
    const channel = typeof source?.channel === "string" ? source.channel : "";
    const adapterInstance =
      typeof source?.adapter_instance === "string" ? source.adapter_instance : "";
    let disposition: TaskDisposition;

    if (layer === null) {
      // No effect target at all. Nothing is admitted, and nothing is written to
      // durable state — an intake queue Atlas could never act on is a promise
      // it cannot keep. `main.ts`'s startup line already said this out loud.
      this.log("error", "no effect config — Atlas admits nothing and can perform no effect");
      disposition = "no-effect-layer";
    } else if (channel !== layer.effects.channelId && !this.deps.state.isOwnedThread(channel)) {
      // Config-pinned admission, UNION the state-pinned one (atlas#22): the
      // bound ledger channel, or a thread Atlas itself opened and durably
      // recorded opening. Nothing else, and the two are checked in that order
      // so the ordinary case costs no query.
      //
      // Silent to the surface on purpose, for BOTH halves: a reply here would
      // let anyone, anywhere, make Atlas speak — and a DISTINGUISHABLE silence
      // ("wrong channel" vs "not one of my threads") would tell a prober which
      // thread ids Atlas owns.
      this.stats.notAdmitted += 1;
      this.log("warn", "task from a channel Atlas is not bound to — ignored, nothing recorded");
      disposition = "not-admitted";
    } else if (
      // Second config-pinned admission check (atlas#24). SAME disposition as
      // the channel check and SAME silence, deliberately: a distinguishable
      // response would tell a forger which of the two checks it failed, and
      // "wrong channel" vs "wrong/missing adapter instance" is not a
      // distinction an outsider is owed. An empty `adapterInstance` (the field
      // omitted entirely — the bus-forged shape) never matches a non-empty
      // configured set, so absence refuses exactly like a wrong value.
      //
      // The `adapterInstance.length === 0` half is written OUT explicitly
      // (atlas#24 M3, adversarial review) rather than left to fall out of
      // `trustedAdapterInstances` never containing `""`. `effects/config.ts`
      // drops blank tokens today, but THIS check is the trust-path boundary —
      // it must fail closed on its own, not by trusting an invariant recorded
      // only in a docstring one file away. Delete `effects/config.ts`'s
      // blank-token guard entirely and this line alone still refuses an
      // absent adapter instance.
      adapterInstance.length === 0 || !layer.effects.trustedAdapterInstances.has(adapterInstance)
    ) {
      this.stats.notAdmitted += 1;
      this.log(
        "warn",
        "task from an adapter instance Atlas does not recognize — ignored, nothing recorded",
      );
      disposition = "not-admitted";
    } else {
      layer.transport.openWindow(task.task_id, channel);
      try {
        disposition = await this.handleAdmitted(task);
        await this.runDuePassesInWindow();
        await this.redrawDashboardIfStale();
      } catch (err) {
        // A throw escaping into the socket callback would take the daemon down
        // and burn a restart. Nothing above is expected to throw; if it does,
        // the task fails honestly and the process survives.
        warn(`unhandled error serving task: ${err instanceof Error ? err.message : String(err)}`);
        layer.transport.closeWindow();
        this.deps.send({
          v: 1,
          type: "result",
          task_id: task.task_id,
          status: "failed",
          reason: { kind: "cant_do", detail: "atlas failed to serve this message" },
        });
        return;
      }
      // The window closes BEFORE `result`, never after: an effect emitted
      // after the host settles the task is refused, and a refused ledger post
      // that had already returned a receipt would be a recorded lie.
      layer.transport.closeWindow();
    }

    this.deps.send({
      v: 1,
      type: "result",
      task_id: task.task_id,
      status: "complete",
      // The summary is a fixed vocabulary term — never the user's text.
      summary: disposition,
    });
  }

  /** Intake first, then the gate. Both are total; neither throws. */
  private async handleAdmitted(task: TaskEvent): Promise<TaskDisposition> {
    const layer = this.deps.effectLayer;
    if (layer === null) return "no-effect-layer";
    const text = typeof task.payload?.text === "string" ? task.payload.text : "";
    const platform = typeof task.source.surface === "string" ? task.source.surface : "";
    const authorId = typeof task.source.user === "string" ? task.source.user : "";

    // ── Intake ──────────────────────────────────────────────────────────────
    // `task_id` is cortex's envelope id (see protocol.ts): stable across a
    // JetStream redelivery of the SAME message, distinct between two different
    // ones. That is exactly the idempotency key `processComment` documents —
    // a redelivery short-circuits to `duplicate` and emits no second reply.
    const outcome = await processComment(
      {
        id: task.task_id,
        body: text,
        // Credit. `proposer` is documented as a GitHub login, and a Discord
        // surface simply does not carry one — so the honest value is the
        // qualified platform identity, NOT a bare id that would render as a
        // plausible-looking `@login` in the ledger. `effects/discord.ts`'s
        // `safeLogin` quotes it (the colon fails GitHub's login grammar),
        // which is the correct outcome: it is not a login and must not look
        // like one. Mapping platform ids → GitHub logins needs a real identity
        // link and is not invented here.
        authorLogin: `${platform}:${authorId}`.slice(0, 100),
      },
      this.deps.gh,
      this.deps.state,
    );

    if (outcome.kind === "surfaced") {
      this.stats.surfaced += 1;
      // atlas#25 — move the EXCHANGE (not the ledger) into a thread Atlas
      // opens, when the deployment has opted in. Awaited before the reply so
      // the summary lands in the thread rather than racing it into the parent
      // channel: the host retargets this task the moment the thread exists
      // (cortex#2248), so post-order is what decides where the words appear.
      // Every failure path falls through to the pre-atlas#25 behaviour — a
      // reply in the bound channel — and none of them costs the reply.
      await this.openThreadForProposal(task, outcome.displayId);
      this.reply(task.task_id, outcome.reply);
      return "proposal-surfaced";
    }
    if (outcome.kind === "declined") {
      this.reply(task.task_id, outcome.reply);
      return "proposal-declined";
    }
    if (outcome.kind === "duplicate") {
      // Already resolved — no second reply, by contract.
      return "proposal-duplicate";
    }

    // ── The gate ────────────────────────────────────────────────────────────
    // Reached only for text that was not a proposal attempt at all. Identity
    // is the host-resolved author; `hostResolvedPrincipal` is deliberately not
    // supplied, because this protocol carries no principal on a `task` event —
    // and `ratify.ts` treats an absent one as "no cross-check available",
    // never as agreement.
    const gate = processGateMessage(
      { id: task.task_id, body: text, authorPlatform: platform, authorId },
      this.deps.identity,
      this.deps.state,
    );

    switch (gate.kind) {
      case "ignored":
        return "gate-ignored";
      case "stale":
      case "too-long":
      case "state-unavailable":
      case "ratified-not-certified":
        this.reply(task.task_id, gate.reply);
        return "gate-replied";
      case "declined":
        this.reply(task.task_id, gate.reply);
        return "gate-declined";
      case "ratified": {
        this.stats.ratified += 1;
        this.reply(task.task_id, gate.reply);
        // The identity config is necessarily non-null on this branch — the gate
        // refuses `gate-unconfigured` before it can reach `ratified` — but
        // `apply.ts` requires the witness, so it is checked rather than
        // asserted. There is no path from here to an effect without one.
        const identity = this.deps.identity;
        if (identity === null) {
          warn("BUG: a ratified outcome with no identity config — no effect will follow");
          return "gate-ratified";
        }
        const applied = await applyRatified(gate.certificate, {
          state: this.deps.state,
          identity,
          effects: layer.effects,
          gh: layer.plan,
          ledger: layer.ledger,
        });
        if (applied.kind === "posted") {
          this.stats.applied += 1;
        } else if (applied.kind === "applied-not-posted") {
          // The map moved and the ledger did not. Reconcile is the recovery
          // path, and it is flagged due so the very next window carries it.
          this.due.reconcile = true;
          this.log("error", "plan changed but the ledger entry did not land — reconcile will catch up");
          // …and name the ONE cause this slice introduced, because "reconcile
          // will catch up" is a weaker promise here than it sounds. A ratify
          // typed in a thread produces a task whose source is the THREAD, and
          // a ledger entry may only ever go to the bound channel
          // (`transport.ts`, unchanged and deliberately so). cortex offers no
          // way to aim a post at the parent channel of the task it rides, so
          // the entry PARKS until a post window opens from the bound channel
          // itself — i.e. until somebody speaks to Atlas there. Documented,
          // logged, and the reason `threadConversation` ships OFF (atlas#25).
          if (
            typeof task.source?.channel === "string" &&
            task.source.channel !== layer.effects.channelId
          ) {
            this.log(
              "error",
              "this ratification arrived in a thread, and a ledger entry can only be written " +
                "in the bound channel — the entry is PARKED until a window opens there",
            );
          }
        } else {
          this.stats.applyRefused += 1;
          this.log("error", `apply refused (${applied.reason})`);
        }
        return "gate-ratified";
      }
      default: {
        const _never: never = gate;
        void _never;
        return "gate-ignored";
      }
    }
  }

  // ── Scheduled passes ──────────────────────────────────────────────────────

  /**
   * Re-run whichever pass previously failed to post, now that a window is
   * open. At most ONE of each per window: the reads are bounded (50 per pass)
   * but a user's task is waiting behind them, and the host fails a task that
   * takes longer than its liveness timeout.
   */
  private async runDuePassesInWindow(): Promise<void> {
    const layer = this.deps.effectLayer;
    if (layer === null || !layer.transport.canPost) return;
    if (this.due.reconcile) await this.reconcilePass("window");
    if (this.due.watch) await this.watchPass("window");
  }

  /** ONE completion-watcher pass. Public so a test can drive it without timers. */
  async watchPass(trigger: string): Promise<void> {
    const layer = this.deps.effectLayer;
    if (layer === null) return;
    this.stats.watchPasses += 1;
    const outcome = await pollCompletions(
      {
        state: this.deps.state,
        plan: layer.plan,
        gh: layer.linked,
        ledger: layer.ledger,
      },
      this.now(),
    );
    if (outcome.kind === "refused") {
      warn(`watch pass (${trigger}) refused: ${outcome.reason} — ${outcome.detail}`);
      // NOT due: a degraded store or an unreadable plan will fail identically
      // inside a window, and retrying there would delay a user's task for
      // nothing.
      this.due.watch = false;
      return;
    }
    // `held` is the one-post-per-UTC-day rule doing its job, not a failure.
    const flush = outcome.flush;
    this.due.watch = flush.kind === "failed";
    if (flush.kind === "failed") {
      warn(
        `watch pass (${trigger}) could not post ${flush.pending} queued completion(s) — ` +
          `they stay queued and go out on the next post window`,
      );
    }
  }

  /** ONE reconcile pass. Public so a test can drive it without timers. */
  async reconcilePass(trigger: string): Promise<void> {
    const layer = this.deps.effectLayer;
    if (layer === null) return;
    this.stats.reconcilePasses += 1;
    // `reconcile.ts` redraws the dashboard itself at the end of every pass, so
    // a pending coalesced redraw is satisfied by this one.
    this.dashboardStale = false;
    const outcome = await reconcilePlan(
      {
        state: this.deps.state,
        plan: layer.plan,
        gh: layer.linked,
        ledger: layer.ledger,
        effects: layer.effects,
        // NO channel cross-check — and that is a wiring FACT, not a choice
        // deferred. `cortex-brain/v1` has no read-a-channel effect, and the
        // receipts this transport mints are local ids that could never be
        // found in a channel window (`transport.ts`). Wiring a reader that
        // could not see them would make `reconcile.ts`'s deleted-✅ detector
        // report every announcement as deleted. Absent, that detector cannot
        // fire at all — which is the correct degradation and the one
        // `reconcile.ts` is written for ("no reader ⇒ no claim").
        channel: null,
        instanceDir: this.deps.instanceDir,
      },
      this.now(),
    );
    if (outcome.kind === "refused") {
      warn(`reconcile pass (${trigger}) refused: ${outcome.reason} — ${outcome.detail}`);
      this.due.reconcile = false;
      return;
    }
    this.due.reconcile = outcome.kind === "post-failed";
    if (outcome.kind === "post-failed") {
      warn(
        `reconcile pass (${trigger}) found ${outcome.items.length} drift item(s) it could not ` +
          `announce — NOTHING recorded; retrying on the next post window`,
      );
    }
  }

  /** The plan dashboard is derived; mark it for a coalesced redraw. */
  markDashboardStale(): void {
    this.dashboardStale = true;
  }

  /**
   * Redraw the derived dashboard, at most once per task. Never throws and
   * never fails a task: `regeneratePlanDashboard` reports a skip rather than
   * writing a dashboard it cannot stand behind (a degraded store asserts
   * nothing).
   */
  private async redrawDashboardIfStale(): Promise<void> {
    if (!this.dashboardStale) return;
    this.dashboardStale = false;
    const layer = this.deps.effectLayer;
    const dir = this.deps.instanceDir;
    if (layer === null || dir === null || dir.length === 0) return;
    const outcome = await regeneratePlanDashboard(
      { state: this.deps.state, plan: layer.plan, dir, planUrl: layer.effects.planUrl },
      this.now(),
    );
    if (outcome.kind === "skipped") {
      warn(`dashboard not redrawn (${outcome.reason}): ${outcome.detail}`);
    }
  }

  // ── The thread the exchange moves into (atlas#22 + atlas#25) ─────────────

  /**
   * Ask the host to open a thread for a just-surfaced proposal, wait for its
   * answer, and record the thread durably if it arrives.
   *
   * ── Every precondition, and why it refuses rather than tries ─────────────
   *   - `threadConversation` off (the DEFAULT) ⇒ no effect at all. See
   *     `effects/config.ts` for the three reasons that flag exists.
   *   - the task did NOT come from the bound channel ⇒ no effect. A task
   *     already in a thread is the conversation continuing; opening a thread
   *     off a thread is not something this protocol offers, and re-asking
   *     would burn the host's 10/hour create budget on every turn.
   *   - durable state unavailable ⇒ no effect. A thread Atlas cannot RECORD is
   *     a thread it will be deaf in after the next restart, which is precisely
   *     the one-way conversation atlas#22 exists to prevent. Better to keep
   *     talking where it can still hear.
   *   - the host refuses, or never answers ⇒ the reply goes to the bound
   *     channel, exactly as before this slice. On today's cortex this is the
   *     ONLY outcome for Atlas (`create_private_thread` is wired for
   *     `openOnboarding` agents only — protocol.ts), and it must be an
   *     ordinary Tuesday, not an error path.
   *   - the host answers with an id that does not look like a platform id, or
   *     the write does not stick ⇒ NOT recorded, and the conversation stays in
   *     the channel. Atlas never claims a thread it cannot re-admit.
   *
   * The thread NAME is Atlas's own display id (`Proposal #7`) — never message
   * text, never a user id, never anything an outsider chose. `members:
   * "source"` is resolved host-side to the task's own recorded source user.
   */
  private async openThreadForProposal(task: TaskEvent, displayId: number): Promise<void> {
    const layer = this.deps.effectLayer;
    if (layer === null || !layer.effects.threadConversation) return;
    const channel = typeof task.source?.channel === "string" ? task.source.channel : "";
    if (channel !== layer.effects.channelId) return;
    if (!this.deps.state.isDurable()) {
      this.log(
        "warn",
        "durable state unavailable — keeping the exchange in the bound channel rather than " +
          "opening a thread Atlas could not remember (and would go deaf in)",
      );
      return;
    }
    if (!Number.isSafeInteger(displayId) || displayId <= 0) return;

    const outcome = await this.openThread(task.task_id, `Proposal #${displayId}`);
    if (outcome.kind === "refused") {
      this.log(
        "warn",
        `the host would not open a thread (${outcome.detail}) — the exchange stays in the ` +
          `bound channel, which is where Atlas can hear a reply anyway`,
      );
      return;
    }
    const recorded = this.deps.state.recordOwnedThread(outcome.threadId, task.task_id, this.now());
    if (!recorded) {
      // The thread EXISTS (the host said so) but Atlas could not durably note
      // that it owns it — so a reply typed there would not be admitted. Said
      // out loud: this is a real, if rare, one-way surface.
      this.log(
        "error",
        "a thread was opened but could NOT be recorded as owned — replies posted in it will " +
          "not be admitted; ratify in the bound channel instead",
      );
      return;
    }
    this.stats.threadsOpened += 1;
  }

  /**
   * Emit ONE `create_private_thread` and wait for its correlated answer.
   *
   * The wait is bounded by `threadWaitMs` and settles at most once, whichever
   * of `thread_created` / `effect_rejected` / `cancel` / the timer gets there
   * first. The correlation entry is always removed — a leak here would make a
   * later, unrelated `thread_created` for a recycled task id settle a stale
   * request.
   */
  private openThread(taskId: string, name: string): Promise<ThreadOutcome> {
    return new Promise<ThreadOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: ThreadOutcome): void => {
        if (settled) return;
        settled = true;
        this.pendingThreads.delete(taskId);
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        finish({ kind: "refused", detail: `no answer within ${this.threadWaitMs}ms` });
      }, this.threadWaitMs);
      // `unref` where the runtime has it: a pending timer must never be the
      // reason a drained daemon fails to exit.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.pendingThreads.set(taskId, finish);
      this.deps.send({
        v: 1,
        type: "create_private_thread",
        task_id: taskId,
        name,
        // The ONLY members value this pack ever constructs. The host resolves
        // it server-side to the task's own recorded source user; nothing read
        // from a message body can reach this field.
        members: "source",
      });
    });
  }

  /**
   * Deliver an answer to a waiting `openThread`. Returns `false` when there
   * was nothing waiting — which is the guard that stops an uncorrelated
   * `thread_created` from ever reaching the owned-thread registry.
   */
  private settleThread(taskId: string, outcome: ThreadOutcome): boolean {
    const pending = this.pendingThreads.get(taskId);
    if (pending === undefined) return false;
    pending(outcome);
    return true;
  }

  // ── Effect helpers ────────────────────────────────────────────────────────

  /**
   * A conversational reply — the surfaced summary, a decline, a gate ack. It
   * goes to the TASK'S OWN thread (the host derives the target), which is where
   * the person who typed is looking.
   *
   * Deliberately NOT routed through `HostLedgerTransport`: that port exists to
   * pin LEDGER posts to one configured channel, and conflating the two would
   * either send replies to the wrong place or let a reply masquerade as a
   * ledger entry with a receipt.
   */
  private reply(taskId: string, text: string): void {
    if (typeof text !== "string" || text.trim().length === 0) return;
    this.deps.send({ v: 1, type: "post", task_id: taskId, text });
  }

  /** A diagnostic line. Task-agnostic; never carries user text. */
  private log(level: "debug" | "info" | "warn" | "error", text: string): void {
    this.deps.send({ v: 1, type: "log", level, text: `atlas: ${text}` });
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((err: unknown) => {
      warn(`queued work threw: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
