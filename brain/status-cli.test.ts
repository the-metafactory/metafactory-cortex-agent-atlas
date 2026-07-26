/**
 * `atlas status`'s impure shell — the properties that need a real filesystem
 * and a real (read-only) SQLite handle, and can't be asserted from the pure
 * `status.test.ts` suite alone:
 *   - it runs with NO daemon in the picture, read-only, and does not block a
 *     concurrent writer holding the same file open (issue #28's D3);
 *   - it refuses loudly (never an empty/fabricated success) when there is no
 *     local state, or no cached plan snapshot yet;
 *   - `--live` reports divergence via an injected fake reader, never a real
 *     network call;
 *   - `--plan` mismatches refuse rather than silently aggregating a second
 *     plan this instance never watched.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinkedIssueReader, LinkedIssueState } from "./gh";
import { AtlasStateStore } from "./state";
import { estimateDaemonRunning, runAtlasStatus } from "./status-cli";

const ISSUE_1 = "https://github.com/acme/widgets/issues/1";
const ISSUE_2 = "https://github.com/acme/widgets/issues/2";

const PLAN_BODY = [
  "# Iteration 1",
  "",
  "## Backend",
  `- [ ] ${ISSUE_1}`,
  `- [x] ${ISSUE_2}`,
  "",
].join("\n");

const ENV_BASE = { ATLAS_PLAN_REPO: "acme/widgets", ATLAS_PLAN_ISSUE: "4" };

function seededDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "atlas-status-cli-test-"));
  const store = AtlasStateStore.open({ dir, bundleDir: null });
  if (store === null) throw new Error("fixture: expected the store to open");
  store.recordPlanBodyCache(PLAN_BODY, "sha256:fixture0000000000000000");
  store.recordLinkedIssueTitle(ISSUE_1, "Fix the thing");
  store.recordWatchPass(Date.now());
  store.close();
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

class FakeReader implements LinkedIssueReader {
  constructor(private readonly states: Record<string, LinkedIssueState | null>) {}
  async getLinkedIssue(url: string): Promise<LinkedIssueState | null> {
    return this.states[url] ?? null;
  }
}

describe("no local state — an explicit refusal, never a fabricated status", () => {
  test("an empty/never-run instance dir refuses with a non-zero exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-status-cli-empty-"));
    try {
      const result = await runAtlasStatus([], { ...ENV_BASE, ATLAS_STATE_DIR: dir }, Date.now());
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("has not run here yet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a store that opened but never cached a plan snapshot ALSO refuses, never reports zero of everything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-status-cli-nocache-"));
    const store = AtlasStateStore.open({ dir, bundleDir: null });
    if (store === null) throw new Error("fixture: expected the store to open");
    store.close(); // schema exists, but no plan_body_cache row
    try {
      const result = await runAtlasStatus([], { ...ENV_BASE, ATLAS_STATE_DIR: dir }, Date.now());
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no plan snapshot cached");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the default (ledger) view — instant, offline", () => {
  test("reports totals, freshness and daemonRunning from cached state alone, with no --live", async () => {
    const { dir, cleanup } = seededDir();
    try {
      const result = await runAtlasStatus([], { ...ENV_BASE, ATLAS_STATE_DIR: dir }, Date.now());
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Plan: Iteration 1");
      expect(result.output).toContain("2 linked");
      expect(result.output).not.toContain("DAEMON NOT RUNNING");
    } finally {
      cleanup();
    }
  });

  test("--json emits a parseable atlas.plan.status.v1 envelope", async () => {
    const { dir, cleanup } = seededDir();
    try {
      const result = await runAtlasStatus(["--json"], { ...ENV_BASE, ATLAS_STATE_DIR: dir }, Date.now());
      const parsed = JSON.parse(result.output);
      expect(parsed.schema).toBe("atlas.plan.status.v1");
      expect(parsed.totals.linked).toBe(2);
      expect(parsed.live).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("daemonRunning goes false once the last watch pass is old relative to the poll interval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-status-cli-stale-"));
    const store = AtlasStateStore.open({ dir, bundleDir: null });
    if (store === null) throw new Error("fixture: expected the store to open");
    const longAgo = Date.now() - 60 * 60_000; // 1h ago
    store.recordPlanBodyCache(PLAN_BODY, "sha256:fixture0000000000000000", longAgo);
    store.recordWatchPass(longAgo);
    store.close();
    try {
      // Default poll interval is 15 minutes; 1h ago is well past 2.5x that.
      const result = await runAtlasStatus(["--json"], { ...ENV_BASE, ATLAS_STATE_DIR: dir }, Date.now());
      const parsed = JSON.parse(result.output);
      expect(parsed.freshness.daemonRunning).toBe(false);
      const humanResult = await runAtlasStatus([], { ...ENV_BASE, ATLAS_STATE_DIR: dir }, Date.now());
      expect(humanResult.output).toContain("DAEMON NOT RUNNING");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("--live — divergence via an injected fake reader, never a network call", () => {
  test("reports a ticket the ledger thinks is open but GitHub says is closed", async () => {
    const { dir, cleanup } = seededDir();
    try {
      const fake = new FakeReader({
        [ISSUE_1]: { closed: true, title: "Fix the thing", closedAt: "2026-07-26T04:00:00Z", referencingPrUrl: null },
        [ISSUE_2]: { closed: true, title: "Ship it", closedAt: "2026-07-20T00:00:00Z", referencingPrUrl: null },
      });
      const result = await runAtlasStatus(
        ["--json", "--live"],
        { ...ENV_BASE, ATLAS_STATE_DIR: dir },
        Date.now(),
        () => fake,
      );
      const parsed = JSON.parse(result.output);
      expect(parsed.live).toEqual({ open: 0, closed: 2, checkedAt: parsed.live.checkedAt });
      expect(parsed.divergence).toEqual([
        { ticket: "acme/widgets#1", ledger: "open", live: "closed", since: "2026-07-26T04:00:00Z" },
      ]);
    } finally {
      cleanup();
    }
  });

  test("--live without a resolvable plan repo/issue refuses rather than silently skipping the check", async () => {
    const { dir, cleanup } = seededDir();
    try {
      const result = await runAtlasStatus(["--live"], { ATLAS_STATE_DIR: dir }, Date.now());
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("--live requires");
    } finally {
      cleanup();
    }
  });
});

describe("--plan — a mismatch refuses; cross-plan aggregation is out of scope", () => {
  test("a --plan naming a DIFFERENT repo/issue than this instance is configured for refuses", async () => {
    const { dir, cleanup } = seededDir();
    try {
      const result = await runAtlasStatus(
        ["--plan", "https://github.com/other/repo/issues/9"],
        { ...ENV_BASE, ATLAS_STATE_DIR: dir },
        Date.now(),
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("does not match");
    } finally {
      cleanup();
    }
  });

  test("a --plan matching the configured plan is accepted", async () => {
    const { dir, cleanup } = seededDir();
    try {
      const result = await runAtlasStatus(
        ["--plan", "https://github.com/acme/widgets/issues/4"],
        { ...ENV_BASE, ATLAS_STATE_DIR: dir },
        Date.now(),
      );
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("--section / --ticket not-found — an explicit miss, never an empty success", () => {
  test("an unknown section exits non-zero and names what was not found", async () => {
    const { dir, cleanup } = seededDir();
    try {
      const result = await runAtlasStatus(["--section", "Nonexistent"], { ...ENV_BASE, ATLAS_STATE_DIR: dir }, Date.now());
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no section matching");
    } finally {
      cleanup();
    }
  });

  test("an unknown ticket exits non-zero and names what was not found", async () => {
    const { dir, cleanup } = seededDir();
    try {
      const result = await runAtlasStatus(["--ticket", "acme/widgets#999"], { ...ENV_BASE, ATLAS_STATE_DIR: dir }, Date.now());
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("no ticket matching");
    } finally {
      cleanup();
    }
  });

  test("a known ticket resolves and reports its section membership", async () => {
    const { dir, cleanup } = seededDir();
    try {
      const result = await runAtlasStatus(["--ticket", "acme/widgets#1"], { ...ENV_BASE, ATLAS_STATE_DIR: dir }, Date.now());
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("acme/widgets#1");
      expect(result.output).toContain("Fix the thing");
    } finally {
      cleanup();
    }
  });
});

describe("read-only does not block a concurrently open writer", () => {
  test("the read-only handle opens and reads while the write-mode store is still open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-status-cli-concurrent-"));
    const writer = AtlasStateStore.open({ dir, bundleDir: null });
    if (writer === null) throw new Error("fixture: expected the store to open");
    writer.recordPlanBodyCache(PLAN_BODY, "sha256:fixture0000000000000000");
    writer.recordWatchPass(Date.now());
    try {
      const result = await runAtlasStatus(["--json"], { ...ENV_BASE, ATLAS_STATE_DIR: dir }, Date.now());
      expect(result.exitCode).toBe(0);
      // The writer is STILL usable afterward — the reader never held a lock
      // that would have blocked or broken it.
      writer.createIntake("still-alive", "ADD", ISSUE_1, "Backend", "reason", "octocat");
      expect(writer.get("still-alive")?.phase).toBe("intake");
    } finally {
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("estimateDaemonRunning — a heuristic, documented as one", () => {
  test("null lastWatchPassTs is never running", () => {
    expect(estimateDaemonRunning(null, 900_000, Date.now())).toBe(false);
  });

  test("a recent pass within 2.5x the poll interval reads as running", () => {
    const now = Date.now();
    expect(estimateDaemonRunning(now - 100_000, 900_000, now)).toBe(true);
  });

  test("a pass older than 2.5x the poll interval reads as not running", () => {
    const now = Date.now();
    expect(estimateDaemonRunning(now - 3_000_000, 900_000, now)).toBe(false);
  });
});
