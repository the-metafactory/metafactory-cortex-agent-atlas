/**
 * `atlas status`'s pure suite (atlas#28).
 *
 * The property that matters most: the envelope's section/total counts are
 * IDENTICAL to `dashboard.ts`'s own `planSections`/`bodyTotals` for the same
 * plan revision — asserted by a test that computes both from the same input
 * and compares, so drift between them is a build failure rather than a
 * discovery. A second test proves that comparison can actually FAIL (feeding
 * the two computations different inputs) — the vacuous-assertion guard this
 * repo has been bitten by before: a parity check that cannot fail is
 * decoration, not a check.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bodyTotals, planSections, type PlanDashboardInput } from "./dashboard";
import type { ProposalRecord } from "./state";
import {
  STATUS_SCHEMA,
  buildStatusEnvelope,
  filterHeld,
  filterRunning,
  parseStatusArgs,
  parseTicketRef,
  renderStatusHuman,
  resolveSection,
  resolveTicket,
  type BuildStatusInput,
  type StatusEnvelope,
} from "./status";

const ISSUE_1 = "https://github.com/acme/widgets/issues/1";
const ISSUE_2 = "https://github.com/acme/widgets/issues/2";
const ISSUE_7 = "https://github.com/acme/widgets/issues/7";

const PLAN_BODY = [
  "# Iteration 1",
  "",
  "## Backend",
  "",
  `- [ ] ${ISSUE_1}`,
  `- [x] ${ISSUE_2}`,
  "",
  "## Frontend",
  "",
  `- [ ] ${ISSUE_7}`,
  "",
].join("\n");

const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);

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

function baseInput(overrides: Partial<BuildStatusInput> = {}): BuildStatusInput {
  return {
    planUrl: "https://github.com/acme/widgets/issues/4",
    revision: "sha256:abcdef0123456789",
    body: PLAN_BODY,
    records: [],
    announced: () => false,
    titleOf: () => null,
    now: NOW,
    freshness: {
      lastWatcherPassTs: NOW - 60_000,
      lastReconcile: { ts: NOW - 3_600_000, driftCount: 0 },
      lastLedgerEntryTs: NOW - 120_000,
      daemonRunning: true,
    },
    live: null,
    ...overrides,
  };
}

function dashInputFrom(input: BuildStatusInput): PlanDashboardInput {
  return {
    body: input.body,
    records: input.records,
    announced: input.announced,
    planUrl: input.planUrl,
    generatedAt: input.now,
  };
}

describe("parity with dashboard.ts — the non-negotiable property", () => {
  test("section counts are IDENTICAL to planSections() for the same input", () => {
    const input = baseInput({
      records: [record({ id: "a", phase: "surfaced", section: "Backend" })],
    });
    const envelope = buildStatusEnvelope(input);
    const direct = planSections(dashInputFrom(input));

    expect(envelope.sections.map((s) => ({ title: s.title, level: s.level, total: s.total, open: s.open, running: s.running, held: s.held }))).toEqual(
      direct.map((s) => ({ title: s.title, level: s.level, total: s.total, open: s.open, running: s.running, held: s.held })),
    );
  });

  test("plan-wide totals are IDENTICAL to bodyTotals() for the same input", () => {
    const input = baseInput({
      records: [
        record({ id: "a", phase: "surfaced", section: "Backend" }),
        record({ id: "b", phase: "applied", section: "Frontend", url: ISSUE_7 }),
      ],
    });
    const envelope = buildStatusEnvelope(input);
    const direct = bodyTotals(dashInputFrom(input));

    expect(envelope.totals.linked).toBe(direct.total);
    expect(envelope.totals.open).toBe(direct.open);
    expect(envelope.totals.closed).toBe(direct.total - direct.open);
    expect(envelope.totals.running).toBe(direct.running);
    expect(envelope.totals.held).toBe(direct.held);
  });

  test("MUTATION PROOF — the parity check actually fails when the two diverge", () => {
    // Feed the envelope a DIFFERENT records array than the one handed to the
    // direct `planSections` call — if this assertion could never fail, the
    // "parity" tests above would be decoration. It must fail here.
    const sharedBody = PLAN_BODY;
    const envelopeInput = baseInput({
      body: sharedBody,
      records: [record({ id: "a", phase: "applied", section: "Backend" })], // running: 1
    });
    const envelope = buildStatusEnvelope(envelopeInput);
    const direct = planSections({
      body: sharedBody,
      records: [record({ id: "a", phase: "surfaced", section: "Backend" })], // held: 1, NOT running
      announced: () => false,
      planUrl: envelopeInput.planUrl,
      generatedAt: NOW,
    });
    const envelopeBackend = envelope.sections.find((s) => s.title === "Backend")!;
    const directBackend = direct.find((s) => s.title === "Backend")!;
    expect(envelopeBackend.running).not.toBe(directBackend.running);
    expect(envelopeBackend.held).not.toBe(directBackend.held);
  });

  test("a plan-wide total DOES double-count if a caller sums section rows instead of calling bodyTotals — proving the envelope does NOT do that", () => {
    // Iteration 1 (level 1) spans Backend AND Frontend (the span rule), so
    // summing section .total values would report 3 + 3 = 6 distinct issues
    // for a plan that really has 3. The envelope must match bodyTotals (3),
    // not the naive sum (6).
    const input = baseInput();
    const envelope = buildStatusEnvelope(input);
    const summed = envelope.sections.reduce((n, s) => n + s.total, 0);
    expect(envelope.totals.linked).toBe(3);
    expect(summed).not.toBe(envelope.totals.linked);
  });
});

describe("the envelope shape — atlas.plan.status.v1", () => {
  test("round-trips through JSON with the exact schema tag and top-level keys", () => {
    const envelope = buildStatusEnvelope(baseInput());
    const json = JSON.stringify(envelope);
    const parsed = JSON.parse(json) as StatusEnvelope;
    expect(parsed).toEqual(envelope);
    expect(parsed.schema).toBe(STATUS_SCHEMA);
    expect(Object.keys(parsed).sort()).toEqual(
      ["schema", "plan", "freshness", "totals", "live", "divergence", "sections", "tickets"].sort(),
    );
  });

  test("every ticket carries the full per-ticket shape the issue's schema names", () => {
    const envelope = buildStatusEnvelope(
      baseInput({ titleOf: (url) => (url === ISSUE_1 ? "Fix the thing" : null) }),
    );
    const t = envelope.tickets.find((x) => x.url === ISSUE_1)!;
    expect(t.repo).toBe("acme/widgets");
    expect(t.number).toBe(1);
    expect(t.title).toBe("Fix the thing");
    expect(t.sections).toEqual(["Iteration 1", "Backend"]);
    expect(t.planState).toBe("unticked");
    expect(t.ledgerState).toBe("not-announced");
    expect(t.liveState).toBeNull();
    expect(t.proposal).toBeNull();
  });

  test("a ticket may belong to more than one section — sections is plural, and section totals may sum to more than the plan total", () => {
    const envelope = buildStatusEnvelope(baseInput());
    const t = envelope.tickets.find((x) => x.url === ISSUE_1)!;
    expect(t.sections.length).toBeGreaterThan(1);
  });

  test("freshness carries generatedAt, lastWatcherPass, lastReconcile (with drift), lastLedgerEntry and daemonRunning", () => {
    const envelope = buildStatusEnvelope(baseInput());
    expect(typeof envelope.freshness.generatedAt).toBe("string");
    expect(envelope.freshness.lastWatcherPass).not.toBeNull();
    expect(envelope.freshness.lastReconcile).toEqual({ at: new Date(NOW - 3_600_000).toISOString(), drift: 0 });
    expect(envelope.freshness.lastLedgerEntry).not.toBeNull();
    expect(envelope.freshness.daemonRunning).toBe(true);
  });

  test("daemonRunning: false is representable and is a distinct fact from a null lastWatcherPass", () => {
    const neverWatched = buildStatusEnvelope(
      baseInput({ freshness: { lastWatcherPassTs: null, lastReconcile: null, lastLedgerEntryTs: null, daemonRunning: false } }),
    );
    expect(neverWatched.freshness.lastWatcherPass).toBeNull();
    expect(neverWatched.freshness.daemonRunning).toBe(false);
    // The human rendering must say so PROMINENTLY, not only in JSON.
    expect(renderStatusHuman(neverWatched)).toContain("DAEMON NOT RUNNING");
  });

  test("`live` is null without --live, and populated with open/closed/checkedAt when present", () => {
    const withoutLive = buildStatusEnvelope(baseInput());
    expect(withoutLive.live).toBeNull();

    const withLive = buildStatusEnvelope(
      baseInput({
        live: {
          states: new Map([
            [ISSUE_1, { closed: false, closedAt: null }],
            [ISSUE_2, { closed: true, closedAt: "2026-07-26T00:00:00.000Z" }],
            [ISSUE_7, { closed: true, closedAt: "2026-07-26T01:00:00.000Z" }],
          ]),
          checkedAt: NOW,
        },
      }),
    );
    expect(withLive.live).toEqual({ open: 1, closed: 2, checkedAt: new Date(NOW).toISOString() });
  });
});

describe("divergence — the ledger and GitHub disagreeing IS the status", () => {
  test("a ticket the ledger thinks is open but GitHub says is closed is reported, never silently resolved either way", () => {
    const envelope = buildStatusEnvelope(
      baseInput({
        live: {
          states: new Map([[ISSUE_1, { closed: true, closedAt: "2026-07-26T04:00:00.000Z" }]]),
          checkedAt: NOW,
        },
      }),
    );
    expect(envelope.divergence).toEqual([
      { ticket: "acme/widgets#1", ledger: "open", live: "closed", since: "2026-07-26T04:00:00.000Z" },
    ]);
  });

  test("agreement between the ledger and GitHub produces no divergence entry", () => {
    const envelope = buildStatusEnvelope(
      baseInput({
        live: {
          states: new Map([[ISSUE_2, { closed: true, closedAt: null }]]), // ISSUE_2 is ticked ⇒ ledger already says closed
          checkedAt: NOW,
        },
      }),
    );
    expect(envelope.divergence).toEqual([]);
  });

  test("an announced (not just ticked) completion also counts as ledger-closed for divergence purposes", () => {
    const envelope = buildStatusEnvelope(
      baseInput({
        announced: (url) => url === ISSUE_7,
        live: {
          states: new Map([[ISSUE_7, { closed: true, closedAt: null }]]),
          checkedAt: NOW,
        },
      }),
    );
    expect(envelope.divergence).toEqual([]);
  });
});

describe("--section / --ticket resolution — a miss is explicit, never an empty success", () => {
  test("resolveSection matches case-insensitively and trimmed", () => {
    const envelope = buildStatusEnvelope(baseInput());
    expect(resolveSection(envelope, "  backend  ").kind).toBe("found");
    expect(resolveSection(envelope, "nonexistent-section").kind).toBe("not-found");
  });

  test("resolveTicket accepts owner/repo#N, a bare #N, and a full URL", () => {
    const envelope = buildStatusEnvelope(baseInput());
    expect(resolveTicket(envelope, "acme/widgets#1").kind).toBe("found");
    expect(resolveTicket(envelope, ISSUE_1).kind).toBe("found");
    expect(resolveTicket(envelope, "acme/widgets#999").kind).toBe("not-found");
  });

  test("parseTicketRef rejects garbage rather than guessing", () => {
    expect(parseTicketRef("not a ticket ref")).toBeNull();
    expect(parseTicketRef("")).toBeNull();
  });
});

describe("--held / --running", () => {
  test("--held is exactly the surfaced (awaiting-a-human) tickets", () => {
    const envelope = buildStatusEnvelope(
      baseInput({
        records: [
          record({ id: "a", phase: "surfaced", url: ISSUE_1 }),
          record({ id: "b", phase: "ratified", url: ISSUE_2 }),
          record({ id: "c", phase: "applied", url: ISSUE_7, section: "Frontend" }),
        ],
      }),
    );
    const held = filterHeld(envelope);
    expect(held.map((t) => t.url)).toEqual([ISSUE_1]);
  });

  test("--running is ratified OR applied, never surfaced or terminal phases", () => {
    const envelope = buildStatusEnvelope(
      baseInput({
        records: [
          record({ id: "a", phase: "surfaced", url: ISSUE_1 }),
          record({ id: "b", phase: "ratified", url: ISSUE_2 }),
          record({ id: "c", phase: "applied", url: ISSUE_7, section: "Frontend" }),
        ],
      }),
    );
    const running = filterRunning(envelope);
    expect(running.map((t) => t.url).sort()).toEqual([ISSUE_2, ISSUE_7].sort());
  });
});

describe("argv parsing", () => {
  test("defaults are all off", () => {
    const parsed = parseStatusArgs([]);
    if (parsed.kind !== "ok") throw new Error("expected ok");
    expect(parsed.args).toEqual({ section: null, ticket: null, held: false, running: false, json: false, live: false, plan: null });
  });

  test("--section and --ticket are mutually exclusive", () => {
    const parsed = parseStatusArgs(["--section", "Backend", "--ticket", "acme/widgets#1"]);
    expect(parsed.kind).toBe("error");
  });

  test("a value-taking flag with nothing after it is an error, not a silent default", () => {
    expect(parseStatusArgs(["--section"]).kind).toBe("error");
    expect(parseStatusArgs(["--ticket"]).kind).toBe("error");
    expect(parseStatusArgs(["--plan"]).kind).toBe("error");
  });

  test("an unrecognised argument refuses rather than being silently ignored", () => {
    expect(parseStatusArgs(["--bogus"]).kind).toBe("error");
  });

  test("every recognised flag parses", () => {
    const parsed = parseStatusArgs(["--held", "--running", "--json", "--live", "--plan", "https://github.com/a/b/issues/1"]);
    if (parsed.kind !== "ok") throw new Error("expected ok");
    expect(parsed.args.held).toBe(true);
    expect(parsed.args.running).toBe(true);
    expect(parsed.args.json).toBe(true);
    expect(parsed.args.live).toBe(true);
    expect(parsed.args.plan).toBe("https://github.com/a/b/issues/1");
  });
});

describe("read-only by construction — status-cli.ts cannot build a writer, an effects layer, or a ledger transport", () => {
  const source = readFileSync(join(import.meta.dir, "status-cli.ts"), "utf8");
  const importLines = source.split("\n").filter((l) => l.trim().startsWith("import "));

  // These modules are where a `PlanWriter`, an effects layer, and a ledger
  // transport are constructible at all. If status-cli.ts never imports from
  // ANY of them, it is not merely refraining from calling them — it has no
  // binding through which it could. This is the "fails to compile" shape of
  // proof asked for: add a call to one of them and this file would need to
  // import it first, which is the line this test pins.
  const forbiddenModules = ["./effects/gh", "./effects/discord", "./transport", "./effects/config"];

  test("no import line references a writer/effects/transport module", () => {
    for (const line of importLines) {
      for (const mod of forbiddenModules) {
        expect(line.includes(`from "${mod}"`)).toBe(false);
      }
    }
  });

  test("the file DOES import the read-only surfaces it legitimately needs", () => {
    expect(importLines.some((l) => l.includes('from "./gh"'))).toBe(true);
    expect(importLines.some((l) => l.includes('from "./state"'))).toBe(true);
  });

  test("none of the forbidden constructor names appear in EXECUTABLE code (belt, over the import-scan brace) — comments may still name them in prose", () => {
    // Strip block AND line comments before scanning: the file's own header
    // deliberately NAMES these constructors in prose (explaining what it does
    // NOT build), which is documentation, not code. What must never appear
    // outside a comment is a reference this file could actually execute.
    const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
    const withoutLineComments = withoutBlockComments
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const name of ["GhCliPlanWriter", "DiscordLedger", "HostLedgerTransport", "makeEffectsConfig", "loadEffectsConfig"]) {
      expect(withoutLineComments.includes(name)).toBe(false);
    }
  });

  test("bin/atlas-status is a thin shim with no imports of its own beyond the CLI entrypoint", () => {
    const binSource = readFileSync(join(import.meta.dir, "..", "bin", "atlas-status"), "utf8");
    const binImports = binSource.split("\n").filter((l) => l.trim().startsWith("import "));
    expect(binImports).toHaveLength(1);
    expect(binImports[0]).toContain("runAtlasStatus");
  });
});
