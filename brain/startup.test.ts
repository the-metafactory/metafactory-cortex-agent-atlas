/**
 * The startup verdict's suite.
 *
 * The line is the ONLY difference an operator can see between a working Atlas
 * and one whose gate is permanently shut, so every branch of it is pinned:
 * armed, each shape of unarmed, and the masking.
 */

import { describe, expect, test } from "bun:test";
import { loadEffectsConfig } from "./effects/config";
import { loadIdentityConfig } from "./identity";
import { buildStartupLine, maskId, type StartupFacts } from "./startup";

const PRINCIPAL_ID = "plan-steward";
const PRINCIPAL_PLATFORM_ID = "pid-principal-fixture";
const ATLAS_PLATFORM_ID = "pid-atlas-self-fixture";
const CHANNEL_ID = "chan-fixture-0000";

function armedEnv(): Record<string, string> {
  return {
    ATLAS_RATIFIER_PRINCIPAL: PRINCIPAL_ID,
    ATLAS_RATIFIER_PLATFORM_IDS: `discord:${PRINCIPAL_PLATFORM_ID}`,
    ATLAS_SELF_PLATFORM_IDS: `discord:${ATLAS_PLATFORM_ID}`,
    ATLAS_PLAN_REPO: "acme/widgets",
    ATLAS_PLAN_ISSUE: "4",
    ATLAS_CHANNEL_ID: CHANNEL_ID,
    ATLAS_TRUSTED_ADAPTER_INSTANCES: "discord:instance-fixture-0000",
  };
}

function facts(overrides: Partial<StartupFacts> = {}, env = armedEnv()): StartupFacts {
  return {
    identity: loadIdentityConfig(env),
    effects: loadEffectsConfig(env),
    ratifierIdCount: 1,
    selfIdCount: 1,
    ratifierPrincipal: env.ATLAS_RATIFIER_PRINCIPAL,
    stateDurable: true,
    envPath: null,
    envFilled: 0,
    ...overrides,
  };
}

describe("maskId", () => {
  test("a short value reveals nothing but its length", () => {
    expect(maskId("abc")).toBe("••••(len3)");
  });

  test("a longer value reveals only enough to correlate two sightings", () => {
    const masked = maskId("pid-principal-fixture");
    expect(masked).toBe("pi••re(len21)");
    expect(masked).not.toContain("principal");
  });

  test("unset and blank are stated, not faked", () => {
    expect(maskId(undefined)).toBe("(unset)");
    expect(maskId("   ")).toBe("(unset)");
  });
});

describe("the verdict", () => {
  test("ARMED when identity loaded and state is durable", () => {
    const line = buildStartupLine(facts());
    expect(line).toContain("GATE ARMED");
    expect(line).toContain("1 platform id(s)");
    expect(line).toContain("plan=acme/widgets#4");
    expect(line).toContain("state=durable");
  });

  test("the ARMED line shows the trusted-adapter-instance COUNT (atlas#24 B1)", () => {
    // The exact failure an adversarial review reproduced: a wrong (but
    // non-empty) ATLAS_TRUSTED_ADAPTER_INSTANCES rejected 100% of traffic
    // while the line still said GATE ARMED, because this second admission
    // dimension appeared nowhere in it — only `channelId` did. A count is
    // enough to notice "0 configured" or "not what I expected" without
    // leaking the value itself.
    const env = armedEnv();
    env.ATLAS_TRUSTED_ADAPTER_INSTANCES = "discord:one,discord:two";
    const line = buildStartupLine(facts({}, env));
    expect(line).toContain("GATE ARMED");
    expect(line).toContain("adapterInstances=2");
    expect(line).not.toContain("discord:one");
    expect(line).not.toContain("discord:two");
  });

  test("it is ONE line — no embedded newline anywhere", () => {
    expect(buildStartupLine(facts())).not.toContain("\n");
  });

  test("identity ids never appear in clear", () => {
    const line = buildStartupLine(facts());
    expect(line).not.toContain(PRINCIPAL_ID);
    expect(line).not.toContain(PRINCIPAL_PLATFORM_ID);
    expect(line).not.toContain(ATLAS_PLATFORM_ID);
    expect(line).not.toContain(CHANNEL_ID);
  });

  test("UNARMED names the refusal and says what it costs", () => {
    const env = armedEnv();
    delete env.ATLAS_SELF_PLATFORM_IDS;
    const line = buildStartupLine(facts({ selfIdCount: 0 }, env));
    expect(line).toContain("GATE UNARMED");
    expect(line).toContain("no-usable-self-platform-ids");
    expect(line).toContain("IGNORED");
  });

  test("a loaded identity over a degraded store is UNARMED, not armed", () => {
    // A gate that cannot durably record its decision mints no certificate and
    // therefore authorises no effect. Calling that "armed" would be the line
    // asserting something `state.ts` will refuse.
    const line = buildStartupLine(facts({ stateDurable: false }));
    expect(line).toContain("GATE UNARMED (state-degraded)");
    expect(line).toContain("MEMORY-ONLY");
  });

  test("a refused effect config is stated as an inability to act", () => {
    const env = armedEnv();
    delete env.ATLAS_CHANNEL_ID;
    const line = buildStartupLine(facts({}, env));
    // The VERDICT PREFIX first — this configuration used to print GATE ARMED
    // while `runtime.ts` short-circuited every message to `no-effect-layer`
    // (atlas#20). Asserting only the `effects:` sub-clause is what let that
    // through review, so the prefix is pinned here before anything else.
    expect(line).toContain("GATE UNARMED");
    expect(line).not.toContain("GATE ARMED");
    expect(line).toContain("effects: NONE (missing-channel-id)");
    expect(line).toContain("Atlas admits no message and can edit nothing");
  });

  test("no effect target ⇒ UNARMED, naming unreachability as the reason", () => {
    // Identity is loaded and state is durable — the two things that used to be
    // the whole arming condition. The gate is still unreachable, so ARMED would
    // be the line promising something `serveTask` refuses before intake.
    const env = armedEnv();
    delete env.ATLAS_CHANNEL_ID;
    const line = buildStartupLine(facts({ stateDurable: true }, env));
    expect(line.startsWith("atlas: GATE UNARMED (")).toBe(true);
    expect(line).toContain("unreachable:missing-channel-id");
    expect(line).toContain("IGNORED");
    expect(line).toContain("the gate never sees it");
  });

  test("no trusted adapter instance ⇒ UNARMED, naming unreachability as the reason (atlas#24)", () => {
    // Same shape as the missing-channel-id case above: identity loads and
    // state is durable, but the second admission check (`runtime.ts`) still
    // makes every message unreachable, so ARMED would overstate the promise.
    const env = armedEnv();
    delete env.ATLAS_TRUSTED_ADAPTER_INSTANCES;
    const line = buildStartupLine(facts({ stateDurable: true }, env));
    expect(line.startsWith("atlas: GATE UNARMED (")).toBe(true);
    expect(line).toContain("unreachable:missing-adapter-instances");
    expect(line).toContain("IGNORED");
  });

  test("every blocking reason is named at once, not one reboot at a time", () => {
    const env = armedEnv();
    delete env.ATLAS_SELF_PLATFORM_IDS;
    delete env.ATLAS_CHANNEL_ID;
    const line = buildStartupLine(facts({ selfIdCount: 0, stateDurable: false }, env));
    expect(line).toContain("GATE UNARMED");
    expect(line).toContain("no-usable-self-platform-ids");
    expect(line).toContain("state-degraded");
    expect(line).toContain("unreachable:missing-channel-id");
  });

  test("ARMED is printed only when identity, storage AND reachability all hold", () => {
    // The mutation guard for the arming condition: drop any ONE of the three
    // and the verdict must flip. A test that only asserts the happy line lets a
    // widened condition through.
    expect(buildStartupLine(facts())).toContain("GATE ARMED");

    const noIdentity = armedEnv();
    delete noIdentity.ATLAS_SELF_PLATFORM_IDS;
    const noEffects = armedEnv();
    delete noEffects.ATLAS_CHANNEL_ID;

    for (const line of [
      buildStartupLine(facts({ selfIdCount: 0 }, noIdentity)),
      buildStartupLine(facts({ stateDurable: false })),
      buildStartupLine(facts({}, noEffects)),
    ]) {
      expect(line).not.toContain("GATE ARMED");
      expect(line).toContain("GATE UNARMED");
    }
  });

  test("the two standing wiring limits are restated every boot", () => {
    // A reader of this line must know the ledger's receipts are local and that
    // the deleted-post detector cannot fire — both change how the ledger is
    // read, and neither is discoverable from the channel.
    const line = buildStartupLine(facts());
    expect(line).toContain("post-window only");
    expect(line).toContain("no channel read-back");
  });

  test("the overlay file is named with the count it filled", () => {
    const line = buildStartupLine(facts({ envPath: "/tmp/x/.env", envFilled: 6 }));
    expect(line).toContain("env=/tmp/x/.env(+6)");
  });

  // atlas#24 B1 — the structural guard against a THIRD admission dimension
  // repeating this exact finding. This cannot fully automate the judgment
  // call ("does a new field belong in the ARMED line?") — that is still a
  // human decision — but it makes silently SKIPPING that decision impossible:
  // `EffectsConfig`'s own key list is pinned here, so the moment a developer
  // adds a field to the interface without touching this test, the suite
  // fails on THIS line, not three atlas#-issues later after an adversarial
  // review finds it again.
  test("every EffectsConfig field is accounted for here — a new one must update this test", () => {
    const loaded = loadEffectsConfig(armedEnv());
    if (loaded.kind !== "ok") throw new Error("fixture: expected ok");
    const KNOWN_FIELDS = [
      "plan", // shown: `plan=`
      "planUrl", // NOT shown (derived from `plan`; redundant with it)
      "channelId", // shown, masked: `channel=`
      "trustedAdapterInstances", // shown, count-only: `adapterInstances=`
      "baseBranch", // shown: `base=`
      "checkoutDir", // shown: `docPRs=`
      "threadConversation", // shown: `threads=` — atlas#25, an admission dimension
    ].sort();
    expect(Object.keys(loaded.config).sort()).toEqual(KNOWN_FIELDS);

    const line = buildStartupLine(facts());
    expect(line).toContain("channel=");
    expect(line).toContain("adapterInstances=");
    expect(line).toContain("base=");
    expect(line).toContain("docPRs=");
    expect(line).toContain("plan=");
    expect(line).toContain("threads=");
  });

  // atlas#25 — the boot line must distinguish the two, or an operator cannot
  // tell from a log whether Atlas is listening to threads at all.
  test("the thread opt-in is reported honestly in both states", () => {
    expect(buildStartupLine(facts())).toContain("threads=off");
    const on = loadEffectsConfig({ ...armedEnv(), ATLAS_THREAD_CONVERSATION: "1" });
    expect(buildStartupLine(facts({ effects: on }))).toContain("threads=on");
  });
});
