/**
 * The atomic pair's suite (W2c, issue #1).
 *
 * Everything here runs against a REAL SQLite store and a REAL ratification
 * obtained through `processGateMessage` — there is no fixture that mints a
 * certificate directly, because "you cannot apply without going through the
 * gate" is the property under test and a shortcut fixture would test around it.
 *
 * The gh side goes through the shipped `GhCliPlanWriter` with only its spawn
 * function faked, so every argv assertion is an assertion about the real
 * builder and the real chokepoint.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRatified, planBodyEdit } from "./apply";
import { DiscordLedger } from "./effects/discord";
import { makeEffectsConfig, type EffectsConfig } from "./effects/config";
import { GhCliPlanWriter, type GhInvocation } from "./effects/gh";
import {
  identityConfigFromPorts,
  StaticPrincipalMap,
  StaticSelfIdentity,
  type RatifyIdentityConfig,
} from "./identity";
import { planBodyRevision } from "./plan-revision";
import type { RatificationCertificate } from "./ratification";
import { processGateMessage, type GateMessage } from "./ratify";
import { AtlasProposals, AtlasStateStore } from "./state";
import { FakePlanRepo, RecordingTransport } from "./test-support";

// ── Fixtures (placeholder ids only — this repo is public) ───────────────────

const PLATFORM = "discord";
const PRINCIPAL_ID = "plan-steward";
const PRINCIPAL_PLATFORM_ID = "pid-principal-fixture";
const ATLAS_PLATFORM_ID = "pid-atlas-self-fixture";
const CHANNEL_ID = "chan-fixture-0000";
const OTHER_CHANNEL = "chan-fixture-9999";
const PLAN_REPO = "acme/widgets";
const NEW_URL = "https://github.com/acme/widgets/issues/12";

const PLAN_BODY = [
  "# Iteration 1",
  "",
  "## Backend",
  "",
  "- [ ] https://github.com/acme/widgets/issues/1",
  "- [ ] https://github.com/acme/widgets/issues/2",
  "",
  "## Frontend",
  "",
  "- [ ] https://github.com/acme/widgets/issues/7",
  "",
].join("\n");

let dir: string;
let store: AtlasStateStore;
let state: AtlasProposals;
let identity: RatifyIdentityConfig;
let effects: EffectsConfig;
let repo: FakePlanRepo;
let transport: RecordingTransport;
let gh: GhCliPlanWriter;
let ledger: DiscordLedger;
/** A single ordered log of EVERY side effect, so ordering is assertable. */
let order: string[];

function makeEffects(): EffectsConfig {
  const loaded = makeEffectsConfig({
    planRepo: PLAN_REPO,
    planIssue: 4,
    channelId: CHANNEL_ID,
  });
  if (loaded.kind !== "ok") throw new Error("fixture: effects config refused");
  return loaded.config;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-apply-test-"));
  const opened = AtlasStateStore.open({ dir, bundleDir: null });
  if (opened === null) throw new Error("fixture: expected the store to open");
  store = opened;
  state = new AtlasProposals(store);
  identity = buildIdentity();
  effects = makeEffects();
  order = [];
  repo = new FakePlanRepo(PLAN_BODY);
  transport = new RecordingTransport();
  gh = new GhCliPlanWriter(effects, async (inv: GhInvocation) => {
    order.push(`gh:${inv.argv.slice(1, 3).join(" ")}`);
    return repo.spawn(inv);
  });
  ledger = new DiscordLedger(effects, {
    async post(channelId, content) {
      order.push("discord:post");
      return transport.post(channelId, content);
    },
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function buildIdentity(): RatifyIdentityConfig {
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

function msg(body: string): GateMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    body,
    authorPlatform: PLATFORM,
    authorId: PRINCIPAL_PLATFORM_ID,
  };
}

/** Drive a proposal to `surfaced` and return its display id. */
function surface(
  id: string,
  overrides: {
    verb?: "ADD" | "REMOVE";
    url?: string;
    section?: string | null;
    why?: string;
    proposer?: string;
  } = {},
): number {
  state.createIntake(
    id,
    overrides.verb ?? "ADD",
    overrides.url ?? NEW_URL,
    overrides.section === undefined ? "Backend" : overrides.section,
    overrides.why ?? "it blocks the release",
    overrides.proposer ?? "octocat",
  );
  state.markValidated(id, true);
  const displayId = state.markSurfaced(id);
  if (displayId === null) throw new Error("fixture: expected a display id");
  return displayId;
}

/**
 * Ratify through the GATE — the only way a certificate can be obtained. A
 * fixture that minted one directly would be testing around the property this
 * whole slice rests on.
 */
function ratify(displayId: number): RatificationCertificate {
  const outcome = processGateMessage(msg(`RATIFY ${displayId}`), identity, state);
  if (outcome.kind !== "ratified") {
    throw new Error(`fixture: expected a ratification, got ${outcome.kind}`);
  }
  return outcome.certificate;
}

// ── The acceptance criteria ────────────────────────────────────────────────

describe("ratified ADD → body edited, then ➕ posted, receipts recorded", () => {
  test("the plan body carries the URL under the NAMED section", async () => {
    const cert = ratify(surface("c1"));
    const outcome = await applyRatified(cert, { state, identity, effects, gh, ledger });

    expect(outcome.kind).toBe("posted");
    const lines = repo.body.split("\n");
    const backend = lines.indexOf("## Backend");
    const frontend = lines.indexOf("## Frontend");
    const added = lines.findIndex((l) => l.includes(NEW_URL));
    expect(added).toBeGreaterThan(backend);
    expect(added).toBeLessThan(frontend);
    expect(lines[added]).toBe(`- [ ] ${NEW_URL}`);
  });

  test("the ➕ post exists, and lands AFTER the body edit", async () => {
    const cert = ratify(surface("c1"));
    await applyRatified(cert, { state, identity, effects, gh, ledger });

    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]!.content.startsWith("➕ Plan body changed")).toBe(true);
    expect(transport.posts[0]!.content).toContain("@octocat");
    // The ordering the map-and-ledger rule requires: map first, ledger second.
    expect(order.indexOf("gh:issue edit")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("discord:post")).toBeGreaterThan(order.indexOf("gh:issue edit"));
  });

  test("both receipts are durably recorded and the phase is `posted`", async () => {
    const id = "c1";
    const cert = ratify(surface(id));
    const outcome = await applyRatified(cert, { state, identity, effects, gh, ledger });
    if (outcome.kind !== "posted") throw new Error(`expected posted, got ${outcome.kind}`);

    const record = state.get(id);
    expect(record?.phase).toBe("posted");
    expect(record?.applied?.revision).toBe(outcome.revision);
    expect(record?.posted?.messageId).toBe(outcome.messageId);
    expect(record?.posted?.channelId).toBe(CHANNEL_ID);
    // atlas#26: the revision receipt is a hash of the body Atlas wrote — NOT
    // GitHub's `updatedAt` (`repo.revisedAt`), which is not a body-revision
    // identity at all (it advances on comments and cross-references too).
    expect(outcome.revision).toBe(planBodyRevision(repo.body));
  });

  test("a REMOVE takes its line out and leaves the rest byte-identical", async () => {
    const target = "https://github.com/acme/widgets/issues/2";
    const cert = ratify(surface("c2", { verb: "REMOVE", url: target }));
    const outcome = await applyRatified(cert, { state, identity, effects, gh, ledger });

    expect(outcome.kind).toBe("posted");
    expect(repo.body).toBe(PLAN_BODY.split("\n").filter((l) => !l.includes(target)).join("\n"));
    expect(transport.posts[0]!.content.startsWith("➖")).toBe(true);
  });

  test("a re-run after a successful apply changes nothing and posts nothing", async () => {
    const cert = ratify(surface("c1"));
    await applyRatified(cert, { state, identity, effects, gh, ledger });
    const bodyAfterFirst = repo.body;

    const again = await applyRatified(cert, { state, identity, effects, gh, ledger });
    expect(again.kind).toBe("refused");
    expect(again.kind === "refused" && again.reason).toBe("not-ratified");
    expect(repo.body).toBe(bodyAfterFirst);
    expect(transport.posts).toHaveLength(1);
  });
});

describe("ledger-post failure after the body edit → PARK in applied", () => {
  test("one retry, then park — no crash, no retry storm", async () => {
    transport.failFirst = Number.POSITIVE_INFINITY;
    const cert = ratify(surface("c1"));
    const outcome = await applyRatified(cert, { state, identity, effects, gh, ledger });

    if (outcome.kind !== "applied-not-posted") {
      throw new Error(`expected applied-not-posted, got ${outcome.kind}`);
    }
    expect(outcome.attempts).toBe(2); // the attempt plus at most ONE retry
    expect(outcome.postLanded).toBe(false);
    // The map DID change — that is not rolled back.
    expect(repo.body).toContain(NEW_URL);
    // And the work item parks exactly where W3a's reconcile will find it.
    const record = state.get("c1");
    expect(record?.phase).toBe("applied");
    expect(record?.applied?.revision).toBe(outcome.revision);
    expect(record?.posted).toBeNull();
    expect(transport.posts).toHaveLength(0);
  });

  test("a throwing transport parks the same way rather than escaping", async () => {
    transport.throwOnPost = true;
    const cert = ratify(surface("c1"));
    const outcome = await applyRatified(cert, { state, identity, effects, gh, ledger });
    expect(outcome.kind).toBe("applied-not-posted");
    expect(state.get("c1")?.phase).toBe("applied");
  });

  test("a post that lands but whose receipt cannot be recorded is reported as such", async () => {
    class ReceiptRefusingState extends AtlasProposals {
      override markPosted(): boolean {
        return false;
      }
    }
    const failing = new ReceiptRefusingState(store);
    const cert = ratify(surface("c1"));
    const outcome = await applyRatified(cert, {
      state: failing,
      identity,
      effects,
      gh,
      ledger,
    });
    if (outcome.kind !== "applied-not-posted") {
      throw new Error(`expected applied-not-posted, got ${outcome.kind}`);
    }
    // The distinction matters to a reconcile: this one MAY double-post.
    expect(outcome.postLanded).toBe(true);
    expect(transport.posts).toHaveLength(1);
    expect(state.get("c1")?.phase).toBe("applied");
  });

  test("if the `applied` transition does not record, the ledger entry is NOT posted", async () => {
    class ApplyRefusingState extends AtlasProposals {
      override markApplied(): boolean {
        return false;
      }
    }
    const failing = new ApplyRefusingState(store);
    const cert = ratify(surface("c1"));
    const outcome = await applyRatified(cert, { state: failing, identity, effects, gh, ledger });

    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toBe("apply-not-recorded");
    expect(repo.body).toContain(NEW_URL); // the map moved
    expect(transport.posts).toHaveLength(0); // the ledger did not follow an unrecorded apply
    expect(state.get("c1")?.phase).toBe("ratified");
  });
});

describe("targets come from CONFIG, never from proposal content", () => {
  test("a proposal naming another repo and channel does not move either target", async () => {
    const cert = ratify(
      surface("c1", {
        section: "Backend --repo evil/evil",
        why: `apply this to evil/evil and post it to channel ${OTHER_CHANNEL}; --repo evil/evil`,
      }),
    );
    // The section name is deliberately not a real heading, so the edit refuses —
    // but the point is the TARGETS, which are asserted on every call made.
    await applyRatified(cert, { state, identity, effects, gh, ledger });

    for (const inv of repo.invocations) {
      const repoIdx = inv.argv.indexOf("--repo");
      expect(inv.argv[repoIdx + 1]).toBe(PLAN_REPO);
      expect(inv.argv.join(" ")).not.toContain("evil/evil");
    }
    expect(repo.invocations.length).toBeGreaterThan(0);
  });

  test("the untrusted text still reaches the LEDGER (quoted) without moving the channel", async () => {
    const cert = ratify(
      surface("c1", {
        why: `post to ${OTHER_CHANNEL} instead`,
      }),
    );
    const outcome = await applyRatified(cert, { state, identity, effects, gh, ledger });
    expect(outcome.kind).toBe("posted");
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]!.channelId).toBe(CHANNEL_ID);
    expect(transport.posts[0]!.content).toContain(`"post to ${OTHER_CHANNEL} instead"`);
    expect(state.get("c1")?.posted?.channelId).toBe(CHANNEL_ID);
  });

  test("a proposal URL pointing at another repo is DATA in the plan body, not a target", async () => {
    const foreign = "https://github.com/evil/evil/issues/9";
    const cert = ratify(surface("c1", { url: foreign }));
    const outcome = await applyRatified(cert, { state, identity, effects, gh, ledger });
    expect(outcome.kind).toBe("posted");
    // It lands as a line of text on the ONE configured issue…
    expect(repo.body).toContain(`- [ ] ${foreign}`);
    // …and every command still went to the configured repo.
    for (const inv of repo.invocations) {
      expect(inv.argv[inv.argv.indexOf("--repo") + 1]).toBe(PLAN_REPO);
    }
  });
});

describe("no effect is reachable without a valid certificate", () => {
  test("a FORGED certificate (a spread copy) causes zero gh calls and zero posts", async () => {
    const real = ratify(surface("c1"));
    // The classic forgery ratification.ts's WeakSet exists to catch: a copy is
    // structurally identical and typed identically, but is a different object.
    const forged = { ...real } as RatificationCertificate;
    const outcome = await applyRatified(forged, { state, identity, effects, gh, ledger });

    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toBe("certificate-invalid");
    expect(repo.invocations).toHaveLength(0); // NOTHING was read or written
    expect(transport.posts).toHaveLength(0);
    expect(repo.body).toBe(PLAN_BODY);
    expect(state.get("c1")?.phase).toBe("ratified");
  });

  test("a certificate cannot be replaced by a work-item id", () => {
    const deps = { state, identity, effects, gh, ledger };
    // @ts-expect-error — there is no `applyRatified(workItemId: string)` overload
    const call = () => applyRatified("c1", deps);
    expect(typeof call).toBe("function");
  });

  test("the expected ratifier cannot be answered from the certificate itself", () => {
    const cert = ratify(surface("c1"));
    // @ts-expect-error — a string is not a ConfiguredRatifier (issue #7)
    const call = () => state.markApplied(cert, cert.ratifierPrincipalId);
    expect(typeof call).toBe("function");
  });

  test("an un-ratified proposal has no certificate to apply with", async () => {
    surface("c1");
    // There is no way to construct one — the only producer reads durable state,
    // and nothing has been ratified.
    const outcome = processGateMessage(msg("RATIFY 999"), identity, state);
    expect(outcome.kind).toBe("stale");
    expect(repo.invocations).toHaveLength(0);
  });

  test("a degraded store refuses before touching GitHub", async () => {
    const cert = ratify(surface("c1"));
    const degraded = new AtlasProposals(null);
    const outcome = await applyRatified(cert, { state: degraded, identity, effects, gh, ledger });
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toBe("state-degraded");
    expect(repo.invocations).toHaveLength(0);
  });

  test("an unreadable plan body refuses before any write", async () => {
    repo.failReads = true;
    const cert = ratify(surface("c1"));
    const outcome = await applyRatified(cert, { state, identity, effects, gh, ledger });
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toBe("plan-unreadable");
    expect(transport.posts).toHaveLength(0);
  });

  test("a failed write leaves the item ratified and posts nothing", async () => {
    repo.failWrites = true;
    const cert = ratify(surface("c1"));
    const outcome = await applyRatified(cert, { state, identity, effects, gh, ledger });
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toBe("plan-write-failed");
    expect(state.get("c1")?.phase).toBe("ratified");
    expect(transport.posts).toHaveLength(0);
  });

  test("an ADD whose section does not exist refuses without writing", async () => {
    const cert = ratify(surface("c1", { section: "Nowhere" }));
    const outcome = await applyRatified(cert, { state, identity, effects, gh, ledger });
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toBe("edit-refused");
    expect(repo.body).toBe(PLAN_BODY);
    expect(state.get("c1")?.phase).toBe("ratified"); // re-runnable once named
  });

  test("an ADD with no named section is refused rather than guessed at", async () => {
    const cert = ratify(surface("c1", { section: null }));
    const outcome = await applyRatified(cert, { state, identity, effects, gh, ledger });
    expect(outcome.kind === "refused" && outcome.reason).toBe("edit-refused");
    expect(repo.body).toBe(PLAN_BODY);
  });
});

// ── The minimal edit, as a pure function ───────────────────────────────────

describe("planBodyEdit — minimal, deterministic, refuses ambiguity", () => {
  test("ADD appends after the last item of the named section only", () => {
    const result = planBodyEdit(PLAN_BODY, { verb: "ADD", url: NEW_URL, section: "Backend" });
    if (result.kind !== "changed") throw new Error("expected a change");
    const before = PLAN_BODY.split("\n");
    const after = result.body.split("\n");
    expect(after).toHaveLength(before.length + 1);
    // Everything except the one inserted line is byte-identical, in order.
    expect(after.filter((l) => l !== `- [ ] ${NEW_URL}`)).toEqual(before);
    expect(after[6]).toBe(`- [ ] ${NEW_URL}`);
  });

  test("ADD is a no-op when the URL is already anywhere on the plan", () => {
    expect(
      planBodyEdit(PLAN_BODY, {
        verb: "ADD",
        url: "https://github.com/acme/widgets/issues/1",
        section: "Backend",
      }),
    ).toEqual({ kind: "unchanged" });
  });

  test("REMOVE of an absent URL is a no-op, not an error", () => {
    expect(planBodyEdit(PLAN_BODY, { verb: "REMOVE", url: NEW_URL, section: "Backend" })).toEqual({
      kind: "unchanged",
    });
  });

  test("issues/1 never matches issues/10 — the trailing-digit guard", () => {
    const body = ["## Backend", "- [ ] https://github.com/acme/widgets/issues/10", ""].join("\n");
    const url = "https://github.com/acme/widgets/issues/1";
    // A plain `includes` would delete #10's line for a REMOVE of #1.
    expect(planBodyEdit(body, { verb: "REMOVE", url, section: "Backend" })).toEqual({
      kind: "unchanged",
    });
    const added = planBodyEdit(body, { verb: "ADD", url, section: "Backend" });
    expect(added.kind).toBe("changed");
    expect(added.kind === "changed" && added.body.split("\n")).toEqual([
      "## Backend",
      "- [ ] https://github.com/acme/widgets/issues/10",
      `- [ ] ${url}`,
      "",
    ]);
  });

  test("a URL on two lines of the named section is ambiguous, and refused", () => {
    const body = [
      "## Backend",
      `- [ ] ${NEW_URL}`,
      `- [ ] ${NEW_URL} (duplicate)`,
      "",
    ].join("\n");
    expect(planBodyEdit(body, { verb: "REMOVE", url: NEW_URL, section: "Backend" })).toEqual({
      kind: "refused",
      reason: "target-ambiguous",
    });
  });

  test("a REMOVE naming the wrong section is refused, not silently widened", () => {
    expect(
      planBodyEdit(PLAN_BODY, {
        verb: "REMOVE",
        url: "https://github.com/acme/widgets/issues/7",
        section: "Backend",
      }),
    ).toEqual({ kind: "refused", reason: "target-outside-section" });
  });

  test("two headings with the same name are ambiguous, and refused", () => {
    const body = ["## Backend", "- [ ] a", "", "## Backend", "- [ ] b", ""].join("\n");
    expect(planBodyEdit(body, { verb: "ADD", url: NEW_URL, section: "Backend" })).toEqual({
      kind: "refused",
      reason: "section-ambiguous",
    });
  });

  test("a subsection belongs to its parent, so an ADD lands after the LAST item under it", () => {
    const body = [
      "## Backend",
      "- [ ] https://github.com/acme/widgets/issues/1",
      "",
      "### Later",
      "- [ ] https://github.com/acme/widgets/issues/2",
      "",
      "## Frontend",
      "- [ ] https://github.com/acme/widgets/issues/7",
      "",
    ].join("\n");
    const result = planBodyEdit(body, { verb: "ADD", url: NEW_URL, section: "Backend" });
    if (result.kind !== "changed") throw new Error("expected a change");
    const lines = result.body.split("\n");
    expect(lines.indexOf(`- [ ] ${NEW_URL}`)).toBe(5);
    expect(lines.indexOf("## Frontend")).toBe(7);
  });

  test("a CRLF body stays a CRLF body", () => {
    const body = ["## Backend\r", "- [ ] https://github.com/acme/widgets/issues/1\r", "\r"].join("\n");
    const result = planBodyEdit(body, { verb: "ADD", url: NEW_URL, section: "Backend" });
    if (result.kind !== "changed") throw new Error("expected a change");
    expect(result.body).toContain(`- [ ] ${NEW_URL}\r\n`);
    expect(result.body.split("\n").every((l) => l === "" || l.endsWith("\r"))).toBe(true);
  });

  test("a section with no list items still gets its item inside the section", () => {
    const body = ["## Backend", "", "Nothing yet.", "", "## Frontend", "- [ ] x", ""].join("\n");
    const result = planBodyEdit(body, { verb: "ADD", url: NEW_URL, section: "Backend" });
    if (result.kind !== "changed") throw new Error("expected a change");
    const lines = result.body.split("\n");
    expect(lines.indexOf(`- [ ] ${NEW_URL}`)).toBe(3);
    expect(lines.indexOf("## Frontend")).toBe(5);
  });

  test("section matching falls back to case-insensitive ONLY when unique", () => {
    const body = ["## backend", "- [ ] x", ""].join("\n");
    expect(planBodyEdit(body, { verb: "ADD", url: NEW_URL, section: "Backend" }).kind).toBe("changed");
    const twoCases = ["## backend", "- [ ] x", "", "## BACKEND", "- [ ] y", ""].join("\n");
    expect(planBodyEdit(twoCases, { verb: "ADD", url: NEW_URL, section: "Backend" })).toEqual({
      kind: "refused",
      reason: "section-ambiguous",
    });
  });
});
