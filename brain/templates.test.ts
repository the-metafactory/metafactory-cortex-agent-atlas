/**
 * Proves the format strings `templates.ts` advertises to users are actually
 * reachable — a template that instructs "type this" is a claim about
 * behaviour, and an untested claim is exactly how atlas#31 shipped.
 *
 * ── Why these two functions and not the others ──────────────────────────────
 * `malformedReply` and `surfacedSummary` are the only functions in this file
 * that print a literal command shape for the reader to copy. Every other
 * template (`declinedReply`, `ratifiedAck`, `declinedByRatifierAck`,
 * `nothingToRatifyReply`, `commandTooLongReply`, `stateDegradedReply`,
 * `ratifiedNotCertifiedReply`) either states facts about what happened or
 * gives prose guidance ("send it again shorter", "send the verb again")
 * without ever spelling out a literal string to type — nothing there can
 * regress to an unreachable form because nothing there advertises a form.
 * See the audit note in the PR/report for the full pass.
 *
 * ── Delivery model these tests assume ───────────────────────────────────────
 * runtime.ts feeds the IDENTICAL `task.payload.text` to both `processComment`
 * (intake.ts's ADD/REMOVE grammar) and `processGateMessage` (ratify.ts's
 * RATIFY/DECLINE grammar) — see runtime.ts's `handleTask`. Cortex only ever
 * delivers that task when the agent is @-mentioned, and it delivers the text
 * with the mention already stripped (atlas#17, decided). So EVERY format
 * string these templates print — proposal grammar or gate grammar alike —
 * must carry the `@atlas ` mention, and the only string the real parsers ever
 * see is what remains after that mention is removed.
 *
 * ── Load-bearing, not decorative ─────────────────────────────────────────────
 * Each extraction regex below matches the advertised text WITHOUT requiring
 * the mention to be present — so a regression back to the bare form is still
 * extracted, and it is the `startsWith(MENTION)` assertion that fails on it,
 * not the extraction silently coming up empty. This mirrors the fix applied
 * to the sibling docs-grammar test (see git history) after its first version
 * used an extractor that itself required `@atlas`, making that assertion
 * unable to ever fail.
 */

import { describe, expect, test } from "bun:test";
import { parseComment, type ParsedProposal, type ProposalVerb } from "./intake";
import { parseGateCommand } from "./ratify";
import { malformedReply, surfacedSummary } from "./templates";

const MENTION = "@atlas ";

describe("malformedReply's advertised format actually parses", () => {
  for (const verb of ["ADD", "REMOVE"] as const satisfies readonly ProposalVerb[]) {
    test(`${verb}: the quoted format string carries the mention and parses once stripped`, () => {
      const reply = malformedReply(verb, "some parse failure reason");

      // Extract the quoted template from the REAL string the function
      // returns — not re-derived, not hand-copied.
      const match = /Format: "([^"]+)"/.exec(reply);
      expect(match).not.toBeNull();
      const template = match![1]!;

      // Load-bearing: this is what fails if `malformedReply` regresses to
      // the bare `${verb}: <github issue url> — <why>` form.
      expect(template.startsWith(MENTION)).toBe(true);

      const asDeliveredToTheBrain = template
        .slice(MENTION.length)
        .replace("<github issue url>", "https://github.com/acme/widgets/issues/42")
        .replace("<why>", "because it improves onboarding");

      const result = parseComment(asDeliveredToTheBrain);
      expect(result.kind).toBe("parsed");
      if (result.kind === "parsed") {
        expect(result.proposal.verb).toBe(verb);
        expect(result.proposal.url).toBe("https://github.com/acme/widgets/issues/42");
        expect(result.proposal.why).toBe("because it improves onboarding");
      }
    });

    // atlas#45: someone who just got the format wrong is exactly the person
    // who needs to know HELP exists — this is the "hook discovery into
    // malformedReply" acceptance criterion.
    test(`${verb}: advertises HELP as the recovery path`, () => {
      const reply = malformedReply(verb, "some parse failure reason");
      expect(reply).toContain("@atlas HELP");
    });
  }
});

describe("surfacedSummary's ratify/decline instructions actually reach the gate", () => {
  const proposal: ParsedProposal = {
    verb: "ADD",
    url: "https://github.com/acme/widgets/issues/42",
    section: null,
    why: "a representative why-field",
    raw: "@atlas ADD: https://github.com/acme/widgets/issues/42 — a representative why-field",
  };
  const summary = surfacedSummary(7, proposal, "octocat");

  test("the ratify line carries the mention and parses as RATIFY", () => {
    const match = /^To ratify: (.+)$/m.exec(summary);
    expect(match).not.toBeNull();
    const line = match![1]!;

    // Load-bearing: fails if the line regresses to bare `RATIFY 7`.
    expect(line.startsWith(MENTION)).toBe(true);

    const asDeliveredToTheBrain = line.slice(MENTION.length);
    const result = parseGateCommand(asDeliveredToTheBrain);
    expect(result).toEqual({ kind: "command", command: { verb: "RATIFY", displayId: 7 } });
  });

  test("the decline line carries the mention and parses as DECLINE", () => {
    const match = /^To decline: (.+)$/m.exec(summary);
    expect(match).not.toBeNull();
    const template = match![1]!;

    // Load-bearing: fails if the line regresses to bare `DECLINE 7 <why>`.
    expect(template.startsWith(MENTION)).toBe(true);

    const asDeliveredToTheBrain = template
      .slice(MENTION.length)
      .replace("<why>", "not aligned with the current roadmap");
    const result = parseGateCommand(asDeliveredToTheBrain);
    expect(result).toEqual({
      kind: "command",
      command: { verb: "DECLINE", displayId: 7, reason: "not aligned with the current roadmap" },
    });
  });
});
