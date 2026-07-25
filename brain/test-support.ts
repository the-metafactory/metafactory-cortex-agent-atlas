/**
 * Shared test-only doubles — not part of the shipped brain, imported only by
 * *.test.ts files. Kept in brain/ (not test/) purely so `bun test
 * brain/intake.test.ts brain/validate.test.ts` (the issue's own verification
 * command) needs no extra include path.
 */

import type { GhIssueInfo, ReadOnlyGh } from "./gh";

export type GhCall =
  | { method: "getIssue"; url: string }
  | { method: "getPlanBody" };

export interface RecordingGhOptions {
  /** url → canned issue info; absent url resolves to `null` (not found). */
  issues?: Record<string, GhIssueInfo>;
  planBody?: string;
}

/**
 * A `ReadOnlyGh` fake that records every call it receives. Because
 * `ReadOnlyGh` exposes exactly two methods — both reads — there is no
 * write-shaped method for any caller to invoke even by mistake; `calls`
 * lets a test assert the exact read sequence (issue #2's own verification
 * bullet: "assert: gh adapter mock records reads only").
 */
export class RecordingGh implements ReadOnlyGh {
  readonly calls: GhCall[] = [];
  private readonly issues: Record<string, GhIssueInfo>;
  private readonly planBody: string;

  constructor(opts: RecordingGhOptions = {}) {
    this.issues = opts.issues ?? {};
    this.planBody = opts.planBody ?? "";
  }

  async getIssue(url: string): Promise<GhIssueInfo | null> {
    this.calls.push({ method: "getIssue", url });
    return this.issues[url] ?? null;
  }

  async getPlanBody(): Promise<string> {
    this.calls.push({ method: "getPlanBody" });
    return this.planBody;
  }
}
