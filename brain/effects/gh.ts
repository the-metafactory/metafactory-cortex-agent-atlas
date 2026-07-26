/**
 * Atlas's WRITING gh adapter (W2c, issue #1; the-metafactory/vision#9 §3 J3/J6,
 * §6). This is the first module in the pack that can change something outside
 * Atlas's own state, so read this header before changing a line of it.
 *
 * ── Relationship to the read-only adapter ──────────────────────────────────
 * `brain/gh.ts` (W2a) stays exactly what it is: reads, over ARBITRARY repos,
 * because validating a proposal means resolving an issue URL that by definition
 * points anywhere. This file is the opposite shape: WRITES (plus the plan
 * issue's own read-back), over EXACTLY ONE repo, which the caller cannot name.
 * Keeping them in separate files keeps that asymmetry visible: the file that
 * can write cannot be pointed anywhere, and the file that can be pointed
 * anywhere cannot write.
 *
 * ── An ALLOWLIST, not a banned list ────────────────────────────────────────
 * W2a's adapter refuses a list of write-shaped tokens. That discipline is
 * extended here, not weakened: a banned list is a claim about what you thought
 * of, and this slice's whole risk is the thing nobody thought of. So:
 *
 *   1. `PlanWriteIntent` is a CLOSED union of five variants. There is no sixth,
 *      and the only way to express one is to add it to that union — a visible,
 *      reviewable diff in this file. `effects/gh.test.ts` pins the union with a
 *      `@ts-expect-error`, so adding a variant BREAKS THE BUILD of the test
 *      that says it cannot exist.
 *   2. `buildInvocation` is the only producer of an argv, and it is a total
 *      switch over that union — an unknown `kind` returns `null`.
 *   3. `assertAllowed` re-validates the FINISHED argv at the chokepoint,
 *      against a frozen table of exact argv prefixes. Nothing runs that does
 *      not match one of them, so an argv assembled by some future caller (or by
 *      a bug in the builder) still cannot execute an unlisted subcommand.
 *   4. The same chokepoint pins the TARGET: `--repo` must be the configured
 *      plan repo, the issue argument must be the configured plan issue, and a
 *      push must go to the plan repo's own https URL — not a named remote,
 *      which is a pointer some other tool controls. Configuration is checked
 *      at the point of execution, not merely at the point of intent.
 *
 * Constitution rule 2 (persona.md; vision#9 §2) says Atlas never performs the
 * one PR-completing verb that would land a change without a human. That rule is
 * kept here by ABSENCE and it is meant to be greppable: no method on this
 * adapter, no variant of the intent union, and no entry in the allowlist table
 * expresses it — and the token does not appear anywhere in this file, so
 * `git grep -in <that verb> brain/effects/gh.ts` returns nothing at all.
 * `effects/gh.test.ts` asserts that emptiness structurally (prototype scan,
 * table scan, source scan, and a compile-time proof) rather than trusting this
 * paragraph.
 *
 * ── Untrusted text never enters argv ───────────────────────────────────────
 * Every body — a plan body containing a proposer's URL, a PR body, a comment —
 * is delivered on STDIN via `--body-file -`, never as an argv element. Argv is
 * already injection-safe here (an array, never a shell string), so this is
 * defence in depth against a body that begins with a dash and a flag parser
 * that is cleverer than we expect.
 */

import type { PlanCoordinates } from "../gh";
import type { EffectsConfig } from "./config";

function warn(msg: string): void {
  process.stderr.write(`atlas: effects-gh: ${msg}\n`);
}

/** Max bytes Atlas will hand to a single write. GitHub's issue-body ceiling is 65536. */
const MAX_BODY_BYTES = 60_000;

/** A branch name Atlas is willing to push. Mirrors effects/config.ts's rule. */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;

/**
 * The CLOSED set of things this adapter can be asked to do. Five variants,
 * each one an entry in vision#9 §6's least-privilege table.
 *
 * Note what is NOT parameterised: no repo, no issue number, no channel. Those
 * come from `EffectsConfig` and cannot be supplied by a caller, so no amount of
 * proposal content can retarget an effect.
 */
export type PlanWriteIntent =
  /** `gh issue view` on the plan issue — the body read-back and its receipt. */
  | { kind: "issue-view" }
  /** `gh issue comment` on the plan issue. */
  | { kind: "issue-comment"; body: string }
  /** `gh issue edit --body` on the plan issue (delivered on stdin). */
  | { kind: "issue-edit-body"; body: string }
  /** `gh pr create` against the plan repo — the J6 doc-change path. */
  | { kind: "pr-create"; head: string; title: string; body: string }
  /** `git push` of one branch to the plan repo's https URL — J6's other half. */
  | { kind: "branch-push"; branch: string };

/** A fully-built, not-yet-validated invocation. `stdin`/`cwd` are explicit nulls. */
export interface GhInvocation {
  readonly argv: readonly string[];
  readonly stdin: string | null;
  readonly cwd: string | null;
}

/**
 * The allowlist. Every invocation must start with one of these EXACT prefixes.
 * Frozen, exported, and asserted element-for-element by the test suite: this
 * table is the machine-readable statement of Atlas's write privileges.
 */
export const ALLOWED_ARGV_PREFIXES: ReadonlyArray<readonly string[]> = Object.freeze([
  Object.freeze(["gh", "issue", "view"]),
  Object.freeze(["gh", "issue", "comment"]),
  Object.freeze(["gh", "issue", "edit"]),
  Object.freeze(["gh", "pr", "create"]),
  Object.freeze(["git", "push"]),
]);

/**
 * Flags that must never appear, whatever the prefix. History rewriting is
 * constitution rule 4; `-X`/`--method` would turn a `gh api` call into an
 * arbitrary verb; `--admin` is a privilege escalation flag on gh's PR family.
 * This is the belt. The allowlist above is the braces.
 */
const FORBIDDEN_FLAGS: ReadonlySet<string> = new Set([
  "--force",
  "-f",
  "--force-with-lease",
  "--delete",
  "-d",
  "--admin",
  "-X",
  "--method",
  "--auto",
]);

/** Why an invocation was refused at the chokepoint. Every value is greppable. */
export type InvocationRefusal =
  | "unlisted-command"
  | "forbidden-flag"
  | "unpinned-target"
  | "malformed-argument"
  | "body-too-large";

export class RefusedInvocation extends Error {
  constructor(
    readonly reason: InvocationRefusal,
    detail: string,
  ) {
    super(`atlas: effects-gh: refused (${reason}): ${detail}`);
    this.name = "RefusedInvocation";
  }
}

/** The https clone URL of the configured plan repo. The ONLY push destination. */
export function planRemoteUrl(plan: PlanCoordinates): string {
  return `https://github.com/${plan.repo}.git`;
}

function usableArg(a: unknown): a is string {
  return typeof a === "string" && a.length > 0 && !a.includes("\0");
}

function startsWithPrefix(argv: readonly string[], prefix: readonly string[]): boolean {
  if (argv.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (argv[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * THE CHOKEPOINT. Throws `RefusedInvocation` unless the invocation is on the
 * allowlist AND aimed at the configured plan repo.
 *
 * Exported so a test can attempt an unlisted invocation directly — the "an
 * attempt to construct one fails" half of the no-such-verb proof — without
 * spawning anything.
 */
export function assertAllowed(inv: GhInvocation, plan: PlanCoordinates): void {
  const argv = inv.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(usableArg)) {
    throw new RefusedInvocation("malformed-argument", "argv must be non-empty printable strings");
  }
  const prefix = ALLOWED_ARGV_PREFIXES.find((p) => startsWithPrefix(argv, p));
  if (prefix === undefined) {
    throw new RefusedInvocation("unlisted-command", `${argv.slice(0, 3).join(" ")} is not allowlisted`);
  }
  for (const arg of argv) {
    if (FORBIDDEN_FLAGS.has(arg)) {
      throw new RefusedInvocation("forbidden-flag", `${arg} may never be passed`);
    }
  }

  if (argv[0] === "git") {
    // `git push <https-url> refs/heads/x:refs/heads/x` — a URL from config, not
    // a named remote (a remote is a pointer some other tool can repoint), and a
    // fully-qualified, non-forced refspec (no leading `+`).
    const url = argv[2];
    const refspec = argv[3];
    if (url !== planRemoteUrl(plan)) {
      throw new RefusedInvocation("unpinned-target", "push destination is not the configured plan repo");
    }
    if (argv.length !== 4 || refspec === undefined || !/^refs\/heads\/[^:+]+:refs\/heads\/[^:+]+$/.test(refspec)) {
      throw new RefusedInvocation("malformed-argument", "push must carry exactly one plain refspec");
    }
    return;
  }

  // gh: exactly one `--repo`, and it must be the configured plan repo.
  const repoFlags = argv.filter((a) => a === "--repo" || a === "-R");
  if (repoFlags.length !== 1) {
    throw new RefusedInvocation("unpinned-target", "a gh invocation must carry exactly one --repo");
  }
  const repoIdx = argv.indexOf("--repo");
  const repoValue = repoIdx >= 0 ? argv[repoIdx + 1] : undefined;
  if (repoValue !== plan.repo) {
    throw new RefusedInvocation("unpinned-target", "gh --repo is not the configured plan repo");
  }

  if (argv[1] === "issue") {
    // The issue number is positional, immediately after the subcommand, and
    // must be the configured plan issue. `gh issue <verb> <n>` — nothing else.
    if (argv[3] !== String(plan.issue)) {
      throw new RefusedInvocation("unpinned-target", "gh issue target is not the configured plan issue");
    }
  }
}

/**
 * The ONLY producer of an argv in this pack's write path. A total switch over
 * `PlanWriteIntent`; anything not in that union returns `null`.
 *
 * Pure and exported, so the exact shape of every command Atlas can issue is
 * unit-testable without a process, a token, or a network — the same reason
 * W2a's `buildGhApiArgs` is exported.
 */
export function buildInvocation(
  cfg: EffectsConfig,
  intent: PlanWriteIntent,
): GhInvocation | null {
  const repo = cfg.plan.repo;
  const issue = String(cfg.plan.issue);
  switch (intent.kind) {
    case "issue-view":
      return {
        argv: ["gh", "issue", "view", issue, "--repo", repo, "--json", "body,updatedAt,url"],
        stdin: null,
        cwd: null,
      };
    case "issue-comment": {
      if (!bodyWithinLimit(intent.body)) return null;
      return {
        argv: ["gh", "issue", "comment", issue, "--repo", repo, "--body-file", "-"],
        stdin: intent.body,
        cwd: null,
      };
    }
    case "issue-edit-body": {
      if (!bodyWithinLimit(intent.body)) return null;
      return {
        argv: ["gh", "issue", "edit", issue, "--repo", repo, "--body-file", "-"],
        stdin: intent.body,
        cwd: null,
      };
    }
    case "pr-create": {
      if (!bodyWithinLimit(intent.body)) return null;
      if (typeof intent.title !== "string" || intent.title.trim().length === 0) return null;
      if (typeof intent.head !== "string" || !BRANCH_RE.test(intent.head)) return null;
      return {
        argv: [
          "gh",
          "pr",
          "create",
          "--repo",
          repo,
          "--base",
          cfg.baseBranch,
          "--head",
          intent.head,
          "--title",
          intent.title.slice(0, 200),
          "--body-file",
          "-",
        ],
        stdin: intent.body,
        cwd: cfg.checkoutDir,
      };
    }
    case "branch-push": {
      if (typeof intent.branch !== "string" || !BRANCH_RE.test(intent.branch)) return null;
      if (cfg.checkoutDir === null) return null; // fail closed: no working copy, no push
      return {
        argv: [
          "git",
          "push",
          planRemoteUrl(cfg.plan),
          `refs/heads/${intent.branch}:refs/heads/${intent.branch}`,
        ],
        stdin: null,
        cwd: cfg.checkoutDir,
      };
    }
    default:
      // Exhaustiveness: if a variant is ever added to the union without a case
      // here, `never` stops compiling and this file fails the build.
      return exhausted(intent);
  }
}

function exhausted(x: never): null {
  void x;
  return null;
}

function bodyWithinLimit(body: unknown): body is string {
  return typeof body === "string" && new TextEncoder().encode(body).length <= MAX_BODY_BYTES;
}

/** What a plan-issue read returns. */
export interface PlanSnapshot {
  readonly body: string;
  /**
   * GitHub's `updatedAt` for the issue (ISO 8601) — diagnostic only. NOT the
   * body-revision identity: `updatedAt` advances on comments, label changes,
   * and cross-references, not only on body edits (atlas#26). Callers that
   * need the body revision use `plan-revision.ts`'s `planBodyRevision(body)`.
   */
  readonly revisedAt: string;
  readonly url: string;
}

/**
 * The write surface, as an interface, so `apply.ts` depends on the CAPABILITY
 * and not on the process spawner. Five methods, and the reason each exists is
 * one row of vision#9 §6's table.
 *
 * There is deliberately no method for the PR-completing verb constitution
 * rule 2 forbids, and none for issue creation (vision#9 §9: Atlas asks
 * proposers to file in the owning repo — "work lives where the code lives").
 */
export interface PlanWriter {
  /** The plan issue's current body + revision receipt. `null` on any failure. */
  readPlan(): Promise<PlanSnapshot | null>;
  /** Replace the plan issue body, returning the NEW revision receipt. `null` on failure. */
  writePlanBody(body: string): Promise<PlanSnapshot | null>;
  /** Comment on the plan issue. `false` on any failure. */
  commentOnPlan(body: string): Promise<boolean>;
  /** Push one branch to the plan repo (J6). `false` on failure or no checkout. */
  pushBranch(branch: string): Promise<boolean>;
  /** Open a doc-change PR (J6). Returns its URL, or `null` on failure. */
  openDocPullRequest(input: { head: string; title: string; body: string }): Promise<string | null>;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * The real adapter. Every method funnels through `run`, which validates at the
 * chokepoint before spawning — so the guarantee is not "the methods happen to
 * build safe argv", it is "nothing else can be executed".
 */
export class GhCliPlanWriter implements PlanWriter {
  constructor(
    private readonly cfg: EffectsConfig,
    /** Injectable purely so tests can observe argv without spawning. */
    private readonly spawn: (inv: GhInvocation) => Promise<RunResult> = defaultSpawn,
  ) {}

  private async run(intent: PlanWriteIntent): Promise<RunResult | null> {
    const inv = buildInvocation(this.cfg, intent);
    if (inv === null) {
      warn(`could not build an invocation for ${intent.kind} — refusing`);
      return null;
    }
    try {
      assertAllowed(inv, this.cfg.plan);
    } catch (err) {
      warn(err instanceof Error ? err.message : String(err));
      return null;
    }
    try {
      return await this.spawn(inv);
    } catch (err) {
      warn(`${intent.kind} failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async readPlan(): Promise<PlanSnapshot | null> {
    const res = await this.run({ kind: "issue-view" });
    if (res === null || !res.ok) return null;
    return parsePlanSnapshot(res.stdout);
  }

  async writePlanBody(body: string): Promise<PlanSnapshot | null> {
    const res = await this.run({ kind: "issue-edit-body", body });
    if (res === null || !res.ok) return null;
    // The receipt is read back from GitHub rather than assumed: an edit that
    // "succeeded" without changing the stored revision is not a receipt for
    // anything. This is why `issue view` is on the allowlist at all.
    return this.readPlan();
  }

  async commentOnPlan(body: string): Promise<boolean> {
    const res = await this.run({ kind: "issue-comment", body });
    return res !== null && res.ok;
  }

  async pushBranch(branch: string): Promise<boolean> {
    const res = await this.run({ kind: "branch-push", branch });
    return res !== null && res.ok;
  }

  async openDocPullRequest(input: {
    head: string;
    title: string;
    body: string;
  }): Promise<string | null> {
    const res = await this.run({
      kind: "pr-create",
      head: input.head,
      title: input.title,
      body: input.body,
    });
    if (res === null || !res.ok) return null;
    const url = res.stdout.trim().split(/\s+/).pop() ?? "";
    return url.startsWith("https://github.com/") ? url : null;
  }
}

/** `gh issue view --json` output → snapshot. Every field re-validated (JSON boundary). */
export function parsePlanSnapshot(stdout: string): PlanSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    const body = o.body;
    const revisedAt = o.updatedAt;
    const url = o.url;
    if (typeof body !== "string") return null;
    if (typeof revisedAt !== "string" || revisedAt.length === 0) return null;
    if (typeof url !== "string" || url.length === 0) return null;
    return { body, revisedAt, url };
  } catch {
    return null;
  }
}

async function defaultSpawn(inv: GhInvocation): Promise<RunResult> {
  const proc = Bun.spawn(inv.argv as string[], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: inv.stdin === null ? "ignore" : new TextEncoder().encode(inv.stdin),
    ...(inv.cwd === null ? {} : { cwd: inv.cwd }),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}
