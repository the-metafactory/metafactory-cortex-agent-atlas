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
    test("accepts multiple COMMA-separated ids, trimmed", () => {
      const loaded = loadEffectsConfig({
        ...OK,
        ATLAS_TRUSTED_ADAPTER_INSTANCES: "discord:one, discord:two , discord:three",
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

    // atlas#24 M4 — an adversarial review found that splitting on whitespace
    // AS WELL AS commas silently WIDENED the trusted set: a copy-paste error
    // that put a stray space or tab inside one intended id turned it into TWO
    // trusted ids, neither of which the operator wrote. Comma is now the ONLY
    // separator, so a value like this stays ONE token and is refused as
    // malformed — it never matches anything, but it also never silently
    // widens the set into believing it configured two instances.
    test("whitespace alone (no comma) does NOT split — stays one token, refused as malformed", () => {
      const reason = refusalFor({
        ...OK,
        ATLAS_TRUSTED_ADAPTER_INSTANCES: "discord:one\tdiscord:two",
      });
      expect(reason).toBe("malformed-adapter-instance");
    });

    test("a space inside one entry is refused, not silently accepted or split", () => {
      const reason = refusalFor({
        ...OK,
        ATLAS_TRUSTED_ADAPTER_INSTANCES: "discord:my guild",
      });
      expect(reason).toBe("malformed-adapter-instance");
    });

    test("an over-long token is refused (length bound, same posture as CHANNEL_ID_RE)", () => {
      const reason = refusalFor({
        ...OK,
        ATLAS_TRUSTED_ADAPTER_INSTANCES: `discord:${"x".repeat(200)}`,
      });
      expect(reason).toBe("malformed-adapter-instance");
    });

    test("a token starting with a non-alphanumeric character is refused (atlas#24 N1)", () => {
      // The installer-placeholder shape (`__NAME__`) always starts with `_`,
      // so requiring the first character be alphanumeric structurally excludes
      // it — see the dedicated placeholder test below for the literal case.
      expect(refusalFor({ ...OK, ATLAS_TRUSTED_ADAPTER_INSTANCES: "_leading-underscore" })).toBe(
        "malformed-adapter-instance",
      );
    });

    test("an unresolved installer placeholder is refused, not treated as a trusted id (atlas#24 N1)", () => {
      // `__ATLAS_TRUSTED_ADAPTER_INSTANCES__` is what agent.yaml ships. Before
      // this guard it would parse as one (weird-looking but non-blank) token
      // and be ACCEPTED — a deployment that never resolved the placeholder
      // would boot GATE ARMED and reject 100% of live traffic, silently.
      expect(
        refusalFor({
          ...OK,
          ATLAS_TRUSTED_ADAPTER_INSTANCES: "__ATLAS_TRUSTED_ADAPTER_INSTANCES__",
        }),
      ).toBe("malformed-adapter-instance");
    });

    test("a mix of one valid and one malformed token refuses the WHOLE config", () => {
      // Not "keep the good one and drop the bad one" — a partially-malformed
      // value is exactly the shape of an operator's typo, and admitting
      // whatever parsed cleanly would silently narrow (or on a different typo,
      // widen) the trusted set from what they intended.
      const reason = refusalFor({
        ...OK,
        ATLAS_TRUSTED_ADAPTER_INSTANCES: "discord:good-one,discord:bad one",
      });
      expect(reason).toBe("malformed-adapter-instance");
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

// ═══════════════════════════════════════════════════════════════════════════
// ATLAS_THREAD_CONVERSATION (atlas#25; adversarial review M1).
//
// This one boolean is the whole guard in front of the thread feature — it
// decides both whether Atlas opens threads AND whether it admits messages from
// threads it opened. A denylist implementation (`v !== "0" && v !== "false"`)
// passes EVERY positive test and arms the capability on a blank string, a
// typo, `off`, `no`, or `disabled`. Positive tests cannot see the difference,
// so the negative ones below are the entire property.
// ═══════════════════════════════════════════════════════════════════════════

function threadFlagFor(raw: string | undefined): boolean {
  const loaded = loadEffectsConfig(
    raw === undefined ? OK : { ...OK, ATLAS_THREAD_CONVERSATION: raw },
  );
  if (loaded.kind !== "ok") throw new Error(`expected ok, got ${loaded.reason}`);
  return loaded.config.threadConversation;
}

describe("the thread opt-in is fail-closed by ALLOWLIST", () => {
  test("unset is off — the default a deployment gets by doing nothing", () => {
    expect(threadFlagFor(undefined)).toBe(false);
  });

  test("only the four documented affirmatives arm it", () => {
    for (const yes of ["1", "true", "yes", "on", "TRUE", "Yes", "ON", " 1 ", "  true  "]) {
      expect(threadFlagFor(yes)).toBe(true);
    }
  });

  test("EVERY other value is off — including the ones that read as intent", () => {
    // `off`/`no`/`disabled`/`none` are what an operator actually types when
    // they mean off, and a denylist parser would arm the capability on all of
    // them. `""` is what an operator gets from `export ATLAS_THREAD_CONVERSATION=`
    // or an empty entry in an env file — the single most likely accident.
    for (const no of [
      "",
      " ",
      "\t",
      "0",
      "false",
      "FALSE",
      "no",
      "off",
      "OFF",
      "disabled",
      "none",
      "null",
      "undefined",
      "2",
      "-1",
      "yes please",
      "true ish",
      "enable",
      "enabled",
      "y",
      "n",
      "t",
      "f",
      "🧵",
    ]) {
      expect(threadFlagFor(no)).toBe(false);
    }
  });

  test("a garbage value degrades to OFF rather than refusing the whole config", () => {
    // The other fail-closed choice — refusing the config — would take the
    // ledger and the plan down over a typo in an optional knob. Wrong trade:
    // this flag failing closed means "no threads", not "no Atlas".
    const loaded = loadEffectsConfig({ ...OK, ATLAS_THREAD_CONVERSATION: "yes-ish" });
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok") return;
    expect(loaded.config.threadConversation).toBe(false);
    expect(loaded.config.channelId).toBe("chan-fixture-0000");
  });

  test("makeEffectsConfig accepts a real boolean too, for callers that have one", () => {
    for (const [input, expected] of [
      [true, true],
      [false, false],
      [undefined, false],
    ] as const) {
      const loaded = makeEffectsConfig({
        planRepo: "acme/widgets",
        planIssue: 4,
        channelId: "chan-fixture-0000",
        adapterInstances: "discord:instance-fixture-0000",
        threadConversation: input,
      });
      if (loaded.kind !== "ok") throw new Error("expected ok");
      expect(loaded.config.threadConversation).toBe(expected);
    }
  });
});
