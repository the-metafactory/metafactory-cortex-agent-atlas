import { describe, expect, test } from "bun:test";
import { buildGhApiArgs, parseIssueUrl } from "./gh";

describe("parseIssueUrl", () => {
  test("parses a well-formed issue URL", () => {
    expect(parseIssueUrl("https://github.com/acme/widgets/issues/42")).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 42,
    });
  });

  test("rejects a pull request URL", () => {
    expect(parseIssueUrl("https://github.com/acme/widgets/pull/42")).toBeNull();
  });

  test("rejects a non-github host (lookalike domain)", () => {
    expect(parseIssueUrl("https://github.com.evil.example/acme/widgets/issues/1")).toBeNull();
  });

  test("rejects http (non-https)", () => {
    expect(parseIssueUrl("http://github.com/acme/widgets/issues/1")).toBeNull();
  });

  test("rejects a trailing slash / extra path segment", () => {
    expect(parseIssueUrl("https://github.com/acme/widgets/issues/1/comments")).toBeNull();
  });

  test("rejects issue number 0 and non-numeric", () => {
    expect(parseIssueUrl("https://github.com/acme/widgets/issues/0")).toBeNull();
    expect(parseIssueUrl("https://github.com/acme/widgets/issues/abc")).toBeNull();
  });
});

describe("buildGhApiArgs — read-only shape", () => {
  test("never includes a write-shaped flag", () => {
    const args = buildGhApiArgs("repos/acme/widgets/issues/1");
    expect(args).toEqual(["gh", "api", "repos/acme/widgets/issues/1"]);
    for (const banned of ["-X", "--method", "POST", "PATCH", "DELETE"]) {
      expect(args).not.toContain(banned);
    }
  });

  test("supports --jq for the plan-body read", () => {
    const args = buildGhApiArgs("repos/acme/plan/issues/4", ".body");
    expect(args).toEqual(["gh", "api", "repos/acme/plan/issues/4", "--jq", ".body"]);
  });
});
