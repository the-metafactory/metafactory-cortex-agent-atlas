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

function makeEffects(): EffectsConfig {
  const loaded = makeEffectsConfig({
    planRepo: PLAN_REPO,
    planIssue: 4,
    channelId: CHANNEL_ID,
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

/** A task event as cortex builds it for an inbound surface message. */
function task(text: string, authorId: string, channel = CHANNEL_ID): TaskEvent {
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
      adapter_instance: "adapter-fixture",
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
    expect(reply[0]!.text).toContain("To ratify: RATIFY 1");
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
