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
 *
 * ── Extraction must not require `@atlas` to find a candidate ────────────────
 * The first version of this test used `/^[ \t]*@atlas (ADD|REMOVE):.+$/` to
 * both FIND examples and to (redundantly) assert they carried the mention —
 * which made the mention assertion vacuous: an example can only ever be
 * extracted by a regex that already required the thing being asserted, so a
 * regression that drops `@atlas` from a published example makes that line
 * silently disappear from the set instead of failing anything. The extractor
 * below matches the verb WITH OR WITHOUT the mention, so a bare `ADD:`/
 * `REMOVE:` line is still extracted as a candidate, and the mention check
 * further down is the thing that actually fails on it. To keep that looser
 * pattern from also matching unrelated prose elsewhere in the file (a scope
 * trap — tightening back toward `@atlas` would silently reintroduce the same
 * vacuity), extraction is scoped to fenced code blocks inside the canonical
 * "Talking to Atlas" section only, which is where worked examples live.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseComment } from "./intake";

const README_PATH = join(import.meta.dir, "..", "README.md");
const MENTION = "@atlas ";
const SECTION_HEADING = "## Talking to Atlas — the proposal grammar";

/** Isolates the canonical grammar section: from its heading to the next `## ` heading (or EOF). */
function extractSection(source: string, heading: string): string {
  const start = source.indexOf(heading);
  if (start === -1) {
    throw new Error(`canonical grammar section heading not found: ${JSON.stringify(heading)}`);
  }
  const afterHeading = start + heading.length;
  const nextHeading = source.indexOf("\n## ", afterHeading);
  return nextHeading === -1 ? source.slice(afterHeading) : source.slice(afterHeading, nextHeading);
}

/** Content of every fenced ``` code block within `section` — where worked examples live. */
function fencedCodeBlocks(section: string): string[] {
  const blocks: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    blocks.push(m[1]!);
  }
  return blocks;
}

/**
 * A candidate example line — the verb with an OPTIONAL leading `@atlas `
 * mention. Deliberately does not require the mention: a candidate that lacks
 * it must still be extracted so the mention assertion below has something to
 * fail on, rather than the line vanishing from the set unnoticed.
 */
const CANDIDATE_LINE_RE = /^[ \t]*(?:@atlas[ \t]+)?(ADD|REMOVE):.+$/gm;

function publishedExamples(source: string): string[] {
  const section = extractSection(source, SECTION_HEADING);
  const blocks = fencedCodeBlocks(section);
  return blocks.flatMap((block) => [...block.matchAll(CANDIDATE_LINE_RE)].map((m) => m[0].trim()));
}

describe("README.md's published proposal grammar parses for real", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const examples = publishedExamples(readme);

  test("extraction actually finds published example candidates (guards against a silently-empty regex)", () => {
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });

  test("every published example candidate carries the required @atlas mention", () => {
    // Load-bearing: CANDIDATE_LINE_RE extracts a bare `ADD:`/`REMOVE:` line
    // too, so this assertion — not the extraction regex — is what catches a
    // published example that regresses to the bare form.
    for (const example of examples) {
      expect(example.startsWith(MENTION)).toBe(true);
    }
  });

  test("both ADD and REMOVE appear among the published examples", () => {
    const verbs = new Set(
      examples.map((e) => (e.startsWith(MENTION) ? e.slice(MENTION.length) : e).split(":")[0]),
    );
    expect(verbs.has("ADD")).toBe(true);
    expect(verbs.has("REMOVE")).toBe(true);
  });

  for (const example of examples) {
    test(`the real parser accepts it once the mention is stripped: ${JSON.stringify(example)}`, () => {
      // Load-bearing (see file header): this must be the assertion that
      // fails for a bare example, not a side effect of it never having been
      // extracted in the first place.
      expect(example.startsWith(MENTION)).toBe(true);
      const asDeliveredToTheBrain = example.slice(MENTION.length);
      const result = parseComment(asDeliveredToTheBrain);
      expect(result.kind).toBe("parsed");
    });
  }
});
