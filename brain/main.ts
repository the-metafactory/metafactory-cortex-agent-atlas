/**
 * Atlas — the daemon entrypoint. `cortex-brain/v1`, `kind: exec`,
 * `lifecycle: daemon`: connect once, serve events until the host says stop.
 *
 * cortex's daemon-brain host spawns this file with:
 *   CORTEX_BRAIN_SOCKET        — the unix socket to connect back on
 *   CORTEX_BRAIN_SOCKET_TOKEN  — a per-spawn auth proof, which MUST be the
 *                                FIRST line written on that socket as
 *                                `{ "v": 1, "type": "auth", token }`
 *   CORTEX_BRAIN_LIFECYCLE     — "daemon"
 * …and, critically, with NOTHING ELSE except PATH/HOME/LANG/TMPDIR and the
 * names declared in `agent.yaml`'s `runtime.brain.secrets`. See `env.ts`.
 *
 * ── What this file is responsible for, and what it deliberately is not ─────
 * It is the SOCKET and the BOOT VERDICT: load config, open state, build the
 * ports, say ARMED or UNARMED in one line, connect, authenticate, decode JSONL,
 * hand every event to `runtime.ts`, write effect lines back with backpressure,
 * and shut down cleanly.
 *
 * It contains NO judgement. Not one line here decides whether a proposal is
 * valid, whether a message ratifies, or whether an effect may follow — those
 * live in `proposal.ts`, `ratify.ts` and `apply.ts`, all of which landed
 * through adversarial review and none of which is touched by this slice.
 *
 * ── Boot never crash-loops on a bad configuration ──────────────────────────
 * A missing principal-map, an unreadable state DB, an absent effect target:
 * every one of them produces a RUNNING daemon that refuses audibly, never a
 * non-zero exit. Exiting would burn `maxRestarts: 3` and leave the operator
 * with a dead agent and three identical stderr lines — the exact shape of the
 * failure epic #5 is about. The ONE hard exit is a missing socket env, which
 * means this file was run by a human instead of by the host; that is a usage
 * error, not a deployment state.
 */

import { loadEffectsConfig, type EffectsConfig } from "./effects/config";
import { GhCliPlanWriter } from "./effects/gh";
import { DiscordLedger } from "./effects/discord";
import { loadBrainEnv } from "./env";
import { GhCliReadOnly } from "./gh";
import {
  loadIdentityConfig,
  parsePlatformActors,
  type RatifyIdentityConfig,
} from "./identity";
import { JsonlDecoder, parseEventLine, encodeEffectLine, type BrainEffect } from "./protocol";
import { resolveReconcileIntervalMs } from "./reconcile";
import { AtlasRuntime, type EffectLayer } from "./runtime";
import { buildStartupLine } from "./startup";
import { AtlasProposals, openAtlasStateFromEnv } from "./state";
import { HostLedgerTransport } from "./transport";
import { resolvePollIntervalMs } from "./watch";

// ── 1. Configuration ────────────────────────────────────────────────────────
//
// The overlay first, so an operator-owned `.env` can fill anything the host did
// not inject. Absent keys ONLY — a host-injected value always wins, because the
// host's env is the deployment's own statement of intent.
const envLoad = loadBrainEnv();

const identityLoad = loadIdentityConfig();
const identity: RatifyIdentityConfig | null =
  identityLoad.kind === "ok" ? identityLoad.config : null;

const effectsLoad = loadEffectsConfig();
const effectsConfig: EffectsConfig | null =
  effectsLoad.kind === "ok" ? effectsLoad.config : null;

// ── 2. Durable state ────────────────────────────────────────────────────────
//
// `onTransition` is state.ts's derived-view hook. It fires SYNCHRONOUSLY from
// inside a state transaction, and redrawing the dashboard needs an async plan
// read — so it only sets a flag, and the runtime coalesces the actual redraw to
// the end of the task. The indirection through a mutable binding exists because
// the store must be opened before the runtime that consumes it.
let onTransition: () => void = () => {};
const store = openAtlasStateFromEnv(() => {
  onTransition();
});
const state = new AtlasProposals(store);
const instanceDir = store?.instanceDir ?? null;

// ── 3. The ports ────────────────────────────────────────────────────────────
//
// Outbound writer with backpressure: a socket `write` may accept only part of a
// large line when the kernel buffer is full, and the remainder must be
// re-offered on `drain`, byte-accurately. It also queues effects emitted before
// `connect` resolves, so nothing is lost in the gap between boot and connect.
const encoder = new TextEncoder();
const outQueue: Uint8Array[] = [];
let outOffset = 0;
// Widened to carry `end()` as well as `write()` so the shutdown path never has
// to reach for the `const socket = await Bun.connect(…)` binding: a socket
// callback can fire before that await settles, and touching the binding from
// there is a temporal-dead-zone ReferenceError inside the one path that must
// not throw.
let sockRef: { write(data: Uint8Array): number; end(): void } | null = null;

function flushOut(): void {
  if (sockRef === null) return;
  while (outQueue.length > 0) {
    const head = outQueue[0]!;
    const chunk = outOffset > 0 ? head.subarray(outOffset) : head;
    const written = sockRef.write(chunk);
    if (written < chunk.length) {
      outOffset += Math.max(0, written);
      return; // wait for drain
    }
    outQueue.shift();
    outOffset = 0;
  }
}

function send(effect: BrainEffect): void {
  outQueue.push(encoder.encode(`${encodeEffectLine(effect)}\n`));
  flushOut();
}

const transport =
  effectsConfig === null
    ? null
    : new HostLedgerTransport({ send, channelId: effectsConfig.channelId });

const effectLayer: EffectLayer | null =
  effectsConfig === null || transport === null
    ? null
    : {
        effects: effectsConfig,
        plan: new GhCliPlanWriter(effectsConfig),
        linked: new GhCliReadOnly(effectsConfig.plan),
        ledger: new DiscordLedger(effectsConfig, transport),
        transport,
      };

// The intake validation read port. When there is no effect target there is no
// plan to read either, so this is pinned to the same coordinates — and if there
// are none, `getIssue` still works (it needs no plan) while `getPlanBody`
// returns "", which makes every ADD/REMOVE fail its ground-truth check. That is
// moot in practice: with no effect layer the runtime admits nothing at all.
const readGh = new GhCliReadOnly(effectsConfig?.plan ?? { repo: "", issue: 0 });

// ── 4. The verdict — ONE line, before anything can go wrong on the socket ───
process.stderr.write(
  `${buildStartupLine({
    identity: identityLoad,
    effects: effectsLoad,
    ratifierIdCount: parsePlatformActors(process.env.ATLAS_RATIFIER_PLATFORM_IDS).length,
    selfIdCount: parsePlatformActors(process.env.ATLAS_SELF_PLATFORM_IDS).length,
    ratifierPrincipal: process.env.ATLAS_RATIFIER_PRINCIPAL,
    stateDurable: state.isDurable(),
    envPath: envLoad.path,
    envFilled: envLoad.filled,
  })}\n`,
);

// ── 5. The runtime, and the socket env it needs ─────────────────────────────
const socketPath = process.env.CORTEX_BRAIN_SOCKET;
const socketToken = process.env.CORTEX_BRAIN_SOCKET_TOKEN;
if (
  socketPath === undefined ||
  socketPath.length === 0 ||
  socketToken === undefined ||
  socketToken.length === 0
) {
  process.stderr.write(
    "atlas: CORTEX_BRAIN_SOCKET / CORTEX_BRAIN_SOCKET_TOKEN missing — this brain is " +
      "spawned by the cortex daemon-brain host, not run directly.\n",
  );
  state.close();
  process.exit(2);
}

const runtime = new AtlasRuntime({
  send,
  state,
  identity,
  gh: readGh,
  effectLayer,
  instanceDir,
  watchIntervalMs: resolvePollIntervalMs(),
  reconcileIntervalMs: resolveReconcileIntervalMs(),
});
onTransition = () => {
  runtime.markDashboardStale();
};

const decoder = new JsonlDecoder();
let shuttingDown = false;

// ── 6. Shutdown — defined BEFORE the connect, deliberately ──────────────────
//
// A socket callback can fire while the top-level `await Bun.connect(…)` is
// still suspended, i.e. before any `const` declared after it has initialised.
// `close`/`error` reach for the drain, so the drain and its constants must be
// fully initialised by then — a temporal-dead-zone ReferenceError inside the
// one path that must not throw would take the daemon down without a log, which
// is the crash-loop shape this file's header is written against.


/**
 * The FLOOR on how long in-flight work is given to settle, whatever deadline
 * the host names.
 *
 * A `shutdown` carrying `deadline_ms: 100` arriving mid-apply used to mean
 * exactly one thing: exit at 100ms with `applyRatified` still inside its
 * `gh issue edit`. The orphaned child then completed the edit anyway, so the
 * plan body moved, no ledger entry was posted, and no apply record landed —
 * the map ahead of both the ledger and Atlas's own memory (atlas#21). One
 * `gh issue view` + one `gh issue edit` is a network round trip; a deadline
 * smaller than that is a deadline that cannot be met, and honouring it to the
 * millisecond buys nothing an operator wants.
 *
 * So the host's deadline governs when Atlas STOPS TAKING WORK and when it says
 * it is overrunning — not when it is willing to abandon a transition. The floor
 * is bounded rather than open-ended because cortex escalates
 * deadline → SIGTERM → (+5s) SIGKILL: floor + flush budget must fit inside that
 * last window, since being SIGKILLed mid-write is strictly worse than a
 * deliberate, logged abandon.
 */
const DRAIN_FLOOR_MS = 3_500;

/** How long the outbound queue may take to leave after the drain. */
const FLUSH_BUDGET_MS = 1_000;

/** SIGTERM/SIGINT get the same floor; see `DRAIN_FLOOR_MS` for the 5s budget. */
const SIGNAL_DRAIN_MS = DRAIN_FLOOR_MS;

/** Resolves `false` after `ms`; races against a drain that resolves `true`. */
function expiresAfter(ms: number): Promise<false> {
  return new Promise<false>((r) => {
    setTimeout(() => {
      r(false);
    }, Math.max(0, ms));
  });
}

/**
 * The host's drain signal (or a signal from the OS, or the loss of the socket).
 *
 * ── The store is closed ONLY when the drain actually won ───────────────────
 * `state.close()` used to run unconditionally on the way out, whether the drain
 * had finished or the deadline had simply expired underneath it. That is the
 * one call that can turn "this transition was abandoned" into "this transition
 * threw halfway through": an in-flight `markApplied` resuming against a closed
 * handle fails as an exception inside the runtime's queue rather than as work
 * that never got to run. Closing is a courtesy to a finished process, so it is
 * done only when there is nothing left that could still want the handle.
 *
 * ── What happens to work that is STILL in flight at the cap ────────────────
 * It is abandoned, loudly and on purpose, and the store is left untouched.
 * SQLite's own transaction atomicity is then the guarantee: an uncommitted
 * transaction rolls back when the file is next opened, so durable state is
 * always a whole number of transitions behind reality — never a torn one. The
 * plan body may be AHEAD of that state (a `gh` child outlives this process and
 * completes its edit), which is ordinary drift with a named owner:
 * `reconcile.ts`'s detector (c) finds a plan body revised outside Atlas, and
 * `runtime.start()` runs a reconcile pass on wake. Recoverable drift, announced
 * in stderr at the moment it is created, is the deliberate choice here — the
 * alternative, ignoring the host's stop indefinitely, ends in SIGKILL with no
 * log at all.
 */
async function drainAndExit(
  deadlineMs: number,
  opts: { exitCode?: number } = {},
): Promise<void> {
  if (shuttingDown) return; // a drain is already running; it owns the exit
  shuttingDown = true;
  runtime.stop();

  const hostDeadline = Math.max(0, deadlineMs);
  const floor = Math.max(hostDeadline, DRAIN_FLOOR_MS);
  let settled = await Promise.race([
    runtime.drained().then(() => true as const),
    expiresAfter(hostDeadline),
  ]);
  if (!settled && floor > hostDeadline) {
    process.stderr.write(
      `atlas: drain deadline (${hostDeadline}ms) expired with a transition still in ` +
        `flight — holding the store open for up to ${floor - hostDeadline}ms more rather ` +
        `than exiting mid-apply\n`,
    );
    settled = await Promise.race([
      runtime.drained().then(() => true as const),
      expiresAfter(floor - hostDeadline),
    ]);
  }

  // Flush whatever WAS decided before the queue emptied or the cap hit: a
  // `post` or a `result` already produced must not be lost on the way out.
  const flushStart = Date.now();
  while (outQueue.length > 0 && Date.now() - flushStart < FLUSH_BUDGET_MS) {
    flushOut();
    await Bun.sleep(10);
  }

  if (settled) {
    try {
      state.close();
    } catch {
      /* a failed DB close must not block exit */
    }
  } else {
    process.stderr.write(
      "atlas: ABANDONING an in-flight transition at the drain cap — the durable store is " +
        "left UNTOUCHED so its last transaction rolls back whole rather than closing under " +
        "a half-written one. The plan body may now be AHEAD of Atlas's state; the reconcile " +
        "pass on next wake is the repair path\n",
    );
  }

  try {
    sockRef?.end();
  } catch {
    /* the host may already be gone */
  }
  process.exit(opts.exitCode ?? 0);
}

// Armed BEFORE the connect too: a SIGTERM arriving while `Bun.connect` is still
// suspended would otherwise hit Bun's default handler and kill the process with
// the store open and no drain — the same shape as everything above.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    process.stderr.write(`atlas: ${signal} — draining\n`);
    void drainAndExit(SIGNAL_DRAIN_MS);
  });
}

// ── 7. The socket ───────────────────────────────────────────────────────────
const socket = await Bun.connect({
  unix: socketPath,
  socket: {
    open(s) {
      // The auth proof is FIRST, before any protocol line. It is consumed by
      // the host's transport, not by the protocol codec: a unix socket under
      // the temp dir is reachable by any local process, and this is what stops
      // one racing the real brain to it.
      s.write(`${JSON.stringify({ v: 1, type: "auth", token: socketToken })}\n`);
    },
    data(_s, chunk) {
      for (const line of decoder.push(chunk)) {
        const event = parseEventLine(line);
        if (event === null) {
          // The mirror rule: an unknown or malformed event is dropped and
          // logged, never fatal. A newer cortex must not be able to kill this
          // daemon by adding an event type.
          process.stderr.write("atlas: dropping unrecognised event line\n");
          continue;
        }
        if (event.type === "shutdown") {
          void drainAndExit(event.deadline_ms);
          continue;
        }
        runtime.onEvent(event);
      }
    },
    drain() {
      flushOut();
    },
    close() {
      // A daemon brain without its host has nothing to do — but "nothing to do"
      // is not the same as "nothing in flight". Losing the socket mid-apply used
      // to close the durable store and exit with NO drain at all (atlas#21),
      // which is the same half-applied split as the deadline path and reached by
      // a route the host does not even choose. So this gets the SAME bounded
      // drain the protocol `shutdown` gets; it simply has nowhere left to flush
      // to afterwards. Exit non-zero when this was NOT an orderly shutdown, so
      // the host's restart budget sees a crash for what it is.
      process.stderr.write("atlas: socket closed by host — draining, then exiting\n");
      void drainAndExit(SIGNAL_DRAIN_MS, { exitCode: shuttingDown ? 0 : 1 });
    },
    error(_s, err) {
      // Same reasoning as `close`: a transport error is not a licence to tear
      // down a transaction that is mid-write.
      process.stderr.write(`atlas: socket error: ${err.message} — draining, then exiting\n`);
      void drainAndExit(SIGNAL_DRAIN_MS, { exitCode: 1 });
    },
  },
});

sockRef = socket;
flushOut();
process.stderr.write("atlas: connected\n");

// Schedulers arm only AFTER the socket is up: reconcile-on-wake may want to
// post, and a pass that ran before there was anywhere to write would refuse for
// the wrong reason.
runtime.start();
