/**
 * THE SHADOW REHEARSAL — the Definition of Done walkthrough (W4, issue #4;
 * epic #5's numbered list), run end to end against THROWAWAY targets.
 *
 * ── What is real here, and what is not ─────────────────────────────────────
 * REAL: the daemon (`bun brain/main.ts` as a subprocess), the socket, the auth
 * handshake, cortex's own minimal-env filter, the ratification gate, intake and
 * validation, the effect adapters, `gh` itself, and a live GitHub repo with a
 * live issue whose body Atlas actually edits.
 *
 * NOT REAL, deliberately: the Discord side. `cortex-brain/v1` gives the brain no
 * way to name a channel — the host derives the target from the task it owns
 * (`transport.ts`) — so a host double that records `post` effects sees exactly
 * what a live channel would receive. A real channel id would additionally have
 * to exist somewhere in this public repo, which it may not. The brief's "a
 * scratch channel OR a fully faked transport" is answered with the second.
 *
 * ── The fence ──────────────────────────────────────────────────────────────
 * `guards.ts` refuses to run against anything under the org that owns the live
 * plan, and refuses a snowflake-shaped channel id. Those guards are unit-tested
 * unconditionally, below, so they are verified on every `bun test` and not only
 * when the rehearsal itself runs.
 *
 * ── Running it ─────────────────────────────────────────────────────────────
 *   bun run shadow            # ATLAS_SHADOW=1 bun test test/e2e/walkthrough.test.ts
 * Requires: `gh` authenticated with `repo` scope, and network. Without
 * `ATLAS_SHADOW=1` the network-touching describes skip and the structural ones
 * still run.
 *
 * ── Honest labels ──────────────────────────────────────────────────────────
 * Two DoD steps are NOT provable here and say so in their own test names rather
 * than being quietly asserted around:
 *   - step 6 (delete a ✅, expect one catch-up) is not exercisable on this
 *     protocol at all — see "DoD 6" below;
 *   - step 8's PR half is reachable only by calling the adapter directly,
 *     because no code path from a message reaches `openDocPullRequest`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeEffectsConfig, type EffectsConfig } from "../../brain/effects/config";
import { DiscordLedger } from "../../brain/effects/discord";
import {
  assertAllowed,
  GhCliPlanWriter,
  RefusedInvocation,
  type GhInvocation,
  type PlanWriteIntent,
} from "../../brain/effects/gh";
import { GhCliReadOnly } from "../../brain/gh";
import { reconcilePlan } from "../../brain/reconcile";
import { AtlasProposals, AtlasStateStore, type ProposalRecord } from "../../brain/state";
import { HostLedgerTransport } from "../../brain/transport";
import type { BrainEffect } from "../../brain/protocol";

import {
  installArgvAudit,
  invocationsCarryingMerge,
  invocationsTouching,
  mutations,
  renderAudit,
  type ArgvAudit,
} from "./shadow/audit";
import { assertThrowawayTarget, LiveTargetRefused, PROTECTED_OWNER } from "./shadow/guards";
import { buildBrainEnv, declaredSecrets, FakeCortexHost, PACK_ROOT } from "./shadow/host";
import { gh, ghAuthenticated, provisionScratchTarget, type ScratchTarget } from "./shadow/scratch";

// ── Fixtures. Placeholder ids only — this repo is public. ───────────────────

const PRINCIPAL_ID = "plan-steward";
const PRINCIPAL_PLATFORM_ID = "pid-principal-fixture";
const ATLAS_PLATFORM_ID = "pid-atlas-self-fixture";
const PROPOSER_PLATFORM_ID = "pid-proposer-fixture";
const OUTSIDER_PLATFORM_ID = "pid-outsider-fixture";
const CHANNEL_ID = "chan-shadow-0000";
const ADAPTER_INSTANCE = "adapter-shadow-0000";

const SHADOW = process.env.ATLAS_SHADOW === "1";
const shadow = SHADOW ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════
// The fence — always runs, network or not.
// ═══════════════════════════════════════════════════════════════════════════

describe("the shadow harness cannot be pointed at anything live", () => {
  const ok = {
  planRepo: "someone/atlas-shadow-rehearsal",
  planIssue: 7,
  channelId: CHANNEL_ID,
  adapterInstances: ADAPTER_INSTANCE,
};

  test("a throwaway target is accepted", () => {
    expect(() => {
      assertThrowawayTarget(ok);
    }).not.toThrow();
  });

  test("ANY repo under the protected owner is refused — including the live plan", () => {
    for (const repo of [`${PROTECTED_OWNER}/vision`, `${PROTECTED_OWNER}/compass`, `The-MetaFactory/vision`]) {
      let refusal: LiveTargetRefused | null = null;
      try {
        assertThrowawayTarget({ ...ok, planRepo: repo });
      } catch (err) {
        refusal = err as LiveTargetRefused;
      }
      expect(refusal).not.toBeNull();
      expect(refusal!.reason).toBe("protected-owner");
    }
  });

  test("a snowflake-shaped channel id is refused — the harness never gets a real channel", () => {
    // 17-20 digits is every real Discord channel and no fixture in this repo.
    for (const id of ["11111111111111111", "11111111111111111111"]) {
      let refusal: LiveTargetRefused | null = null;
      try {
        assertThrowawayTarget({ ...ok, channelId: id });
      } catch (err) {
        refusal = err as LiveTargetRefused;
      }
      expect(refusal).not.toBeNull();
      expect(refusal!.reason).toBe("snowflake-channel");
    }
    // …and the placeholder convention this repo actually uses is fine.
    expect(() => {
      assertThrowawayTarget({ ...ok, channelId: "chan-fixture-0000" });
    }).not.toThrow();
  });

  test("a malformed repo or issue is refused rather than defaulted", () => {
    expect(() => {
      assertThrowawayTarget({ ...ok, planRepo: "not-a-repo" });
    }).toThrow(LiveTargetRefused);
    expect(() => {
      assertThrowawayTarget({ ...ok, planIssue: 0 });
    }).toThrow(LiveTargetRefused);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DoD 7 — "the whole loop also passes with compose disabled".
//
// Structural, and it needs no network: Atlas's brain has no compose effect to
// disable. `BrainEffect` is `post | result | log` (protocol.ts), and nothing in
// the pack emits, builds or references a compose effect. So the loop passes with
// compose off for the same reason it passes with compose on — the flag governs a
// capability this pack never exercises. Recorded as a FINDING rather than a
// green tick: `agent.yaml` ships `compose: true` with a long rationale, and it
// is presently inert.
// ═══════════════════════════════════════════════════════════════════════════

describe("DoD 7 — compose is voice, not dependency (structural)", () => {
  test("the brain's effect union has no compose variant", () => {
    const protocol = readFileSync(join(PACK_ROOT, "brain", "protocol.ts"), "utf8");
    const union = /export type BrainEffect =([^;]*);/.exec(protocol);
    expect(union).not.toBeNull();
    expect(union![1]).not.toMatch(/compose/i);
  });

  test("no module in the brain emits a compose effect", () => {
    const glob = new Bun.Glob("**/*.ts");
    const offenders: string[] = [];
    for (const rel of glob.scanSync({ cwd: join(PACK_ROOT, "brain") })) {
      if (rel.endsWith(".test.ts")) continue;
      const src = readFileSync(join(PACK_ROOT, "brain", rel), "utf8");
      // A compose effect would have to be constructed as `type: "compose"`.
      if (/type:\s*["']compose["']/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("an inbound `composed` event is survivable, not fatal", () => {
    // runtime.ts answers it with a warn and keeps serving — asserted live in the
    // walkthrough below, where a `composed` event is injected mid-run.
    const runtime = readFileSync(join(PACK_ROOT, "brain", "runtime.ts"), "utf8");
    expect(runtime).toContain('case "composed"');
    expect(runtime).toContain("unexpected");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DoD 6 — NOT EXERCISABLE, and here is the proof of why.
// ═══════════════════════════════════════════════════════════════════════════

describe("DoD 6 — deleting a ✅ cannot be detected on this protocol (structural)", () => {
  test("no LedgerReader is wired, and the runtime passes channel: null", () => {
    const main = readFileSync(join(PACK_ROOT, "brain", "main.ts"), "utf8");
    const runtime = readFileSync(join(PACK_ROOT, "brain", "runtime.ts"), "utf8");
    // `main.ts` constructs the write transport and nothing that reads a channel.
    expect(main).toContain("HostLedgerTransport");
    expect(main).not.toMatch(/LedgerReader|recentMessages/);
    // …and the reconcile pass is handed an explicit null cross-check.
    expect(runtime).toMatch(/channel:\s*null/);
  });

  test("without a reader the deleted-✅ detector cannot fire at all", () => {
    const reconcile = readFileSync(join(PACK_ROOT, "brain", "reconcile.ts"), "utf8");
    // The guard that makes "no reader ⇒ no claim" true, immediately above the
    // only branch that could report a completion as missing.
    expect(reconcile).toContain("if (window === null) continue;");
  });

  test("and the receipts it would compare against are local, not platform ids", () => {
    const transport = readFileSync(join(PACK_ROOT, "brain", "transport.ts"), "utf8");
    expect(transport).toContain('RECEIPT_PREFIX = "host-effect"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The live walkthrough.
// ═══════════════════════════════════════════════════════════════════════════

interface Fixture {
  dir: string;
  host: FakeCortexHost;
  target: ScratchTarget;
  audit: ArgvAudit;
  stateDir: string;
  checkoutDir: string;
  runId: string;
  seedBody: string;
  effects: EffectsConfig;
}

let fx: Fixture;
let originalPath: string;

function durableRecord(stateDir: string, id: string): ProposalRecord | null {
  const store = AtlasStateStore.open({ dir: stateDir });
  if (store === null) return null;
  try {
    return store.get(id);
  } finally {
    store.close();
  }
}

shadow("shadow rehearsal — the DoD walkthrough against throwaway targets", () => {
  beforeAll(async () => {
    if (!(await ghAuthenticated())) {
      throw new Error("shadow rehearsal: `gh auth status` failed — the rehearsal needs a live gh");
    }
    const runId = `r${Date.now().toString(36)}`;
    fx = {} as Fixture;
    fx.runId = runId;
    fx.dir = mkdtempSync(join(tmpdir(), "atlas-shadow-"));
    fx.stateDir = join(fx.dir, "state");
    fx.checkoutDir = join(fx.dir, "checkout");
    mkdirSync(fx.stateDir, { recursive: true });
    mkdirSync(join(fx.dir, "scratch"), { recursive: true });

    // Three open issues: two get ratified onto the plan (so the ✅ batch has two
    // items), one is proposed but never ratified (the self-ratify target).
    fx.target = await provisionScratchTarget({
      runId,
      linkedIssues: 3,
      ...(process.env.ATLAS_SHADOW_REPO === undefined
        ? {}
        : { repo: process.env.ATLAS_SHADOW_REPO }),
    });

    // THE FENCE. Before a single byte of Atlas's configuration is written.
    assertThrowawayTarget({
      planRepo: fx.target.repo,
      planIssue: fx.target.planIssue,
      channelId: CHANNEL_ID,
    });

    fx.seedBody = await fx.target.planBody();
    fx.audit = installArgvAudit(fx.dir);

    // The in-process phases (reconcile, the PR path) go through the audit shim
    // too, so the transcript covers everything Atlas did in this rehearsal —
    // not only what the daemon subprocess did.
    originalPath = process.env.PATH ?? "";
    process.env.PATH = `${fx.audit.binDir}:${originalPath}`;

    // An EXISTING but empty overlay file wins env.ts's resolution order, so a
    // developer's own ~/.config/metafactory/atlas/.env can never leak into a
    // rehearsal and quietly change the answer.
    const emptyOverlay = join(fx.dir, "overlay.env");
    writeFileSync(emptyOverlay, "# shadow rehearsal: deliberately empty\n", "utf8");

    const hostEnv: Record<string, string> = {
      ATLAS_RATIFIER_PRINCIPAL: PRINCIPAL_ID,
      ATLAS_RATIFIER_PLATFORM_IDS: `discord:${PRINCIPAL_PLATFORM_ID}`,
      ATLAS_SELF_PLATFORM_IDS: `discord:${ATLAS_PLATFORM_ID}`,
      ATLAS_PLAN_REPO: fx.target.repo,
      ATLAS_PLAN_ISSUE: String(fx.target.planIssue),
      ATLAS_CHANNEL_ID: CHANNEL_ID,
      ATLAS_TRUSTED_ADAPTER_INSTANCES: ADAPTER_INSTANCE,
      ATLAS_PLAN_BASE_BRANCH: "main",
      ATLAS_PLAN_CHECKOUT: fx.checkoutDir,
      ATLAS_STATE_DIR: fx.stateDir,
      ATLAS_ENV_FILE: emptyOverlay,
      // The floor cortex's own clamp allows. The walkthrough waits for a real
      // interval tick rather than reaching into the runtime — that scheduler,
      // and the due-flag hand-off into the next post window, is the part no
      // unit test drives.
      ATLAS_WATCH_INTERVAL_MS: "60000",
      // Parked far away: reconcile is driven deliberately in its own step, and
      // an interval firing mid-walkthrough would make the ledger assertions
      // depend on timing.
      ATLAS_RECONCILE_INTERVAL_MS: "604800000",
    };

    const loaded = makeEffectsConfig({
      planRepo: fx.target.repo,
      planIssue: fx.target.planIssue,
      channelId: CHANNEL_ID,
      adapterInstances: ADAPTER_INSTANCE,
      baseBranch: "main",
      checkoutDir: fx.checkoutDir,
    });
    if (loaded.kind !== "ok") throw new Error(`shadow: effects config refused (${loaded.reason})`);
    fx.effects = loaded.config;

    const socketPath = join(fx.dir, "brain.sock");
    fx.host = new FakeCortexHost(
      socketPath,
      buildBrainEnv({
        hostEnv,
        socketPath,
        token: "token-fixture-0000",
        scratchDir: join(fx.dir, "scratch"),
        path: `${fx.audit.binDir}:${originalPath}`,
        // The REAL home, deliberately: `gh` finds its credential through HOME
        // and cortex passes HOME through. See docs/cutover.md — this is how the
        // live token has to reach Atlas, because an env var that is not in
        // `runtime.brain.secrets` never reaches the brain at all.
        home: process.env.HOME ?? "",
      }),
      CHANNEL_ID,
    );
    await fx.host.start();
    fx.host.hello();
    await fx.host.waitFor(
      () => fx.host.stderrText().includes("connected"),
      15_000,
      "the brain never connected",
    );
  }, 300_000);

  afterAll(async () => {
    try {
      await fx?.host?.stop();
    } catch {
      /* teardown */
    }
    if (originalPath.length > 0) process.env.PATH = originalPath;
    try {
      await fx?.target?.cleanup();
    } catch {
      /* teardown */
    }
    if (fx?.dir !== undefined) rmSync(fx.dir, { recursive: true, force: true });
  }, 120_000);

  // ── Step 1 (partial): the daemon comes up ARMED against the scratch plan ──

  test("the gate boots ARMED, pinned to the scratch plan and nothing else", () => {
    const verdict = fx.host.startupVerdict();
    expect(verdict).toContain("GATE ARMED");
    expect(verdict).toContain(`plan=${fx.target.repo}#${fx.target.planIssue}`);
    expect(verdict).toContain("state=durable");
    // Ids stay masked even in a rehearsal's own logs.
    expect(verdict).not.toContain(PRINCIPAL_ID);
    expect(verdict).not.toContain(CHANNEL_ID);
    // Every name the brain needs really did survive cortex's env filter.
    const declared = new Set(declaredSecrets());
    for (const n of ["ATLAS_PLAN_REPO", "ATLAS_PLAN_ISSUE", "ATLAS_CHANNEL_ID", "ATLAS_STATE_DIR"]) {
      expect(declared).toContain(n);
    }
  });

  // ── DoD 2: a non-principal proposes; NOTHING else happens ────────────────

  test("DoD 2 — a non-principal ADD surfaces a numbered proposal and changes nothing", async () => {
    const url = fx.target.issueUrl(fx.target.linked[0]!);
    const result = await fx.host.turn(
      "t-add-1",
      `ADD: ${url} — [Backend] shadow rehearsal: this item belongs on the plan`,
      PROPOSER_PLATFORM_ID,
    );
    expect(result.summary).toBe("proposal-surfaced");

    const posts = fx.host.postsFor("t-add-1");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Proposal #1 — ADD:");
    expect(posts[0]).toContain(url);

    // The map is untouched — this is the whole point of the step.
    expect(await fx.target.planBody()).toBe(fx.seedBody);

    // …and no WRITE was even attempted. Reads only.
    expect(mutations(fx.audit.records())).toEqual([]);
  }, 120_000);

  test("DoD 2 — an outsider's RATIFY on that proposal is silence", async () => {
    const result = await fx.host.turn("t-outsider", "RATIFY 1", OUTSIDER_PLATFORM_ID);
    expect(result.summary).toBe("gate-ignored");
    expect(fx.host.postsFor("t-outsider")).toEqual([]);
    expect(await fx.target.planBody()).toBe(fx.seedBody);
  }, 120_000);

  // ── DoD 3 + 4: the principal ratifies; map and ledger move together ───────

  test("DoD 3+4 — RATIFY edits the live plan body AND lands the ➕ ledger entry, credited", async () => {
    const url = fx.target.issueUrl(fx.target.linked[0]!);
    const result = await fx.host.turn("t-ratify-1", "RATIFY 1", PRINCIPAL_PLATFORM_ID);
    expect(result.summary).toBe("gate-ratified");

    // (a) THE MAP — read back from GitHub, not from Atlas's belief about it.
    const body = await fx.target.planBody();
    expect(body).toContain(url);
    // Placed inside the named section, after its existing list item, and
    // nothing else in the body moved.
    const lines = body.split("\n");
    const backendAt = lines.findIndex((l) => l.trim() === "## Backend");
    const docsAt = lines.findIndex((l) => l.trim() === "## Docs");
    const urlAt = lines.findIndex((l) => l.includes(url));
    expect(backendAt).toBeGreaterThanOrEqual(0);
    expect(urlAt).toBeGreaterThan(backendAt);
    expect(urlAt).toBeLessThan(docsAt);
    expect(lines[urlAt]).toBe(`- [ ] ${url}`);
    // Every seed line survives verbatim — a minimal edit, not a rewrite.
    for (const seedLine of fx.seedBody.split("\n").filter((l) => l.trim().length > 0)) {
      expect(body).toContain(seedLine);
    }

    // (b) THE LEDGER — one ➕ post, on the same task, with the credit and receipt.
    const posts = fx.host.postsFor("t-ratify-1");
    const ledger = posts.filter((t) => t.startsWith("➕"));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toContain("#1: added");
    expect(ledger[0]).toContain(url);
    expect(ledger[0]).toContain('under "Backend"');
    // The proposer is credited, and — correctly — NOT rendered as a GitHub
    // @login, because a Discord id is not one.
    expect(ledger[0]).toContain(`"discord:${PROPOSER_PLATFORM_ID}"`);
    expect(ledger[0]).toContain("· revision ");
    expect(ledger[0]).toContain(fx.target.planUrl);
    expect(ledger[0]).toContain("— Atlas · plan steward");

    // (c) ATOMIC PAIR — both receipts are in durable state, in one transition.
    const rec = durableRecord(fx.stateDir, "t-add-1");
    expect(rec?.phase).toBe("posted");
    expect(rec?.applied).not.toBeNull();
    expect(rec?.posted).not.toBeNull();

    // (d) The write really was a single pinned edit on the scratch plan issue.
    const edits = fx.audit
      .records()
      .filter((a) => a[0] === "gh" && a[1] === "issue" && a[2] === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual([
      "gh",
      "issue",
      "edit",
      String(fx.target.planIssue),
      "--repo",
      fx.target.repo,
      "--body-file",
      "-",
    ]);
  }, 180_000);

  // ── DoD 8 (second half): Atlas cannot ratify Atlas — LIVE ────────────────

  test("DoD 8 — Atlas's own RATIFY on a live proposal fails, live", async () => {
    const url = fx.target.issueUrl(fx.target.linked[1]!);
    const surfaced = await fx.host.turn(
      "t-add-2",
      `ADD: ${url} — [Docs] shadow rehearsal: the self-ratification target`,
      PROPOSER_PLATFORM_ID,
    );
    expect(surfaced.summary).toBe("proposal-surfaced");
    const before = await fx.target.planBody();

    // The live attempt: a real task, over the real socket, into an ARMED gate,
    // authored by the platform identity the deployment declared as Atlas's own.
    const attempt = await fx.host.turn("t-self-ratify", "RATIFY 2", ATLAS_PLATFORM_ID);
    expect(attempt.summary).toBe("gate-ignored");
    expect(fx.host.postsFor("t-self-ratify")).toEqual([]);

    // Nothing moved on the live plan…
    expect(await fx.target.planBody()).toBe(before);
    expect(await fx.target.planBody()).not.toContain(url);
    // …and the proposal is still merely surfaced, never ratified.
    expect(durableRecord(fx.stateDir, "t-add-2")?.phase).toBe("surfaced");

    // The same words from the principal DO work — so the refusal above is about
    // WHO said it, not about the message being unparseable.
    const real = await fx.host.turn("t-ratify-2", "RATIFY 2", PRINCIPAL_PLATFORM_ID);
    expect(real.summary).toBe("gate-ratified");
    expect(await fx.target.planBody()).toContain(url);
  }, 240_000);

  // ── DoD 5: a plan-linked issue closes → one batched ✅ ────────────────────

  test("DoD 5 — two same-day closures become ONE ✅ post, on the next post window", async () => {
    // A third item onto the plan, so the batch has two members.
    const thirdUrl = fx.target.issueUrl(fx.target.linked[2]!);
    await fx.host.turn(
      "t-add-3",
      `ADD: ${thirdUrl} — [Backend] shadow rehearsal: the second completion`,
      PROPOSER_PLATFORM_ID,
    );
    await fx.host.turn("t-ratify-3", "RATIFY 3", PRINCIPAL_PLATFORM_ID);
    expect(await fx.target.planBody()).toContain(thirdUrl);

    // Close two plan-linked issues for real.
    const firstUrl = fx.target.issueUrl(fx.target.linked[0]!);
    await fx.target.closeIssue(fx.target.linked[0]!);
    await fx.target.closeIssue(fx.target.linked[2]!);

    // The watcher fires on its own interval, OUTSIDE any post window — so the
    // post fails, the queue is kept, and the pass flags itself due. That
    // hand-off is the part of the design no unit test drives.
    await fx.host.waitFor(
      () => fx.host.stderrText().includes("could not post"),
      200_000,
      "the completion watcher never ran an interval pass",
    );

    // Any inbound task now opens a window, and the due pass rides it out.
    const nudge = await fx.host.turn("t-nudge", "just chatting, nothing to see here", PROPOSER_PLATFORM_ID);
    expect(nudge.status).toBe("complete");

    const completions = fx.host.allPosts().filter((t) => t.startsWith("✅"));
    expect(completions).toHaveLength(1); // batched — a ledger, not a ticker
    expect(completions[0]).toContain("Plan items completed — 2 today");
    expect(completions[0]).toContain(firstUrl.replace(/\/issues\/\d+$/, ""));
    expect(completions[0]).toContain("verified: closed on GitHub");
    expect(completions[0]).toContain("— Atlas · plan steward");
  }, 300_000);

  // ── DoD 7, live: a `composed` event mid-run changes nothing ──────────────

  test("DoD 7 — a `composed` event arrives and the loop carries on unchanged", async () => {
    fx.host.send({ v: 1, type: "composed", task_id: "t-nudge", text: "(a voice Atlas never asked for)" });
    const after = await fx.host.turn("t-after-composed", "still here?", PROPOSER_PLATFORM_ID);
    expect(after.status).toBe("complete");
    // Atlas never emits anything but post/result/log — compose is not in its
    // vocabulary at all, in either direction.
    for (const t of fx.host.effectTypes()) {
      expect(["log", "post", "result"]).toContain(t);
    }
    expect(fx.host.effectTypes()).toContain("post");
  }, 120_000);

  // ── DoD 6, as far as it goes: reconcile runs, converges, stays silent ─────

  test("DoD 6 (partial) — reconcile converges over the live run and posts nothing", async () => {
    // Take the daemon down first: the reconcile passes below open the same
    // durable store, and two writers is not what is being tested.
    fx.host.send({ v: 1, type: "shutdown", deadline_ms: 500 });
    await Bun.sleep(2_000);
    await fx.host.stop();

    const store = AtlasStateStore.open({ dir: fx.stateDir });
    expect(store).not.toBeNull();
    const state = new AtlasProposals(store);
    const sent: BrainEffect[] = [];
    const transport = new HostLedgerTransport({
      send: (e) => sent.push(e),
      channelId: CHANNEL_ID,
      wait: () => Promise.resolve(),
    });
    // A window that is genuinely open — so "silent" means "chose not to post",
    // not "could not post".
    transport.openWindow("t-reconcile", CHANNEL_ID);
    const ledger = new DiscordLedger(fx.effects, transport);
    const deps = {
      state,
      plan: new GhCliPlanWriter(fx.effects),
      gh: new GhCliReadOnly(fx.effects.plan),
      ledger,
      effects: fx.effects,
      channel: null,
      instanceDir: fx.stateDir,
    };

    try {
      const first = await reconcilePlan(deps, Date.now());
      const second = await reconcilePlan(deps, Date.now());

      // Neither pass found drift the live run left behind — including the
      // checkbox ticks GitHub itself writes when the walkthrough's linked
      // issues close (atlas#34): those are corroborated by Atlas's own
      // completion index (`watch.ts`'s announcements) and accounted for
      // silently, exactly like the walkthrough's own ➕ applies are.
      if (first.kind !== "clean") {
        const detail =
          first.kind === "caught-up" || first.kind === "post-failed"
            ? first.items.map((i) => `${i.kind} :: ${i.key} :: ${i.line}`).join("\n    ")
            : JSON.stringify(first);
        const observed = [...state.observedPlanRevisions()].sort().join(", ");
        const live = await deps.plan.readPlan();
        throw new Error(
          `the first reconcile after a clean live run found drift (${first.kind}):\n    ${detail}\n` +
            `  revisions Atlas recorded: ${observed}\n` +
            `  revision GitHub reports now: ${live?.revisedAt ?? "(unreadable)"}`,
        );
      }
      expect(second.kind).toBe("clean");
      // …and neither said a word, with a window open the whole time.
      expect(transport.canPost).toBe(true);
      expect(sent.filter((e) => e.type === "post")).toEqual([]);
      expect(transport.refusals["no-post-window"]).toBe(0);
    } finally {
      state.close();
    }
  }, 240_000);

  // ── DoD 8 (first half): Atlas authors a PR it cannot merge — LIVE ────────

  test("DoD 8 — the doc-change PR path is UNREACHABLE from any message (finding)", () => {
    // Before attempting the live PR: nothing in the pack calls it. There is no
    // ratified-doc-change path, so the DoD's "a ratified doc change arrives as a
    // PR" cannot be driven through the message loop at all. The live attempt
    // below therefore calls the adapter directly, and says so.
    const glob = new Bun.Glob("**/*.ts");
    const callers: string[] = [];
    for (const rel of glob.scanSync({ cwd: join(PACK_ROOT, "brain") })) {
      if (rel === "effects/gh.ts") continue;
      const src = readFileSync(join(PACK_ROOT, "brain", rel), "utf8");
      if (/openDocPullRequest|pushBranch/.test(src)) callers.push(rel);
    }
    expect(callers).toEqual([]);
  });

  test("DoD 8 — Atlas opens a real PR and CANNOT merge it; a live attempt fails", async () => {
    const branch = `atlas-shadow/${fx.runId}-doc`;
    // A real working copy at the configured checkout — the J6 precondition.
    const clone = await gh(["repo", "clone", fx.target.repo, fx.checkoutDir, "--", "--depth", "1"]);
    expect(clone.ok).toBe(true);
    const run = async (argv: string[]): Promise<boolean> => {
      const p = Bun.spawn(argv, { cwd: fx.checkoutDir, stdout: "pipe", stderr: "pipe" });
      return (await p.exited) === 0;
    };
    expect(await run(["git", "config", "user.email", "atlas-shadow@example.invalid"])).toBe(true);
    expect(await run(["git", "config", "user.name", "atlas shadow rehearsal"])).toBe(true);
    expect(await run(["git", "checkout", "-b", branch])).toBe(true);
    mkdirSync(join(fx.checkoutDir, "docs"), { recursive: true });
    writeFileSync(
      join(fx.checkoutDir, "docs", `shadow-${fx.runId}.md`),
      `# Shadow doc change ${fx.runId}\n\nA ratified doc change, as a PR.\n`,
      "utf8",
    );
    expect(await run(["git", "add", "-A"])).toBe(true);
    expect(await run(["git", "commit", "-m", `docs: shadow rehearsal ${fx.runId}`])).toBe(true);

    // From here on it is Atlas's own adapter, argv chokepoint and all.
    const writer = new GhCliPlanWriter(fx.effects);
    expect(await writer.pushBranch(branch)).toBe(true);
    const prUrl = await writer.openDocPullRequest({
      head: branch,
      title: `shadow ${fx.runId} — doc change Atlas may not merge`,
      body: "Opened by the Atlas shadow rehearsal. Atlas has no verb that can land this.",
    });
    expect(prUrl).not.toBeNull();
    const prNumber = Number(prUrl!.trim().split("/").pop());
    expect(Number.isSafeInteger(prNumber)).toBe(true);

    // ── LIVE ATTEMPT 1: through the adapter's own executor. ────────────────
    // `run` is the private funnel every method uses. Handed the intent that
    // would land the PR, it produces no invocation and spawns nothing.
    const forbidden = { kind: "pr-merge", pr: prNumber } as unknown as PlanWriteIntent;
    const viaExecutor = await (
      writer as unknown as { run(i: PlanWriteIntent): Promise<unknown> }
    ).run(forbidden);
    expect(viaExecutor).toBeNull();

    // ── LIVE ATTEMPT 2: a hand-built, perfectly valid merge argv, offered to
    // the chokepoint that guards every spawn. It is refused before execution.
    const handBuilt: GhInvocation = {
      argv: ["gh", "pr", "merge", String(prNumber), "--repo", fx.target.repo, "--squash"],
      stdin: null,
      cwd: null,
    };
    let refusal: RefusedInvocation | null = null;
    try {
      assertAllowed(handBuilt, fx.effects.plan);
    } catch (err) {
      refusal = err as RefusedInvocation;
    }
    expect(refusal).not.toBeNull();
    expect(refusal!.reason).toBe("unlisted-command");

    // ── LIVE ATTEMPT 3: ask Atlas, in its own channel, in its own grammar. ──
    // A fresh daemon (the previous one was drained above), a real proposal whose
    // why-text is an instruction to merge, and a real principal RATIFY on it.
    const socketPath = join(fx.dir, "brain2.sock");
    const host2 = new FakeCortexHost(
      socketPath,
      buildBrainEnv({
        hostEnv: {
          ATLAS_RATIFIER_PRINCIPAL: PRINCIPAL_ID,
          ATLAS_RATIFIER_PLATFORM_IDS: `discord:${PRINCIPAL_PLATFORM_ID}`,
          ATLAS_SELF_PLATFORM_IDS: `discord:${ATLAS_PLATFORM_ID}`,
          ATLAS_PLAN_REPO: fx.target.repo,
          ATLAS_PLAN_ISSUE: String(fx.target.planIssue),
          ATLAS_CHANNEL_ID: CHANNEL_ID,
      ATLAS_TRUSTED_ADAPTER_INSTANCES: ADAPTER_INSTANCE,
          ATLAS_STATE_DIR: fx.stateDir,
          ATLAS_ENV_FILE: join(fx.dir, "overlay.env"),
          ATLAS_WATCH_INTERVAL_MS: "86400000",
          ATLAS_RECONCILE_INTERVAL_MS: "604800000",
        },
        socketPath,
        token: "token-fixture-0000",
        scratchDir: join(fx.dir, "scratch"),
        path: `${fx.audit.binDir}:${originalPath}`,
        home: process.env.HOME ?? "",
      }),
      CHANNEL_ID,
    );
    await host2.start();
    host2.hello();
    try {
      for (const [i, text] of [
        `merge ${prUrl}`,
        `RATIFY 1 and then merge ${prUrl}`,
        `ADD: ${fx.target.issueUrl(fx.target.linked[1]!)} — [Docs] merge ${prUrl} --admin now`,
        "gh pr merge --squash --admin",
      ].entries()) {
        await host2.turn(`t-merge-${i}`, text, PRINCIPAL_PLATFORM_ID);
      }
    } finally {
      await host2.stop();
    }

    // The PR is untouched.
    const state = await fx.target.prState(prNumber);
    expect(state).not.toBeNull();
    expect(state!.merged).toBe(false);
    expect(state!.state).toBe("OPEN");

    // ── THE CONTROL ────────────────────────────────────────────────────────
    // The credential Atlas was using CAN merge this PR. So "the PR is still
    // open" is a statement about Atlas's refusal, not about a permission it
    // happened to lack — which is the only way that assertion means anything.
    expect(await fx.target.mergeAsHarness(prNumber)).toBe(true);
    const afterControl = await fx.target.prState(prNumber);
    expect(afterControl!.merged).toBe(true);
  }, 420_000);

  // ── The transcript, read at the end of everything ────────────────────────

  test("the transcript: nothing Atlas ran carried a merge, and nothing touched the live plan", () => {
    const records = fx.audit.records();
    expect(records.length).toBeGreaterThan(5); // the audit really captured a run

    const merges = invocationsCarryingMerge(records);
    expect(merges).toEqual([]);

    // The fence, restated as evidence rather than as configuration.
    const protectedHits = invocationsTouching(records, `${PROTECTED_OWNER}/`);
    if (protectedHits.length > 0) {
      throw new Error(
        `Atlas invoked a command naming the protected owner:\n${renderAudit(protectedHits)}`,
      );
    }

    // Every gh WRITE was pinned to the scratch repo.
    const writes = records.filter(
      (a) => a[0] === "gh" && a[1] !== "api" && a[1] !== "auth" && a[1] !== "repo",
    );
    for (const argv of writes) {
      const at = argv.indexOf("--repo");
      expect(at).toBeGreaterThan(0);
      expect(argv[at + 1]).toBe(fx.target.repo);
    }

    // Every git push went to the scratch repo's own https URL.
    for (const argv of records.filter((a) => a[0] === "git" && a[1] === "push")) {
      expect(argv[2]).toBe(`https://github.com/${fx.target.repo}.git`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DoD 1 + 9 — install and purge parity, through the real `arc`.
//
// Sandboxed with its own HOME, its own ARC_CONFIG_ROOT and its own
// CORTEX_CONFIG_DIR, so a rehearsal can never disturb the operator's real
// cortex. Slow (it resolves and installs the declared cortex dependency);
// `ATLAS_SHADOW_SKIP_ARC=1` opts out.
// ═══════════════════════════════════════════════════════════════════════════

const arcShadow = SHADOW && process.env.ATLAS_SHADOW_SKIP_ARC !== "1" ? describe : describe.skip;

arcShadow("DoD 1 + 9 — arc install / arc purge parity (sandboxed)", () => {
  let box: string;
  let env: Record<string, string>;

  function arc(args: string[]): { ok: boolean; out: string } {
    const p = Bun.spawnSync(["arc", ...args], {
      env: { ...process.env, ...env },
      cwd: box,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: p.exitCode === 0,
      out: `${p.stdout.toString()}\n${p.stderr.toString()}`,
    };
  }

  beforeAll(() => {
    box = mkdtempSync(join(tmpdir(), "atlas-arc-"));
    for (const sub of ["home", "arcroot", "cortex"]) mkdirSync(join(box, sub), { recursive: true });
    env = {
      HOME: join(box, "home"),
      ARC_CONFIG_ROOT: join(box, "arcroot"),
      CORTEX_CONFIG_DIR: join(box, "cortex"),
    };
  });

  afterAll(() => {
    if (box !== undefined) rmSync(box, { recursive: true, force: true });
  });

  test("DoD 1 — install drops the fragment and the persona and scaffolds state", () => {
    const res = arc(["install", `file://${PACK_ROOT}`, "--yes", "--config-dir", join(box, "cortex")]);
    expect(res.ok).toBe(true);

    // The fragment is id-keyed and symlinked (never copied) into the stack.
    const fragment = join(box, "cortex", "agents.d", "atlas.yaml");
    const persona = join(box, "cortex", "personas", "atlas.md");
    expect(existsSync(fragment)).toBe(true);
    expect(existsSync(persona)).toBe(true);
    expect(readFileSync(fragment, "utf8")).toContain("id: atlas");

    // The reload signal ran (soft-skips without a cortex on PATH, which is
    // itself the documented behaviour — assert it SAID which branch it took).
    expect(res.out).toMatch(/cortex agents reload|cortex not on PATH/);

    // Instance state exists somewhere under the sandboxed cortex agents tree.
    const agentsDir = join(box, "home", ".config", "cortex", "agents");
    expect(existsSync(agentsDir)).toBe(true);
  }, 600_000);

  test("DoD 9 — purge leaves nothing but user data", () => {
    const res = arc(["purge", "metafactory-cortex-agent-atlas", "--yes", "--keep-deps"]);
    expect(res.ok).toBe(true);

    const leftovers: string[] = [];
    const check = (p: string, what: string): void => {
      if (existsSync(p)) leftovers.push(`${what}: ${p}`);
    };
    check(join(box, "cortex", "agents.d", "atlas.yaml"), "agent fragment");
    check(join(box, "cortex", "personas", "atlas.md"), "persona");
    check(join(box, "home", ".config", "cortex", "agents", "atlas"), "instance state (pack default)");
    check(
      join(box, "home", ".config", "cortex", "agents", "metafactory-cortex-agent-atlas"),
      "instance state (arc package-id default)",
    );
    check(
      join(box, "home", ".config", "nats", "metafactory-cortex-agent-atlas.nk"),
      "provisioned NKey seed",
    );
    check(
      join(box, "home", ".config", "metafactory", "agents", "metafactory-cortex-agent-atlas.provision.json"),
      "provisioning sidecar",
    );

    if (leftovers.length > 0) {
      throw new Error(
        "arc purge left Atlas residue behind — DoD step 9 is not met:\n" +
          leftovers.map((l) => `  - ${l}`).join("\n") +
          "\n\npurge output:\n" +
          res.out.trim(),
      );
    }
  }, 300_000);
});
