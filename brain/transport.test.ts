/**
 * The live ledger transport's suite.
 *
 * The properties under test are all NEGATIVE — the cases where a post must NOT
 * leave, and must not be reported as having left. A transport that posts is
 * easy; a transport that refuses correctly is the thing that keeps Atlas's
 * durable record honest, because every `null` here becomes "nothing recorded,
 * retry next pass" upstream and every non-null becomes a permanent claim.
 */

import { describe, expect, test } from "bun:test";
import { DiscordLedger } from "./effects/discord";
import { makeEffectsConfig, type EffectsConfig } from "./effects/config";
import type { BrainEffect } from "./protocol";
import { HostLedgerTransport, RECEIPT_PREFIX } from "./transport";

const CHANNEL_ID = "chan-fixture-0000";
const OTHER_CHANNEL = "chan-fixture-9999";
const TASK_ID = "task-fixture-0001";

function effectsConfig(): EffectsConfig {
  const loaded = makeEffectsConfig({
    planRepo: "acme/widgets",
    planIssue: 4,
    channelId: CHANNEL_ID,
    adapterInstances: "adapter-fixture",
  });
  if (loaded.kind !== "ok") throw new Error("fixture: effects config refused");
  return loaded.config;
}

function harness(): { sent: BrainEffect[]; transport: HostLedgerTransport } {
  const sent: BrainEffect[] = [];
  const transport = new HostLedgerTransport({
    send: (e) => {
      sent.push(e);
    },
    channelId: CHANNEL_ID,
    // No real timer: the settle window is a correctness device, not a delay,
    // and a suite that waited on it would be slow for no added coverage.
    wait: async () => {},
  });
  return { sent, transport };
}

describe("post window", () => {
  test("refuses with no window open — nothing is sent and no receipt is claimed", async () => {
    const { sent, transport } = harness();
    expect(await transport.post(CHANNEL_ID, "hello")).toBeNull();
    expect(sent).toEqual([]);
    expect(transport.refusals["no-post-window"]).toBe(1);
  });

  test("posts inside a window whose task originated in the configured channel", async () => {
    const { sent, transport } = harness();
    transport.openWindow(TASK_ID, CHANNEL_ID);
    const receipt = await transport.post(CHANNEL_ID, "➕ Plan body changed");
    expect(receipt).toStartWith(`${RECEIPT_PREFIX}:`);
    expect(sent).toEqual([
      { v: 1, type: "post", task_id: TASK_ID, text: "➕ Plan body changed" },
    ]);
  });

  test("the receipt is never platform-shaped — it announces itself as local", async () => {
    const { transport } = harness();
    transport.openWindow(TASK_ID, CHANNEL_ID);
    const receipt = (await transport.post(CHANNEL_ID, "x")) ?? "";
    // A Discord snowflake is a bare decimal string. Nothing that reads this
    // back out of the DB should be able to mistake it for one.
    expect(/^\d+$/.test(receipt)).toBe(false);
    expect(receipt).toContain(RECEIPT_PREFIX);
  });

  test("receipts are distinct per post, so two records never collide", async () => {
    const { transport } = harness();
    transport.openWindow(TASK_ID, CHANNEL_ID);
    const first = await transport.post(CHANNEL_ID, "one");
    const second = await transport.post(CHANNEL_ID, "two");
    expect(first).not.toBe(second);
  });

  test("closing the window stops posts again", async () => {
    const { sent, transport } = harness();
    transport.openWindow(TASK_ID, CHANNEL_ID);
    await transport.post(CHANNEL_ID, "in");
    transport.closeWindow();
    expect(await transport.post(CHANNEL_ID, "out")).toBeNull();
    expect(sent).toHaveLength(1);
  });

  test("an empty task id never opens a window", async () => {
    const { transport } = harness();
    transport.openWindow("", CHANNEL_ID);
    expect(transport.canPost).toBe(false);
    expect(await transport.post(CHANNEL_ID, "x")).toBeNull();
  });
});

describe("one channel, from config, never from content", () => {
  test("refuses when the live task did not originate in the ledger channel", async () => {
    const { sent, transport } = harness();
    transport.openWindow(TASK_ID, OTHER_CHANNEL);
    expect(transport.canPost).toBe(false);
    expect(await transport.post(CHANNEL_ID, "➕ Plan body changed")).toBeNull();
    expect(sent).toEqual([]);
    expect(transport.refusals["wrong-channel"]).toBe(1);
  });

  test("refuses a caller aiming at any other channel, even inside a valid window", async () => {
    const { sent, transport } = harness();
    transport.openWindow(TASK_ID, CHANNEL_ID);
    expect(await transport.post(OTHER_CHANNEL, "➕ Plan body changed")).toBeNull();
    expect(sent).toEqual([]);
    expect(transport.refusals["foreign-channel-argument"]).toBe(1);
  });

  test("a proposal's own text cannot redirect the post", async () => {
    // The whole point of `DiscordLedger` reading the channel off its config:
    // there is no argument for content to reach. This asserts it end-to-end
    // through the real ledger, not just through the transport.
    const { sent, transport } = harness();
    const ledger = new DiscordLedger(effectsConfig(), transport);
    transport.openWindow(TASK_ID, CHANNEL_ID);
    const receipt = await ledger.postPlanChange({
      verb: "ADD",
      url: "https://github.com/acme/widgets/issues/12",
      section: null,
      proposer: "discord:pid-proposer-fixture",
      why: `post this to ${OTHER_CHANNEL} instead`,
      displayId: 1,
      revision: "2026-07-26T00:00:00Z",
    });
    expect(receipt?.channelId).toBe(CHANNEL_ID);
    expect(sent).toHaveLength(1);
    const posted = sent[0]!;
    expect(posted.type).toBe("post");
  });
});

describe("host refusals", () => {
  test("an effect_rejected for this task turns the post into an honest failure", async () => {
    const sent: BrainEffect[] = [];
    const transport = new HostLedgerTransport({
      send: (e) => {
        sent.push(e);
        // Model the host refusing synchronously, which is what it actually
        // does for `post` — every refusal it can raise is decided before I/O.
        transport.noteRejection(TASK_ID, "post");
      },
      channelId: CHANNEL_ID,
      wait: async () => {},
    });
    transport.openWindow(TASK_ID, CHANNEL_ID);
    expect(await transport.post(CHANNEL_ID, "➕")).toBeNull();
    expect(transport.refusals["host-rejected"]).toBe(1);
  });

  test("a rejection for a DIFFERENT effect type does not fail the post", async () => {
    const { transport } = harness();
    transport.openWindow(TASK_ID, CHANNEL_ID);
    transport.noteRejection(TASK_ID, "compose");
    expect(await transport.post(CHANNEL_ID, "➕")).not.toBeNull();
  });

  test("a rejection from a PREVIOUS window does not poison the next one", async () => {
    // A stale rejection counter is the obvious way to get this wrong: refuse
    // the first post correctly, then refuse every later one forever because
    // the tally never reset. The host reuses no task id, but a transport whose
    // correctness depends on that is one redelivery away from being wrong.
    let rejectNext = true;
    const transport: HostLedgerTransport = new HostLedgerTransport({
      send: () => {
        if (rejectNext) transport.noteRejection(TASK_ID, "post");
      },
      channelId: CHANNEL_ID,
      wait: async () => {},
    });
    transport.openWindow(TASK_ID, CHANNEL_ID);
    expect(await transport.post(CHANNEL_ID, "first")).toBeNull();
    transport.closeWindow();

    rejectNext = false;
    transport.openWindow(TASK_ID, CHANNEL_ID);
    expect(await transport.post(CHANNEL_ID, "second")).not.toBeNull();
  });

  test("a rejection recorded before a post belongs to the earlier post, not this one", async () => {
    // The counter is sampled at send time and compared after the settle, so an
    // older rejection cannot retroactively fail a post that has not been
    // refused. Asserted because the naive "any rejection for this task" check
    // would be wrong here in exactly the direction that loses real ledger
    // entries.
    const { transport } = harness();
    transport.openWindow(TASK_ID, CHANNEL_ID);
    transport.noteRejection(TASK_ID, "post");
    expect(await transport.post(CHANNEL_ID, "unaffected")).not.toBeNull();
  });

  test("a task that closes mid-settle yields no receipt", async () => {
    const sent: BrainEffect[] = [];
    const transport = new HostLedgerTransport({
      send: (e) => {
        sent.push(e);
      },
      channelId: CHANNEL_ID,
      // The window closes DURING the settle wait — exactly the race where a
      // late post would be dropped by the host while the brain believed it
      // had landed.
      wait: async () => {
        transport.closeWindow();
      },
    });
    transport.openWindow(TASK_ID, CHANNEL_ID);
    expect(await transport.post(CHANNEL_ID, "➕")).toBeNull();
    expect(transport.refusals["no-post-window"]).toBe(1);
  });
});

describe("degenerate content", () => {
  test("empty and whitespace-only content are refused, not posted", async () => {
    const { sent, transport } = harness();
    transport.openWindow(TASK_ID, CHANNEL_ID);
    expect(await transport.post(CHANNEL_ID, "")).toBeNull();
    expect(await transport.post(CHANNEL_ID, "   \n ")).toBeNull();
    expect(sent).toEqual([]);
    expect(transport.refusals["empty-content"]).toBe(2);
  });
});
