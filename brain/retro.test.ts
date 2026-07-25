/**
 * The weekly retro's suite (W3a, issue #2 item 3).
 *
 * The counters are read off a REAL event log driven by REAL transitions — the
 * gate, the applier, the watcher and the reconcile loop — because "posts made"
 * and "drift found" are facts about what those modules WROTE, and a fixture
 * that inserted the events by hand would be asserting the fixture.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRatified } from "./apply";
import { DiscordLedger } from "./effects/discord";
import { makeEffectsConfig, type EffectsConfig } from "./effects/config";
import { GhCliPlanWriter } from "./effects/gh";
import {
  identityConfigFromPorts,
  StaticPrincipalMap,
  StaticSelfIdentity,
  type RatifyIdentityConfig,
} from "./identity";
import { processGateMessage, type GateMessage } from "./ratify";
import { reconcilePlan } from "./reconcile";
import {
  isoWeekLabel,
  renderRetro,
  retroCounters,
  retroWindow,
  writeWeeklyRetro,
} from "./retro";
import { AtlasProposals, AtlasStateStore } from "./state";
import { FakeLinkedIssues, FakePlanRepo, RecordingTransport } from "./test-support";

const PLATFORM = "discord";
const PRINCIPAL_ID = "plan-steward";
const PRINCIPAL_PLATFORM_ID = "pid-principal-fixture";
const ATLAS_PLATFORM_ID = "pid-atlas-self-fixture";
const CHANNEL_ID = "chan-fixture-0000";
const NEW_URL = "https://github.com/acme/widgets/issues/12";

const PLAN_BODY = [
  "# Iteration 1",
  "",
  "## Backend",
  "",
  "- [ ] https://github.com/acme/widgets/issues/1",
  "",
].join("\n");

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-retro-test-"));
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
  const loaded = makeEffectsConfig({ planRepo: "acme/widgets", planIssue: 4, channelId: CHANNEL_ID });
  if (loaded.kind !== "ok") throw new Error("fixture: effects config refused");
  effects = loaded.config;
  repo = new FakePlanRepo(PLAN_BODY);
  transport = new RecordingTransport();
  plan = new GhCliPlanWriter(effects, repo.spawn);
  ledger = new DiscordLedger(effects, transport);
  gh = new FakeLinkedIssues();
  gh.set("https://github.com/acme/widgets/issues/1", {
    closed: false,
    title: "open",
    closedAt: null,
    referencingPrUrl: null,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function msg(body: string): GateMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    body,
    authorPlatform: PLATFORM,
    authorId: PRINCIPAL_PLATFORM_ID,
  };
}

function surface(id: string, url = NEW_URL): number {
  state.createIntake(id, "ADD", url, "Backend", "it blocks the release", "octocat");
  state.markValidated(id, true);
  const displayId = state.markSurfaced(id);
  if (displayId === null) throw new Error("fixture: expected a display id");
  return displayId;
}

/** The window covering "everything this test just did". */
function nowWindow(): { startMs: number; endMs: number; label: string } {
  return { startMs: 0, endMs: Date.now() + 60_000, label: "test" };
}

// ── ISO weeks ──────────────────────────────────────────────────────────────

describe("the reporting window is the previous ISO week", () => {
  test("weeks run Monday 00:00 UTC to the following Monday", () => {
    // 2026-07-26 is a Sunday, so its ISO week starts Monday 2026-07-20 and the
    // PREVIOUS completed week starts Monday 2026-07-13.
    const w = retroWindow(Date.UTC(2026, 6, 26, 12, 0, 0));
    expect(new Date(w.startMs).toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(new Date(w.endMs).toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(w.endMs - w.startMs).toBe(7 * 86_400_000);
  });

  test("a Monday belongs to its own week, not the one before", () => {
    const w = retroWindow(Date.UTC(2026, 6, 20, 0, 0, 0), 0);
    expect(new Date(w.startMs).toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  test("the label is YYYY-Www, zero-padded", () => {
    expect(isoWeekLabel(Date.UTC(2026, 0, 5))).toBe("2026-W02");
    expect(retroWindow(Date.UTC(2026, 6, 26), 0).label).toMatch(/^\d{4}-W\d{2}$/);
  });
});

// ── The four counters ──────────────────────────────────────────────────────

describe("the four counters, read off real transitions", () => {
  test("proposals in / ratified / declined", async () => {
    surface("p1");
    surface("p2");
    surface("p3");
    // One ratified.
    expect(processGateMessage(msg("RATIFY 1"), identity, state).kind).toBe("ratified");
    // One declined by the principal.
    expect(processGateMessage(msg("DECLINE 2 not now"), identity, state).kind).toBe("declined");
    // One declined by the validator (a fresh item — validation cannot touch a
    // surfaced row).
    state.createIntake("p4", "ADD", NEW_URL, "Backend", "reason", "octocat");
    state.markDeclined("p4", "already on the plan");

    const counters = retroCounters(state, nowWindow());
    expect(counters.proposalsIn).toBe(4);
    expect(counters.ratified).toBe(1);
    // BOTH decline paths, and NOT the `applied` resolution.
    expect(counters.declined).toBe(2);
  });

  test("posts made counts ➕/➖ receipts, ✅ announcements and catch-ups", async () => {
    const displayId = surface("p1");
    const ratified = processGateMessage(msg(`RATIFY ${displayId}`), identity, state);
    if (ratified.kind !== "ratified") throw new Error("fixture");
    const applied = await applyRatified(ratified.certificate, {
      state,
      identity,
      effects,
      gh: plan,
      ledger,
    });
    expect(applied.kind).toBe("posted");

    let counters = retroCounters(state, nowWindow());
    expect(counters.postsMade).toBe(1); // the ➕
    expect(counters.driftFound).toBe(0);

    // A ✅ announcement recorded by the watcher.
    state.recordCompletionAnnounced("https://github.com/acme/widgets/issues/1", "msg-fixture-9");
    counters = retroCounters(state, nowWindow());
    expect(counters.postsMade).toBe(2);
  });

  test("drift found is the reconcile health metric, and a clean pass records ZERO", async () => {
    // A clean pass — no post, but a recorded zero, which is what makes the
    // metric a trend rather than a sighting.
    const clean = await reconcilePlan({ state, plan, gh, ledger, effects });
    expect(clean.kind).toBe("clean");
    let counters = retroCounters(state, nowWindow());
    expect(counters.driftFound).toBe(0);
    expect(counters.postsMade).toBe(0);
    expect(transport.posts).toHaveLength(0);

    // Now park an item and let reconcile catch it up.
    const displayId = surface("p1");
    const ratified = processGateMessage(msg(`RATIFY ${displayId}`), identity, state);
    if (ratified.kind !== "ratified") throw new Error("fixture");
    transport.failFirst = Number.POSITIVE_INFINITY;
    await applyRatified(ratified.certificate, { state, identity, effects, gh: plan, ledger });
    transport.failFirst = 0;

    const caught = await reconcilePlan({ state, plan, gh, ledger, effects });
    expect(caught.kind).toBe("caught-up");

    counters = retroCounters(state, nowWindow());
    expect(counters.driftFound).toBe(1);
    expect(counters.postsMade).toBe(1); // the catch-up post itself
  });

  test("events outside the window are not counted", () => {
    surface("p1");
    const empty = retroCounters(state, { startMs: 0, endMs: 1, label: "ancient" });
    expect(empty.proposalsIn).toBe(0);
    expect(empty.ratified).toBe(0);
    expect(empty.declined).toBe(0);
    expect(empty.postsMade).toBe(0);
    expect(empty.driftFound).toBe(0);
  });
});

// ── The written file ───────────────────────────────────────────────────────

describe("writeWeeklyRetro", () => {
  test("writes retros/<week>-atlas.md carrying all four counters", () => {
    surface("p1");
    // Report on the CURRENT week so the events just written fall inside it.
    const outcome = writeWeeklyRetro(state, dir, Date.now(), 0);
    if (outcome.kind !== "written") throw new Error(`expected written, got ${outcome.reason}`);
    expect(outcome.path).toBe(join(dir, "retros", `${outcome.label}-atlas.md`));

    const text = readFileSync(outcome.path, "utf8");
    expect(text).toContain("| Proposals in | 1 |");
    expect(text).toContain("| Ratified | 0 |");
    expect(text).toContain("| Declined | 0 |");
    expect(text).toContain("| Posts made | 0 |");
    expect(text).toContain("| Drift found by reconcile | 0 |");
    expect(text).toContain("health metric");
    expect(text).toContain("GENERATED FILE");
  });

  test("it does NOT collide with agent-state's own retros/<week>.md", () => {
    const outcome = writeWeeklyRetro(state, dir, Date.now(), 0);
    if (outcome.kind !== "written") throw new Error("expected written");
    expect(existsSync(join(dir, "retros", `${outcome.label}.md`))).toBe(false);
    expect(existsSync(outcome.path)).toBe(true);
  });

  test("idempotent — same events, same bytes apart from the generated-at line", () => {
    surface("p1");
    const first = writeWeeklyRetro(state, dir, Date.now(), 0);
    if (first.kind !== "written") throw new Error("expected written");
    const a = readFileSync(first.path, "utf8").split("\n").filter((l) => !l.startsWith("_Generated:"));
    writeWeeklyRetro(state, dir, Date.now() + 1_000, 0);
    const b = readFileSync(first.path, "utf8").split("\n").filter((l) => !l.startsWith("_Generated:"));
    expect(a).toEqual(b);
  });

  test("a DEGRADED store writes nothing rather than a retro of zeroes", () => {
    const degraded = new AtlasProposals(null);
    const outcome = writeWeeklyRetro(degraded, dir, Date.now(), 0);
    if (outcome.kind !== "skipped") throw new Error("expected skipped");
    expect(outcome.reason).toBe("state-degraded");
    expect(outcome.detail).toContain("false claim");
    expect(existsSync(join(dir, "retros"))).toBe(false);
  });

  test("the rendered markdown states the window and the label", () => {
    const window = retroWindow(Date.UTC(2026, 6, 26, 12, 0, 0));
    const text = renderRetro(
      window,
      { proposalsIn: 3, ratified: 2, declined: 1, postsMade: 4, driftFound: 0 },
      Date.UTC(2026, 6, 26, 12, 0, 0),
    );
    expect(text).toContain(`# Atlas — plan-steward retro · ${window.label}`);
    expect(text).toContain("2026-07-13T00:00:00.000Z → 2026-07-20T00:00:00.000Z");
    expect(text).toContain("| Drift found by reconcile | 0 |");
  });
});
