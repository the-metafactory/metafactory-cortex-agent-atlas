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
let sockRef: { write(data: Uint8Array): number } | null = null;

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

// ── 5. The socket ───────────────────────────────────────────────────────────
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
      // A daemon brain without its host has nothing to do. Exit non-zero when
      // this was NOT an orderly shutdown, so the host's restart budget sees a
      // crash for what it is.
      process.stderr.write("atlas: socket closed by host — exiting\n");
      shutdownLocals();
      process.exit(shuttingDown ? 0 : 1);
    },
    error(_s, err) {
      process.stderr.write(`atlas: socket error: ${err.message}\n`);
      shutdownLocals();
      process.exit(1);
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

// ── 6. Shutdown ─────────────────────────────────────────────────────────────

/** Stop timers and close the state DB. Idempotent; never throws. */
function shutdownLocals(): void {
  try {
    runtime.stop();
  } catch {
    /* a failed timer teardown must not block exit */
  }
  try {
    state.close();
  } catch {
    /* a failed DB close must not block exit */
  }
}

/**
 * The host's drain signal (or a signal from the OS). In-flight work is given
 * until `deadlineMs` to settle — an orphaned transition is exactly the drift
 * `reconcile.ts` then has to repair, so finishing one is worth waiting for —
 * and the outbound queue is then flushed before the socket closes, so a `post`
 * or a `result` already decided is not lost on the way out.
 */
async function drainAndExit(deadlineMs: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  runtime.stop();
  const deadline = new Promise<void>((r) => {
    setTimeout(r, Math.max(0, deadlineMs));
  });
  await Promise.race([runtime.drained(), deadline]);
  const flushStart = Date.now();
  while (outQueue.length > 0 && Date.now() - flushStart < 1_000) {
    flushOut();
    await Bun.sleep(10);
  }
  try {
    state.close();
  } catch {
    /* see shutdownLocals */
  }
  socket.end();
  process.exit(0);
}

// SIGTERM/SIGINT get the same orderly drain the protocol's `shutdown` gets.
// cortex escalates deadline → SIGTERM → (+5s) SIGKILL, so 4s leaves room to
// finish and flush inside the window the host actually allows.
const SIGNAL_DRAIN_MS = 4_000;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    process.stderr.write(`atlas: ${signal} — draining\n`);
    void drainAndExit(SIGNAL_DRAIN_MS);
  });
}
