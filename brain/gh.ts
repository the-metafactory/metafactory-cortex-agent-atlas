/**
 * Atlas's gh adapter — READ-ONLY, deliberately (W2a, the-metafactory/vision#9
 * §3 J1/§6). This slice's `ReadOnlyGh` interface exposes exactly two methods,
 * both reads. There is no write method to call by accident, and no code path
 * in this pack constructs a `gh` invocation with a mutating verb (`comment`,
 * `edit`, `close`, `-X POST/PATCH`, …) — that capability is deliberately
 * reserved for a later, trust-path slice (W2b/#3), which gets its own
 * adversarial review lane per the epic.
 *
 * `GhCliReadOnly` is the real implementation, spawned via `Bun.spawn` with an
 * argv ARRAY (never a shell string — nothing here is vulnerable to shell
 * injection even though the URL has already been shape-validated by
 * intake.ts before it ever reaches this file). `buildGhApiArgs` is exported
 * separately, pure and unit-testable, so a test can assert the exact argv
 * shape without spawning a process — see test/gh.test.ts.
 */

export interface GhIssueInfo {
  /** Does the issue exist (200, not 404/410/etc.)? */
  exists: boolean;
  /** Only meaningful when `exists` is true. */
  open: boolean;
}

/** The two ground-truth reads validate.ts needs. Nothing else — see file header. */
export interface ReadOnlyGh {
  /** Resolve a GitHub issue URL against live state, or `null` on any failure/not-found. */
  getIssue(url: string): Promise<GhIssueInfo | null>;
  /** The plan issue's current body text (ground truth for the on-plan/dedup checks). */
  getPlanBody(): Promise<string>;
}

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

const ISSUE_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,99}))\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,99}))\/issues\/([1-9][0-9]{0,9})$/;

/**
 * Re-derive owner/repo/number from a URL independently of intake.ts — never
 * trust an upstream "this was already validated" claim when the value is
 * about to be used to construct a `gh` command. Returns `null` for anything
 * that doesn't match the strict shape.
 */
export function parseIssueUrl(url: string): IssueRef | null {
  const m = ISSUE_URL_RE.exec(url);
  if (m === null) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { owner: m[1]!, repo: m[2]!, number };
}

export interface PlanCoordinates {
  /** `owner/repo` of the plan issue. */
  repo: string;
  issue: number;
}

/** Pure argv builder for `gh api` reads — GET only, never `-X`/`--method`. */
export function buildGhApiArgs(path: string, jq?: string): string[] {
  const args = ["gh", "api", path];
  if (jq !== undefined) args.push("--jq", jq);
  return args;
}

async function runGh(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  // READ-ONLY GUARD: this is the one place this pack ever shells out to gh.
  // Refuse anything that looks like a write, even defensively — belt AND
  // braces on top of the fact that no caller in this file ever builds one.
  const banned = ["-X", "--method", "comment", "edit", "close", "delete", "create"];
  if (args.some((a) => banned.includes(a))) {
    throw new Error(`gh.ts: refused non-read-only invocation: ${args.join(" ")}`);
  }
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout };
}

/**
 * Real `gh` CLI adapter. Every call is a GET-shaped `gh api repos/...` read;
 * see `runGh`'s banned-verb guard and `buildGhApiArgs` (no `-X`/`--method`
 * anywhere in this file). Never invoked from unit tests — those use a
 * recording in-memory fake (test/*.test.ts) so the suite runs without
 * network access or a real `gh` auth context.
 */
export class GhCliReadOnly implements ReadOnlyGh {
  constructor(private readonly plan: PlanCoordinates) {}

  async getIssue(url: string): Promise<GhIssueInfo | null> {
    const ref = parseIssueUrl(url);
    if (ref === null) return null;
    const path = `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    const { ok, stdout } = await runGh(buildGhApiArgs(path));
    if (!ok) return null; // 404/410/network/auth failure — treated uniformly as "not found"
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (parsed === null || typeof parsed !== "object") return null;
      const state = (parsed as Record<string, unknown>).state;
      // A PR also resolves via the issues endpoint (GitHub models PRs as
      // issues); pull_request presence would let a future slice distinguish
      // them, but this slice only needs open/closed, so we don't branch on it.
      return { exists: true, open: state === "open" };
    } catch {
      return null;
    }
  }

  async getPlanBody(): Promise<string> {
    const path = `repos/${this.plan.repo}/issues/${this.plan.issue}`;
    const { ok, stdout } = await runGh(buildGhApiArgs(path, ".body"));
    if (!ok) return "";
    return stdout.trim();
  }
}

/** ATLAS_PLAN_REPO / ATLAS_PLAN_ISSUE — matches agent.yaml's `plan:` block. */
export function resolvePlanCoordinatesFromEnv(): PlanCoordinates | null {
  const repo = process.env.ATLAS_PLAN_REPO;
  const issueRaw = process.env.ATLAS_PLAN_ISSUE;
  if (repo === undefined || repo.length === 0 || issueRaw === undefined) return null;
  const issue = Number(issueRaw);
  if (!Number.isSafeInteger(issue) || issue <= 0) return null;
  return { repo, issue };
}
