/**
 * The reconcile loop's suite (W3a, issue #2, J5).
 *
 * Everything runs against a REAL SQLite store and, wherever a work item has to
 * reach `applied`, through the REAL `applyRatified` with a REAL ratification
 * obtained from the REAL gate. There is no fixture that parks an item by
 * writing a row by hand: "the parked population is what a failed atomic pair
 * actually leaves behind" is the property under test, and a shortcut fixture
 * would let this suite pass against a park shape apply.ts never produces.
 *
 * The channel fake mirrors the SAME transport the ledger posts through, so
 * "the post exists" and "the post is in the channel" cannot disagree except by
 * an explicit `delete()` — which is the kill test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRatified } from "./apply";
import { DiscordLedger, messageRecordsPlanChange } from "./effects/discord";
import { makeEffectsConfig, type EffectsConfig } from "./effects/config";
import { GhCliPlanWriter } from "./effects/gh";
import type { LinkedIssueState } from "./gh";
import {
  identityConfigFromPorts,
  StaticPrincipalMap,
  StaticSelfIdentity,
  type RatifyIdentityConfig,
} from "./identity";
import { planBodyRevision } from "./plan-revision";
import type { RatificationCertificate } from "./ratification";
import { processGateMessage, type GateMessage } from "./ratify";
import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  reconcilePlan,
  resolveReconcileIntervalMs,
  type ReconcileDeps,
} from "./reconcile";
import { AtlasProposals, AtlasStateStore } from "./state";
import {
  FakeLedgerChannel,
  FakeLinkedIssues,
  FakePlanRepo,
  RecordingTransport,
} from "./test-support";
import { pollCompletions } from "./watch";

// ── Fixtures (placeholder ids only — this repo is public) ───────────────────

const PLATFORM = "discord";
const PRINCIPAL_ID = "plan-steward";
const PRINCIPAL_PLATFORM_ID = "pid-principal-fixture";
const ATLAS_PLATFORM_ID = "pid-atlas-self-fixture";
const CHANNEL_ID = "chan-fixture-0000";
const PLAN_REPO = "acme/widgets";
const PLAN_URL = "https://github.com/acme/widgets/issues/4";

const ISSUE_1 = "https://github.com/acme/widgets/issues/1";
const ISSUE_2 = "https://github.com/acme/widgets/issues/2";
const NEW_URL = "https://github.com/acme/widgets/issues/12";

const PLAN_BODY = [
  "# Iteration 1",
  "",
  "## Backend",
  "",
  `- [ ] ${ISSUE_1}`,
  `- [ ] ${ISSUE_2}`,
  "",
  "## Frontend",
  "",
  "- [ ] https://github.com/acme/widgets/issues/7",
  "",
].join("\n");

/** A fixed "now" so nothing in this suite depends on the wall clock. */
const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);

function closed(title: string, closedAt: string): LinkedIssueState {
  return { closed: true, title, closedAt, referencingPrUrl: null };
}
const OPEN: LinkedIssueState = {
  closed: false,
  title: "still going",
  closedAt: null,
  referencingPrUrl: null,
};

let dir: string;
let store: AtlasStateStore;
let state: AtlasProposals;
let identity: RatifyIdentityConfig;
let effects: EffectsConfig;
let repo: FakePlanRepo;
let transport: RecordingTransport;
let plan: GhCliPlanWriter;
let ledger: DiscordLedger;
let gh: FakeLinkedIssues;
let channel: FakeLedgerChannel;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-reconcile-test-"));
  const opened = AtlasStateStore.open({ dir, bundleDir: null });
  if (opened === null) throw new Error("fixture: expected the store to open");
  store = opened;
  state = new AtlasProposals(store);
  const cfg = identityConfigFromPorts({
    ratifierPrincipalId: PRINCIPAL_ID,
    principals: new StaticPrincipalMap([
      { actor: { platform: PLATFORM, id: PRINCIPAL_PLATFORM_ID }, principalId: PRINCIPAL_ID },
    ]),
    self: new StaticSelfIdentity([{ platform: PLATFORM, id: ATLAS_PLATFORM_ID }]),
  });
  if (cfg === null) throw new Error("fixture: expected an identity config");
  identity = cfg;
  const loaded = makeEffectsConfig({
    planRepo: PLAN_REPO,
    planIssue: 4,
    channelId: CHANNEL_ID,
    adapterInstances: "adapter-fixture",
  });
  if (loaded.kind !== "ok") throw new Error("fixture: effects config refused");
  effects = loaded.config;
  repo = new FakePlanRepo(PLAN_BODY);
  transport = new RecordingTransport();
  plan = new GhCliPlanWriter(effects, repo.spawn);
  ledger = new DiscordLedger(effects, transport);
  gh = new FakeLinkedIssues();
  channel = new FakeLedgerChannel(transport);
  gh.set(ISSUE_1, OPEN);
  gh.set(ISSUE_2, OPEN);
  gh.set("https://github.com/acme/widgets/issues/7", OPEN);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Deps with NO channel reader — Atlas's own event log as the only index. */
function deps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return { state, plan, gh, ledger, effects, ...overrides };
}

/** Deps WITH the channel cross-check wired. */
function depsWithChannel(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return deps({ channel, ...overrides });
}

function msg(body: string): GateMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    body,
    authorPlatform: PLATFORM,
    authorId: PRINCIPAL_PLATFORM_ID,
  };
}

/** surfaced → ratified, through the real gate. The only route to a certificate. */
function ratifyNew(id: string, url = NEW_URL): RatificationCertificate {
  state.createIntake(id, "ADD", url, "Backend", "it blocks the release", "octocat");
  state.markValidated(id, true);
  const displayId = state.markSurfaced(id);
  if (displayId === null) throw new Error("fixture: expected a display id");
  const outcome = processGateMessage(msg(`RATIFY ${displayId}`), identity, state);
  if (outcome.kind !== "ratified") throw new Error(`fixture: expected ratified, got ${outcome.kind}`);
  return outcome.certificate;
}

/**
 * Park an item in `applied` the way the world does it: the plan body edit
 * lands and the ledger post does not.
 */
async function parkUnposted(id: string, url = NEW_URL): Promise<void> {
  const cert = ratifyNew(id, url);
  transport.failFirst = Number.POSITIVE_INFINITY;
  const outcome = await applyRatified(cert, { state, identity, effects, gh: plan, ledger });
  transport.failFirst = 0;
  if (outcome.kind !== "applied-not-posted" || outcome.postLanded) {
    throw new Error(`fixture: expected a postLanded:false park, got ${JSON.stringify(outcome.kind)}`);
  }
}

/**
 * Park an item in `applied` the OTHER way: the ledger post LANDS and its
 * receipt does not record. `apply.ts` writes the durable marker on this branch.
 */
async function parkPostLanded(id: string, url = NEW_URL): Promise<void> {
  class ReceiptRefusingState extends AtlasProposals {
    override markPosted(): boolean {
      return false;
    }
  }
  const cert = ratifyNew(id, url);
  const refusing = new ReceiptRefusingState(store);
  const outcome = await applyRatified(cert, {
    state: refusing,
    identity,
    effects,
    gh: plan,
    ledger,
  });
  if (outcome.kind !== "applied-not-posted" || !outcome.postLanded) {
    throw new Error(`fixture: expected a postLanded:true park, got ${outcome.kind}`);
  }
}

// ── ACCEPTANCE: the kill test ──────────────────────────────────────────────

describe("KILL TEST — a parked `applied` item is caught up exactly once", () => {
  test("one labelled catch-up covering it, then a SECOND reconcile is silent", async () => {
    await parkUnposted("c1");
    expect(state.get("c1")?.phase).toBe("applied");
    expect(transport.posts).toHaveLength(0);

    const first = await reconcilePlan(deps(), NOW);
    if (first.kind !== "caught-up") throw new Error(`expected caught-up, got ${first.kind}`);

    // EXACTLY ONE post, and it is the labelled catch-up.
    expect(transport.posts).toHaveLength(1);
    const content = transport.posts[0]!.content;
    expect(content.startsWith("✅ Catch-up — since ")).toBe(true);
    expect(content).toContain(PLAN_URL); // the mandatory map link
    expect(content).toContain("— Atlas · plan steward");
    // It itemises the missed event, naming the proposal and the URL.
    expect(content).toContain("ledger entry missing for proposal #1");
    expect(content).toContain(NEW_URL);
    expect(content.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(1);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.kind).toBe("applied-unposted");
    expect(first.deferred).toBe(0);

    // CONVERGENCE: a second pass over an unchanged world says NOTHING.
    const second = await reconcilePlan(deps(), NOW + 1);
    expect(second.kind).toBe("clean");
    expect(transport.posts).toHaveLength(1);

    // And a third, for good measure — convergence is stable, not a one-off.
    const third = await reconcilePlan(deps(), NOW + 2);
    expect(third.kind).toBe("clean");
    expect(transport.posts).toHaveLength(1);
  });

  test("the kill test also holds with the channel cross-check wired", async () => {
    await parkUnposted("c1");
    channel.sync(NOW - 60_000);

    const first = await reconcilePlan(depsWithChannel(), NOW);
    expect(first.kind).toBe("caught-up");
    expect(transport.posts).toHaveLength(1);

    channel.sync(NOW);
    const second = await reconcilePlan(depsWithChannel(), NOW + 1);
    expect(second.kind).toBe("clean");
    expect(transport.posts).toHaveLength(1);
  });

  test("TWO parked items produce ONE post carrying both, not two posts", async () => {
    await parkUnposted("c1", NEW_URL);
    await parkUnposted("c2", "https://github.com/acme/widgets/issues/13");

    const outcome = await reconcilePlan(deps(), NOW);
    if (outcome.kind !== "caught-up") throw new Error(`expected caught-up, got ${outcome.kind}`);
    expect(transport.posts).toHaveLength(1);
    expect(outcome.items).toHaveLength(2);
    expect(transport.posts[0]!.content.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(2);

    expect((await reconcilePlan(deps(), NOW + 1)).kind).toBe("clean");
    expect(transport.posts).toHaveLength(1);
  });
});

// ── ACCEPTANCE: the silence rule ───────────────────────────────────────────

describe("SILENCE — a pass with no drift posts NOTHING", () => {
  test("a clean world produces no post at all, on the first pass and every one after", async () => {
    const first = await reconcilePlan(deps(), NOW);
    expect(first.kind).toBe("clean");
    expect(transport.posts).toHaveLength(0);

    const second = await reconcilePlan(deps(), NOW + 1);
    expect(second.kind).toBe("clean");
    expect(transport.posts).toHaveLength(0);
  });

  test("a fully-healthy loop (apply → post → reconcile) stays silent", async () => {
    const cert = ratifyNew("c1");
    const applied = await applyRatified(cert, { state, identity, effects, gh: plan, ledger });
    expect(applied.kind).toBe("posted");
    expect(transport.posts).toHaveLength(1); // the ➕, not a catch-up

    const outcome = await reconcilePlan(deps(), NOW);
    expect(outcome.kind).toBe("clean");
    expect(transport.posts).toHaveLength(1); // still just the ➕
  });

  test("silence is about the CHANNEL — a clean pass still records the drift metric", async () => {
    expect(state.hasReconciled()).toBe(false);
    await reconcilePlan(deps(), NOW);
    expect(state.hasReconciled()).toBe(true);
    // Zero recorded, so a retro can show the health metric trending to zero.
    expect(state.sumReconcileDrift(0, NOW * 2)).toBe(0);
    expect(state.countCatchUpPosts(0, NOW * 2)).toBe(0);
  });
});

// ── ACCEPTANCE: never double-post ──────────────────────────────────────────

describe("NEVER DOUBLE-POST — the postLanded:true parked shape", () => {
  test("a post that landed but did not record is NOT itemised in a catch-up", async () => {
    await parkPostLanded("c1");
    // The ➕ really did go out — this is the shape a naive reconcile duplicates.
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]!.content.startsWith("➕")).toBe(true);
    expect(state.get("c1")?.phase).toBe("applied");
    // And the durable marker is what makes the two parked shapes tellable apart.
    expect(state.hasLedgerPostUnrecorded("c1")).toBe(true);

    const outcome = await reconcilePlan(deps(), NOW);
    expect(outcome.kind).toBe("clean");
    expect(outcome.kind === "clean" && outcome.suppressed).toBe(1);
    // NO second post. The ledger still has exactly the one ➕ it always had.
    expect(transport.posts).toHaveLength(1);
  });

  test("without the marker, the channel cross-check alone still suppresses it", async () => {
    await parkPostLanded("c1");
    channel.sync(NOW - 60_000);
    // Simulate the residual window the marker covers: a crash between the post
    // landing and the marker committing. The channel is the second line of
    // defence for exactly this case.
    const noMarker = new (class extends AtlasProposals {
      override hasLedgerPostUnrecorded(): boolean {
        return false;
      }
    })(store);

    const outcome = await reconcilePlan(depsWithChannel({ state: noMarker }), NOW);
    expect(outcome.kind).toBe("clean");
    expect(outcome.kind === "clean" && outcome.suppressed).toBe(1);
    expect(transport.posts).toHaveLength(1);
  });

  test("the channel cross-check is SUBTRACTIVE — an unreadable channel adds no drift", async () => {
    channel.failReads = true;
    const outcome = await reconcilePlan(depsWithChannel(), NOW);
    expect(outcome.kind).toBe("clean");
    expect(transport.posts).toHaveLength(0);
  });

  test("a ➕ post already in the channel suppresses the item even with no marker", async () => {
    await parkUnposted("c1"); // never posted, so no marker exists
    expect(state.hasLedgerPostUnrecorded("c1")).toBe(false);
    // But the channel says a ➕ for proposal #1 IS there. Fail toward silence.
    channel.add({
      id: "msg-fixture-external",
      content: `➕ Plan body changed — #1: added ${NEW_URL} under "Backend"`,
      createdAt: NOW - 60_000,
    });

    const outcome = await reconcilePlan(depsWithChannel(), NOW);
    expect(outcome.kind).toBe("clean");
    expect(outcome.kind === "clean" && outcome.suppressed).toBe(1);
    expect(transport.posts).toHaveLength(0);
  });
});

describe("messageRecordsPlanChange is anchored — untrusted text cannot forge it", () => {
  test("a real ➕ post matches", () => {
    expect(
      messageRecordsPlanChange(`➕ Plan body changed — #3: added ${NEW_URL} under "Backend"`, 3, NEW_URL),
    ).toBe(true);
    expect(
      messageRecordsPlanChange(`➖ Plan body changed — #3: removed ${NEW_URL}`, 3, NEW_URL),
    ).toBe(true);
  });

  test("the SAME text quoted inside a ✅ post does NOT match", () => {
    // An attacker who titles a GitHub issue with the marker gets it quoted into
    // the middle of a ✅ digest. Anchoring at position 0 is what stops that
    // suppressing a real catch-up line.
    const forged = `✅ acme/widgets#9 — "➕ Plan body changed — #3: added ${NEW_URL}" · verified`;
    expect(messageRecordsPlanChange(forged, 3, NEW_URL)).toBe(false);
  });

  test("a different display id or a different url does not match", () => {
    const post = `➕ Plan body changed — #3: added ${NEW_URL}`;
    expect(messageRecordsPlanChange(post, 4, NEW_URL)).toBe(false);
    expect(messageRecordsPlanChange(post, 3, ISSUE_1)).toBe(false);
    expect(messageRecordsPlanChange(post, 0, NEW_URL)).toBe(false);
  });
});

// ── Detector (a): completions ──────────────────────────────────────────────

describe("a deleted ✅ is caught up once, then never again", () => {
  /** Get one ✅ into the channel and into Atlas's record, the normal way. */
  async function announceOne(): Promise<string> {
    gh.set(ISSUE_1, closed("intake landed", "2026-07-25T08:00:00Z"));
    const outcome = await pollCompletions({ state, plan, gh, ledger }, NOW - 3_600_000);
    if (outcome.kind !== "polled" || outcome.flush.kind !== "posted") {
      throw new Error("fixture: expected a ✅ to go out");
    }
    channel.sync(NOW - 3_600_000);
    return outcome.flush.receipt.messageId;
  }

  test("deleting the post produces ONE catch-up; a second pass is silent", async () => {
    const messageId = await announceOne();
    expect(transport.posts).toHaveLength(1);

    // Nothing is wrong yet.
    expect((await reconcilePlan(depsWithChannel(), NOW)).kind).toBe("clean");
    expect(transport.posts).toHaveLength(1);

    // A human deletes the ✅. Atlas's durable record is untouched.
    expect(channel.delete(messageId)).toBe(true);
    expect(state.hasAnnouncedCompletion(ISSUE_1)).toBe(true);

    const caught = await reconcilePlan(depsWithChannel(), NOW + 1);
    if (caught.kind !== "caught-up") throw new Error(`expected caught-up, got ${caught.kind}`);
    expect(transport.posts).toHaveLength(2);
    expect(caught.items).toHaveLength(1);
    expect(caught.items[0]!.kind).toBe("completion-missing");
    expect(transport.posts[1]!.content.startsWith("✅ Catch-up — since ")).toBe(true);
    expect(transport.posts[1]!.content).toContain(ISSUE_1);

    // Converges even though the post is still gone.
    channel.sync(NOW + 1);
    const second = await reconcilePlan(depsWithChannel(), NOW + 2);
    expect(second.kind).toBe("clean");
    expect(transport.posts).toHaveLength(2);
  });

  test("with NO channel reader the deleted-✅ detector cannot fire at all", async () => {
    const messageId = await announceOne();
    channel.delete(messageId);
    // Atlas has no way to know, and inventing drift from a read it did not make
    // is the failure this loop is built to avoid.
    expect((await reconcilePlan(deps(), NOW)).kind).toBe("clean");
    expect(transport.posts).toHaveLength(1);
  });
});

describe("a closure whose ✅ never went out", () => {
  test("is caught up, and the catch-up IS its ledger entry — the watcher does not re-post", async () => {
    // An anchor: one ✅ landed for ISSUE_2 AFTER ISSUE_1 closed. That is what
    // proves the watcher had its chance at ISSUE_1 and missed it.
    gh.set(ISSUE_2, closed("second", "2026-07-20T08:00:00Z"));
    await pollCompletions({ state, plan, gh, ledger }, NOW - 3_600_000);
    expect(transport.posts).toHaveLength(1);
    gh.set(ISSUE_1, closed("first", "2026-07-21T08:00:00Z"));

    const caught = await reconcilePlan(deps(), NOW);
    if (caught.kind !== "caught-up") throw new Error(`expected caught-up, got ${caught.kind}`);
    expect(caught.items.map((i) => i.kind)).toEqual(["completion-unposted"]);
    expect(transport.posts).toHaveLength(2);
    expect(transport.posts[1]!.content).toContain(ISSUE_1);
    expect(transport.posts[1]!.content).toContain('"first"');

    // The catch-up line is the ledger entry for this closure, so the WATCHER
    // must not post a second ✅ for it on its next pass.
    expect(state.hasAnnouncedCompletion(ISSUE_1)).toBe(true);
    const poll = await pollCompletions({ state, plan, gh, ledger }, NOW + 86_400_000);
    expect(poll.kind === "polled" && poll.enqueued).toBe(0);
    expect(transport.posts).toHaveLength(2);

    // And reconcile converges.
    expect((await reconcilePlan(deps(), NOW + 1)).kind).toBe("clean");
    expect(transport.posts).toHaveLength(2);
  });

  test("a closure the watcher has simply not reached yet is NOT drift", async () => {
    // No ledger entry has ever landed, so there is no anchor and no claim.
    gh.set(ISSUE_1, closed("just closed", "2026-07-26T11:00:00Z"));
    const outcome = await reconcilePlan(deps(), NOW);
    expect(outcome.kind).toBe("clean");
    expect(transport.posts).toHaveLength(0);
  });

  test("a closure NEWER than the last ledger entry is not drift either", async () => {
    gh.set(ISSUE_2, closed("second", "2026-07-20T08:00:00Z"));
    await pollCompletions({ state, plan, gh, ledger }, NOW - 3_600_000);
    // ISSUE_1 closed AFTER that ✅ went out — the watcher's next pass owns it.
    gh.set(ISSUE_1, closed("first", "2026-07-27T08:00:00Z"));
    const outcome = await reconcilePlan(deps(), NOW);
    expect(outcome.kind).toBe("clean");
    expect(transport.posts).toHaveLength(1);
  });

  test("a failed linked-issue read is never reported as a missed closure", async () => {
    gh.set(ISSUE_2, closed("second", "2026-07-20T08:00:00Z"));
    await pollCompletions({ state, plan, gh, ledger }, NOW - 3_600_000);
    gh.set(ISSUE_1, null); // read failure
    const outcome = await reconcilePlan(deps(), NOW);
    expect(outcome.kind).toBe("clean");
    expect(transport.posts).toHaveLength(1);
  });
});

// ── Detector (c): plan-body revisions ──────────────────────────────────────

describe("a plan-body revision with no matching ➕/➖ event", () => {
  test("the FIRST pass establishes the baseline instead of reporting on it", async () => {
    const outcome = await reconcilePlan(deps(), NOW);
    expect(outcome.kind).toBe("clean");
    expect(transport.posts).toHaveLength(0);
    // atlas#26: the revision is a hash of the BODY, not GitHub's `updatedAt`.
    expect(outcome.kind === "clean" && outcome.revision).toBe(planBodyRevision(repo.body));
  });

  test("an edit Atlas did not make IS drift on a later pass, and converges", async () => {
    await reconcilePlan(deps(), NOW); // baseline
    // A human edits the plan body directly.
    repo.body = `${PLAN_BODY}\n- [ ] https://github.com/acme/widgets/issues/99\n`;
    repo.revisedAt = "2026-07-26T13:00:00Z";

    const caught = await reconcilePlan(deps(), NOW + 1);
    if (caught.kind !== "caught-up") throw new Error(`expected caught-up, got ${caught.kind}`);
    expect(caught.items.map((i) => i.kind)).toEqual(["plan-revised"]);
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]!.content).toContain("revised outside Atlas");
    expect(transport.posts[0]!.content).toContain(planBodyRevision(repo.body));

    expect((await reconcilePlan(deps(), NOW + 2)).kind).toBe("clean");
    expect(transport.posts).toHaveLength(1);
  });

  test("a revision ATLAS produced is accounted for and never reported", async () => {
    await reconcilePlan(deps(), NOW); // baseline
    const cert = ratifyNew("c1");
    const applied = await applyRatified(cert, { state, identity, effects, gh: plan, ledger });
    expect(applied.kind).toBe("posted");
    expect(repo.revisedAt).not.toBe("2026-07-26T00:00:00Z"); // the body really moved

    const outcome = await reconcilePlan(deps(), NOW + 1);
    expect(outcome.kind).toBe("clean");
    expect(transport.posts).toHaveLength(1); // just the ➕
  });

  // ── atlas#26: the whole point ─────────────────────────────────────────────

  test("a comment on the plan issue produces NO drift — this FAILS against the old `updatedAt` identity", async () => {
    await reconcilePlan(deps(), NOW); // baseline
    // Simulate ordinary activity on a public, comment-friendly plan issue: a
    // comment lands (or a cross-reference from another issue/PR arrives) and
    // GitHub bumps `updatedAt` — WITHOUT touching the body at all. The old
    // fake (`brain/test-support.ts`) could not represent this; it bumped
    // `revisedAt` only inside the write path, which is precisely the property
    // real GitHub does not have.
    repo.touchWithoutBodyChange();
    repo.touchWithoutBodyChange();
    repo.touchWithoutBodyChange();

    const outcome = await reconcilePlan(deps(), NOW + 1);
    expect(outcome.kind).toBe("clean");
    expect(transport.posts).toHaveLength(0);
  });

  test("a cross-reference from another issue/PR produces NO drift either", async () => {
    await reconcilePlan(deps(), NOW); // baseline
    // Same GitHub behaviour, different source event: a PR that references
    // the plan issue bumps its `updatedAt` too.
    repo.touchWithoutBodyChange();

    const outcome = await reconcilePlan(deps(), NOW + 1);
    expect(outcome.kind).toBe("clean");
    expect(transport.posts).toHaveLength(0);
  });

  test("a genuine out-of-band body edit is STILL detected after comments have bumped updatedAt", async () => {
    await reconcilePlan(deps(), NOW); // baseline
    // Noise first — comments/cross-references that must NOT register.
    repo.touchWithoutBodyChange();
    repo.touchWithoutBodyChange();
    expect((await reconcilePlan(deps(), NOW + 1)).kind).toBe("clean");

    // Then a REAL out-of-band edit — this must still be caught; the fix must
    // not neuter the detector.
    repo.body = `${PLAN_BODY}\n- [ ] https://github.com/acme/widgets/issues/99\n`;
    repo.touchWithoutBodyChange();
    const caught = await reconcilePlan(deps(), NOW + 2);
    if (caught.kind !== "caught-up") throw new Error(`expected caught-up, got ${caught.kind}`);
    expect(caught.items.map((i) => i.kind)).toEqual(["plan-revised"]);
  });

  // ── atlas#26: the migration ────────────────────────────────────────────────

  describe("re-baselining across the identity change (legacy `updatedAt` history)", () => {
    /** Seed reconcile history the way it looked BEFORE atlas#26: an ISO timestamp. */
    function seedLegacyHistory(revision = "2026-07-20T00:00:00Z"): void {
      state.recordReconcilePass(0, revision, null, null);
    }

    test("a pass whose ENTIRE history is legacy timestamps re-baselines instead of reporting drift", async () => {
      seedLegacyHistory();
      expect(state.hasReconciled()).toBe(true); // not the very-first-pass case

      // The body has not changed since the legacy history was recorded — but
      // its (new-scheme) hash cannot possibly match the old timestamp. A naive
      // switch would report this as drift on every plan ever reconciled
      // before the fix; the migration path must not.
      const outcome = await reconcilePlan(deps(), NOW);
      expect(outcome.kind).toBe("clean");
      expect(transport.posts).toHaveLength(0);
    });

    test("the pass immediately after re-baselining establishes the hash going forward", async () => {
      seedLegacyHistory();
      const first = await reconcilePlan(deps(), NOW);
      expect(first.kind).toBe("clean");

      // A comment lands — `updatedAt` moves, the body does not — between the
      // re-baselining pass and the next one.
      repo.touchWithoutBodyChange();

      // No further change to the body: the SECOND pass must also stay clean,
      // because the first pass wrote the hash down as the new baseline.
      const second = await reconcilePlan(deps(), NOW + 1);
      expect(second.kind).toBe("clean");
      expect(transport.posts).toHaveLength(0);
    });

    test("a genuine edit is still detected once the migration has re-baselined", async () => {
      seedLegacyHistory();
      // The re-baselining pass itself must be silent about the legacy/hash
      // mismatch — that is the property under test here, not an aside.
      const baseline = await reconcilePlan(deps(), NOW);
      expect(baseline.kind).toBe("clean");

      repo.body = `${PLAN_BODY}\n- [ ] https://github.com/acme/widgets/issues/99\n`;
      repo.touchWithoutBodyChange();
      const caught = await reconcilePlan(deps(), NOW + 1);
      if (caught.kind !== "caught-up") throw new Error(`expected caught-up, got ${caught.kind}`);
      expect(caught.items.map((i) => i.kind)).toEqual(["plan-revised"]);
    });

    test("a mix of legacy AND at-least-one hashed revision is treated as migration already done", async () => {
      seedLegacyHistory("2026-07-20T00:00:00Z");
      // A hashed revision has already been recorded once (say, by an earlier
      // deploy of the fix) — migration is over, real detection applies.
      state.recordReconcilePass(0, planBodyRevision(repo.body), null, null);

      // A comment lands with NO body change — this must stay clean even
      // though legacy noise is still present in history. Under the OLD
      // `updatedAt` identity this would ALSO be reported as drift, because
      // the naive scheme never distinguished "body changed" from "issue
      // touched" in the first place.
      repo.touchWithoutBodyChange();
      const quiet = await reconcilePlan(deps(), NOW);
      expect(quiet.kind).toBe("clean");
      expect(transport.posts).toHaveLength(0);

      // The body changes out-of-band without Atlas's involvement.
      repo.body = `${PLAN_BODY}\n- [ ] https://github.com/acme/widgets/issues/99\n`;
      repo.touchWithoutBodyChange();
      const caught = await reconcilePlan(deps(), NOW + 1);
      if (caught.kind !== "caught-up") throw new Error(`expected caught-up, got ${caught.kind}`);
      expect(caught.items.map((i) => i.kind)).toEqual(["plan-revised"]);
    });
  });
});

// ── atlas#34: GitHub itself ticks a plan checkbox on issue closure ─────────
//
// See `plan-revision.ts`'s header for the decision this suite verifies:
// (c) with (b) as the fallback classification, plus the ordering/race note
// on why an uncorroborated tick is deferred once rather than reported
// immediately.

describe("a GitHub-authored checkbox tick (atlas#34)", () => {
  /** Simulate GitHub ticking the plan's checkbox for `url` — Atlas never does. */
  function tick(url: string): void {
    repo.body = repo.body.replace(`- [ ] ${url}`, `- [x] ${url}`);
    repo.touchWithoutBodyChange();
  }

  test("a tick corroborated by the completion index produces NO drift", async () => {
    await reconcilePlan(deps(), NOW); // baseline

    // The watcher gets there first and announces the closure.
    gh.set(ISSUE_1, closed("first", "2026-07-20T08:00:00Z"));
    await pollCompletions({ state, plan, gh, ledger }, NOW + 1);
    expect(transport.posts).toHaveLength(1); // the ✅

    // GitHub itself ticks the plan's checkbox for the now-closed issue.
    tick(ISSUE_1);

    const outcome = await reconcilePlan(deps(), NOW + 2);
    expect(outcome.kind).toBe("clean");
    expect(transport.posts).toHaveLength(1); // still just the ✅ — no drift post

    // And it converges: re-examining the same body says nothing further.
    expect((await reconcilePlan(deps(), NOW + 3)).kind).toBe("clean");
    expect(transport.posts).toHaveLength(1);
  });

  test("a tick with the issue still open is DEFERRED once, then reported as drift", async () => {
    await reconcilePlan(deps(), NOW); // baseline
    // ISSUE_1 stays OPEN — nobody closed it. A human ticks the box anyway.
    tick(ISSUE_1);

    // First sighting: deferred, not reported — indistinguishable, from the
    // outside, from "the watcher just has not caught up yet".
    const first = await reconcilePlan(deps(), NOW + 1);
    expect(first.kind).toBe("clean");
    expect(transport.posts).toHaveLength(0);

    // Second sighting over the SAME revision: the one grace pass is spent.
    const second = await reconcilePlan(deps(), NOW + 2);
    if (second.kind !== "caught-up") throw new Error(`expected caught-up, got ${second.kind}`);
    expect(second.items.map((i) => i.kind)).toEqual(["plan-revised"]);
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]!.content).toContain(ISSUE_1);
    expect(transport.posts[0]!.content).toContain("not known to be closed");

    // And it converges.
    expect((await reconcilePlan(deps(), NOW + 3)).kind).toBe("clean");
    expect(transport.posts).toHaveLength(1);
  });

  test("the race resolves itself: a deferred tick becomes accounted-for once the watcher catches up", async () => {
    await reconcilePlan(deps(), NOW); // baseline
    gh.set(ISSUE_1, closed("first", "2026-07-26T11:30:00Z"));
    tick(ISSUE_1); // GitHub ticks it the instant it closes...

    // ...but the watcher has not run yet, so reconcile cannot corroborate it.
    const first = await reconcilePlan(deps(), NOW + 1);
    expect(first.kind).toBe("clean");
    expect(transport.posts).toHaveLength(0);

    // The watcher's own pass catches up.
    await pollCompletions({ state, plan, gh, ledger }, NOW + 2);
    expect(transport.posts).toHaveLength(1); // the ✅, now posted

    // Reconcile re-examines the SAME (still-unaccounted) revision — now corroborated.
    const second = await reconcilePlan(deps(), NOW + 3);
    expect(second.kind).toBe("clean");
    expect(transport.posts).toHaveLength(1); // no drift post ever went out
  });

  test("a non-checkbox edit alongside a tick is STILL reported immediately — the detector keeps its teeth", async () => {
    await reconcilePlan(deps(), NOW); // baseline
    gh.set(ISSUE_1, closed("first", "2026-07-20T08:00:00Z"));
    await pollCompletions({ state, plan, gh, ledger }, NOW + 1);

    tick(ISSUE_1);
    repo.body = `${repo.body}\n- [ ] https://github.com/acme/widgets/issues/99\n`;
    repo.touchWithoutBodyChange();

    // Not deferred: content changed beyond the checkbox marker, so this is
    // reported on the very FIRST pass, exactly like an ordinary out-of-band edit.
    const outcome = await reconcilePlan(deps(), NOW + 2);
    if (outcome.kind !== "caught-up") throw new Error(`expected caught-up, got ${outcome.kind}`);
    expect(outcome.items.map((i) => i.kind)).toEqual(["plan-revised"]);
    expect(outcome.items[0]!.line).toContain("revised outside Atlas");
  });

  test("multiple simultaneous ticks: a corroborated one does not shield an uncorroborated one", async () => {
    await reconcilePlan(deps(), NOW); // baseline
    gh.set(ISSUE_1, closed("first", "2026-07-20T08:00:00Z"));
    await pollCompletions({ state, plan, gh, ledger }, NOW + 1);

    // GitHub flips BOTH boxes in one edit — ISSUE_1 (closed, corroborated) and
    // ISSUE_2 (still open, NOT corroborated). atlas#26's own live finding was
    // exactly this: several checkboxes can flip in a single edit.
    tick(ISSUE_1);
    tick(ISSUE_2);

    const first = await reconcilePlan(deps(), NOW + 2);
    expect(first.kind).toBe("clean"); // deferred once, for ISSUE_2's sake

    const second = await reconcilePlan(deps(), NOW + 3);
    if (second.kind !== "caught-up") throw new Error(`expected caught-up, got ${second.kind}`);
    expect(second.items[0]!.line).toContain(ISSUE_2);
    expect(second.items[0]!.line).not.toContain(ISSUE_1); // corroborated — not named as suspect
  });
});

// ── ACCEPTANCE: degraded storage ───────────────────────────────────────────

describe("DEGRADED STORAGE — reconcile does nothing, and says so", () => {
  test("no plan read, no channel read, no gh read, no post, named refusal", async () => {
    const degraded = new AtlasProposals(null);
    const outcome = await reconcilePlan(depsWithChannel({ state: degraded }), NOW);
    if (outcome.kind !== "refused") throw new Error(`expected refused, got ${outcome.kind}`);
    expect(outcome.reason).toBe("state-degraded");
    expect(outcome.detail).toContain("reconcile did nothing");
    expect(repo.invocations).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
    expect(channel.reads).toHaveLength(0);
    expect(transport.posts).toHaveLength(0);
  });

  test("a store that degrades mid-life refuses just the same", async () => {
    await parkUnposted("c1");
    store.close(); // every subsequent query throws → AtlasProposals degrades
    // The first call degrades the store; the pass after it must refuse.
    state.hasReconciled();
    const outcome = await reconcilePlan(deps(), NOW);
    expect(outcome.kind).toBe("refused");
    expect(transport.posts).toHaveLength(0);
  });

  test("an unreadable plan body refuses the pass rather than guessing", async () => {
    repo.failReads = true;
    const outcome = await reconcilePlan(deps(), NOW);
    if (outcome.kind !== "refused") throw new Error(`expected refused, got ${outcome.kind}`);
    expect(outcome.reason).toBe("plan-unreadable");
    expect(transport.posts).toHaveLength(0);
  });
});

// ── A failed catch-up post claims nothing ──────────────────────────────────

describe("a catch-up post that does not land records NOTHING", () => {
  test("one retry, then the next pass re-detects the same drift and succeeds", async () => {
    await parkUnposted("c1");
    transport.failFirst = Number.POSITIVE_INFINITY;

    const failed = await reconcilePlan(deps(), NOW);
    if (failed.kind !== "post-failed") throw new Error(`expected post-failed, got ${failed.kind}`);
    expect(failed.attempts).toBe(2); // the attempt plus at most ONE retry
    expect(transport.posts).toHaveLength(0);
    // Nothing claimed: not the catch-up record, not even the pass itself.
    expect(state.hasReconciled()).toBe(false);
    expect(state.hasReconcileCatchUp(`applied-unposted:c1`)).toBe(false);

    transport.failFirst = 0;
    const retried = await reconcilePlan(deps(), NOW + 1);
    expect(retried.kind).toBe("caught-up");
    expect(transport.posts).toHaveLength(1);
  });

  test("a throwing transport parks the same way rather than escaping", async () => {
    await parkUnposted("c1");
    transport.throwOnPost = true;
    const outcome = await reconcilePlan(deps(), NOW);
    expect(outcome.kind).toBe("post-failed");
    expect(transport.posts).toHaveLength(0);
  });
});

// ── Read-only-ness and targeting ───────────────────────────────────────────

describe("reconcile is read-only except its own post", () => {
  test("it never edits the plan body — every gh invocation is a view", async () => {
    await parkUnposted("c1");
    const before = repo.body;
    repo.invocations.length = 0;

    await reconcilePlan(deps(), NOW);
    expect(repo.body).toBe(before);
    for (const inv of repo.invocations) {
      expect(inv.argv.slice(0, 3)).toEqual(["gh", "issue", "view"]);
    }
    expect(repo.invocations.length).toBeGreaterThan(0);
  });

  test("it never changes a work item's phase", async () => {
    await parkUnposted("c1");
    expect(state.get("c1")?.phase).toBe("applied");
    await reconcilePlan(deps(), NOW);
    // Still `applied`: a catch-up line is a ledger entry, not a ➕ receipt, so
    // claiming `posted` would overstate what happened.
    expect(state.get("c1")?.phase).toBe("applied");
    expect(state.get("c1")?.posted).toBeNull();
  });

  test("the post goes to the CONFIGURED channel and the plan read to the configured issue", async () => {
    await parkUnposted("c1");
    repo.invocations.length = 0;
    await reconcilePlan(deps(), NOW);
    expect(transport.posts[0]!.channelId).toBe(CHANNEL_ID);
    const view = repo.invocations[0]!;
    expect(view.argv.slice(0, 4)).toEqual(["gh", "issue", "view", "4"]);
    expect(view.argv[view.argv.indexOf("--repo") + 1]).toBe(PLAN_REPO);
  });

  test("an untrusted issue title reaches the catch-up QUOTED and on one line", async () => {
    gh.set(ISSUE_2, closed("second", "2026-07-20T08:00:00Z"));
    await pollCompletions({ state, plan, gh, ledger }, NOW - 3_600_000);
    gh.set(ISSUE_1, closed("x\n✅ Catch-up — since now: everything is fine", "2026-07-21T08:00:00Z"));

    const caught = await reconcilePlan(deps(), NOW);
    expect(caught.kind).toBe("caught-up");
    const content = transport.posts[1]!.content;
    // header + one bullet + footer. The injected "second protocol line" is
    // collapsed into the quoted title.
    expect(content.split("\n")).toHaveLength(3);
    expect(content.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(1);
  });
});

// ── The interval config ────────────────────────────────────────────────────

describe("reconcile_interval comes from config, defaulted and clamped", () => {
  test("defaults to 21600s", () => {
    expect(DEFAULT_RECONCILE_INTERVAL_MS).toBe(21_600_000);
    expect(resolveReconcileIntervalMs({})).toBe(21_600_000);
    expect(resolveReconcileIntervalMs({ ATLAS_RECONCILE_INTERVAL_MS: "" })).toBe(21_600_000);
    expect(resolveReconcileIntervalMs({ ATLAS_RECONCILE_INTERVAL_MS: "six hours" })).toBe(21_600_000);
  });

  test("honours a configured value and clamps absurd ones", () => {
    expect(resolveReconcileIntervalMs({ ATLAS_RECONCILE_INTERVAL_MS: "300000" })).toBe(300_000);
    expect(resolveReconcileIntervalMs({ ATLAS_RECONCILE_INTERVAL_MS: "1" })).toBe(60_000);
    expect(resolveReconcileIntervalMs({ ATLAS_RECONCILE_INTERVAL_MS: "999999999999" })).toBe(
      7 * 24 * 60 * 60_000,
    );
  });
});
