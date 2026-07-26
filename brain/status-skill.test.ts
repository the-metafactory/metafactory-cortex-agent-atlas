/**
 * Pins the "Status" section of `persona.md` — Atlas's own system prompt (see
 * that file's header: it is LOAD-BEARING at runtime, not only documentation).
 * Issue #28's acceptance criteria require the skill to "refuse and say so
 * when the tool is unavailable; it never reconstructs status from another
 * source" — that rule lives in prose, not code, so it needs the same
 * durability `docs-grammar.test.ts` gives README's proposal grammar: an
 * editor who softens or drops the prohibition turns CI red instead of
 * shipping a persona that quietly starts guessing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PERSONA_PATH = join(import.meta.dir, "..", "persona.md");
const SECTION_HEADING = "## Status";

function extractSection(source: string, heading: string): string {
  const start = source.indexOf(heading);
  if (start === -1) throw new Error(`section heading not found: ${JSON.stringify(heading)}`);
  const afterHeading = start + heading.length;
  const nextHeading = source.indexOf("\n## ", afterHeading);
  return nextHeading === -1 ? source.slice(afterHeading) : source.slice(afterHeading, nextHeading);
}

describe("persona.md's Status section carries the CLI-routing rule and its prohibition", () => {
  const persona = readFileSync(PERSONA_PATH, "utf8");
  const section = extractSection(persona, SECTION_HEADING);

  test("routes to the CLI by name, rather than leaving the model to compute an answer", () => {
    expect(section).toContain("atlas-status");
  });

  test("states the freshness requirement explicitly", () => {
    expect(section.toLowerCase()).toContain("freshness");
  });

  test("carries the refuse-and-stop prohibition — never gh issue list, never reconstruct", () => {
    expect(section).toContain("STOP");
    expect(section).toContain("gh issue list");
    expect(section.toLowerCase()).toContain("do not");
  });

  test("names --live divergence as reported, not silently resolved", () => {
    expect(section).toContain("--live");
    expect(section.toLowerCase()).toContain("divergence");
  });
});
