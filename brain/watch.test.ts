/**
 * The completion watcher's suite (W2c, issue #1, J4).
 *
 * Runs against a real SQLite store, because the property that matters most —
 * "already announced" survives a restart — is a property of the event log, not
 * of a process-local set. A restart is simulated by building a NEW ledger (a
 * fresh in-memory queue and day flag) over the SAME store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordLedger } from "./effects/discord";
import { makeEffectsConfig, type EffectsConfig } from "./effects/config";
import { GhCliPlanWriter } from "./effects/gh";
import type { LinkedIssueState } from "./gh";
import { AtlasProposals, AtlasStateStore } from "./state";
import { FakeLinkedIssues, FakePlanRepo, RecordingTransport } from "./test-support";
import { extractLinkedIssueUrls, pollCompletions, resolvePollIntervalMs } from "./watch";

const CHANNEL_ID = "chan-fixture-0000";
const ISSUE_1 = "https://github.com/acme/widgets/issues/1";
const ISSUE_2 = "https://github.com/acme/widgets/issues/2";
const ISSUE_7 = "https://github.com/other-org/other-repo/issues/7";

const PLAN_BODY = [
  "# Iteration 1",
  "",
  "## Backend",
  `- [ ] ${ISSUE_1}`,
  `- [x] ${ISSUE_2}`,
  "",
  "## Cross-repo",
  `- [ ] ${ISSUE_7}`,
  "",
].join("\n");

const DAY_ONE = Date.UTC(2026, 6, 26, 9, 0, 0);
const DAY_ONE_LATER = Date.UTC(2026, 6, 26, 22, 0, 0);
const DAY_TWO = Date.UTC(2026, 6, 27, 9, 0, 0);

function closed(title: string, pr: string | null = null): LinkedIssueState {
  return { closed: true, title, closedAt: "2026-07-26T08:00:00Z", referencingPrUrl: pr };
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
let effects: EffectsConfig;
let repo: FakePlanRepo;
let transport: RecordingTransport;
let plan: GhCliPlanWriter;
let ledger: DiscordLedger;
let gh: FakeLinkedIssues;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-watch-test-"));
  const opened = AtlasStateStore.open({ dir, bundleDir: null });
  if (opened === null) throw new Error("fixture: expected the store to open");
  store = opened;
  state = new AtlasProposals(store);
  const loaded = makeEffectsConfig({
    planRepo: "acme/widgets",
    planIssue: 4,
    channelId: CHANNEL_ID,
  });
  if (loaded.kind !== "ok") throw new Error("fixture: effects config refused");
  effects = loaded.config;
  repo = new FakePlanRepo(PLAN_BODY);
  transport = new RecordingTransport();
  plan = new GhCliPlanWriter(effects, repo.spawn);
  ledger = new DiscordLedger(effects, transport);
  gh = new FakeLinkedIssues();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("extractLinkedIssueUrls", () => {
  test("finds every distinct issue URL, in body order, across repos", () => {
    expect(extractLinkedIssueUrls(PLAN_BODY)).toEqual([ISSUE_1, ISSUE_2, ISSUE_7]);
  });

  test("de-duplicates and ignores PR/other URLs", () => {
    const body = [
      ISSUE_1,
      ISSUE_1,
      "https://github.com/acme/widgets/pull/3",
      "https://gitlab.example/acme/widgets/issues/9",
      "https://github.com/acme/widgets/issues/0",
    ].join("\n");
    expect(extractLinkedIssueUrls(body)).toEqual([ISSUE_1]);
  });

  test("is safe to call repeatedly (no shared regex lastIndex)", () => {
    expect(extractLinkedIssueUrls(PLAN_BODY)).toEqual(extractLinkedIssueUrls(PLAN_BODY));
  });

  test("empty and non-string bodies yield nothing", () => {
    expect(extractLinkedIssueUrls("")).toEqual([]);
    expect(extractLinkedIssueUrls(undefined as unknown as string)).toEqual([]);
  });
});

describe("a newly-closed plan-linked issue produces one ✅", () => {
  test("posts, carries a receipt, and records the announcement durably", async () => {
    gh.set(ISSUE_1, closed("intake landed", "https://github.com/acme/widgets/pull/5"));
    gh.set(ISSUE_2, OPEN);
    gh.set(ISSUE_7, OPEN);

    const outcome = await pollCompletions({ state, plan, gh, ledger }, DAY_ONE);
    if (outcome.kind !== "polled") throw new Error(`expected polled, got ${outcome.kind}`);

    expect(outcome.enqueued).toBe(1);
    expect(outcome.flush.kind).toBe("posted");
    expect(outcome.recorded).toBe(1);
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]!.channelId).toBe(CHANNEL_ID);
    expect(transport.posts[0]!.content).toContain("✅ acme/widgets#1");
    expect(transport.posts[0]!.content).toContain('"intake landed"');
    expect(transport.posts[0]!.content).toContain("https://github.com/acme/widgets/pull/5");
    expect(state.hasAnnouncedCompletion(ISSUE_1)).toBe(true);
  });

  test("a closure with no known PR still carries the issue URL as its receipt", async () => {
    gh.set(ISSUE_1, closed("done"));
    gh.set(ISSUE_2, OPEN);
    gh.set(ISSUE_7, OPEN);
    await pollCompletions({ state, plan, gh, ledger }, DAY_ONE);
    expect(transport.posts[0]!.content).toContain(ISSUE_1);
  });

  test("an issue that is still open is not announced", async () => {
    gh.set(ISSUE_1, OPEN);
    gh.set(ISSUE_2, OPEN);
    gh.set(ISSUE_7, OPEN);
    const outcome = await pollCompletions({ state, plan, gh, ledger }, DAY_ONE);
    expect(outcome.kind === "polled" && outcome.enqueued).toBe(0);
    expect(transport.posts).toHaveLength(0);
  });

  test("a failed read is never reported as a closure", async () => {
    gh.set(ISSUE_1, null); // read failure / not found
    const outcome = await pollCompletions({ state, plan, gh, ledger }, DAY_ONE);
    expect(outcome.kind === "polled" && outcome.enqueued).toBe(0);
    expect(transport.posts).toHaveLength(0);
    expect(state.hasAnnouncedCompletion(ISSUE_1)).toBe(false);
  });

  test("a throwing read is a skipped item, not an escaping exception", async () => {
    const throwing = {
      async getLinkedIssue(): Promise<LinkedIssueState | null> {
        throw new Error("gh exploded");
      },
    };
    const outcome = await pollCompletions({ state, plan, gh: throwing, ledger }, DAY_ONE);
    expect(outcome.kind).toBe("polled");
    expect(transport.posts).toHaveLength(0);
  });
});

describe("two same-day closures produce ONE batched post", () => {
  test("observed in the same pass", async () => {
    gh.set(ISSUE_1, closed("first"));
    gh.set(ISSUE_2, closed("second"));
    gh.set(ISSUE_7, OPEN);

    const outcome = await pollCompletions({ state, plan, gh, ledger }, DAY_ONE);
    expect(outcome.kind === "polled" && outcome.enqueued).toBe(2);
    expect(transport.posts).toHaveLength(1);
    const content = transport.posts[0]!.content;
    expect(content).toContain("✅ Plan items completed — 2 today");
    expect(content).toContain("acme/widgets#1");
    expect(content).toContain("acme/widgets#2");
    expect(state.hasAnnouncedCompletion(ISSUE_1)).toBe(true);
    expect(state.hasAnnouncedCompletion(ISSUE_2)).toBe(true);
  });

  test("observed in two passes on the same day — still ONE post that day", async () => {
    gh.set(ISSUE_1, closed("first"));
    gh.set(ISSUE_2, OPEN);
    gh.set(ISSUE_7, OPEN);
    await pollCompletions({ state, plan, gh, ledger }, DAY_ONE);
    expect(transport.posts).toHaveLength(1);

    gh.set(ISSUE_2, closed("second"));
    const second = await pollCompletions({ state, plan, gh, ledger }, DAY_ONE_LATER);
    expect(second.kind === "polled" && second.flush.kind).toBe("held");
    expect(transport.posts).toHaveLength(1); // the channel is a ledger, not a ticker
    expect(state.hasAnnouncedCompletion(ISSUE_2)).toBe(false); // nothing claimed

    // Held, never lost: it goes out with the next day's single post.
    const third = await pollCompletions({ state, plan, gh, ledger }, DAY_TWO);
    expect(third.kind === "polled" && third.flush.kind).toBe("posted");
    expect(transport.posts).toHaveLength(2);
    expect(transport.posts[1]!.content).toContain("acme/widgets#2");
    expect(state.hasAnnouncedCompletion(ISSUE_2)).toBe(true);
  });
});

describe("announcements are durable, and nothing is claimed that did not land", () => {
  test("a restart does not re-announce what already went out", async () => {
    gh.set(ISSUE_1, closed("first"));
    gh.set(ISSUE_2, OPEN);
    gh.set(ISSUE_7, OPEN);
    await pollCompletions({ state, plan, gh, ledger }, DAY_ONE);
    expect(transport.posts).toHaveLength(1);

    // "Restart": a brand new ledger (empty queue, no day flag) over the SAME
    // durable store. An in-process memory would re-announce here.
    const afterRestart = new DiscordLedger(effects, transport);
    const outcome = await pollCompletions(
      { state, plan, gh, ledger: afterRestart },
      DAY_TWO,
    );
    expect(outcome.kind === "polled" && outcome.enqueued).toBe(0);
    expect(transport.posts).toHaveLength(1);
    // The already-announced issue is not even re-READ.
    expect(gh.calls.filter((c) => c === ISSUE_1)).toHaveLength(1);
  });

  test("a failed post records nothing, and the next pass retries it", async () => {
    gh.set(ISSUE_1, closed("first"));
    gh.set(ISSUE_2, OPEN);
    gh.set(ISSUE_7, OPEN);
    transport.failFirst = 1;

    const first = await pollCompletions({ state, plan, gh, ledger }, DAY_ONE);
    expect(first.kind === "polled" && first.flush.kind).toBe("failed");
    expect(first.kind === "polled" && first.recorded).toBe(0);
    expect(state.hasAnnouncedCompletion(ISSUE_1)).toBe(false);

    const second = await pollCompletions({ state, plan, gh, ledger }, DAY_ONE_LATER);
    expect(second.kind === "polled" && second.flush.kind).toBe("posted");
    expect(state.hasAnnouncedCompletion(ISSUE_1)).toBe(true);
    expect(transport.posts).toHaveLength(1);
  });

  test("a degraded store refuses the whole pass — no reads, no posts", async () => {
    const degraded = new AtlasProposals(null);
    gh.set(ISSUE_1, closed("first"));
    const outcome = await pollCompletions({ state: degraded, plan, gh, ledger }, DAY_ONE);
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toBe("state-degraded");
    expect(gh.calls).toHaveLength(0);
    expect(repo.invocations).toHaveLength(0);
    expect(transport.posts).toHaveLength(0);
  });

  test("an unreadable plan body refuses the pass rather than announcing nothing forever", async () => {
    repo.failReads = true;
    const outcome = await pollCompletions({ state, plan, gh, ledger }, DAY_ONE);
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toBe("plan-unreadable");
    expect(transport.posts).toHaveLength(0);
  });

  test("the plan body read is aimed at the configured issue, from config", async () => {
    await pollCompletions({ state, plan, gh, ledger }, DAY_ONE);
    const view = repo.invocations[0]!;
    expect(view.argv.slice(0, 4)).toEqual(["gh", "issue", "view", "4"]);
    expect(view.argv[view.argv.indexOf("--repo") + 1]).toBe("acme/widgets");
  });
});

describe("poll cadence comes from config, clamped", () => {
  test("defaults to 15 minutes", () => {
    expect(resolvePollIntervalMs({})).toBe(900_000);
    expect(resolvePollIntervalMs({ ATLAS_WATCH_INTERVAL_MS: "" })).toBe(900_000);
    expect(resolvePollIntervalMs({ ATLAS_WATCH_INTERVAL_MS: "not a number" })).toBe(900_000);
  });

  test("honours a configured value, and clamps absurd ones", () => {
    expect(resolvePollIntervalMs({ ATLAS_WATCH_INTERVAL_MS: "300000" })).toBe(300_000);
    expect(resolvePollIntervalMs({ ATLAS_WATCH_INTERVAL_MS: "1" })).toBe(60_000);
    expect(resolvePollIntervalMs({ ATLAS_WATCH_INTERVAL_MS: "999999999999" })).toBe(86_400_000);
  });
});
