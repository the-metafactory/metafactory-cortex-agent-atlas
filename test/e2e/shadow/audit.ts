/**
 * THE ARGV AUDIT — a `gh`/`git` shim that RECORDS and then RUNS.
 *
 * The wiring suite (`brain/wiring.e2e.test.ts`) fakes `gh` on PATH so it never
 * touches a network. The rehearsal does the opposite: the shim is a pass-through
 * to the real binary, and its only job is to leave a complete, ordered
 * transcript of every command Atlas actually executed against a live GitHub.
 *
 * That transcript is what turns three DoD claims from "we believe the code
 * cannot" into "here is everything it did":
 *
 *   - no invocation ever carried the PR-completing verb;
 *   - every write was aimed at the throwaway repo, never the live plan;
 *   - the count and shape of the writes match the walkthrough's narration.
 *
 * ── Record format ──────────────────────────────────────────────────────────
 * argv elements are NUL-separated and records are RS-separated (0x1e), because
 * a shell can emit both with `printf` alone and neither byte can occur inside a
 * command-line argument. No quoting, no escaping, no ambiguity.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 0x1e between records, NUL between the arguments of one record. */
const RECORD_SEP = "\u001e";
const ARG_SEP = "\u0000";

export interface ArgvAudit {
  /** Prepend to PATH so Atlas's `Bun.spawn("gh", …)` resolves to the shim. */
  readonly binDir: string;
  /** Every invocation, in order, as argv arrays. */
  records(): string[][];
}

/** Resolve a binary on the CURRENT PATH, before the shim shadows it. */
function realPath(bin: string): string {
  const which = Bun.spawnSync(["/usr/bin/which", bin], { stdout: "pipe", stderr: "pipe" });
  const p = which.stdout.toString().trim().split("\n")[0] ?? "";
  if (p.length === 0 || !existsSync(p)) {
    throw new Error(`shadow rehearsal: ${bin} is not on PATH — the rehearsal needs the real one`);
  }
  return p;
}

/**
 * Write pass-through shims for `gh` and `git` into `dir`, recording into
 * `dir/audit-bin/argv.log`.
 */
export function installArgvAudit(dir: string): ArgvAudit {
  const binDir = join(dir, "audit-bin");
  const logPath = join(binDir, "argv.log");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(logPath, "", "utf8");

  for (const bin of ["gh", "git"] as const) {
    const real = realPath(bin);
    // `\\000` / `\\036` reach the shell as `\000` / `\036` — POSIX printf octal
    // escapes for NUL and RS.
    // argv[0] is recorded EXPLICITLY: `"$@"` carries only the arguments, and a
    // transcript that cannot tell `gh push` from `git push` cannot answer the
    // question this file exists to answer.
    const script = `#!/bin/sh
# Shadow-rehearsal audit shim for ${bin}. Records argv, then execs the real one.
{ printf '%s\\000' "${bin}" "$@"; printf '\\036'; } >> "${logPath}"
exec "${real}" "$@"
`;
    const p = join(binDir, bin);
    writeFileSync(p, script, "utf8");
    chmodSync(p, 0o755);
  }

  return {
    binDir,
    records(): string[][] {
      const raw = readFileSync(logPath, "utf8");
      return raw
        .split(RECORD_SEP)
        .filter((r) => r.length > 0)
        .map((r) => r.split(ARG_SEP).filter((a) => a.length > 0));
    },
  };
}

/** Every recorded invocation rendered as one line each, for failure messages. */
export function renderAudit(records: readonly string[][]): string {
  return records.map((r, i) => `  ${String(i + 1).padStart(3, " ")}. ${r.join(" ")}`).join("\n");
}

/**
 * The constitution, read off the transcript.
 *
 * `merge` is matched case-insensitively across the WHOLE argv, not just the
 * subcommand slot: `gh api --method PUT …/merge` would be a merge too, and so
 * would `git merge`. Nothing Atlas legitimately does contains the token.
 */
export function invocationsCarryingMerge(records: readonly string[][]): string[][] {
  return records.filter((argv) => argv.some((a) => /merge/i.test(a)));
}

/**
 * The invocations that CHANGE something. `gh issue view` is on Atlas's
 * allowlist but is a read (it is how a revision receipt is obtained), so a
 * "did anything get written?" question has to name the mutating verbs rather
 * than assume "not `gh api`" means "a write".
 */
export function mutations(records: readonly string[][]): string[][] {
  return records.filter((a) => {
    if (a[0] === "git") return a[1] === "push";
    if (a[0] !== "gh") return false;
    if (a[1] === "issue") return a[2] === "edit" || a[2] === "comment";
    if (a[1] === "pr") return a[2] === "create";
    return false;
  });
}

/** Invocations naming `needle` in any argument — used for the live-plan fence. */
export function invocationsTouching(records: readonly string[][], needle: string): string[][] {
  return records.filter((argv) => argv.some((a) => a.includes(needle)));
}
