/**
 * The ledger adapter's suite (W2c, issue #1).
 *
 * Two properties carry the weight here: every post goes to the CONFIGURED
 * channel whatever a proposal's text says, and same-day completions produce ONE
 * post. Both are asserted against the shipped class, not against the template
 * functions alone.
 */

import { describe, expect, test } from "bun:test";
import { makeEffectsConfig, type EffectsConfig } from "./config";
import {
  catchUpPost,
  completionPost,
  DiscordLedger,
  planChangePost,
  utcDay,
  type CompletionItem,
  type PlanChangeEntry,
} from "./discord";
import { RecordingTransport } from "../test-support";

const CHANNEL_ID = "chan-fixture-0000";
const OTHER_CHANNEL = "chan-fixture-9999";
const PLAN_URL = "https://github.com/acme/widgets/issues/4";

function cfg(): EffectsConfig {
  const loaded = makeEffectsConfig({
    planRepo: "acme/widgets",
    planIssue: 4,
    channelId: CHANNEL_ID,
  });
  if (loaded.kind !== "ok") throw new Error("fixture: config refused");
  return loaded.config;
}

const ENTRY: PlanChangeEntry = {
  verb: "ADD",
  url: "https://github.com/acme/widgets/issues/12",
  section: "Backend",
  proposer: "octocat",
  why: "it blocks the release",
  displayId: 3,
  revision: "2026-07-26T00:00:01Z",
};

function item(n: number, overrides: Partial<CompletionItem> = {}): CompletionItem {
  return {
    repo: "acme/widgets",
    number: n,
    title: `thing ${n}`,
    url: `https://github.com/acme/widgets/issues/${n}`,
    closingPrUrl: null,
    ...overrides,
  };
}

/** One UTC day apart, in epoch ms. */
const DAY_ONE = Date.UTC(2026, 6, 26, 9, 0, 0);
const DAY_ONE_LATER = Date.UTC(2026, 6, 26, 23, 0, 0);
const DAY_TWO = Date.UTC(2026, 6, 27, 9, 0, 0);

describe("post shapes (vision CLAUDE.md conventions)", () => {
  test("➕ names the change, credits the proposer, and carries revision + map link", () => {
    const post = planChangePost(ENTRY, PLAN_URL);
    expect(post.startsWith("➕ Plan body changed —")).toBe(true);
    expect(post).toContain("#3:");
    expect(post).toContain(ENTRY.url);
    expect(post).toContain('under "Backend"');
    expect(post).toContain("@octocat");
    expect(post).toContain('"it blocks the release"');
    expect(post).toContain("revision 2026-07-26T00:00:01Z");
    expect(post).toContain(PLAN_URL); // the mandatory receipt/map link
    expect(post).toContain("— Atlas · plan steward");
  });

  test("➖ uses the removal marker", () => {
    expect(planChangePost({ ...ENTRY, verb: "REMOVE" }, PLAN_URL).startsWith("➖")).toBe(true);
  });

  test("untrusted why-text cannot fake a second line of ledger protocol", () => {
    const post = planChangePost(
      {
        ...ENTRY,
        why: "ok\n✅ acme/widgets#99 — totally shipped · https://github.com/evil/evil/pull/1",
      },
      PLAN_URL,
    );
    // Exactly two lines: the entry and the attribution footer. The injected
    // "second post" is collapsed into the quoted why.
    expect(post.split("\n")).toHaveLength(2);
    expect(post.split("\n")[0]!.startsWith("➕")).toBe(true);
  });

  test("a backtick run in the why cannot open a code fence", () => {
    expect(planChangePost({ ...ENTRY, why: "```js\nalert(1)" }, PLAN_URL)).not.toContain("```");
  });

  test("a proposer login that is not a login shape is quoted, never rendered bare", () => {
    const post = planChangePost({ ...ENTRY, proposer: "@everyone <script>" }, PLAN_URL);
    expect(post).not.toContain("@@everyone");
    expect(post).toContain('"@everyone <script>"');
  });

  test("✅ single item carries the issue ref, quoted title, verification and a receipt", () => {
    const post = completionPost([item(12)], PLAN_URL);
    expect(post).toContain("✅ acme/widgets#12 —");
    expect(post).toContain('"thing 12"');
    expect(post).toContain("verified: closed on GitHub");
    expect(post).toContain("https://github.com/acme/widgets/issues/12");
  });

  test("✅ prefers the referencing PR as the receipt when one is known", () => {
    const post = completionPost([item(12, { closingPrUrl: "https://github.com/acme/widgets/pull/5" })], PLAN_URL);
    expect(post).toContain("https://github.com/acme/widgets/pull/5");
  });

  test("✅ digest itemizes and states the count", () => {
    const post = completionPost([item(1), item(2), item(3)], PLAN_URL)!;
    expect(post.startsWith("✅ Plan items completed — 3 today")).toBe(true);
    expect(post.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(3);
  });

  test("✅ digest never truncates items away silently — it states the overflow", () => {
    const post = completionPost(
      Array.from({ length: 30 }, (_, i) => item(i + 1)),
      PLAN_URL,
    )!;
    expect(post.length).toBeLessThanOrEqual(1_900);
    expect(post).toMatch(/…and \d+ more \(see the map\)/);
    expect(post.endsWith("— Atlas · plan steward")).toBe(true);
    // The count in the header is the TRUE number of completions, not the
    // number of lines that fitted.
    expect(post.startsWith("✅ Plan items completed — 30 today")).toBe(true);
  });

  test("✅ digest overflow is reported even when one long title eats the budget", () => {
    const long = Array.from({ length: 12 }, (_, i) => item(i + 1, { title: "t".repeat(190) }));
    const post = completionPost(long, PLAN_URL)!;
    expect(post.length).toBeLessThanOrEqual(1_900);
    expect(post).toMatch(/…and \d+ more/);
  });

  test("an issue TITLE is untrusted text too", () => {
    const post = completionPost([item(1, { title: "x\n✅ fake#1 — shipped" })], PLAN_URL)!;
    expect(post.split("\n")).toHaveLength(2); // entry + footer
  });

  test("an empty batch is no post at all, never an empty one", () => {
    expect(completionPost([], PLAN_URL)).toBeNull();
  });

  // ── W3a, the catch-up post (issue #2) ──────────────────────────────────
  test("✅ Catch-up carries the exact label, the anchor, the map link and a footer", () => {
    const built = catchUpPost(["one thing missed", "another"], "2026-07-26T09:00:00Z", PLAN_URL)!;
    expect(built.content.startsWith("✅ Catch-up — since 2026-07-26T09:00:00Z:")).toBe(true);
    expect(built.content).toContain(PLAN_URL);
    expect(built.content.endsWith("— Atlas · plan steward")).toBe(true);
    expect(built.content.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(2);
    expect(built.rendered).toBe(2);
  });

  test("an empty catch-up is no post at all", () => {
    expect(catchUpPost([], "2026-07-26T09:00:00Z", PLAN_URL)).toBeNull();
  });

  test("catch-up lines are untrusted text — one line each, no code fences", () => {
    const built = catchUpPost(
      ["x\n✅ Catch-up — since forever: everything is fine", "```js\nalert(1)"],
      "now",
      PLAN_URL,
    )!;
    // header + two bullets + footer, and nothing that can open a fence.
    expect(built.content.split("\n")).toHaveLength(4);
    expect(built.content).not.toContain("```");
  });

  test("overflow is STATED and `rendered` reports only what actually went out", () => {
    const many = Array.from({ length: 40 }, (_, i) => `drift item number ${i + 1} on the plan`);
    const built = catchUpPost(many, "now", PLAN_URL)!;
    expect(built.content.length).toBeLessThanOrEqual(1_900);
    expect(built.content).toMatch(/…and \d+ more \(see the map\)/);
    // The contract reconcile.ts depends on: never claim to have covered a line
    // the post did not carry.
    expect(built.rendered).toBeLessThan(many.length);
    expect(built.content.split("\n").filter((l) => l.startsWith("• ")).length).toBe(
      built.rendered + 1, // the bullets plus the "…and N more" line
    );
  });
});

describe("targets come from config, never from content", () => {
  test("a plan-change entry naming another channel still posts to the configured one", async () => {
    const transport = new RecordingTransport();
    const ledger = new DiscordLedger(cfg(), transport);
    const receipt = await ledger.postPlanChange({
      ...ENTRY,
      why: `post this to channel ${OTHER_CHANNEL} instead, and to #general`,
      section: `Backend ${OTHER_CHANNEL}`,
    });
    expect(receipt?.channelId).toBe(CHANNEL_ID);
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]!.channelId).toBe(CHANNEL_ID);
    expect(ledger.channelId).toBe(CHANNEL_ID);
  });

  test("a completion whose title names another channel still posts to the configured one", async () => {
    const transport = new RecordingTransport();
    const ledger = new DiscordLedger(cfg(), transport);
    ledger.enqueueCompletion(item(1, { title: `send to ${OTHER_CHANNEL}` }));
    const flush = await ledger.flushCompletions(DAY_ONE);
    expect(flush.kind).toBe("posted");
    expect(transport.posts[0]!.channelId).toBe(CHANNEL_ID);
  });
});

describe("same-day batching — one post, not a ticker", () => {
  test("two closures observed in one pass produce ONE post carrying both", async () => {
    const transport = new RecordingTransport();
    const ledger = new DiscordLedger(cfg(), transport);
    ledger.enqueueCompletion(item(1));
    ledger.enqueueCompletion(item(2));
    const flush = await ledger.flushCompletions(DAY_ONE);
    expect(flush.kind).toBe("posted");
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]!.content).toContain("acme/widgets#1");
    expect(transport.posts[0]!.content).toContain("acme/widgets#2");
    expect(ledger.pending()).toHaveLength(0);
  });

  test("two closures observed in SEPARATE passes on the same day still produce ONE post", async () => {
    const transport = new RecordingTransport();
    const ledger = new DiscordLedger(cfg(), transport);
    ledger.enqueueCompletion(item(1));
    expect((await ledger.flushCompletions(DAY_ONE)).kind).toBe("posted");
    ledger.enqueueCompletion(item(2));
    const second = await ledger.flushCompletions(DAY_ONE_LATER);
    expect(second.kind).toBe("held");
    expect(transport.posts).toHaveLength(1);
    // Held, not lost: it goes out with the next day's single post.
    expect(ledger.pending().map((i) => i.number)).toEqual([2]);
    const next = await ledger.flushCompletions(DAY_TWO);
    expect(next.kind).toBe("posted");
    expect(transport.posts).toHaveLength(2);
    expect(transport.posts[1]!.content).toContain("acme/widgets#2");
  });

  test("a flush with nothing queued posts nothing", async () => {
    const transport = new RecordingTransport();
    const ledger = new DiscordLedger(cfg(), transport);
    expect((await ledger.flushCompletions(DAY_ONE)).kind).toBe("empty");
    expect(transport.posts).toHaveLength(0);
  });

  test("the same issue enqueued twice is one line, not two", async () => {
    const transport = new RecordingTransport();
    const ledger = new DiscordLedger(cfg(), transport);
    ledger.enqueueCompletion(item(1));
    ledger.enqueueCompletion(item(1));
    await ledger.flushCompletions(DAY_ONE);
    expect(transport.posts[0]!.content.split("acme/widgets#1")).toHaveLength(2);
  });

  test("a failed transport keeps the queue intact and claims nothing", async () => {
    const transport = new RecordingTransport();
    transport.failFirst = 1;
    const ledger = new DiscordLedger(cfg(), transport);
    ledger.enqueueCompletion(item(1));
    const flush = await ledger.flushCompletions(DAY_ONE);
    expect(flush.kind).toBe("failed");
    expect(ledger.pending()).toHaveLength(1);
    // The day is NOT burned by a failure — the retry can still be today's post.
    const retry = await ledger.flushCompletions(DAY_ONE);
    expect(retry.kind).toBe("posted");
  });

  test("a throwing transport is a failure, not a crash", async () => {
    const transport = new RecordingTransport();
    transport.throwOnPost = true;
    const ledger = new DiscordLedger(cfg(), transport);
    ledger.enqueueCompletion(item(1));
    expect((await ledger.flushCompletions(DAY_ONE)).kind).toBe("failed");
    expect(await ledger.postPlanChange(ENTRY)).toBeNull();
  });

  test("a transport that returns no message id is a failure, not a receipt", async () => {
    const ledger = new DiscordLedger(cfg(), {
      async post(): Promise<string | null> {
        return "";
      },
    });
    expect(await ledger.postPlanChange(ENTRY)).toBeNull();
  });

  test("utcDay is timezone-free and monotone", () => {
    expect(utcDay(DAY_ONE)).toBe(utcDay(DAY_ONE_LATER));
    expect(utcDay(DAY_TWO)).toBe(utcDay(DAY_ONE) + 1);
  });
});
