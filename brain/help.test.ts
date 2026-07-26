/**
 * `isHelpRequest`'s verb detection (atlas#45), plus proof that `helpText()`'s
 * embedded examples parse with the REAL parsers — the same discipline
 * `docs-grammar.test.ts` holds README.md to and `templates.test.ts` holds the
 * other reply templates to. A help text that drifts from the grammar would be
 * the FIFTH wrong copy (see the issue and `intake.ts`/`ratify.ts`'s headers),
 * so this file is the guard that makes that impossible to ship silently.
 */

import { describe, expect, test } from "bun:test";
import { isHelpRequest } from "./help";
import { parseComment } from "./intake";
import { parseGateCommand } from "./ratify";
import { helpText } from "./templates";

describe("isHelpRequest", () => {
  test.each(["HELP", "help"])("accepts the exact literal %p", (body) => {
    expect(isHelpRequest(body)).toBe(true);
  });

  test("accepts HELP/help followed by trailing content — no arguments required", () => {
    expect(isHelpRequest("HELP me understand this")).toBe(true);
    expect(isHelpRequest("help please")).toBe(true);
  });

  test("accepts up to 20 chars of leading whitespace, same bound as intake.ts/ratify.ts", () => {
    expect(isHelpRequest("   HELP")).toBe(true);
    expect(isHelpRequest("\t\tHELP")).toBe(true);
  });

  test("rejects mixed/other case — only the two literal spellings are accepted", () => {
    expect(isHelpRequest("Help")).toBe(false);
    expect(isHelpRequest("HElP")).toBe(false);
    expect(isHelpRequest("hELP")).toBe(false);
  });

  test("rejects a word that merely starts with the token — word-boundary discipline", () => {
    expect(isHelpRequest("Helpful tips: ADD: ...")).toBe(false);
    expect(isHelpRequest("HELPME")).toBe(false);
    expect(isHelpRequest("helping out today")).toBe(false);
  });

  test("rejects HELP appearing mid-sentence, not as the leading token", () => {
    expect(isHelpRequest("I could use some HELP")).toBe(false);
    expect(isHelpRequest("please help")).toBe(false);
  });

  test("rejects empty and non-string input without throwing", () => {
    expect(isHelpRequest("")).toBe(false);
    // @ts-expect-error — deliberately adversarial input, mirroring intake.ts's own tests
    expect(isHelpRequest(null)).toBe(false);
    // @ts-expect-error
    expect(isHelpRequest(undefined)).toBe(false);
  });

  test("ordinary chatter is never mistaken for the verb", () => {
    expect(isHelpRequest("morning all")).toBe(false);
    expect(isHelpRequest("RATIFY 1")).toBe(false);
    expect(isHelpRequest("ADD: https://github.com/acme/widgets/issues/1 — why")).toBe(false);
  });
});

// ── helpText() content ───────────────────────────────────────────────────────

const MENTION = "@atlas ";
const text = helpText();

describe("helpText() is identity-neutral prose", () => {
  test("describes the protocol, never the reader ('the principal may…', never 'you may…')", () => {
    // Load-bearing: this is the exact failure mode the issue warns about — a
    // help text that addresses the reader's own authority ("you may ratify")
    // would leak who is trusted depending on who asks. Asserting the text
    // never uses second person is a cheap, durable guard against that
    // regression creeping back in during a future edit.
    expect(/\byou\b/i.test(text)).toBe(false);
    expect(/\byour\b/i.test(text)).toBe(false);
  });

  test("takes no parameters — there is no identity input for the text to vary on", () => {
    expect(helpText.length).toBe(0);
    expect(helpText()).toBe(helpText());
  });

  test("names all three causes of silence", () => {
    expect(text).toMatch(/never arrived/i);
    expect(text).toMatch(/(not admitted|wasn't admitted)/i);
    expect(text).toMatch(/(not parsed|wasn't parsed)/i);
  });
});

describe("helpText()'s examples parse with the REAL parsers", () => {
  const lines = text.split("\n").filter((l) => l.trim().startsWith(MENTION));

  test("extraction actually finds example lines (guards against a silently-empty set)", () => {
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  test("both ADD and REMOVE are shown", () => {
    expect(lines.some((l) => l.includes("ADD:"))).toBe(true);
    expect(lines.some((l) => l.includes("REMOVE:"))).toBe(true);
  });

  test("both RATIFY and DECLINE are shown", () => {
    expect(lines.some((l) => l.includes("RATIFY"))).toBe(true);
    expect(lines.some((l) => l.includes("DECLINE"))).toBe(true);
  });

  for (const raw of lines) {
    const line = raw.trim();
    test(`parses once the mention is stripped: ${JSON.stringify(line)}`, () => {
      expect(line.startsWith(MENTION)).toBe(true);
      const asDeliveredToTheBrain = line
        .slice(MENTION.length)
        .replace("<github issue url>", "https://github.com/acme/widgets/issues/42")
        .replace("<why>", "because it improves onboarding")
        .replace("<id>", "7")
        .replace("<reason>", "not aligned with the current roadmap");

      if (asDeliveredToTheBrain.startsWith("ADD:") || asDeliveredToTheBrain.startsWith("REMOVE:")) {
        const result = parseComment(asDeliveredToTheBrain);
        expect(result.kind).toBe("parsed");
      } else {
        const result = parseGateCommand(asDeliveredToTheBrain);
        expect(result.kind).toBe("command");
      }
    });
  }
});
