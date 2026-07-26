import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeRatifierAction,
  identityConfigFromPorts,
  StaticPrincipalMap,
  StaticSelfIdentity,
  type RatifyIdentityConfig,
} from "./identity";
import { requireRatification, type RatificationCertificate } from "./ratification";
import {
  AtlasProposals,
  AtlasStateStore,
  defaultBundleDir,
  defaultInstanceDir,
  type DashboardSpawnResult,
} from "./state";

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

// ════════════════════════════════════════════════════════════════════════════
// atlas#8 — "outsider-paced cost": an outsider commenting on the public intake
// issue must not be able to (1) make every subsequent gate message's replay
// check cost proportional to how much they spammed, or (2) turn a burst of
// their comments into a burst of `bun` subprocesses. Both criteria in the
// issue are timing claims ("flat, not linear"; "O(1)-ish") — flaky as CI
// gates and unfalsifiable as written — so both are restated below as
// STRUCTURAL assertions: an index the query planner must use, and a spawn
// count an injected seam can observe directly, rather than a clock.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Reach into the raw DB, capture the SQL text of the first `.query(...)`
 * call `fn` makes against it, then restore the original method. Same
 * monkey-patch shape as `ratify.test.ts`'s `failNextQuery` — a capture
 * instead of a fault injection.
 */
function captureQuerySql(fn: () => void): string {
  const holder = store as unknown as { db: Database };
  const real = holder.db;
  const original = real.query.bind(real);
  let captured: string | null = null;
  (real as unknown as { query: unknown }).query = (sql: string) => {
    if (captured === null) captured = sql;
    return original(sql);
  };
  try {
    fn();
  } finally {
    (real as unknown as { query: unknown }).query = original;
  }
  if (captured === null) throw new Error("fixture: expected a query to be captured");
  return captured;
}

describe("atlas#8 finding 1 — replay-check cost is independent of outsider-created event rows", () => {
  test("validation declines from spam intake comments never enter the replay index", () => {
    // `markDeclined` is the W2a validation-decline path — reachable from
    // EVERY invalid public `ADD:`/`REMOVE:` comment, with no `gate_message_id`
    // in its payload (it is not a gate decision). Before this fix these rows
    // inflated the `work_item_resolved` bucket `hasSeenGateMessage` scanned;
    // now they must never even reach the replay index.
    for (let i = 0; i < 200; i++) {
      proposals.createIntake(`spam-${i}`, "ADD", URL, null, "spam", "outsider");
      proposals.markDeclined(`spam-${i}`, "malformed");
    }
    const db = (store as unknown as { db: Database }).db;
    const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM gate_replay_keys`).get();
    expect(row?.n ?? -1).toBe(0);
  });

  test("hasSeenGateMessage's query plans a search on the dedicated index, not events", () => {
    // Same spam as above, so a regression back to the old query would have
    // something real to be slow (and wrong) about.
    for (let i = 0; i < 200; i++) {
      proposals.createIntake(`spam2-${i}`, "ADD", URL, null, "spam", "outsider");
      proposals.markDeclined(`spam2-${i}`, "malformed");
    }

    const sql = captureQuerySql(() => {
      store.hasSeenGateMessage("m-does-not-exist");
    });

    const db = (store as unknown as { db: Database }).db;
    const plan = db
      .query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all("m-does-not-exist");
    const detail = plan.map((r) => r.detail).join(" | ");

    // The restated structural form of "flat, not linear": the replay check
    // must search the dedicated `gate_replay_keys` table (whose size the
    // spam above never touches — see the test above), not scan `events`
    // (whose `work_item_resolved` bucket the same spam inflates directly).
    expect(detail).toContain("gate_replay_keys");
    expect(detail).not.toContain("events");
  });
});

describe("atlas#8 finding 5 — dashboard-regen subprocess spawns are bounded, not one per transition", () => {
  let bundleDir: string;

  beforeEach(() => {
    // A fake agent-state bundle: `existsSync` must find the script for
    // `regenDashboard` to reach the (injected) spawn seam at all.
    bundleDir = mkdtempSync(join(tmpdir(), "atlas-fake-bundle-"));
    mkdirSync(join(bundleDir, "skill", "scripts"), { recursive: true });
    writeFileSync(join(bundleDir, "skill", "scripts", "dashboard.ts"), "// fixture, never executed\n");
  });

  afterEach(() => {
    rmSync(bundleDir, { recursive: true, force: true });
  });

  test("a synchronous burst of N transitions spawns the dashboard regen AT MOST ONCE", async () => {
    let spawnCount = 0;
    const dir2 = mkdtempSync(join(tmpdir(), "atlas-state-test-burst-"));
    const opened = AtlasStateStore.open({
      dir: dir2,
      bundleDir,
      dashboardDebounceMs: 20,
      spawnDashboardProcess: (): DashboardSpawnResult => {
        spawnCount += 1;
        return { exited: Promise.resolve(0) };
      },
    });
    if (opened === null) throw new Error("fixture: expected open to succeed");
    const proposals2 = new AtlasProposals(opened);
    try {
      // A burst of N inbound "invalid comment" transitions, all synchronous
      // (no await between any of them) — exactly what an outsider spamming
      // the intake path produces. Each call reaches `regenDashboard()`.
      for (let i = 0; i < 50; i++) {
        proposals2.createIntake(`burst-${i}`, "ADD", URL, null, "spam", "outsider");
        proposals2.markDeclined(`burst-${i}`, "malformed");
      }
      // Nothing has spawned yet — the debounce window has not elapsed, so
      // the whole burst is still coalesced onto one pending timer.
      expect(spawnCount).toBe(0);

      await Bun.sleep(60); // past the debounce window

      // 50 transitions, ONE spawn — not 50.
      expect(spawnCount).toBe(1);
    } finally {
      opened.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("transitions arriving WHILE a spawn is running coalesce onto exactly one more spawn, never one per caller", async () => {
    let spawnCount = 0;
    let resolveCurrent: ((code: number) => void) | null = null;
    const dir2 = mkdtempSync(join(tmpdir(), "atlas-state-test-coalesce-"));
    const opened = AtlasStateStore.open({
      dir: dir2,
      bundleDir,
      dashboardDebounceMs: 10,
      spawnDashboardProcess: (): DashboardSpawnResult => {
        spawnCount += 1;
        return {
          exited: new Promise<number>((resolve) => {
            resolveCurrent = resolve;
          }),
        };
      },
    });
    if (opened === null) throw new Error("fixture: expected open to succeed");
    const proposals2 = new AtlasProposals(opened);
    try {
      proposals2.createIntake("first", "ADD", URL, null, "reason", "octocat");
      proposals2.markDeclined("first", "malformed");
      await Bun.sleep(30); // past the debounce window — spawn #1 is now "running"
      expect(spawnCount).toBe(1);
      expect(resolveCurrent).not.toBeNull();

      // A burst of MORE transitions while spawn #1 is still in flight — the
      // property under test: this must NOT be one spawn per transition.
      for (let i = 0; i < 10; i++) {
        proposals2.createIntake(`mid-${i}`, "ADD", URL, null, "spam", "outsider");
        proposals2.markDeclined(`mid-${i}`, "malformed");
      }
      expect(spawnCount).toBe(1); // still just the one, still-running spawn

      // Let spawn #1 finish; the pending flag the burst above set should
      // trigger exactly ONE more debounced spawn — not ten.
      resolveCurrent!(0);
      await Bun.sleep(30);

      expect(spawnCount).toBe(2);
    } finally {
      opened.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("atlas#15/#19 — defaultInstanceDir / defaultBundleDir path resolution", () => {
  test("defaultInstanceDir names the flat ~/.config/cortex/agents/atlas convention, not the metafactory/cortex config-move path", () => {
    // Matches arc-manifest.yaml's `owns.state` and cortex's own
    // `resolveInstanceDir()` (host hardcoded to the literal "cortex" at every
    // call site — never derived from cortexConfigDir()/METAFACTORY_DIRNAME).
    expect(defaultInstanceDir()).toBe(join(homedir(), ".config", "cortex", "agents", "atlas"));
    expect(defaultInstanceDir()).not.toContain("metafactory/cortex");
  });

  describe("defaultBundleDir — existence-gated canonical/legacy resolution", () => {
    let fakeHome: string;

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), "atlas-bundle-home-"));
    });

    afterEach(() => {
      rmSync(fakeHome, { recursive: true, force: true });
    });

    test("neither tree exists -> falls back to the canonical path (never the legacy one)", () => {
      const dirPath = defaultBundleDir({ home: fakeHome, env: {} });
      expect(dirPath).toBe(
        join(fakeHome, ".local", "share", "metafactory", "arc", "repos", "agent-state"),
      );
    });

    test("only the legacy pre-arc#287 tree exists -> resolves to it", () => {
      const legacy = join(fakeHome, ".config", "metafactory", "pkg", "repos", "agent-state");
      mkdirSync(legacy, { recursive: true });
      const dirPath = defaultBundleDir({ home: fakeHome, env: {} });
      expect(dirPath).toBe(legacy);
    });

    test("both trees exist -> the canonical (current arc install) tree wins", () => {
      const canonical = join(
        fakeHome,
        ".local",
        "share",
        "metafactory",
        "arc",
        "repos",
        "agent-state",
      );
      const legacy = join(fakeHome, ".config", "metafactory", "pkg", "repos", "agent-state");
      mkdirSync(canonical, { recursive: true });
      mkdirSync(legacy, { recursive: true });
      const dirPath = defaultBundleDir({ home: fakeHome, env: {} });
      expect(dirPath).toBe(canonical);
    });

    test("honors $XDG_DATA_HOME for the canonical tree", () => {
      const xdgData = join(fakeHome, "custom-data-home");
      const canonical = join(xdgData, "metafactory", "arc", "repos", "agent-state");
      mkdirSync(canonical, { recursive: true });
      const dirPath = defaultBundleDir({ home: fakeHome, env: { XDG_DATA_HOME: xdgData } });
      expect(dirPath).toBe(canonical);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The owned-thread registry (atlas#22 + atlas#25).
//
// This table is the ONLY state in the pack that WIDENS what Atlas will act on,
// so its tests are about the two directions separately: what it must remember
// (restart-safety — a forgotten thread is a conversation Atlas goes deaf in)
// and what it must refuse to remember (anything that does not look like a
// platform id, and anything at all while the store cannot persist).
// ═══════════════════════════════════════════════════════════════════════════

describe("owned threads — the admission registry", () => {
  test("a recorded thread is owned; an unrecorded one is not", () => {
    expect(proposals.isOwnedThread("thread-fixture-1")).toBe(false);
    expect(proposals.recordOwnedThread("thread-fixture-1", "task-fixture-1")).toBe(true);
    expect(proposals.isOwnedThread("thread-fixture-1")).toBe(true);
    expect(proposals.isOwnedThread("thread-fixture-2")).toBe(false);
  });

  test("RESTART-SAFE — a reopened store still owns the thread", () => {
    expect(proposals.recordOwnedThread("thread-fixture-restart", "task-fixture-1")).toBe(true);
    store.close();

    const reopened = AtlasStateStore.open({ dir, bundleDir: null });
    if (reopened === null) throw new Error("expected the store to reopen");
    store = reopened;
    proposals = new AtlasProposals(store);

    expect(proposals.isOwnedThread("thread-fixture-restart")).toBe(true);
    expect(store.ownedThreadCount()).toBe(1);
  });

  test("recording the same thread twice is a no-op that still reports success", () => {
    expect(proposals.recordOwnedThread("thread-fixture-1", "task-fixture-1")).toBe(true);
    expect(proposals.recordOwnedThread("thread-fixture-1", "task-fixture-2")).toBe(true);
    expect(store.ownedThreadCount()).toBe(1);
  });

  test("a malformed id is refused, not stored — this table decides what Atlas acts on", () => {
    for (const bad of ["", "   ", "thread with spaces", "thread\nnewline", "x".repeat(129)]) {
      expect(proposals.recordOwnedThread(bad, "task-fixture-1")).toBe(false);
      expect(proposals.isOwnedThread(bad)).toBe(false);
    }
    expect(store.ownedThreadCount()).toBe(0);
  });

  test("an empty channel never matches, whatever else the table holds", () => {
    expect(proposals.recordOwnedThread("thread-fixture-1", "task-fixture-1")).toBe(true);
    expect(proposals.isOwnedThread("")).toBe(false);
  });

  test("a snowflake-shaped id round-trips (the real Discord shape)", () => {
    // 17-20 decimal digits. A fixture value, never a live channel.
    const snowflake = "1".repeat(19);
    expect(proposals.recordOwnedThread(snowflake, "task-fixture-1")).toBe(true);
    expect(proposals.isOwnedThread(snowflake)).toBe(true);
  });

  test("FAIL-CLOSED in degraded mode: a memory-only store owns nothing", () => {
    const degraded = new AtlasProposals(null);
    expect(degraded.recordOwnedThread("thread-fixture-1", "task-fixture-1")).toBe(false);
    expect(degraded.isOwnedThread("thread-fixture-1")).toBe(false);
  });
});

// ── atlas#22/#25 × atlas#28: the registry must not break a READ-ONLY open ───
//
// The status CLI (atlas#28) opens `state.sqlite` with `{ readonly: true }`. A
// read-only handle CANNOT `CREATE TABLE IF NOT EXISTS` — SQLITE_READONLY — so
// an auxiliary table created unconditionally on every open would turn the
// status tool into a crash on any DB the current daemon has not yet touched.
// It does not, because `openReadOnly` constructs the store WITHOUT
// `applyMigration`; these tests pin that, from both directions.
describe("owned threads — the read-only open (atlas#28 interaction)", () => {
  test("a read-only open succeeds on a DB that already has the table", () => {
    expect(proposals.recordOwnedThread("thread-fixture-ro", "task-fixture-1")).toBe(true);
    store.close();

    const ro = AtlasStateStore.openReadOnly(dir);
    expect(ro).not.toBeNull();
    try {
      // The registry is readable through a read-only handle — no write, no create.
      expect(ro!.isOwnedThread("thread-fixture-ro")).toBe(true);
      expect(ro!.ownedThreadCount()).toBe(1);
    } finally {
      ro!.close();
    }

    const reopened = AtlasStateStore.open({ dir, bundleDir: null });
    if (reopened === null) throw new Error("expected the store to reopen read-write");
    store = reopened;
    proposals = new AtlasProposals(store);
  });

  test("STRUCTURAL — `openReadOnly` does not run the migration/create path at all", () => {
    // This is the mutation-killable form of the property, and it HAS to be
    // structural because the behavioural symptom is SILENT: on a WAL-mode
    // database (which every Atlas store is — `AtlasStateStore.open` sets
    // `journal_mode = WAL`), `CREATE TABLE IF NOT EXISTS` through a read-only
    // handle does NOT raise SQLITE_READONLY. Verified directly against
    // bun:sqlite: it is a no-op that creates nothing and reports nothing. So a
    // create wrongly placed on this path would not fail at open — it would
    // "succeed", and the first query against the still-absent table would
    // throw `no such table` somewhere else entirely, at status time. Assert
    // the shape, because the runtime cannot tell you.
    const src = readFileSync(join(import.meta.dir, "state.ts"), "utf8");
    const body = /static openReadOnly\(dir: string\): AtlasStateStore \| null \{[\s\S]*?\n  \}/.exec(
      src,
    );
    expect(body).not.toBeNull();
    expect(body![0]).toContain("readonly: true");
    expect(body![0]).not.toContain("applyMigration");
    expect(body![0]).not.toMatch(/CREATE TABLE/i);
  });

  test("a read-only open does NOT create the table — an older DB opens fine", () => {
    // The scenario the read-only path must survive: a `state.sqlite` written
    // before this table existed (modelled by dropping it), opened by the status
    // CLI before the upgraded daemon has ever run against it.
    store.close();
    const raw = new Database(join(dir, "state.sqlite"));
    raw.exec("DROP TABLE IF EXISTS owned_threads;");
    raw.close();

    const ro = AtlasStateStore.openReadOnly(dir);
    expect(ro).not.toBeNull();
    try {
      // Opening did not throw, and — the actual property — it did not try to
      // create anything: the table is still absent afterwards.
      const check = new Database(join(dir, "state.sqlite"), { readonly: true });
      const row = check
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'owned_threads'`,
        )
        .get();
      check.close();
      expect(row === null || row === undefined).toBe(true);
    } finally {
      ro!.close();
    }

    // …and the read-write open is what repairs it, on the very next daemon boot.
    const reopened = AtlasStateStore.open({ dir, bundleDir: null });
    if (reopened === null) throw new Error("expected the store to reopen read-write");
    store = reopened;
    proposals = new AtlasProposals(store);
    expect(store.ownedThreadCount()).toBe(0);
    expect(proposals.recordOwnedThread("thread-fixture-after-repair", "task-fixture-1")).toBe(true);
  });

  test("the status CLI never reads the admission registry", () => {
    // Structural: admission is a daemon concern. If a future status feature
    // starts reading `owned_threads`, it inherits the missing-table case above
    // and this test is the place that says so.
    for (const rel of ["status.ts", "status-cli.ts"]) {
      const src = readFileSync(join(import.meta.dir, rel), "utf8");
      expect(src).not.toMatch(/isOwnedThread|ownedThreadCount|owned_threads/);
    }
  });
});
