import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeRatifierAction,
  identityConfigFromPorts,
  StaticPrincipalMap,
  StaticSelfIdentity,
  type RatifyIdentityConfig,
} from "./identity";
import { requireRatification, type RatificationCertificate } from "./ratification";
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

describe("W2c — the applied → posted transition and completion records", () => {
  const PLATFORM = "discord";
  const PRINCIPAL_ID = "plan-steward";
  const PRINCIPAL_PLATFORM_ID = "pid-principal-fixture";
  const ATLAS_PLATFORM_ID = "pid-atlas-self-fixture";

  function identity(): RatifyIdentityConfig {
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

  /** Drive a proposal all the way to a real certificate, the only way there is. */
  function certify(id: string, cfg: RatifyIdentityConfig): RatificationCertificate {
    proposals.createIntake(id, "ADD", URL, "Backend", "reason", "octocat");
    proposals.markValidated(id, true);
    proposals.markSurfaced(id);
    const authority = authorizeRatifierAction(cfg, {
      platform: PLATFORM,
      platformId: PRINCIPAL_PLATFORM_ID,
      messageId: `m-${id}`,
    });
    if (authority === null) throw new Error("fixture: expected an authority");
    if (proposals.markRatified(id, authority) === null) {
      throw new Error("fixture: expected a ratification");
    }
    const cert = requireRatification(proposals, id);
    if (cert === null) throw new Error("fixture: expected a certificate");
    return cert;
  }

  const RECEIPT = { messageId: "msg-fixture-1", channelId: "chan-fixture-0000", ts: Date.now() };

  test("posted requires an APPLIED row — it cannot skip the plan edit", () => {
    const cfg = identity();
    const cert = certify("p1", cfg);
    // Still `ratified`: there is no path from here to `posted`.
    expect(proposals.markPosted(cert, cfg.ratifier, RECEIPT)).toBe(false);
    expect(proposals.get("p1")?.phase).toBe("ratified");
  });

  test("applied → posted records the receipt and moves the phase", () => {
    const cfg = identity();
    const cert = certify("p2", cfg);
    expect(proposals.markApplied(cert, cfg.ratifier, { revision: "rev-1", ts: Date.now() })).toBe(true);
    expect(proposals.get("p2")?.phase).toBe("applied");
    expect(proposals.get("p2")?.applied?.revision).toBe("rev-1");

    expect(proposals.markPosted(cert, cfg.ratifier, RECEIPT)).toBe(true);
    const record = proposals.get("p2");
    expect(record?.phase).toBe("posted");
    expect(record?.posted?.messageId).toBe("msg-fixture-1");
    expect(record?.posted?.channelId).toBe("chan-fixture-0000");
  });

  test("a posted receipt is never rewritten (constitution rule 4)", () => {
    const cfg = identity();
    const cert = certify("p3", cfg);
    proposals.markApplied(cert, cfg.ratifier, { revision: "rev-1", ts: Date.now() });
    expect(proposals.markPosted(cert, cfg.ratifier, RECEIPT)).toBe(true);
    expect(
      proposals.markPosted(cert, cfg.ratifier, { ...RECEIPT, messageId: "msg-fixture-2" }),
    ).toBe(false);
    expect(proposals.get("p3")?.posted?.messageId).toBe("msg-fixture-1");
  });

  test("a FORGED certificate cannot record a posted receipt either", () => {
    const cfg = identity();
    const cert = certify("p4", cfg);
    proposals.markApplied(cert, cfg.ratifier, { revision: "rev-1", ts: Date.now() });
    const forged = { ...cert } as RatificationCertificate;
    expect(proposals.markPosted(forged, cfg.ratifier, RECEIPT)).toBe(false);
    expect(proposals.get("p4")?.phase).toBe("applied");
  });

  test("a certificate naming a DIFFERENT configured ratifier is refused", () => {
    const cfg = identity();
    const cert = certify("p5", cfg);
    proposals.markApplied(cert, cfg.ratifier, { revision: "rev-1", ts: Date.now() });
    const other = identityConfigFromPorts({
      ratifierPrincipalId: "someone-else",
      principals: new StaticPrincipalMap([]),
      self: new StaticSelfIdentity([{ platform: PLATFORM, id: ATLAS_PLATFORM_ID }]),
    });
    if (other === null) throw new Error("fixture");
    expect(proposals.markPosted(cert, other.ratifier, RECEIPT)).toBe(false);
  });

  test("a receipt with no message id or no channel id is not a receipt", () => {
    const cfg = identity();
    const cert = certify("p6", cfg);
    proposals.markApplied(cert, cfg.ratifier, { revision: "rev-1", ts: Date.now() });
    expect(proposals.markPosted(cert, cfg.ratifier, { ...RECEIPT, messageId: "" })).toBe(false);
    expect(proposals.markPosted(cert, cfg.ratifier, { ...RECEIPT, channelId: "" })).toBe(false);
    expect(proposals.get("p6")?.phase).toBe("applied");
  });

  test("completion announcements are durable, per URL, and never burn a gate replay key", () => {
    const url = "https://github.com/acme/widgets/issues/9";
    expect(proposals.hasAnnouncedCompletion(url)).toBe(false);
    proposals.recordCompletionAnnounced(url, "msg-fixture-1");
    expect(proposals.hasAnnouncedCompletion(url)).toBe(true);
    expect(proposals.hasAnnouncedCompletion("https://github.com/acme/widgets/issues/90")).toBe(false);
    // The record lives OUTSIDE the gate's replay index, so it cannot consume a
    // gate message key — see state.ts's GATE_EVENT_TYPES.
    const db = (store as unknown as { db: Database }).db;
    const rows = db
      .query<{ type: string }, []>(`SELECT type FROM events WHERE work_item_id IS NULL`)
      .all();
    expect(rows.map((r) => r.type)).toEqual(["completion_announced"]);
  });

  test("a degraded store answers 'already announced' — fail closed, never a post loop", () => {
    const memOnly = new AtlasProposals(null);
    expect(memOnly.hasAnnouncedCompletion("https://github.com/acme/widgets/issues/9")).toBe(true);
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
