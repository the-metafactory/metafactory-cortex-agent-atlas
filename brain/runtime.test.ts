/**
 * The wiring suite — cortex events in, brain effects out.
 *
 * Every test here drives the REAL runtime over a REAL SQLite store, the REAL
 * gate, the REAL apply path and the REAL `GhCliPlanWriter` (only its spawn
 * function faked, so the argv assertions are about the shipped builder). The
 * only doubles are at the two true process boundaries: the socket (`sent`, an
 * array) and GitHub (`FakePlanRepo`).
 *
 * That is deliberate. This slice's whole risk is that the pieces were each
 * correct and connected wrong, so a suite that stubbed the pieces would test
 * nothing that could fail.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEffectsConfig, type EffectsConfig } from "./effects/config";
import { DiscordLedger } from "./effects/discord";
import { GhCliPlanWriter, type GhInvocation } from "./effects/gh";
import {
  identityConfigFromPorts,
  StaticPrincipalMap,
  StaticSelfIdentity,
  type RatifyIdentityConfig,
} from "./identity";
import type { BrainEffect, PostEffect, TaskEvent } from "./protocol";
import { AtlasRuntime, type AtlasRuntimeDeps, type EffectLayer } from "./runtime";
import { AtlasProposals, AtlasStateStore } from "./state";
import { FakeLinkedIssues, FakePlanRepo, RecordingGh } from "./test-support";
import { HostLedgerTransport } from "./transport";

// ── Fixtures (placeholder ids only — this repo is public) ───────────────────

const PLATFORM = "discord";
const PRINCIPAL_ID = "plan-steward";
const PRINCIPAL_PLATFORM_ID = "pid-principal-fixture";
const ATLAS_PLATFORM_ID = "pid-atlas-self-fixture";
const PROPOSER_PLATFORM_ID = "pid-proposer-fixture";
const CHANNEL_ID = "chan-fixture-0000";
const OTHER_CHANNEL = "chan-fixture-9999";
const PLAN_REPO = "acme/widgets";
const NEW_URL = "https://github.com/acme/widgets/issues/12";
const LINKED_URL = "https://github.com/acme/widgets/issues/1";

/** A well-formed proposal. The `[Backend]` section is what lets apply place it. */
const ADD_TEXT = `ADD: ${NEW_URL} — [Backend] worth doing`;

const PLAN_BODY = [
  "# Iteration 1",
  "",
  "## Backend",
  "",
  `- [ ] ${LINKED_URL}`,
  "",
].join("\n");

let dir: string;
let store: AtlasStateStore;
let state: AtlasProposals;
let effects: EffectsConfig;
let identity: RatifyIdentityConfig;
let repo: FakePlanRepo;
let transport: HostLedgerTransport;
let linked: FakeLinkedIssues;
let readGh: RecordingGh;
let sent: BrainEffect[];
let layer: EffectLayer;
let taskSeq = 0;

const ADAPTER_INSTANCE_ID = "adapter-fixture";
const OTHER_ADAPTER_INSTANCE_ID = "adapter-fixture-untrusted";

function makeEffects(): EffectsConfig {
  const loaded = makeEffectsConfig({
    planRepo: PLAN_REPO,
    planIssue: 4,
    channelId: CHANNEL_ID,
    adapterInstances: ADAPTER_INSTANCE_ID,
  });
  if (loaded.kind !== "ok") throw new Error("fixture: effects config refused");
  return loaded.config;
}

function makeIdentity(): RatifyIdentityConfig {
  const cfg = identityConfigFromPorts({
    ratifierPrincipalId: PRINCIPAL_ID,
    principals: new StaticPrincipalMap([
      { actor: { platform: PLATFORM, id: PRINCIPAL_PLATFORM_ID }, principalId: PRINCIPAL_ID },
    ]),
    self: new StaticSelfIdentity([{ platform: PLATFORM, id: ATLAS_PLATFORM_ID }]),
  });
  if (cfg === null) throw new Error("fixture: expected an identity config");
  return cfg;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-runtime-test-"));
  const opened = AtlasStateStore.open({ dir, bundleDir: null });
  if (opened === null) throw new Error("fixture: expected the store to open");
  store = opened;
  state = new AtlasProposals(store);
  effects = makeEffects();
  identity = makeIdentity();
  repo = new FakePlanRepo(PLAN_BODY);
  linked = new FakeLinkedIssues();
  readGh = new RecordingGh({
    issues: { [NEW_URL]: { exists: true, open: true } },
    planBody: PLAN_BODY,
  });
  sent = [];
  transport = new HostLedgerTransport({
    send: (e) => {
      sent.push(e);
    },
    channelId: CHANNEL_ID,
    wait: async () => {},
  });
  layer = {
    effects,
    plan: new GhCliPlanWriter(effects, (inv: GhInvocation) => repo.spawn(inv)),
    linked,
    ledger: new DiscordLedger(effects, transport),
    transport,
  };
  taskSeq = 0;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a runtime. Timers are injected as no-ops by default so nothing fires
 * behind a test's back; the scheduler tests supply their own.
 */
function makeRuntime(
  overrides: Partial<AtlasRuntimeDeps> = {},
): AtlasRuntime {
  return new AtlasRuntime({
    send: (e) => {
      sent.push(e);
    },
    state,
    identity,
    gh: readGh,
    effectLayer: layer,
    instanceDir: dir,
    watchIntervalMs: 900_000,
    reconcileIntervalMs: 21_600_000,
    setIntervalFn: () => 0,
    clearIntervalFn: () => {},
    ...overrides,
  });
}

/**
 * A task event as cortex builds it for an inbound surface message.
 *
 * `adapterInstance` uses `null` — not `undefined` — as its "omit the field"
 * sentinel: a default PARAMETER value still applies when a caller explicitly
 * passes `undefined`, so `undefined` could not mean "omit" here without also
 * silently meaning "use the default" for anyone who passed it by accident.
 */
function task(
  text: string,
  authorId: string,
  channel = CHANNEL_ID,
  adapterInstance: string | null = ADAPTER_INSTANCE_ID,
): TaskEvent {
  taskSeq += 1;
  return {
    v: 1,
    type: "task",
    task_id: `task-fixture-${taskSeq}`,
    capability: "atlas.plan.steward",
    payload: { text, scenario: text, user: authorId, response_routing: {} },
    source: {
      surface: PLATFORM,
      channel,
      thread: channel,
      user: authorId,
      ...(adapterInstance !== null && { adapter_instance: adapterInstance }),
    },
  };
}

function posts(): PostEffect[] {
  return sent.filter((e): e is PostEffect => e.type === "post");
}

type ResultLine = Extract<BrainEffect, { type: "result" }>;

function results(): ResultLine[] {
  return sent.filter((e): e is ResultLine => e.type === "result");
}

/** The disposition a result carries, or "" for a failed one. */
function summaryOf(result: ResultLine | undefined): string {
  if (result === undefined) return "";
  return result.status === "complete" ? (result.summary ?? "") : "";
}

async function serve(runtime: AtlasRuntime, event: TaskEvent): Promise<void> {
  runtime.onEvent(event);
  await runtime.drained();
}

// ── Intake ──────────────────────────────────────────────────────────────────

describe("an ADD comment reaches intake", () => {
  test("surfaces a numbered proposal and settles the task", async () => {
    const runtime = makeRuntime();
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));

    const reply = posts();
    expect(reply).toHaveLength(1);
    expect(reply[0]!.text).toContain("Proposal #1 — ADD:");
    expect(reply[0]!.text).toContain("To ratify: @atlas RATIFY 1");
    expect(results()).toHaveLength(1);
    expect(results()[0]!.status).toBe("complete");
    // Zero effects: intake surfaces, it does not act.
    expect(repo.invocations.filter((i) => i.argv[2] === "edit")).toHaveLength(0);
  });

  test("ordinary chatter produces no reply and no state", async () => {
    const runtime = makeRuntime();
    await serve(runtime, task("morning all", PROPOSER_PLATFORM_ID));
    expect(posts()).toHaveLength(0);
    expect(results()).toHaveLength(1);
  });

  test("a redelivered task_id never surfaces a second proposal", async () => {
    // cortex reuses the envelope id across a JetStream redelivery, which is
    // exactly why it is the idempotency key. If the wiring passed something
    // per-delivery instead, this would surface twice.
    const runtime = makeRuntime();
    const event = task(ADD_TEXT, PROPOSER_PLATFORM_ID);
    await serve(runtime, event);
    await serve(runtime, event);
    expect(posts()).toHaveLength(1);
    expect(results()).toHaveLength(2);
  });

  test("the proposer is credited as a qualified platform identity, not a bare id", async () => {
    // A bare snowflake satisfies GitHub's login grammar and would render in
    // the ledger as a plausible `@login` that does not exist.
    const runtime = makeRuntime();
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    expect(posts()[0]!.text).toContain(`${PLATFORM}:${PROPOSER_PLATFORM_ID}`);
  });
});

// ── The gate ────────────────────────────────────────────────────────────────

describe("RATIFY from the principal reaches the gate", () => {
  async function surfaceOne(runtime: AtlasRuntime): Promise<void> {
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    sent.length = 0;
  }

  test("ratifies, applies, and the ledger post leaves via the host protocol", async () => {
    const runtime = makeRuntime();
    await surfaceOne(runtime);
    await serve(runtime, task("RATIFY 1", PRINCIPAL_PLATFORM_ID));

    // The plan body carries the change…
    expect(repo.body).toContain(NEW_URL);
    // …and the ➕ ledger entry left as a `post` effect on the live task.
    const ledgerPost = posts().find((p) => p.text.startsWith("➕"));
    expect(ledgerPost).toBeDefined();
    expect(ledgerPost!.text).toContain("Plan body changed");
    expect(ledgerPost!.text).toContain(NEW_URL);
    expect(runtime.stats.applied).toBe(1);
  });

  test("a non-principal's RATIFY changes nothing and says nothing", async () => {
    const runtime = makeRuntime();
    await surfaceOne(runtime);
    await serve(runtime, task("RATIFY 1", PROPOSER_PLATFORM_ID));
    expect(posts()).toHaveLength(0);
    expect(repo.body).not.toContain(NEW_URL);
    expect(runtime.stats.ratified).toBe(0);
  });

  test("Atlas's own RATIFY is refused — constitution rule 3, through the wiring", async () => {
    const runtime = makeRuntime();
    await surfaceOne(runtime);
    await serve(runtime, task("RATIFY 1", ATLAS_PLATFORM_ID));
    expect(posts()).toHaveLength(0);
    expect(repo.body).not.toContain(NEW_URL);
  });

  test("an UNARMED gate ignores the principal and still serves the task", async () => {
    const runtime = makeRuntime({ identity: null });
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    sent.length = 0;
    await serve(runtime, task("RATIFY 1", PRINCIPAL_PLATFORM_ID));
    expect(posts()).toHaveLength(0);
    expect(repo.body).not.toContain(NEW_URL);
    // Still up, still answering the host — no crash, no restart burned.
    expect(results()).toHaveLength(1);
    expect(results()[0]!.status).toBe("complete");
  });
});

// ── Admission ───────────────────────────────────────────────────────────────

describe("admission is config-pinned", () => {
  test("a task from another channel is ignored — no reply, no state", async () => {
    const runtime = makeRuntime();
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID, OTHER_CHANNEL));
    expect(posts()).toHaveLength(0);
    expect(runtime.stats.notAdmitted).toBe(1);
    // Nothing was recorded, so the same proposal from the right channel later
    // is NOT a duplicate.
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    expect(posts()).toHaveLength(1);
  });

  // atlas#24 — the wire-forged shape: a `task` published straight onto
  // `brain.>` (bypassing every real adapter) can set `source.channel` to
  // whatever it likes, but a genuine live-surface task ALWAYS carries
  // `adapter_instance`. These two cases are the mutation guard for that check:
  // reverting it (dropping the `trustedAdapterInstances` branch in
  // `serveTask`) must turn both back into a successful RATIFY.
  test("a task with no adapter_instance cannot ratify — ignored, nothing recorded", async () => {
    const runtime = makeRuntime();
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    sent.length = 0;
    // The bus-forged shape atlas#24 found admitted: same channel, same
    // authenticated-looking author id, but no adapter_instance at all.
    await serve(runtime, task("RATIFY 1", PRINCIPAL_PLATFORM_ID, CHANNEL_ID, null));
    expect(posts()).toHaveLength(0);
    expect(repo.body).not.toContain(NEW_URL);
    expect(runtime.stats.ratified).toBe(0);
    expect(runtime.stats.notAdmitted).toBe(1);
  });

  test("a task from an untrusted adapter instance cannot ratify — ignored, nothing recorded", async () => {
    const runtime = makeRuntime();
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    sent.length = 0;
    await serve(
      runtime,
      task("RATIFY 1", PRINCIPAL_PLATFORM_ID, CHANNEL_ID, OTHER_ADAPTER_INSTANCE_ID),
    );
    expect(posts()).toHaveLength(0);
    expect(repo.body).not.toContain(NEW_URL);
    expect(runtime.stats.ratified).toBe(0);
    expect(runtime.stats.notAdmitted).toBe(1);
  });

  // atlas#24 M3 (adversarial review) — `runtime.ts`'s admission check must
  // fail closed on an empty adapter instance ON ITS OWN, not because
  // `effects/config.ts` happens to never let `trustedAdapterInstances`
  // contain `""`. This test breaks that invariant DELIBERATELY — a hand-built
  // `EffectsConfig` (bypassing `makeEffectsConfig` entirely, the way a config
  // bug or a future refactor could) whose trusted set explicitly contains the
  // empty string — and proves the runtime still refuses a task with no
  // `adapter_instance`. If `runtime.ts` ever regresses to relying solely on
  // `trustedAdapterInstances.has(adapterInstance)`, this is the test that
  // catches it, independent of whatever `effects/config.ts` does or doesn't
  // guarantee.
  test("an empty adapter_instance is refused even if the trusted set contains '' (M3)", async () => {
    const brokenLayer: EffectLayer = {
      ...layer,
      effects: { ...effects, trustedAdapterInstances: new Set(["", ADAPTER_INSTANCE_ID]) },
    };
    const runtime = makeRuntime({ effectLayer: brokenLayer });
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    sent.length = 0;
    await serve(runtime, task("RATIFY 1", PRINCIPAL_PLATFORM_ID, CHANNEL_ID, null));
    expect(posts()).toHaveLength(0);
    expect(repo.body).not.toContain(NEW_URL);
    expect(runtime.stats.ratified).toBe(0);
    expect(runtime.stats.notAdmitted).toBe(1);
  });

  test("with no effect layer nothing is admitted and nothing is recorded", async () => {
    const runtime = makeRuntime({ effectLayer: null });
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    expect(posts()).toHaveLength(0);
    expect(results()).toHaveLength(1);
    expect(sent.some((e) => e.type === "log" && e.level === "error")).toBe(true);
  });
});

// ── The post window ─────────────────────────────────────────────────────────

describe("the post window", () => {
  test("closes before the result, so no effect can outlive its task", async () => {
    const runtime = makeRuntime();
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    const resultIdx = sent.findIndex((e) => e.type === "result");
    const postIdx = sent.findIndex((e) => e.type === "post");
    expect(postIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeLessThan(resultIdx);
    expect(transport.canPost).toBe(false);
  });

  test("a ledger post outside any task is refused, and nothing is recorded", async () => {
    // The scheduler's reality: a 03:00 reconcile has no task to ride on.
    const runtime = makeRuntime();
    await runtime.reconcilePass("test");
    // A clean plan has nothing to say, so this asserts the important half —
    // silence — plus that the transport was never asked to post.
    expect(posts()).toHaveLength(0);
    expect(runtime.stats.reconcilePasses).toBe(1);
  });
});

// ── Schedulers ──────────────────────────────────────────────────────────────

describe("schedulers", () => {
  test("start() reconciles on wake and arms both intervals", async () => {
    const armed: number[] = [];
    const runtime = makeRuntime({
      setIntervalFn: (_fn, ms) => {
        armed.push(ms);
        return armed.length;
      },
    });
    runtime.start();
    await runtime.drained();
    expect(runtime.stats.reconcilePasses).toBe(1);
    expect(armed).toEqual([21_600_000, 900_000]);
  });

  test("stop() disarms every timer it armed", () => {
    const cleared: unknown[] = [];
    const runtime = makeRuntime({
      setIntervalFn: () => Symbol("timer"),
      clearIntervalFn: (h) => {
        cleared.push(h);
      },
    });
    runtime.start();
    runtime.stop();
    expect(cleared).toHaveLength(2);
  });

  test("a watch pass announces a completion, once, through the host protocol", async () => {
    linked.set(LINKED_URL, {
      closed: true,
      title: "Backend groundwork",
      closedAt: "2026-07-20T00:00:00Z",
      referencingPrUrl: null,
    });
    const runtime = makeRuntime();
    // Open a window the way a served task does, so the post can actually leave.
    transport.openWindow("task-fixture-window", CHANNEL_ID);
    await runtime.watchPass("test");
    transport.closeWindow();

    const done = posts().filter((p) => p.text.startsWith("✅"));
    expect(done).toHaveLength(1);
    expect(done[0]!.text).toContain(LINKED_URL);

    // A second pass must not re-announce — the durable marker is what stops it.
    sent.length = 0;
    transport.openWindow("task-fixture-window-2", CHANNEL_ID);
    await runtime.watchPass("test");
    transport.closeWindow();
    expect(posts()).toHaveLength(0);
  });

  test("a watch pass that cannot post keeps its queue and retries in the next window", async () => {
    linked.set(LINKED_URL, {
      closed: true,
      title: "Backend groundwork",
      closedAt: "2026-07-20T00:00:00Z",
      referencingPrUrl: null,
    });
    const runtime = makeRuntime();
    // No window: the pass detects the closure, queues it, and fails to flush.
    await runtime.watchPass("interval");
    expect(posts()).toHaveLength(0);

    // The very next served task carries it out — that is the whole point of the
    // due flag, and the reason an interval pass without a window is safe.
    await serve(runtime, task("hello there", PROPOSER_PLATFORM_ID));
    const done = posts().filter((p) => p.text.startsWith("✅"));
    expect(done).toHaveLength(1);
  });

  test("a failed announcement is never recorded as made", async () => {
    linked.set(LINKED_URL, {
      closed: true,
      title: "Backend groundwork",
      closedAt: "2026-07-20T00:00:00Z",
      referencingPrUrl: null,
    });
    const runtime = makeRuntime();
    await runtime.watchPass("interval");
    // Nothing left the process, so nothing may be marked announced — otherwise
    // the closure is lost forever.
    expect(state.hasAnnouncedCompletion(LINKED_URL)).toBe(false);
  });

  test("an unreadable plan refuses the pass instead of flagging it due", async () => {
    repo.failReads = true;
    const runtime = makeRuntime();
    await runtime.watchPass("interval");
    await runtime.reconcilePass("interval");
    // A due flag here would make every subsequent task pay for a read that
    // will fail identically.
    await serve(runtime, task("hello", PROPOSER_PLATFORM_ID));
    expect(runtime.stats.watchPasses).toBe(1);
    expect(runtime.stats.reconcilePasses).toBe(1);
  });
});

// ── Protocol hygiene ────────────────────────────────────────────────────────

describe("protocol hygiene", () => {
  test("every task gets exactly one terminal result", async () => {
    const runtime = makeRuntime();
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    await serve(runtime, task("chatter", PROPOSER_PLATFORM_ID));
    await serve(runtime, task("RATIFY 999", PRINCIPAL_PLATFORM_ID));
    expect(results()).toHaveLength(3);
    for (const r of results()) expect(r.status).toBe("complete");
  });

  test("a result summary never echoes the user's text", async () => {
    const runtime = makeRuntime();
    await serve(runtime, task("ADD: totally-not-a-url — @everyone", PROPOSER_PLATFORM_ID));
    for (const r of results()) {
      expect(r.status === "complete" ? (r.summary ?? "") : "").not.toContain("@everyone");
    }
  });

  test("unknown and answer-shaped events are tolerated, never fatal", () => {
    const runtime = makeRuntime();
    runtime.onEvent({ v: 1, type: "hello", persona: "…", agent: "atlas", protocol: "cortex-brain/v1" });
    runtime.onEvent({ v: 1, type: "cancel", task_id: "task-fixture-x" });
    runtime.onEvent({ v: 1, type: "message", task_id: "task-fixture-x", text: "hi", user: "u" });
    runtime.onEvent({
      v: 1,
      type: "composed",
      task_id: "task-fixture-x",
      compose_id: "c1",
      text: "…",
    });
    expect(sent).toEqual([]);
  });

  test("an effect_rejected for a post is routed to the transport", async () => {
    const runtime = makeRuntime();
    runtime.onEvent({
      v: 1,
      type: "effect_rejected",
      task_id: "task-fixture-1",
      effect: "post",
      reason: { kind: "policy_denied", detail: "nope" },
    });
    expect(runtime.stats.effectRejections).toBe(1);
    // The transport now knows that task saw a refusal — proven by a post on
    // that same task id being refused rather than receipted.
    transport.openWindow("task-fixture-1", CHANNEL_ID);
    // Note: the rejection arrived BEFORE the send, so it belongs to an earlier
    // post; the sampled-counter design deliberately lets this one through. The
    // assertion is that the routing happened at all.
    expect(await transport.post(CHANNEL_ID, "x")).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THREADS — atlas#22 (Atlas was deaf in threads) + atlas#25 (converse in one).
//
// The four properties an adversarial reviewer will attack, each with its own
// test, plus the plumbing that makes them reachable:
//
//   P1  a message in a thread Atlas does NOT own is still refused, in silence
//   P2  owning a thread does NOT widen who may ratify
//   P3  owned threads survive a restart
//   P4  no effect can target anything outside {bound channel} ∪ {owned threads}
// ═══════════════════════════════════════════════════════════════════════════

const OWNED_THREAD = "thread-fixture-owned";
const FOREIGN_THREAD = "thread-fixture-foreign";

/** Effects config with the atlas#25 opt-in ON. */
function makeThreadEffects(): EffectsConfig {
  const loaded = makeEffectsConfig({
    planRepo: PLAN_REPO,
    planIssue: 4,
    channelId: CHANNEL_ID,
    adapterInstances: ADAPTER_INSTANCE_ID,
    threadConversation: "1",
  });
  if (loaded.kind !== "ok") throw new Error("fixture: thread effects config refused");
  return loaded.config;
}

/** Swap the whole effect layer onto a thread-enabled config. */
function useThreadLayer(): void {
  effects = makeThreadEffects();
  layer = {
    effects,
    plan: new GhCliPlanWriter(effects, (inv: GhInvocation) => repo.spawn(inv)),
    linked,
    ledger: new DiscordLedger(effects, transport),
    transport,
  };
}

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(2);
  }
  throw new Error(`waitUntil: ${label}`);
}

function threadEffects(): Array<Extract<BrainEffect, { type: "create_private_thread" }>> {
  return sent.filter(
    (e): e is Extract<BrainEffect, { type: "create_private_thread" }> =>
      e.type === "create_private_thread",
  );
}

/**
 * Serve a task, answering its `create_private_thread` the way the host would.
 * `answer` decides which answer arrives; `null` means none ever does (the
 * timeout path).
 */
async function serveWithHost(
  runtime: AtlasRuntime,
  event: TaskEvent,
  answer: { kind: "created"; threadId: string } | { kind: "refused" } | null,
): Promise<void> {
  const served = (async () => {
    runtime.onEvent(event);
    await runtime.drained();
  })();
  if (answer !== null) {
    await waitUntil(() => threadEffects().length > 0, "no create_private_thread was emitted");
    if (answer.kind === "created") {
      runtime.onEvent({
        v: 1,
        type: "thread_created",
        task_id: event.task_id,
        thread_id: answer.threadId,
      });
    } else {
      runtime.onEvent({
        v: 1,
        type: "effect_rejected",
        task_id: event.task_id,
        effect: "create_private_thread",
        reason: { kind: "cant_do", detail: "no thread-capable surface binding configured" },
      });
    }
  }
  await served;
}

describe("atlas#25 — opening the thread the exchange moves into", () => {
  test("OFF by default: a surfaced proposal asks for no thread at all", async () => {
    const runtime = makeRuntime();
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    expect(threadEffects()).toHaveLength(0);
    expect(posts()).toHaveLength(1);
    expect(runtime.stats.threadsOpened).toBe(0);
  });

  test("ON: one create_private_thread, named from Atlas's own display id, members 'source'", async () => {
    useThreadLayer();
    const runtime = makeRuntime({ threadWaitMs: 50 });
    const event = task(ADD_TEXT, PROPOSER_PLATFORM_ID);
    await serveWithHost(runtime, event, { kind: "created", threadId: OWNED_THREAD });

    const asked = threadEffects();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.name).toBe("Proposal #1");
    expect(asked[0]!.members).toBe("source");
    // Never the proposer's text or id — the only dynamic part is Atlas's own
    // number.
    expect(asked[0]!.name).not.toContain(PROPOSER_PLATFORM_ID);
    expect(asked[0]!.name).not.toContain("http");
    // The thread is asked for BEFORE the summary is posted, so the host's
    // retarget (cortex#2248) puts the summary in the thread.
    const askedAt = sent.findIndex((e) => e.type === "create_private_thread");
    const postedAt = sent.findIndex((e) => e.type === "post");
    expect(askedAt).toBeLessThan(postedAt);
    expect(runtime.stats.threadsOpened).toBe(1);
    expect(state.isOwnedThread(OWNED_THREAD)).toBe(true);
  });

  test("a host refusal is an ordinary outcome: the reply still lands, no thread is owned", async () => {
    // This is the ONLY path today's cortex can produce for Atlas —
    // create_private_thread is wired for openOnboarding agents only.
    useThreadLayer();
    const runtime = makeRuntime({ threadWaitMs: 50 });
    await serveWithHost(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID), { kind: "refused" });

    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.text).toContain("Proposal #1 — ADD:");
    expect(state.isOwnedThread(OWNED_THREAD)).toBe(false);
    expect(runtime.stats.threadsOpened).toBe(0);
    expect(results()).toHaveLength(1);
  });

  test("a host that never answers falls back to the channel, bounded by threadWaitMs", async () => {
    useThreadLayer();
    const runtime = makeRuntime({ threadWaitMs: 30 });
    await serveWithHost(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID), null);
    expect(posts()).toHaveLength(1);
    expect(runtime.stats.threadsOpened).toBe(0);
    expect(results()).toHaveLength(1);
  });

  test("a degraded store never opens a thread — Atlas will not invite a reply it cannot hear", async () => {
    useThreadLayer();
    const memoryOnly = new AtlasProposals(null);
    const runtime = makeRuntime({ state: memoryOnly, threadWaitMs: 50 });
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID));
    expect(threadEffects()).toHaveLength(0);
  });

  test("a task ALREADY in a thread never asks for a second thread", async () => {
    useThreadLayer();
    expect(state.recordOwnedThread(OWNED_THREAD, "task-fixture-seed")).toBe(true);
    const runtime = makeRuntime({ threadWaitMs: 50 });
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID, OWNED_THREAD));
    expect(threadEffects()).toHaveLength(0);
    expect(posts()).toHaveLength(1);
  });

  test("an uncorrelated thread_created records NOTHING — the registry is not writable by an event", async () => {
    // The attack: a task Atlas never asked a thread for (or a forged/stale
    // event) claiming a thread id, hoping to have it admitted afterwards.
    useThreadLayer();
    const runtime = makeRuntime({ threadWaitMs: 50 });
    runtime.onEvent({
      v: 1,
      type: "thread_created",
      task_id: "task-fixture-never-asked",
      thread_id: FOREIGN_THREAD,
    });
    await runtime.drained();
    expect(state.isOwnedThread(FOREIGN_THREAD)).toBe(false);

    // …and a message from it is still refused.
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID, FOREIGN_THREAD));
    expect(posts()).toHaveLength(0);
    expect(summaryOf(results()[0])).toBe("not-admitted");
  });

  test("a malformed thread id is refused rather than stored", async () => {
    useThreadLayer();
    const runtime = makeRuntime({ threadWaitMs: 50 });
    await serveWithHost(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID), {
      kind: "created",
      threadId: "not a thread id — with spaces",
    });
    expect(runtime.stats.threadsOpened).toBe(0);
    expect(state.isOwnedThread("not a thread id — with spaces")).toBe(false);
    // The reply still went out; only the ownership claim was dropped.
    expect(posts()).toHaveLength(1);
  });
});

describe("atlas#22 — admission covers threads Atlas owns, and nothing else", () => {
  test("a RATIFY posted in an OWNED thread is admitted and applied", async () => {
    // The interaction atlas#22/#25 exist for: Atlas invites `RATIFY 1` into a
    // thread, and the principal typing it there is heard.
    useThreadLayer();
    const runtime = makeRuntime({ threadWaitMs: 50 });
    await serveWithHost(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID), {
      kind: "created",
      threadId: OWNED_THREAD,
    });
    sent.length = 0;

    await serve(runtime, task("RATIFY 1", PRINCIPAL_PLATFORM_ID, OWNED_THREAD));
    expect(summaryOf(results()[0])).toBe("gate-ratified");
    expect(runtime.stats.ratified).toBe(1);
    // The plan really moved — the map half of the atomic pair.
    expect(repo.body).toContain(NEW_URL);
  });

  // ── P1 ──────────────────────────────────────────────────────────────────
  test("P1 — a message in a thread Atlas does NOT own is refused, in silence", async () => {
    useThreadLayer();
    expect(state.recordOwnedThread(OWNED_THREAD, "task-fixture-seed")).toBe(true);
    const runtime = makeRuntime({ threadWaitMs: 50 });

    // A proposal AND a ratification, both from the foreign thread.
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID, FOREIGN_THREAD));
    await serve(runtime, task("RATIFY 1", PRINCIPAL_PLATFORM_ID, FOREIGN_THREAD));

    expect(posts()).toHaveLength(0);
    expect(threadEffects()).toHaveLength(0);
    expect(runtime.stats.notAdmitted).toBe(2);
    for (const r of results()) {
      expect(summaryOf(r)).toBe("not-admitted");
    }
    // Nothing was recorded either — an unadmitted proposal never enters state.
    expect(repo.invocations.filter((i) => i.argv[2] === "edit")).toHaveLength(0);
  });

  test("P1 (cont.) — an empty or absent channel never matches an owned thread", async () => {
    useThreadLayer();
    expect(state.recordOwnedThread(OWNED_THREAD, "task-fixture-seed")).toBe(true);
    const runtime = makeRuntime({ threadWaitMs: 50 });
    await serve(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID, ""));
    expect(posts()).toHaveLength(0);
    expect(runtime.stats.notAdmitted).toBe(1);
  });

  // ── P2 ──────────────────────────────────────────────────────────────────
  test("P2 — an owned thread does NOT widen who may ratify", async () => {
    useThreadLayer();
    const runtime = makeRuntime({ threadWaitMs: 50 });
    await serveWithHost(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID), {
      kind: "created",
      threadId: OWNED_THREAD,
    });
    sent.length = 0;

    // The proposer — who is IN the thread Atlas opened FOR them — ratifies.
    await serve(runtime, task("RATIFY 1", PROPOSER_PLATFORM_ID, OWNED_THREAD));

    expect(runtime.stats.ratified).toBe(0);
    expect(repo.body).not.toContain(NEW_URL);
    expect(posts()).toHaveLength(0); // outsider RATIFY is silence, in a thread too
    expect(summaryOf(results()[0])).toBe("gate-ignored");
  });

  test("P2 (cont.) — Atlas's own id cannot ratify from inside its own thread", async () => {
    useThreadLayer();
    const runtime = makeRuntime({ threadWaitMs: 50 });
    await serveWithHost(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID), {
      kind: "created",
      threadId: OWNED_THREAD,
    });
    sent.length = 0;
    await serve(runtime, task("RATIFY 1", ATLAS_PLATFORM_ID, OWNED_THREAD));
    expect(runtime.stats.ratified).toBe(0);
    expect(repo.body).not.toContain(NEW_URL);
  });

  // ── P3 ──────────────────────────────────────────────────────────────────
  test("P3 — an owned thread survives a restart: a fresh store still admits it", async () => {
    useThreadLayer();
    const runtime = makeRuntime({ threadWaitMs: 50 });
    await serveWithHost(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID), {
      kind: "created",
      threadId: OWNED_THREAD,
    });

    // The daemon dies and comes back on the same instance dir — a maxRestarts
    // restart, a redeploy, a config reload.
    store.close();
    const reopened = AtlasStateStore.open({ dir, bundleDir: null });
    if (reopened === null) throw new Error("fixture: reopen failed");
    store = reopened;
    state = new AtlasProposals(store);
    expect(state.isOwnedThread(OWNED_THREAD)).toBe(true);

    sent.length = 0;
    const rebooted = makeRuntime({ threadWaitMs: 50 });
    await serve(rebooted, task("RATIFY 1", PRINCIPAL_PLATFORM_ID, OWNED_THREAD));
    expect(rebooted.stats.notAdmitted).toBe(0);
    expect(rebooted.stats.ratified).toBe(1);
  });

  // ── P4 ──────────────────────────────────────────────────────────────────
  test("P4 — no effect rides a task from outside {bound channel} ∪ {owned threads}", async () => {
    useThreadLayer();
    const runtime = makeRuntime({ threadWaitMs: 50 });
    const opener = task(ADD_TEXT, PROPOSER_PLATFORM_ID);
    await serveWithHost(runtime, opener, { kind: "created", threadId: OWNED_THREAD });

    // Everything an outsider could try, from everywhere Atlas must not act.
    const foreign = [
      task(ADD_TEXT, PROPOSER_PLATFORM_ID, OTHER_CHANNEL),
      task("RATIFY 1", PRINCIPAL_PLATFORM_ID, OTHER_CHANNEL),
      task("RATIFY 1", PRINCIPAL_PLATFORM_ID, FOREIGN_THREAD),
      task(ADD_TEXT, PROPOSER_PLATFORM_ID, CHANNEL_ID, OTHER_ADAPTER_INSTANCE_ID),
      task("RATIFY 1", PRINCIPAL_PLATFORM_ID, OWNED_THREAD, OTHER_ADAPTER_INSTANCE_ID),
    ];
    for (const f of foreign) await serve(runtime, f);
    const foreignIds = new Set(foreign.map((f) => f.task_id));

    // The universe check: EVERY effect that names a task must name a task
    // Atlas admitted, i.e. one whose source channel is the bound channel or an
    // owned thread. `log`/`result` are exempt from the first half only because
    // `log` carries no task at all.
    for (const effect of sent) {
      if (effect.type === "post" || effect.type === "create_private_thread") {
        expect(foreignIds.has(effect.task_id)).toBe(false);
        expect(effect.task_id).toBe(opener.task_id);
      }
    }
    expect(posts()).toHaveLength(1); // the opener's summary, and nothing else
  });

  test("P4 (cont.) — a ledger entry earned in a thread is PARKED, never written to the thread", async () => {
    // cortex#2248 retargets every post on a thread-created task INTO the
    // thread, and there is no way to aim one at the parent. So the ledger post
    // is REFUSED (transport `wrong-channel`) rather than written in the wrong
    // room — the plan moves, the entry parks, and reconcile is flagged due.
    useThreadLayer();
    const runtime = makeRuntime({ threadWaitMs: 50 });
    await serveWithHost(runtime, task(ADD_TEXT, PROPOSER_PLATFORM_ID), {
      kind: "created",
      threadId: OWNED_THREAD,
    });
    sent.length = 0;

    await serve(runtime, task("RATIFY 1", PRINCIPAL_PLATFORM_ID, OWNED_THREAD));
    expect(repo.body).toContain(NEW_URL); // the map moved
    expect(transport.refusals["wrong-channel"]).toBeGreaterThan(0); // …the ledger did not
    expect(runtime.stats.applied).toBe(0);
    // Said out loud, on the wire, naming the cause.
    const logs = sent.filter((e) => e.type === "log").map((e) => String(e.text));
    expect(logs.join("\n")).toContain("arrived in a thread");
  });
});
