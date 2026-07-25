import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtlasProposals, AtlasStateStore } from "./state";

let dir: string;
let store: AtlasStateStore;
let proposals: AtlasProposals;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-state-test-"));
  const opened = AtlasStateStore.open({ dir, bundleDir: null });
  if (opened === null) throw new Error("expected AtlasStateStore.open to succeed in a temp dir");
  store = opened;
  proposals = new AtlasProposals(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const URL = "https://github.com/acme/widgets/issues/1";

describe("AtlasProposals — lifecycle", () => {
  test("intake -> validated -> surfaced, with events at each transition", () => {
    proposals.createIntake("c1", "ADD", URL, "Backend", "good reason", "octocat");
    expect(proposals.get("c1")?.phase).toBe("intake");

    proposals.markValidated("c1", true);
    expect(proposals.get("c1")?.phase).toBe("validated");

    const displayId = proposals.markSurfaced("c1");
    expect(displayId).toBe(1);
    proposals.recordSummary("c1", "Proposal #1 — ADD: ...");
    expect(proposals.get("c1")?.phase).toBe("surfaced");
    expect(proposals.get("c1")?.displayId).toBe(1);
  });

  test("declined from intake (malformed path)", () => {
    proposals.createIntake("c2", "ADD", "", null, "(malformed: bad url)", "octocat");
    proposals.markDeclined("c2", "malformed: bad url");
    expect(proposals.get("c2")?.phase).toBe("declined");
  });

  test("declined from validated (ground-truth failure)", () => {
    proposals.createIntake("c3", "ADD", URL, null, "reason", "octocat");
    proposals.markValidated("c3", true);
    proposals.markDeclined("c3", "already on the plan");
    expect(proposals.get("c3")?.phase).toBe("declined");
  });

  test("a declined (terminal) row is never re-resolved", () => {
    proposals.createIntake("c4", "ADD", URL, null, "reason", "octocat");
    proposals.markDeclined("c4", "issue not found");
    expect(proposals.get("c4")?.phase).toBe("declined");
    // A stray second decline call must not throw and must not emit a second
    // resolution event (agent-state discipline: never re-resolve terminal).
    proposals.markDeclined("c4", "issue not open");
    expect(proposals.get("c4")?.phase).toBe("declined");
  });

  test("createIntake is idempotent — a redelivered comment id creates no second row", () => {
    proposals.createIntake("c5", "ADD", URL, null, "first", "octocat");
    proposals.createIntake("c5", "ADD", URL, null, "SECOND — should be ignored", "mallory");
    expect(proposals.get("c5")?.why).toBe("first");
    expect(proposals.get("c5")?.proposer).toBe("octocat");
  });

  test("display ids are sequential and never collide across two proposals surfaced out of order", () => {
    proposals.createIntake("a", "ADD", URL, null, "reason a", "alice");
    proposals.createIntake("b", "ADD", URL + "0", null, "reason b", "bob");
    proposals.markValidated("a", true);
    proposals.markValidated("b", true);
    const idA = proposals.markSurfaced("a");
    const idB = proposals.markSurfaced("b");
    expect(idA).not.toBe(idB);
    expect([idA, idB].sort()).toEqual([1, 2]);
  });

  test("markSurfaced returns null (never throws) on a row that is not validated", () => {
    proposals.createIntake("c6", "ADD", URL, null, "reason", "octocat");
    // Precondition violation, not a DB failure — must not throw, and must not
    // trip AtlasProposals' fail-soft degradation (see state.ts's comment on
    // markSurfaced for why a thrown precondition would be misdiagnosed as
    // "the DB is broken" and silently degrade every other proposal too).
    expect(proposals.markSurfaced("c6")).toBeNull();
    expect(proposals.get("c6")?.phase).toBe("intake"); // unchanged
  });
});

describe("AtlasStateStore — events table (raw check)", () => {
  test("one event per transition, in order", () => {
    proposals.createIntake("e1", "ADD", URL, null, "reason", "octocat");
    proposals.markValidated("e1", true);
    proposals.markSurfaced("e1");

    // Reach into the underlying DB directly for this one assertion — the
    // public surface intentionally doesn't expose raw event rows.
    const db = (store as unknown as { db: Database }).db;
    const rows = db
      .query<{ type: string }, [string]>(
        `SELECT type FROM events WHERE work_item_id = ? ORDER BY id ASC`,
      )
      .all("e1");
    expect(rows.map((r) => r.type)).toEqual([
      "work_item_created",
      "work_item_claimed",
      "work_item_annotated", // issue_open annotation
      "work_item_parked",
      "work_item_annotated", // display_id annotation
    ]);
  });
});

describe("AtlasProposals — memory fallback (no DB)", () => {
  test("still tracks phase and displayId when the DB is unavailable", () => {
    const memOnly = new AtlasProposals(null);
    memOnly.createIntake("m1", "ADD", URL, null, "reason", "octocat");
    expect(memOnly.get("m1")?.phase).toBe("intake");
    memOnly.markValidated("m1", true);
    const id = memOnly.markSurfaced("m1");
    expect(id).toBe(1);
    expect(memOnly.get("m1")?.phase).toBe("surfaced");
  });
});
