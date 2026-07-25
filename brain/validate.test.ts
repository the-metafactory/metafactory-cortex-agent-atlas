import { describe, expect, test } from "bun:test";
import { validateProposal } from "./validate";
import type { ParsedProposal } from "./intake";
import { RecordingGh } from "./test-support";

const ADD_URL = "https://github.com/acme/widgets/issues/1";
const OTHER_URL = "https://github.com/acme/widgets/issues/2";

function proposal(overrides: Partial<ParsedProposal> = {}): ParsedProposal {
  return {
    verb: "ADD",
    url: ADD_URL,
    section: null,
    why: "good reason",
    raw: `ADD: ${ADD_URL} — good reason`,
    ...overrides,
  };
}

describe("validateProposal — ADD", () => {
  test("issue not found → declines with exactly one gh call", async () => {
    const gh = new RecordingGh(); // no issues configured — every lookup is "not found"
    const result = await validateProposal(proposal(), gh);
    expect(result).toEqual({ ok: false, reason: "issue not found" });
    expect(gh.calls).toEqual([{ method: "getIssue", url: ADD_URL }]);
  });

  test("issue closed → declines, plan body never fetched", async () => {
    const gh = new RecordingGh({ issues: { [ADD_URL]: { exists: true, open: false } } });
    const result = await validateProposal(proposal(), gh);
    expect(result).toEqual({ ok: false, reason: "issue not open" });
    expect(gh.calls).toEqual([{ method: "getIssue", url: ADD_URL }]);
  });

  test("already on the plan → declines (exact URL dedup)", async () => {
    const gh = new RecordingGh({
      issues: { [ADD_URL]: { exists: true, open: true } },
      planBody: `Some section:\n- [ ] ${ADD_URL}\n`,
    });
    const result = await validateProposal(proposal(), gh);
    expect(result).toEqual({ ok: false, reason: "already on the plan" });
    expect(gh.calls).toEqual([
      { method: "getIssue", url: ADD_URL },
      { method: "getPlanBody" },
    ]);
  });

  test("dedup is an exact URL substring match — a different issue on the plan does not block", async () => {
    const gh = new RecordingGh({
      issues: { [ADD_URL]: { exists: true, open: true } },
      planBody: `- [ ] ${OTHER_URL}\n`,
    });
    const result = await validateProposal(proposal(), gh);
    expect(result).toEqual({ ok: true, issueOpen: true });
  });

  test("open, not on the plan → valid", async () => {
    const gh = new RecordingGh({ issues: { [ADD_URL]: { exists: true, open: true } } });
    const result = await validateProposal(proposal(), gh);
    expect(result).toEqual({ ok: true, issueOpen: true });
  });
});

describe("validateProposal — REMOVE", () => {
  test("not currently on the plan → declines", async () => {
    const gh = new RecordingGh({
      issues: { [ADD_URL]: { exists: true, open: true } },
      planBody: "nothing relevant here",
    });
    const result = await validateProposal(proposal({ verb: "REMOVE" }), gh);
    expect(result).toEqual({ ok: false, reason: "not on the plan" });
  });

  test("on the plan and still open → valid (removals aren't only for closed issues)", async () => {
    const gh = new RecordingGh({
      issues: { [ADD_URL]: { exists: true, open: true } },
      planBody: `- [ ] ${ADD_URL}\n`,
    });
    const result = await validateProposal(proposal({ verb: "REMOVE" }), gh);
    expect(result).toEqual({ ok: true, issueOpen: true });
  });

  test("on the plan and closed → valid", async () => {
    const gh = new RecordingGh({
      issues: { [ADD_URL]: { exists: true, open: false } },
      planBody: `- [x] ${ADD_URL}\n`,
    });
    const result = await validateProposal(proposal({ verb: "REMOVE" }), gh);
    expect(result).toEqual({ ok: true, issueOpen: false });
  });

  test("issue not found → declines before ever checking the plan body", async () => {
    const gh = new RecordingGh();
    const result = await validateProposal(proposal({ verb: "REMOVE" }), gh);
    expect(result).toEqual({ ok: false, reason: "issue not found" });
    expect(gh.calls).toEqual([{ method: "getIssue", url: ADD_URL }]);
  });
});

describe("validateProposal — gh adapter surface is read-only by construction", () => {
  test("RecordingGh (and the real ReadOnlyGh interface) exposes no write-shaped method", () => {
    const gh = new RecordingGh();
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(gh));
    for (const writeish of ["comment", "edit", "close", "delete", "create", "post", "patch"]) {
      expect(methodNames).not.toContain(writeish);
    }
    expect(methodNames.sort()).toEqual(["constructor", "getIssue", "getPlanBody"].sort());
  });
});
