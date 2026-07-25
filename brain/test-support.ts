/**
 * Shared test-only doubles — not part of the shipped brain, imported only by
 * *.test.ts files. Kept in brain/ (not test/) purely so `bun test
 * brain/intake.test.ts brain/validate.test.ts` (the issue's own verification
 * command) needs no extra include path.
 */

import type { GhIssueInfo, LinkedIssueReader, LinkedIssueState, ReadOnlyGh } from "./gh";
import type { GhInvocation } from "./effects/gh";
import type { LedgerMessage, LedgerReader, LedgerTransport } from "./effects/discord";

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

// ── W2c effect doubles (issue #1) ───────────────────────────────────────────

/**
 * A fake GitHub for the WRITE adapter, plugged in as `GhCliPlanWriter`'s spawn
 * function — deliberately BELOW the adapter rather than replacing it, so every
 * test that touches this class exercises the real `buildInvocation` and the
 * real `assertAllowed` chokepoint. A test asserting "the argv carried the
 * configured repo" is then asserting something about the shipped code, not
 * about a stub that agreed to say so.
 */
export class FakePlanRepo {
  readonly invocations: GhInvocation[] = [];
  readonly comments: string[] = [];
  readonly pushes: string[] = [];
  readonly pullRequests: Array<{ argv: readonly string[]; body: string }> = [];
  body: string;
  revisedAt: string;
  /** When true, every `issue edit` reports failure (the "write failed" case). */
  failWrites = false;
  /** When true, `issue view` reports failure (the "plan unreadable" case). */
  failReads = false;
  private revisions = 0;

  constructor(body = "", revisedAt = "2026-07-26T00:00:00Z") {
    this.body = body;
    this.revisedAt = revisedAt;
  }

  /** Bound method — passed directly as the adapter's spawn dependency. */
  readonly spawn = async (
    inv: GhInvocation,
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
    this.invocations.push(inv);
    const argv = inv.argv;
    if (argv[0] === "git") {
      this.pushes.push(argv[3] ?? "");
      return { ok: true, stdout: "", stderr: "" };
    }
    if (argv[1] === "issue" && argv[2] === "view") {
      if (this.failReads) return { ok: false, stdout: "", stderr: "not found" };
      return {
        ok: true,
        stdout: JSON.stringify({
          body: this.body,
          updatedAt: this.revisedAt,
          url: `https://github.com/${argvRepo(argv)}/issues/${argv[3]}`,
        }),
        stderr: "",
      };
    }
    if (argv[1] === "issue" && argv[2] === "edit") {
      if (this.failWrites) return { ok: false, stdout: "", stderr: "edit failed" };
      this.body = inv.stdin ?? "";
      this.revisions += 1;
      this.revisedAt = `2026-07-26T00:00:0${this.revisions}Z`;
      return { ok: true, stdout: "", stderr: "" };
    }
    if (argv[1] === "issue" && argv[2] === "comment") {
      this.comments.push(inv.stdin ?? "");
      return { ok: true, stdout: "", stderr: "" };
    }
    if (argv[1] === "pr" && argv[2] === "create") {
      this.pullRequests.push({ argv, body: inv.stdin ?? "" });
      return { ok: true, stdout: `https://github.com/${argvRepo(argv)}/pull/1\n`, stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "unrecognised" };
  };
}

function argvRepo(argv: readonly string[]): string {
  const i = argv.indexOf("--repo");
  return i >= 0 ? (argv[i + 1] ?? "") : "";
}

/** Records every ledger post, with the channel id it was aimed at. */
export class RecordingTransport implements LedgerTransport {
  /** `messageId` is recorded too (W3a) so a channel reader can mirror this list. */
  readonly posts: Array<{ channelId: string; content: string; messageId: string }> = [];
  /** Number of leading attempts to fail. `Infinity` fails every attempt. */
  failFirst = 0;
  /** When true, `post` throws instead of returning `null`. */
  throwOnPost = false;
  private nextId = 1;

  async post(channelId: string, content: string): Promise<string | null> {
    if (this.throwOnPost) throw new Error("transport exploded");
    if (this.failFirst > 0) {
      this.failFirst -= 1;
      return null;
    }
    const messageId = `msg-fixture-${this.nextId++}`;
    this.posts.push({ channelId, content, messageId });
    return messageId;
  }
}

/**
 * A readable ledger channel (W3a). Deliberately backed by the SAME
 * `RecordingTransport` a test posts through, so "the post is in the channel"
 * and "the post was made" are one fact — a fake where those two could disagree
 * would let a reconcile test pass against a world that cannot exist.
 * `delete(messageId)` is the kill test: it removes a post the way a human
 * deleting it in Discord would, leaving Atlas's durable record untouched.
 */
export class FakeLedgerChannel implements LedgerReader {
  /** Set to make every read fail — "the channel told us nothing". */
  failReads = false;
  readonly reads: number[] = [];
  private readonly messages: LedgerMessage[] = [];

  constructor(private readonly transport?: RecordingTransport) {}

  /** Mirror everything the transport has posted since the last sync. */
  sync(createdAt: number): void {
    if (this.transport === undefined) return;
    for (let i = this.messages.length; i < this.transport.posts.length; i += 1) {
      const post = this.transport.posts[i]!;
      this.messages.push({ id: post.messageId, content: post.content, createdAt });
    }
  }

  add(message: LedgerMessage): void {
    this.messages.push(message);
  }

  /** Remove one message, as a human deleting it in the channel would. */
  delete(messageId: string): boolean {
    const at = this.messages.findIndex((m) => m.id === messageId);
    if (at < 0) return false;
    this.messages.splice(at, 1);
    return true;
  }

  async recentMessages(limit: number): Promise<readonly LedgerMessage[] | null> {
    this.reads.push(limit);
    if (this.failReads) return null;
    return [...this.messages].reverse().slice(0, limit);
  }
}

/** Canned linked-issue states for the completion watcher. */
export class FakeLinkedIssues implements LinkedIssueReader {
  readonly calls: string[] = [];
  constructor(private readonly states: Record<string, LinkedIssueState | null> = {}) {}

  set(url: string, state: LinkedIssueState | null): void {
    this.states[url] = state;
  }

  async getLinkedIssue(url: string): Promise<LinkedIssueState | null> {
    this.calls.push(url);
    return this.states[url] ?? null;
  }
}
