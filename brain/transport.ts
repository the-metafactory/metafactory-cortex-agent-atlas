/**
 * The LIVE ledger transport — `LedgerTransport` over the host effect protocol.
 *
 * ── Why this is not a Discord client ───────────────────────────────────────
 * Atlas runs IN-PROCESS on cortex (`runtime.mode: in-process`) and holds no
 * platform credential of its own (`runtime.brain.secrets: []`). It cannot open
 * a Discord connection, and giving it one would defeat the point of the bot-pack
 * seam: the brain ASKS for effects, the host PERFORMS them under policy. So a
 * ledger post leaves as a `post` effect on the `cortex-brain/v1` socket — the
 * same path `metafactory-cortex-agent-escort` uses for every word it says.
 *
 * ── Three properties of that path that shape this file ─────────────────────
 *
 * **1. A post is bound to a live task; there is no free-standing post.**
 * `daemon-brain-host.ts` looks the effect's `task_id` up in its in-flight table
 * and rejects (`wont_do`) anything it does not own or has already settled. So
 * there is a POST WINDOW: it opens when a `task` event arrives and closes when
 * Atlas emits `result`. Outside a window this transport refuses — audibly —
 * rather than emitting an effect that would be rejected. The consequences for
 * the timer-driven passes are handled in `runtime.ts`, not hidden here.
 *
 * **2. The brain cannot name a channel.** `PostEffect` has no channel field on
 * purpose; the host derives the target from the task's own recorded source. So
 * "one channel, from config, never from content" — the rule `effects/config.ts`
 * and `effects/discord.ts` exist to keep — has to be re-established HERE, at
 * the last point where Atlas still has a choice: a post is emitted only when
 * the live task's `source.channel` IS the configured ledger channel. A mention
 * from anywhere else gets a refusal, not a ledger entry in the wrong room.
 *
 * ── `wrong-channel` is REACHABLE since atlas#22, and it is load-bearing ─────
 * atlas#22 observed that this guard could not fire in production, because
 * `runtime.ts` admitted the bound channel and nothing else — so the live
 * task's source channel was the configured one by construction. That is no
 * longer true: admission now also covers a thread Atlas opened
 * (`owned_threads`), and a task from such a thread carries the THREAD's id as
 * its source channel. `canPost` is `false` there and `post` refuses
 * `wrong-channel`.
 *
 * That refusal is the correct behaviour, not a gap to paper over. The ledger
 * is the bound channel's record; cortex#2248 retargets every post on a
 * thread-created task INTO the thread and offers no way to aim one at the
 * parent, so the only alternatives to refusing are (a) writing the ledger
 * inside a thread, which defeats the ledger, or (b) claiming a receipt for a
 * post that went somewhere else, which is a recorded lie. Refusing parks the
 * entry for `reconcile.ts` (`apply.ts` reports `applied-not-posted`) and
 * `runtime.ts` says so in a `log` effect naming the cause.
 *
 * **3. A post returns no platform message id.** `post` is fire-and-forget;
 * cortex has no ack event for it (unlike `create_private_thread` →
 * `thread_created`). `LedgerTransport.post` must nevertheless return a receipt,
 * because `apply.ts` records one and `watch.ts`/`reconcile.ts` key their
 * "already announced" markers on it. This transport therefore mints a LOCAL
 * receipt id with an explicit, non-platform prefix ({@link RECEIPT_PREFIX}) and
 * `main.ts` wires NO `LedgerReader` at all. Those two facts are one decision:
 * a local receipt can never be found in a channel window, so if a reader were
 * wired, `reconcile.ts`'s deleted-✅ detector would report every announcement
 * as deleted, forever. Without a reader that detector cannot fire at all
 * (`reconcile.ts`: `if (window === null) continue;`) and every other consumer
 * treats the id as an opaque marker. See `main.ts`'s startup line, which states
 * the missing cross-check out loud.
 *
 * ── What a returned receipt does and does NOT claim ────────────────────────
 * It claims: the host ACCEPTED the post effect and did not refuse it within
 * {@link SETTLE_MS}. Host-side refusals (unknown task, closed task, policy) are
 * synchronous — the host emits `effect_rejected` before any I/O — so the settle
 * window catches them and turns the post into an honest failure.
 *
 * It does NOT claim the message reached Discord. Delivery happens downstream of
 * the host's `onPost` hook (bus publish → dispatch sink → adapter) and cortex
 * reports nothing back about it on this protocol. That residual gap is real,
 * and it is bounded the same way every other unconfirmable effect in this pack
 * is: `reconcile.ts` re-derives the truth from the plan body and Atlas's own
 * event log, not from a belief about a post. It is stated in the startup line.
 */

import type { LedgerTransport } from "./effects/discord";
import type { BrainEffect } from "./protocol";

function warn(msg: string): void {
  process.stderr.write(`atlas: transport: ${msg}\n`);
}

/**
 * The prefix on every receipt this transport mints. Deliberately NOT
 * snowflake-shaped: anything that reads a stored receipt and wonders whether it
 * is a platform message id can answer the question by looking at it.
 */
export const RECEIPT_PREFIX = "host-effect";

/**
 * How long to wait for a host `effect_rejected` before treating a post as
 * accepted. The refusals this catches are all decided host-side without I/O
 * (task-table lookup, attachment budget, policy), so they arrive on the socket
 * within a turn or two; this is generous, and a ledger post is rare enough that
 * the latency never matters.
 */
export const SETTLE_MS = 50;

/**
 * How many retargeted task ids to remember. A retarget is per-task and a task
 * is short-lived, so this only has to outlive the gap between an out-of-order
 * `thread_created` and the window it applies to. Bounded because a daemon runs
 * for months and an uncorrelated event costs an entry.
 */
export const MAX_TRACKED_RETARGETS = 256;

/** The live task a post may ride on. Set by `openWindow`, cleared by `closeWindow`. */
interface PostWindow {
  readonly taskId: string;
  /** The task's `source.channel`, host-resolved. Compared against config. */
  readonly sourceChannel: string;
  /**
   * The host has moved THIS task's conversation into a thread (cortex#2248),
   * so its posts no longer land in `sourceChannel`. Set by `noteRetarget`,
   * never unset — a retarget is one-way for the life of the task.
   *
   * This is not bookkeeping: it is the difference between "where this task
   * came from" and "where a post on it will land", which are the same value
   * right up until a thread is created and different for every post after.
   * `sourceChannel` alone answered the first question while `canPost`/`post`
   * were asking the second.
   */
  retargeted: boolean;
}

/** Why a post did not go out. Every one is logged; the caller sees `null`. */
export type PostRefusal =
  /** No task is in flight, so no effect can be emitted at all. */
  | "no-post-window"
  /** The live task did not originate in the configured ledger channel. */
  | "wrong-channel"
  /**
   * The live task DID originate in the ledger channel, but the host has since
   * moved its conversation into a thread — so a post riding it would land
   * there instead. See {@link HostLedgerTransport.noteRetarget}.
   */
  | "retargeted-to-thread"
  /** A caller asked for a channel that is not the configured one. */
  | "foreign-channel-argument"
  /** Nothing to say. */
  | "empty-content"
  /** The host refused the effect within the settle window. */
  | "host-rejected";

export interface HostLedgerTransportOptions {
  /** Writes one effect line to the socket. Supplied by `main.ts`. */
  readonly send: (effect: BrainEffect) => void;
  /** The ONE channel Atlas may post to — `EffectsConfig.channelId`, never a caller's. */
  readonly channelId: string;
  /** Injectable purely so tests never wait on a real timer. */
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * `LedgerTransport` implemented over `cortex-brain/v1`. One instance per
 * process, owned by `main.ts` and handed to the single `DiscordLedger`.
 */
export class HostLedgerTransport implements LedgerTransport {
  private window: PostWindow | null = null;
  private seq = 0;
  /** Rejections seen per task id, so a settle check can tell "since when". */
  private readonly rejections = new Map<string, number>();
  /**
   * Task ids the host has moved into a thread. Kept independently of the live
   * window so `openWindow` can consult it — see `noteRetarget`. Bounded by
   * {@link MAX_TRACKED_RETARGETS}.
   */
  private readonly retargetedTasks = new Set<string>();
  private readonly send: (effect: BrainEffect) => void;
  private readonly channelId: string;
  private readonly wait: (ms: number) => Promise<void>;

  /** Refusal tally, by reason — surfaced in the shutdown line and asserted in tests. */
  readonly refusals: Record<PostRefusal, number> = {
    "no-post-window": 0,
    "wrong-channel": 0,
    "retargeted-to-thread": 0,
    "foreign-channel-argument": 0,
    "empty-content": 0,
    "host-rejected": 0,
  };

  constructor(opts: HostLedgerTransportOptions) {
    this.send = opts.send;
    this.channelId = opts.channelId;
    this.wait = opts.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /**
   * True while a LEDGER post could actually leave for the ledger channel.
   * Read by `runtime.ts`'s scheduler before it runs a due pass inside the
   * window — which is exactly why the retarget must be part of this answer and
   * not only of `post`'s: the due passes decide whether to RUN from here.
   */
  get canPost(): boolean {
    return (
      this.window !== null &&
      this.window.sourceChannel === this.channelId &&
      !this.window.retargeted
    );
  }

  /**
   * Open the post window for a task. `sourceChannel` is the HOST-RESOLVED
   * `task.source.channel` — never anything read out of a message body.
   */
  openWindow(taskId: string, sourceChannel: string): void {
    if (typeof taskId !== "string" || taskId.length === 0) {
      warn("refusing to open a post window for an empty task id");
      return;
    }
    this.window = {
      taskId,
      sourceChannel: typeof sourceChannel === "string" ? sourceChannel : "",
      // A retarget already seen for this task id wins immediately — see
      // `noteRetarget`. The window can only ever open MORE closed, never less.
      retargeted: this.retargetedTasks.has(taskId),
    };
  }

  /**
   * The host has moved a task's conversation into a thread (cortex#2248's
   * `onThreadCreated` retarget). From this point every `post` on that task
   * lands in the THREAD, whatever channel the task came from.
   *
   * ── The bug this closes (adversarial review, BLOCKER 1) ──────────────────
   * `openWindow` recorded where the task CAME FROM, and `canPost`/`post`
   * treated that as where a post WOULD GO. Those are the same value until a
   * thread is created inside the very task that holds the window — and after
   * that they are different for every remaining post on it. The window still
   * said "bound channel", so a ledger post emitted later in that task (a
   * `watch.ts` ✅ flush, a `reconcile.ts` catch-up — both of which
   * `runDuePassesInWindow` runs INSIDE the window) went out, landed in the
   * private thread, drew no `effect_rejected`, and was minted a receipt. The
   * ✅ was then recorded as announced and would never be posted again: a
   * ledger entry destroyed by the mechanism documented as its recovery path.
   *
   * Called from `runtime.ts` on the raw `thread_created` EVENT — deliberately
   * before, and independently of, Atlas's own correlation bookkeeping. The
   * host retargets the task whether or not this brain asked for the thread or
   * still remembers asking, so the transport must learn it from the same fact
   * the host acted on, not from Atlas's opinion about it.
   *
   * One-way and per-task: a retarget is never undone, and `closeWindow` +
   * `openWindow` start the next task clean.
   */
  noteRetarget(taskId: string): void {
    if (typeof taskId !== "string" || taskId.length === 0) return;
    // Recorded against the TASK ID, not only against the live window, so the
    // answer does not depend on whether the window happened to be open when
    // the event arrived. `openWindow` consults this set, which is what makes
    // the invariant hold by construction rather than by ordering — a retarget
    // that lands before the window opens (an uncorrelated event, a redelivery)
    // is honoured just the same.
    if (!this.retargetedTasks.has(taskId)) {
      this.retargetedTasks.add(taskId);
      // Bounded: an uncorrelated retarget for a task never served would
      // otherwise accumulate forever in a daemon that runs for months. Oldest
      // out first — Set preserves insertion order — and the live window's own
      // flag is already set below, so eviction can never un-retarget the task
      // currently being served.
      while (this.retargetedTasks.size > MAX_TRACKED_RETARGETS) {
        const oldest = this.retargetedTasks.values().next().value;
        if (oldest === undefined) break;
        this.retargetedTasks.delete(oldest);
      }
    }
    const window = this.window;
    if (window === null || window.taskId !== taskId || window.retargeted) return;
    window.retargeted = true;
    warn(
      `task ${taskId} was retargeted into a thread by the host — the ledger post window is ` +
        `CLOSED for it; any ledger entry it would have carried stays parked for the bound channel`,
    );
  }

  /** Close the window. Called immediately before `result` — never after. */
  closeWindow(): void {
    if (this.window !== null) this.rejections.delete(this.window.taskId);
    this.window = null;
  }

  /**
   * Record a host `effect_rejected` for a `post`. `main.ts` routes every
   * rejection here; only `post` ones matter to this transport.
   */
  noteRejection(taskId: string, effect: string): void {
    if (effect !== "post") return;
    if (typeof taskId !== "string" || taskId.length === 0) return;
    this.rejections.set(taskId, (this.rejections.get(taskId) ?? 0) + 1);
  }

  /**
   * Post to the ledger channel. `channelId` comes from `DiscordLedger`, which
   * reads it from `EffectsConfig` on every call; it is re-checked here anyway,
   * because a transport that trusts its caller's target is one refactor away
   * from posting wherever a proposal's text says.
   */
  async post(channelId: string, content: string): Promise<string | null> {
    if (channelId !== this.channelId) {
      return this.refuse(
        "foreign-channel-argument",
        "a post was aimed at a channel that is not the configured ledger channel",
      );
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      return this.refuse("empty-content", "refusing to post empty content");
    }
    const window = this.window;
    if (window === null) {
      return this.refuse(
        "no-post-window",
        "no task is in flight, and cortex-brain/v1 has no free-standing post effect — " +
          "nothing was posted and nothing was recorded",
      );
    }
    if (window.sourceChannel !== this.channelId) {
      return this.refuse(
        "wrong-channel",
        "the live task did not originate in the configured ledger channel — " +
          "refusing to post the ledger somewhere else",
      );
    }
    if (window.retargeted) {
      // Same rule, later cause: the task came from the ledger channel but the
      // host has since moved it into a thread, so this post would land there.
      // Its own reason code, because the two are operationally different — one
      // is "somebody spoke to Atlas elsewhere", the other is "Atlas opened a
      // thread on this very task" — and a shared counter would hide which.
      return this.refuse(
        "retargeted-to-thread",
        "the live task's conversation was moved into a thread by the host — " +
          "refusing to post the ledger into a thread, and refusing to claim a receipt for it",
      );
    }

    const before = this.rejections.get(window.taskId) ?? 0;
    this.send({ v: 1, type: "post", task_id: window.taskId, text: content });

    // Give the host its chance to refuse. Every refusal `post` can draw is
    // decided before any I/O, so this is a real check and not a hopeful sleep.
    await this.wait(SETTLE_MS);
    const after = this.rejections.get(window.taskId) ?? 0;
    if (after > before) {
      return this.refuse("host-rejected", "the host refused the post effect");
    }
    // Still the same window? A `result` (or a cancel) between the send and the
    // settle means the task closed underneath us; the host would have dropped a
    // late post, so claiming a receipt would be a lie.
    if (this.window === null || this.window.taskId !== window.taskId) {
      return this.refuse(
        "no-post-window",
        "the task closed while the post was settling — no receipt is claimable",
      );
    }

    this.seq += 1;
    return `${RECEIPT_PREFIX}:${window.taskId}:${this.seq}`;
  }

  private refuse(reason: PostRefusal, detail: string): null {
    this.refusals[reason] += 1;
    warn(`POST REFUSED (${reason}) — ${detail}`);
    return null;
  }
}
