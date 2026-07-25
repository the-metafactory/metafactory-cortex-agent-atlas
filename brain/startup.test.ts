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
});
