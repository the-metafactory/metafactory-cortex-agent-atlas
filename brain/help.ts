/**
 * Atlas's HELP verb (atlas#45) — the in-channel counterpart to `atlas check`
 * (#29). This file is detection ONLY: the templated reply text lives in
 * `templates.ts` (`helpText`), and admission, the per-channel cooldown, and
 * wiring into the served-task path live in `runtime.ts`. Kept as its own
 * module because HELP is neither a proposal (`intake.ts`'s `ADD:`/`REMOVE:`
 * grammar) nor a gate command (`ratify.ts`'s `RATIFY`/`DECLINE` grammar,
 * reachable only by the configured principal) — it is a third, distinct
 * thing, answerable by anyone the admission path already lets through.
 *
 * ── Case: both `HELP` and `help` are accepted, and the asymmetry with every
 *    other verb in this pack is deliberate, not accidental ─────────────────
 * `ADD:`/`REMOVE:` (intake.ts) and `RATIFY`/`DECLINE` (ratify.ts) are
 * exact-case ASCII literals on purpose — see intake.ts's and ratify.ts's own
 * file headers: each one either creates a durable work item or authorises a
 * real state transition, and near-miss / fuzzy matching on a verb that does
 * either of those things is exactly the kind of leniency this pack refuses
 * everywhere else.
 *
 * HELP does neither. It authorises nothing (no identity is consulted at
 * all — see `runtime.ts`'s `handleHelp`), it mutates no durable state, and
 * its reply is byte-identical for every sender by construction (`helpText`
 * takes no argument). A false match here costs exactly one harmless,
 * cooldown-bounded reply — never a privilege, never a state transition. Given
 * that, matching the lowercase form people will actually type is a usability
 * win with no matching security cost, so both `HELP` and `help` — and ONLY
 * those two literal spellings, never a general case-insensitive match — are
 * accepted as the leading token.
 */

/** Bounded prefix scan — O(1) regardless of the comment's total size. */
const PREFIX_SCAN_LEN = 24;

/**
 * `HELP`/`help` as the LEADING token, terminated by whitespace or end of
 * string — the same word-boundary discipline `ratify.ts`'s `VERB_SHAPE_RE`
 * uses, so "Helpful", "HELPME" or "helping" never match. Bounded leading
 * whitespace, matching the sibling parsers in `intake.ts` and `ratify.ts`.
 */
const HELP_RE = /^[ \t\r\n]{0,20}(?:HELP|help)(?:[ \t\r\n]|$)/;

/**
 * Does this message body open with the HELP verb? Pure, total, never throws
 * — the same discipline `parseComment`/`parseGateCommand` follow. Trailing
 * content after the verb is irrelevant and deliberately ignored: HELP takes
 * no arguments, so whatever follows (or nothing at all) still means the same
 * thing.
 */
export function isHelpRequest(body: string): boolean {
  if (typeof body !== "string" || body.length === 0) return false;
  return HELP_RE.test(body.slice(0, PREFIX_SCAN_LEN));
}
