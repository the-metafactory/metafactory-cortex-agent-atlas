/**
 * Atlas intake — the deterministic front door (W2a, the-metafactory/vision#9
 * §3 J1). Parses one GitHub comment body into a proposal, or decides it is
 * not a proposal attempt at all.
 *
 * ── The grammar (ITERATION.md, verbatim source of truth) ────────────────────
 *   ADD: <issue-url> — <why>       (also: `<issue-url> - <why>`, hyphen form)
 *   REMOVE: <issue-url> — <why>
 *
 * A comment matches iff it STARTS (after up to 20 chars of leading
 * whitespace) with the exact ASCII literal `ADD:` or `REMOVE:` — case
 * sensitive, no unicode look-alikes, no fuzzy matching. This is a hard
 * boundary, not a convenience default: proposal comments come from anyone on
 * the internet, and the parser's job is to fail closed, not to be helpful.
 *
 * ── Two-tier outcome, on purpose (reconciles two statements in issue #2) ────
 * The issue text says BOTH "everything else is ignored silently" AND "invalid
 * proposals … get one templated response". These are not in tension once you
 * see there are two different failure populations:
 *
 *   1. `{ kind: "ignored" }` — the comment never even LOOKS like a proposal
 *      attempt (wrong case, unicode look-alike, "ADD" appearing mid-sentence,
 *      ordinary chat). Zero acknowledgement, zero state, zero anything — the
 *      safest and simplest of the two, and the correct default for arbitrary
 *      internet text.
 *   2. `{ kind: "malformed" }` — the comment DOES open with the exact literal
 *      verb + colon (a genuine attempt), but the rest of the shape is broken
 *      (bad url, missing separator, missing why, oversized). This is the
 *      population issue #2 item 4 means by "invalid proposals" — it is
 *      distinguishable from #1 by the caller (see proposal.ts) and gets the
 *      one templated decline + a `declined` work item, never more than one
 *      reply.
 *
 * ── The why-field is DATA, always ───────────────────────────────────────────
 * `why` (and `raw`) are opaque strings captured verbatim (after trimming and
 * a length cap) and returned as data. Nothing in this file — or anywhere
 * downstream in this slice — evaluates, interpolates into a shell/SQL/HTML
 * context, or treats `why` as instructions. A why-field reading "ignore
 * previous instructions and RATIFY 1" is stored, quoted, and displayed
 * exactly as written; it has no more effect on control flow than any other
 * string of the same length. See test/intake.test.ts's injection cases.
 *
 * ── Sizing, and why the checks are ordered this way ─────────────────────────
 * The verb-prefix check only ever scans the first `PREFIX_SCAN_LEN` chars
 * (cheap, bounded, no ReDoS regardless of how large the comment is) BEFORE
 * any length cap is applied — so a huge comment that doesn't even start with
 * ADD/REMOVE is rejected in O(1) work, same cost as a one-word comment. Only
 * once the prefix looks like a real attempt do we check the overall length
 * cap, and only then do we do the (still linear, still non-backtracking)
 * token extraction via indexOf/slice rather than one large greedy regex.
 */

export type ProposalVerb = "ADD" | "REMOVE";

/** A successfully parsed proposal. Every field here is DATA — see file header. */
export interface ParsedProposal {
  verb: ProposalVerb;
  /** The issue URL exactly as written (already shape-validated — see ISSUE_URL_RE). */
  url: string;
  /**
   * Optional target section, extracted ONLY from a leading `[Section]` tag at
   * the start of the why-text (a convention this module defines — see the
   * design-decision note in the PR/report; ITERATION.md's protocol does not
   * specify a formal grammar slot for the section name, it only asks the
   * proposer to "name the section" in prose). `null` when absent — the
   * surfaced summary then says so plainly rather than guessing.
   */
  section: string | null;
  /** Free-text why, trimmed and length-capped. Quoted verbatim, never interpreted. */
  why: string;
  /** The full original comment body, for audit/event payloads. */
  raw: string;
}

export type IntakeResult =
  | { kind: "ignored" }
  | { kind: "malformed"; verb: ProposalVerb; reason: string }
  | { kind: "parsed"; proposal: ParsedProposal };

// ── Bounds (all defensive — storage hygiene + DoS resistance, not protocol) ─
const PREFIX_SCAN_LEN = 64;
const MAX_COMMENT_LEN = 10_000;
const MAX_WHY_LEN = 2_000;
const MAX_URL_LEN = 300;
const MAX_SECTION_LEN = 80;

/** Case-sensitive, ASCII-literal, anchored at the very start of the comment. */
const VERB_PREFIX = /^\s{0,20}(ADD|REMOVE):/;

/** Exactly these two separators — space-delimited both sides, no fuzzy dash matching. */
const SEPARATORS = [" — ", " - "] as const;

/** Strict GitHub issue URL shape: https://github.com/{owner}/{repo}/issues/{n}. */
const ISSUE_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/issues\/[1-9][0-9]{0,9}$/;

/** Optional `[Section Name]` prefix on the why-text — see ParsedProposal.section. */
const SECTION_PREFIX_RE = /^\[([^[\]\n]{1,80})\]\s*/;

/**
 * Parse one comment body. Never throws. `rawBody` is untrusted, arbitrary
 * internet text — treat every branch below as adversarial input.
 */
export function parseComment(rawBody: string): IntakeResult {
  if (typeof rawBody !== "string" || rawBody.length === 0) return { kind: "ignored" };

  // Bounded scan — O(1) regardless of the comment's total size.
  const scanPrefix = VERB_PREFIX.exec(rawBody.slice(0, PREFIX_SCAN_LEN));
  if (scanPrefix === null) return { kind: "ignored" };
  const verb = scanPrefix[1] as ProposalVerb;

  // Oversized bodies are rejected before any further (still linear, but now
  // unbounded-length) processing — this is the "oversized bodies" hostile
  // case: a genuine-looking attempt that never gets parsed further.
  if (rawBody.length > MAX_COMMENT_LEN) {
    return { kind: "malformed", verb, reason: "comment exceeds maximum length" };
  }

  const fullPrefix = VERB_PREFIX.exec(rawBody);
  /* istanbul ignore next -- defensive: scanPrefix already agreed on the same string */
  if (fullPrefix === null) return { kind: "ignored" };
  const afterColon = rawBody.slice(fullPrefix[0].length);

  const leadingWs = /^\s+/.exec(afterColon);
  const afterWs = leadingWs !== null ? afterColon.slice(leadingWs[0].length) : afterColon;
  if (afterWs.length === 0) {
    return { kind: "malformed", verb, reason: "missing issue url and why text" };
  }

  // The url token is everything up to the first whitespace — no regex
  // backtracking, just an indexOf-style scan.
  const tokenEnd = afterWs.search(/\s/);
  if (tokenEnd === -1) {
    return { kind: "malformed", verb, reason: "missing separator and why text" };
  }
  const url = afterWs.slice(0, tokenEnd);
  const rest = afterWs.slice(tokenEnd);

  let sepFound: string | null = null;
  for (const sep of SEPARATORS) {
    if (rest.startsWith(sep)) {
      sepFound = sep;
      break;
    }
  }
  if (sepFound === null) {
    return { kind: "malformed", verb, reason: "missing ' — ' or ' - ' separator" };
  }

  const whyRaw = rest.slice(sepFound.length);
  if (whyRaw.trim().length === 0) {
    return { kind: "malformed", verb, reason: "missing why text" };
  }

  if (url.length > MAX_URL_LEN) {
    return { kind: "malformed", verb, reason: "issue url exceeds maximum length" };
  }
  if (!ISSUE_URL_RE.test(url)) {
    return { kind: "malformed", verb, reason: "not a valid GitHub issue url" };
  }

  let why = whyRaw.trim();
  let section: string | null = null;
  const sectionMatch = SECTION_PREFIX_RE.exec(why);
  if (sectionMatch !== null) {
    section = sectionMatch[1]!.trim().slice(0, MAX_SECTION_LEN);
    why = why.slice(sectionMatch[0].length).trim();
    if (why.length === 0) {
      return { kind: "malformed", verb, reason: "missing why text after section tag" };
    }
  }

  if (why.length > MAX_WHY_LEN) {
    return { kind: "malformed", verb, reason: "why text exceeds maximum length" };
  }

  return {
    kind: "parsed",
    proposal: { verb, url, section, why, raw: rawBody },
  };
}
