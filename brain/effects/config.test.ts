/**
 * The effect universe's loader (W2c, issue #1). Every refusal is NAMED, and a
 * refusal means Atlas cannot act at all — the mirror image of identity.ts's
 * "an unarmed gate must never be silent about being unarmed".
 */

import { describe, expect, test } from "bun:test";
import {
  loadEffectsConfig,
  loadEffectsConfigFromEnv,
  makeEffectsConfig,
  type EffectsConfigRefusal,
} from "./config";

const OK = {
  ATLAS_PLAN_REPO: "acme/widgets",
  ATLAS_PLAN_ISSUE: "4",
  ATLAS_CHANNEL_ID: "chan-fixture-0000",
  ATLAS_TRUSTED_ADAPTER_INSTANCES: "discord:instance-fixture-0000",
};

function refusalFor(env: Record<string, string | undefined>): EffectsConfigRefusal | "ok" {
  const loaded = loadEffectsConfig(env);
  return loaded.kind === "ok" ? "ok" : loaded.reason;
}

describe("loadEffectsConfig", () => {
  test("a complete environment yields one repo, one issue, one channel, and a map link", () => {
    const loaded = loadEffectsConfig(OK);
    if (loaded.kind !== "ok") throw new Error(`expected ok, got ${loaded.reason}`);
    expect(loaded.config.plan).toEqual({ repo: "acme/widgets", issue: 4 });
    expect(loaded.config.channelId).toBe("chan-fixture-0000");
    expect(loaded.config.planUrl).toBe("https://github.com/acme/widgets/issues/4");
    expect(loaded.config.baseBranch).toBe("main");
    expect(loaded.config.checkoutDir).toBeNull();
    expect(loaded.config.trustedAdapterInstances.has("discord:instance-fixture-0000")).toBe(true);
  });

  test("each missing or malformed value is its own NAMED refusal", () => {
    expect(refusalFor({ ...OK, ATLAS_PLAN_REPO: "" })).toBe("missing-plan-repo");
    expect(refusalFor({ ...OK, ATLAS_PLAN_REPO: "not-a-repo" })).toBe("malformed-plan-repo");
    expect(refusalFor({ ...OK, ATLAS_PLAN_REPO: "acme/widgets/extra" })).toBe("malformed-plan-repo");
    expect(refusalFor({ ...OK, ATLAS_PLAN_ISSUE: "" })).toBe("missing-plan-issue");
    expect(refusalFor({ ...OK, ATLAS_PLAN_ISSUE: "0" })).toBe("missing-plan-issue");
    expect(refusalFor({ ...OK, ATLAS_PLAN_ISSUE: "four" })).toBe("missing-plan-issue");
    expect(refusalFor({ ...OK, ATLAS_CHANNEL_ID: "  " })).toBe("missing-channel-id");
    expect(refusalFor({ ...OK, ATLAS_CHANNEL_ID: "chan fixture" })).toBe("malformed-channel-id");
    expect(refusalFor({ ...OK, ATLAS_PLAN_BASE_BRANCH: "--force" })).toBe("malformed-base-branch");
    expect(refusalFor({ ...OK, ATLAS_TRUSTED_ADAPTER_INSTANCES: "" })).toBe(
      "missing-adapter-instances",
    );
    expect(refusalFor({ ...OK, ATLAS_TRUSTED_ADAPTER_INSTANCES: "   " })).toBe(
      "missing-adapter-instances",
    );
  });

  describe("trustedAdapterInstances (atlas#24)", () => {
    test("accepts multiple comma/whitespace-separated ids", () => {
      const loaded = loadEffectsConfig({
        ...OK,
        ATLAS_TRUSTED_ADAPTER_INSTANCES: "discord:one, discord:two\tdiscord:three",
      });
      if (loaded.kind !== "ok") throw new Error(`expected ok, got ${loaded.reason}`);
      expect(loaded.config.trustedAdapterInstances.has("discord:one")).toBe(true);
      expect(loaded.config.trustedAdapterInstances.has("discord:two")).toBe(true);
      expect(loaded.config.trustedAdapterInstances.has("discord:three")).toBe(true);
      expect(loaded.config.trustedAdapterInstances.size).toBe(3);
    });

    test("an id not in the configured set is simply absent — no fuzzy match", () => {
      const loaded = loadEffectsConfig(OK);
      if (loaded.kind !== "ok") throw new Error(`expected ok, got ${loaded.reason}`);
      expect(loaded.config.trustedAdapterInstances.has("discord:instance-fixture-0001")).toBe(
        false,
      );
      expect(loaded.config.trustedAdapterInstances.has("")).toBe(false);
    });

    test("a comma-only value yields no usable id, refused rather than admitting everything", () => {
      expect(refusalFor({ ...OK, ATLAS_TRUSTED_ADAPTER_INSTANCES: " , , " })).toBe(
        "missing-adapter-instances",
      );
    });
  });

  test("an unresolved installer placeholder is refused, not treated as a repo", () => {
    // `__ATLAS_PLAN_REPO__` is what agent.yaml ships; a deployment that never
    // resolved it must not end up with Atlas aiming at a literal placeholder.
    expect(refusalFor({ ...OK, ATLAS_PLAN_REPO: "__ATLAS_PLAN_REPO__" })).toBe("malformed-plan-repo");
    expect(refusalFor({ ...OK, ATLAS_PLAN_ISSUE: "__ATLAS_PLAN_ISSUE__" })).toBe("missing-plan-issue");
  });

  test("the collapsed form is fail-closed: an incomplete environment yields null", () => {
    expect(loadEffectsConfigFromEnv({ ...OK, ATLAS_CHANNEL_ID: "" })).toBeNull();
    expect(loadEffectsConfigFromEnv(OK)).not.toBeNull();
  });

  test("values are trimmed but never repaired", () => {
    const loaded = makeEffectsConfig({
      planRepo: "  acme/widgets  ",
      planIssue: " 4 ",
      channelId: " chan-fixture-0000 ",
      adapterInstances: "discord:instance-fixture-0000",
      checkoutDir: "  ",
    });
    if (loaded.kind !== "ok") throw new Error("expected ok");
    expect(loaded.config.plan.repo).toBe("acme/widgets");
    expect(loaded.config.checkoutDir).toBeNull(); // whitespace-only is NOT a directory
  });

  test("the resolved config is frozen — no caller can retarget it after load", () => {
    const loaded = makeEffectsConfig({
      planRepo: "acme/widgets",
      planIssue: 4,
      channelId: "chan-fixture-0000",
      adapterInstances: "discord:instance-fixture-0000",
    });
    if (loaded.kind !== "ok") throw new Error("expected ok");
    const cfg = loaded.config;
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.plan)).toBe(true);
    expect(() => {
      (cfg as { channelId: string }).channelId = "chan-fixture-9999";
    }).toThrow();
    expect(cfg.channelId).toBe("chan-fixture-0000");
  });
});
