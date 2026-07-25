/**
 * The overlay loader's suite.
 *
 * Small file, one dangerous property: a host-injected value must NEVER be
 * overwritten by a file on disk. The overlay exists so an operator can
 * configure Atlas without editing the pack; it must not become a way for a
 * stale file to quietly re-point a live deployment's gate or ledger.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrainEnv, parseEnvFile, resolveEnvFilePath } from "./env";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-env-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeEnv(name: string, body: string): string {
  const p = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, body, "utf8");
  return p;
}

describe("parseEnvFile", () => {
  test("reads KEY=VALUE, skipping comments and blanks", () => {
    expect(
      parseEnvFile(["# a comment", "", "A=1", "B = two words ", "C="].join("\n")),
    ).toEqual({ A: "1", B: "two words", C: "" });
  });

  test("strips surrounding quotes but performs no interpolation", () => {
    expect(parseEnvFile(`A="x $B y"\nB='z'`)).toEqual({ A: "x $B y", B: "z" });
  });

  test("ignores malformed lines rather than throwing", () => {
    expect(parseEnvFile("no-equals-here\n=novalue\nOK=1")).toEqual({ OK: "1" });
  });

  test("a lone quote character is not treated as a quoted string", () => {
    expect(parseEnvFile(`A="`)).toEqual({ A: '"' });
  });
});

describe("resolution order", () => {
  test("an explicit ATLAS_ENV_FILE wins", () => {
    const p = writeEnv("explicit.env", "A=1");
    expect(resolveEnvFilePath({ ATLAS_ENV_FILE: p })).toBe(p);
  });

  test("an explicit path that does not exist resolves to nothing, not a fallback", () => {
    // Silently reading a DIFFERENT file than the operator named is how a
    // deployment ends up armed with the wrong identity.
    expect(resolveEnvFilePath({ ATLAS_ENV_FILE: join(dir, "absent.env") })).toBeNull();
  });
});

describe("loadBrainEnv", () => {
  test("fills only ABSENT keys — a host-injected value always wins", () => {
    const p = writeEnv("overlay.env", "ATLAS_PLAN_REPO=file/repo\nATLAS_CHANNEL_ID=chan-from-file");
    const env: NodeJS.ProcessEnv = {
      ATLAS_ENV_FILE: p,
      ATLAS_PLAN_REPO: "host/repo",
    };
    const load = loadBrainEnv(env);
    expect(load.path).toBe(p);
    expect(load.filled).toBe(1);
    expect(env.ATLAS_PLAN_REPO).toBe("host/repo");
    expect(env.ATLAS_CHANNEL_ID).toBe("chan-from-file");
  });

  test("an empty host value counts as absent and is filled", () => {
    const p = writeEnv("overlay.env", "ATLAS_PLAN_REPO=file/repo");
    const env: NodeJS.ProcessEnv = { ATLAS_ENV_FILE: p, ATLAS_PLAN_REPO: "" };
    loadBrainEnv(env);
    expect(env.ATLAS_PLAN_REPO).toBe("file/repo");
  });

  test("no overlay is a no-op, never an error", () => {
    const env: NodeJS.ProcessEnv = { ATLAS_ENV_FILE: join(dir, "absent.env") };
    expect(loadBrainEnv(env)).toEqual({ path: null, filled: 0 });
  });

  test("an unreadable overlay degrades to 'no overlay' rather than throwing", () => {
    // Boot must not crash-loop on a broken config file: cortex's restart
    // budget would be exhausted with three identical stderr lines to show for
    // it. An UNARMED-but-running brain that SAYS so is the correct outcome.
    const env: NodeJS.ProcessEnv = { ATLAS_ENV_FILE: dir }; // a directory
    expect(loadBrainEnv(env)).toEqual({ path: null, filled: 0 });
  });
});
