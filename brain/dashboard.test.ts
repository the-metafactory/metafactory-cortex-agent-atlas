/**
 * The plan dashboard's suite (W3a, issue #2 item 2).
 *
 * Two properties carry the weight: the section table matches the LIVE plan
 * body's sections, and the file is regenerated on EVERY state transition. The
 * second is asserted through the state layer's own transition hook against a
 * real store, not by calling the writer in a loop — "it redraws when something
 * moves" is a claim about the wiring, and a test that drives the writer
 * directly would assert nothing about it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLAN_DASHBOARD_FILENAME,
  planSections,
  regeneratePlanDashboard,
  renderPlanDashboard,
  type PlanDashboardInput,
} from "./dashboard";
import { makeEffectsConfig, type EffectsConfig } from "./effects/config";
import { GhCliPlanWriter } from "./effects/gh";
import { AtlasProposals, AtlasStateStore, type ProposalRecord } from "./state";
import { FakePlanRepo } from "./test-support";

const CHANNEL_ID = "chan-fixture-0000";
const PLAN_URL = "https://github.com/acme/widgets/issues/4";
const ISSUE_1 = "https://github.com/acme/widgets/issues/1";
const ISSUE_2 = "https://github.com/acme/widgets/issues/2";
const ISSUE_7 = "https://github.com/acme/widgets/issues/7";
const ISSUE_12 = "https://github.com/acme/widgets/issues/12";

const PLAN_BODY = [
  "# Iteration 1",
  "",
  "## Backend",
  "",
  `- [ ] ${ISSUE_1}`,
  `- [x] ${ISSUE_2}`,
  "",
  "### Backend / storage",
  "",
  `- [ ] ${ISSUE_12}`,
  "",
  "## Frontend",
  "",
  `- [ ] ${ISSUE_7}`,
  "",
].join("\n");

const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);

function input(overrides: Partial<PlanDashboardInput> = {}): PlanDashboardInput {
  return {
    body: PLAN_BODY,
    records: [],
    announced: () => false,
    planUrl: PLAN_URL,
    generatedAt: NOW,
    ...overrides,
  };
}

/** A minimal record shaped like the store's, for the marker arithmetic. */
function record(over: Partial<ProposalRecord> & { id: string }): ProposalRecord {
  return {
    phase: "surfaced",
    verb: "ADD",
    url: ISSUE_1,
    section: "Backend",
    why: "reason",
    proposer: "octocat",
    displayId: 1,
    ratification: null,
    applied: null,
    posted: null,
    ...over,
  };
}

let dir: string;
let store: AtlasStateStore;
let state: AtlasProposals;
let effects: EffectsConfig;
let repo: FakePlanRepo;
let plan: GhCliPlanWriter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-dashboard-test-"));
  const loaded = makeEffectsConfig({
    planRepo: "acme/widgets",
    planIssue: 4,
    channelId: CHANNEL_ID,
    adapterInstances: "adapter-fixture",
  });
  if (loaded.kind !== "ok") throw new Error("fixture: effects config refused");
  effects = loaded.config;
  repo = new FakePlanRepo(PLAN_BODY);
  plan = new GhCliPlanWriter(effects, repo.spawn);
  const opened = AtlasStateStore.open({ dir, bundleDir: null });
  if (opened === null) throw new Error("fixture: expected the store to open");
  store = opened;
  state = new AtlasProposals(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the section table matches the live plan body", () => {
  test("one entry per heading, in body order, with its level", () => {
    const sections = planSections(input());
    expect(sections.map((s) => s.title)).toEqual([
      "Iteration 1",
      "Backend",
      "Backend / storage",
      "Frontend",
    ]);
    expect(sections.map((s) => s.level)).toEqual([1, 2, 3, 2]);
  });

  test("a parent section owns its subsection's links (same span rule as apply.ts)", () => {
    const sections = planSections(input());
    const backend = sections.find((s) => s.title === "Backend")!;
    // Backend spans through `### Backend / storage`, so it carries all three.
    expect(backend.total).toBe(3);
    const storage = sections.find((s) => s.title === "Backend / storage")!;
    expect(storage.total).toBe(1);
    const frontend = sections.find((s) => s.title === "Frontend")!;
    expect(frontend.total).toBe(1);
  });

  test("a ticked task-list item counts as closed", () => {
    const backend = planSections(input()).find((s) => s.title === "Backend")!;
    // ISSUE_2 is `- [x]`; the other two are open.
    expect(backend.open).toBe(2);
    expect(backend.total).toBe(3);
  });

  test("an announced completion counts as closed even when the box is unticked", () => {
    const backend = planSections(
      input({ announced: (url) => url === ISSUE_1 }),
    ).find((s) => s.title === "Backend")!;
    expect(backend.open).toBe(1);
    expect(backend.total).toBe(3);
  });

  test("a body with no headings yields no sections and says so", () => {
    expect(planSections(input({ body: `- [ ] ${ISSUE_1}` }))).toHaveLength(0);
    expect(renderPlanDashboard(input({ body: "no headings here" }))).toContain(
      "_No sections",
    );
  });

  test("a section title is untrusted text — quoted, collapsed, never markup", () => {
    const hostile = ["## Ops\n```js\nalert(1)", "", `- [ ] ${ISSUE_1}`].join("\n");
    const rendered = renderPlanDashboard(input({ body: hostile }));
    expect(rendered).not.toContain("```");
  });
});

describe("🏃 / ✋ markers come from work-item state", () => {
  test("✋ counts surfaced items, 🏃 counts ratified and applied ones", () => {
    const sections = planSections(
      input({
        records: [
          record({ id: "a", phase: "surfaced", section: "Backend" }),
          record({ id: "b", phase: "ratified", section: "Backend" }),
          record({ id: "c", phase: "applied", section: "Backend" }),
          // Terminal phases are neither running nor held.
          record({ id: "d", phase: "posted", section: "Backend" }),
          record({ id: "e", phase: "declined", section: "Backend" }),
          record({ id: "f", phase: "surfaced", section: "Frontend", url: ISSUE_7 }),
        ],
      }),
    );
    const backend = sections.find((s) => s.title === "Backend")!;
    expect(backend.held).toBe(1);
    expect(backend.running).toBe(2);
    const frontend = sections.find((s) => s.title === "Frontend")!;
    expect(frontend.held).toBe(1);
    expect(frontend.running).toBe(0);
  });

  test("an item with no named section is attributed by its URL's location", () => {
    const sections = planSections(
      input({ records: [record({ id: "a", phase: "surfaced", section: null, url: ISSUE_7 })] }),
    );
    expect(sections.find((s) => s.title === "Frontend")!.held).toBe(1);
    expect(sections.find((s) => s.title === "Backend")!.held).toBe(0);
  });

  test("a section line omits its markers entirely when both counts are zero", () => {
    const rendered = renderPlanDashboard(input());
    const frontend = rendered.split("\n").find((l) => l.includes("**Frontend**"))!;
    expect(frontend.trim()).toBe("- **Frontend** — 1/1 open");
    expect(frontend).not.toContain("🏃");
    expect(frontend).not.toContain("✋");
  });

  test("the rendered line carries title, open/total and the markers", () => {
    const rendered = renderPlanDashboard(
      input({
        records: [
          record({ id: "a", phase: "surfaced", section: "Backend" }),
          record({ id: "b", phase: "applied", section: "Backend" }),
        ],
      }),
    );
    expect(rendered).toContain("- **Backend** — 2/3 open · 🏃 1 · ✋ 1");
  });

  test("TOTALS count each thing ONCE — a `#` heading spanning `##` ones must not double it", () => {
    // The body has 4 distinct linked issues (one of them ticked) and 4 nested
    // headings. Summing the section rows would report 9/5; the plan really has
    // 4 issues, 3 of them open, and 2 work items.
    const rendered = renderPlanDashboard(
      input({
        records: [
          record({ id: "a", phase: "surfaced", section: "Backend" }),
          record({ id: "b", phase: "applied", section: "Backend" }),
        ],
      }),
    );
    expect(rendered).toContain("_Totals: 3/4 open · 🏃 1 · ✋ 1_");
  });

  test("it announces itself as the ONLY digest source, and as generated", () => {
    const rendered = renderPlanDashboard(input());
    expect(rendered).toContain("GENERATED FILE");
    expect(rendered).toContain("ONLY source for 🏃 wave-post digests");
    expect(rendered).toContain(PLAN_URL);
  });

  test("idempotent — same state, same bytes apart from the generated-at line", () => {
    const a = renderPlanDashboard(input()).split("\n").filter((l) => !l.startsWith("_Generated:"));
    const b = renderPlanDashboard(input({ generatedAt: NOW + 5_000 }))
      .split("\n")
      .filter((l) => !l.startsWith("_Generated:"));
    expect(a).toEqual(b);
  });
});

describe("regeneratePlanDashboard writes the file", () => {
  test("it lands at plan-dashboard.md and matches the LIVE body", async () => {
    const outcome = await regeneratePlanDashboard(
      { state, plan, dir, planUrl: effects.planUrl },
      NOW,
    );
    if (outcome.kind !== "written") throw new Error(`expected written, got ${outcome.reason}`);
    expect(outcome.path).toBe(join(dir, PLAN_DASHBOARD_FILENAME));
    const text = readFileSync(outcome.path, "utf8");
    expect(text).toContain("- **Backend** — 2/3 open");
    expect(text).toContain("- **Frontend** — 1/1 open");

    // Change the LIVE body; the next regen must follow it, not a cached copy.
    repo.body = ["## Only", "", `- [ ] ${ISSUE_1}`, ""].join("\n");
    await regeneratePlanDashboard({ state, plan, dir, planUrl: effects.planUrl }, NOW);
    const after = readFileSync(outcome.path, "utf8");
    expect(after).toContain("- **Only** — 1/1 open");
    expect(after).not.toContain("Backend");
  });

  test("it does NOT collide with agent-state's own dashboard.md", async () => {
    await regeneratePlanDashboard({ state, plan, dir, planUrl: effects.planUrl }, NOW);
    expect(existsSync(join(dir, PLAN_DASHBOARD_FILENAME))).toBe(true);
    expect(existsSync(join(dir, "dashboard.md"))).toBe(false);
  });

  test("a degraded store SKIPS rather than writing an empty claim", async () => {
    const degraded = new AtlasProposals(null);
    const outcome = await regeneratePlanDashboard(
      { state: degraded, plan, dir, planUrl: effects.planUrl },
      NOW,
    );
    if (outcome.kind !== "skipped") throw new Error("expected skipped");
    expect(outcome.reason).toBe("state-degraded");
    expect(existsSync(join(dir, PLAN_DASHBOARD_FILENAME))).toBe(false);
  });

  test("an unreadable plan body skips rather than drawing a plan with no sections", async () => {
    repo.failReads = true;
    const outcome = await regeneratePlanDashboard(
      { state, plan, dir, planUrl: effects.planUrl },
      NOW,
    );
    expect(outcome.kind === "skipped" && outcome.reason).toBe("plan-unreadable");
    expect(existsSync(join(dir, PLAN_DASHBOARD_FILENAME))).toBe(false);
  });
});

describe("REGENERATED ON EVERY STATE CHANGE", () => {
  test("the transition hook fires for every phase transition", () => {
    const hookDir = mkdtempSync(join(tmpdir(), "atlas-dashboard-hook-"));
    let fired = 0;
    const hooked = AtlasStateStore.open({
      dir: hookDir,
      bundleDir: null,
      onTransition: () => {
        fired += 1;
      },
    });
    if (hooked === null) throw new Error("fixture: expected the store to open");
    const proposals = new AtlasProposals(hooked);
    try {
      proposals.createIntake("h1", "ADD", ISSUE_12, "Backend", "reason", "octocat");
      expect(fired).toBe(1);
      proposals.markValidated("h1", true);
      expect(fired).toBe(2);
      proposals.markSurfaced("h1");
      expect(fired).toBe(3);
      // A SECOND item's intake, so the count is driven by transitions and not
      // by one item's lifecycle. (`markDeclined` deliberately refuses a
      // `waiting_human` row — only the gate may decline a surfaced proposal —
      // so it is not a transition and correctly fires nothing.)
      proposals.markDeclined("h1", "already on the plan");
      expect(fired).toBe(3);
      proposals.createIntake("h2", "ADD", ISSUE_7, "Frontend", "reason", "octocat");
      expect(fired).toBe(4);
      proposals.markValidated("h2", true);
      expect(fired).toBe(5);
      proposals.markDeclined("h2", "already on the plan");
      expect(fired).toBe(6);
    } finally {
      hooked.close();
      rmSync(hookDir, { recursive: true, force: true });
    }
  });

  test("wired to the writer, every transition leaves a dashboard matching the body", async () => {
    const hookDir = mkdtempSync(join(tmpdir(), "atlas-dashboard-wired-"));
    const path = join(hookDir, PLAN_DASHBOARD_FILENAME);
    const pending: Array<Promise<unknown>> = [];
    let proposals: AtlasProposals;
    const hooked = AtlasStateStore.open({
      dir: hookDir,
      bundleDir: null,
      onTransition: () => {
        pending.push(
          regeneratePlanDashboard({ state: proposals, plan, dir: hookDir, planUrl: effects.planUrl }, NOW),
        );
      },
    });
    if (hooked === null) throw new Error("fixture: expected the store to open");
    proposals = new AtlasProposals(hooked);
    try {
      proposals.createIntake("w1", "ADD", ISSUE_12, "Backend", "reason", "octocat");
      await Promise.all(pending);
      expect(existsSync(path)).toBe(true);
      // An `intake` item is neither running nor held, so no markers yet.
      expect(readFileSync(path, "utf8")).toContain("- **Backend** — 2/3 open\n");

      proposals.markValidated("w1", true);
      proposals.markSurfaced("w1");
      await Promise.all(pending);
      // ✋ appears the moment the item is awaiting a human — one transition, one redraw.
      expect(readFileSync(path, "utf8")).toContain("- **Backend** — 2/3 open · ✋ 1");
      // And the section list still matches the live plan body exactly.
      const titles = planSections({
        body: repo.body,
        records: [],
        announced: () => false,
        planUrl: effects.planUrl,
        generatedAt: NOW,
      }).map((s) => s.title);
      const text = readFileSync(path, "utf8");
      for (const title of titles) expect(text).toContain(`**${title}**`);
    } finally {
      hooked.close();
      rmSync(hookDir, { recursive: true, force: true });
    }
  });

  test("a throwing hook never breaks the transition it observes", () => {
    const hookDir = mkdtempSync(join(tmpdir(), "atlas-dashboard-throw-"));
    const hooked = AtlasStateStore.open({
      dir: hookDir,
      bundleDir: null,
      onTransition: () => {
        throw new Error("dashboard exploded");
      },
    });
    if (hooked === null) throw new Error("fixture: expected the store to open");
    const proposals = new AtlasProposals(hooked);
    try {
      proposals.createIntake("t1", "ADD", ISSUE_12, "Backend", "reason", "octocat");
      // The transition still happened, and the store did NOT degrade.
      expect(proposals.get("t1")?.phase).toBe("intake");
      expect(proposals.isDurable()).toBe(true);
    } finally {
      hooked.close();
      rmSync(hookDir, { recursive: true, force: true });
    }
  });
});
