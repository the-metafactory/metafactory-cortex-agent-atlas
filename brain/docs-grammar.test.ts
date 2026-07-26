/**
 * Atlas's published proposal grammar is prose, not code — nothing verified
 * that the example lines shown to a human actually parse the way the docs
 * claim (atlas#30). Three published copies of this grammar had dropped the
 * required `@atlas` mention; anyone following them got silence, not a
 * proposal (atlas#17 settled that the mention is required and correct — no
 * code change; the fix is documentation, made durable by this file).
 *
 * This test reads the example lines OUT OF README.md itself — never a
 * hand-copied duplicate — so an editor who breaks a published example (wrong
 * URL shape, missing separator, or regressing back to a bare `ADD:` with no
 * mention) turns CI red instead of shipping silently, the way this bug did.
 *
 * cortex only delivers a message to Atlas's brain when Atlas is @-mentioned,
 * and the mention is stripped before the brain ever sees the text (see
 * README.md's "Talking to Atlas" section and brain/intake.ts's file header
 * for what the parser receives after that strip). So a published example
 * must show the `@atlas ` mention — and this file proves the real parser
 * accepts whatever text is left once that mention is removed, which is the
 * only string the brain ever actually sees.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseComment } from "./intake";

const README_PATH = join(import.meta.dir, "..", "README.md");
const MENTION = "@atlas ";

/** A published example line: `@atlas ADD:`/`@atlas REMOVE:` through end of line. */
const EXAMPLE_LINE_RE = /^[ \t]*@atlas (ADD|REMOVE):.+$/gm;

function publishedExamples(source: string): string[] {
  return [...source.matchAll(EXAMPLE_LINE_RE)].map((m) => m[0].trim());
}

describe("README.md's published proposal grammar parses for real", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const examples = publishedExamples(readme);

  test("extraction actually finds published examples (guards against a silently-empty regex)", () => {
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });

  test("every published example carries the required @atlas mention", () => {
    for (const example of examples) {
      expect(example.startsWith(MENTION)).toBe(true);
    }
  });

  test("both ADD and REMOVE appear among the published examples", () => {
    const verbs = new Set(examples.map((e) => e.slice(MENTION.length).split(":")[0]));
    expect(verbs.has("ADD")).toBe(true);
    expect(verbs.has("REMOVE")).toBe(true);
  });

  for (const example of examples) {
    test(`the real parser accepts it once the mention is stripped: ${JSON.stringify(example)}`, () => {
      expect(example.startsWith(MENTION)).toBe(true);
      const asDeliveredToTheBrain = example.slice(MENTION.length);
      const result = parseComment(asDeliveredToTheBrain);
      expect(result.kind).toBe("parsed");
    });
  }
});
