/**
 * Atlas's LEDGER adapter — the one Discord channel (W2c, issue #1; vision#9
 * §3 J3/J4, §6; the vision repo's CLAUDE.md "Discord conventions", which is the
 * source of truth for every shape below).
 *
 * ── One channel, from config, never from content ───────────────────────────
 * `DiscordLedger` is constructed with an `EffectsConfig` and reads
 * `cfg.channelId` itself. No method takes a channel argument, so there is no
 * parameter for a proposal's text to influence, and the transport port is
 * called with the configured id every time. The test suite feeds a proposal
 * whose why-text names another channel and asserts the posted channel id is
 * unchanged.
 *
 * ── The shapes (vision CLAUDE.md, "Post shapes") ───────────────────────────
 *   ➕/➖ Plan body changed — <what and why, itemized> · <revision> · map link
 *   ✅ <repo>#<n> — <what shipped> · <how verified> · <link>
 * A receipt link is mandatory — "no post without one" — so both builders below
 * take their receipt as a REQUIRED argument and refuse to build without it,
 * rather than emitting a post that quietly lacks one.
 *
 * ── Untrusted text is quoted, never interpreted ────────────────────────────
 * A why-field, a section name and a linked issue's TITLE are all written by
 * arbitrary internet users. Every one of them goes through templates.ts's
 * `sanitizeForDisplay` (newlines collapsed so nothing can fake a second line of
 * ledger protocol; backticks neutralised so nothing can open a code fence) and
 * is then QUOTED. A proposer login is additionally shape-checked against
 * GitHub's own login grammar and falls back to a quoted string when it does not
 * match — an unexpected login shape must not be able to look like markup.
 *
 * ── Batching: at most ONE completion post per day ──────────────────────────
 * The convention is "events landing the same day go out as one combined post —
 * the channel reads as a ledger, not a ticker". So completions QUEUE, and a
 * flush emits a single post carrying everything queued at that moment. Once a
 * day has had its completion post, later arrivals stay queued for the next
 * day's flush rather than becoming a second post — because corrections are
 * append-only (rule 4: nothing is ever edited to absorb them), so a second post
 * is the one outcome the convention rules out. The common case — a poll pass
 * that observes several closures and then flushes — is one post, immediately.
 *
 * "Day" is the UTC day. Deterministic, host-timezone-free, and the same number
 * on every machine that reads the ledger.
 */

import { sanitizeForDisplay } from "../templates";
import type { EffectsConfig } from "./config";

function warn(msg: string): void {
  process.stderr.write(`atlas: effects-discord: ${msg}\n`);
}

const MAX_POST_LEN = 1_900; // Discord's limit is 2000; leave room for the footer.
const MAX_BATCH_ITEMS = 25;

/** GitHub's own login grammar. Anything else is quoted rather than rendered bare. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** The attribution footer the conventions require on agent posts. */
const FOOTER = "— Atlas · plan steward";

/**
 * The transport port. Deliberately the narrowest possible: one method, taking
 * the channel and the finished text, returning the platform message id (the
 * receipt an `applied → posted` transition records) or `null` on failure.
 *
 * There is no live implementation in this slice, and that is a WIRING gap, not
 * a design one: an in-process cortex agent does not own a Discord token — posts
 * leave through the host's effect protocol (`cortex-brain/v1`), which is bound
 * in `brain/main.ts`. That file does not exist yet (see epic #5's "the gate is
 * not wired" note); when it lands it supplies this port. Everything above the
 * port — targeting, templating, batching, receipts — is complete and tested.
 */
export interface LedgerTransport {
  post(channelId: string, content: string): Promise<string | null>;
}

/**
 * ONE message already in the ledger channel, as seen by a READ (W3a, issue #2).
 * Deliberately a separate port from `LedgerTransport`: the transport WRITES to
 * one configured channel, this READS the same one, and keeping them apart means
 * a reconcile that only wants to look cannot be handed something that can post.
 */
export interface LedgerMessage {
  readonly id: string;
  /** The message text. UNTRUSTED — matched against, never interpreted or echoed. */
  readonly content: string;
  /** Epoch ms. Bounds the window a "this post is gone" conclusion may be drawn in. */
  readonly createdAt: number;
}

/**
 * The channel cross-check (issue #2: *"Atlas's own event log is the primary
 * index; channel read as cross-check"*).
 *
 * OPTIONAL everywhere it is consumed, and used SUBTRACTIVELY ONLY for the
 * dangerous question — it may remove an item from a catch-up ("that post is
 * already there"), never add one on the strength of a read that could simply
 * have missed it. The one place it may ADD drift is a ✅ whose recorded message
 * id has vanished from a window that provably covers it, which is the deleted-
 * post kill test and is guarded by `createdAt` (see `reconcile.ts`).
 */
export interface LedgerReader {
  /** Newest-first, bounded. `null` means the channel could not be read AT ALL. */
  recentMessages(limit: number): Promise<readonly LedgerMessage[] | null>;
}

/** The receipt a successful post yields. */
export interface PostReceipt {
  readonly messageId: string;
  readonly channelId: string;
  readonly postedAt: number;
}

/** Everything the ➕/➖ post needs. All of it comes from state + config, never from a caller's idea of a target. */
export interface PlanChangeEntry {
  readonly verb: "ADD" | "REMOVE";
  readonly url: string;
  readonly section: string | null;
  /** The proposer's GitHub login — credit, per J3 and the conventions. */
  readonly proposer: string;
  /** The proposer's free text. Untrusted. Quoted. */
  readonly why: string;
  /** The human-facing proposal number, so the post is referenceable in one word. */
  readonly displayId: number;
  /** The plan body's revision receipt (GitHub `updatedAt` after the edit). */
  readonly revision: string;
}

/** One completed plan-linked issue, awaiting its ✅. */
export interface CompletionItem {
  /** `owner/repo` of the issue that closed — from the plan body, not from a proposal. */
  readonly repo: string;
  readonly number: number;
  /** The issue's title. UNTRUSTED — quoted, never interpreted. */
  readonly title: string;
  /** The issue URL. Always present, so a post always has a receipt link. */
  readonly url: string;
  /** The PR that carries the work, when it can be determined. */
  readonly closingPrUrl: string | null;
}

function safeLogin(login: string): string {
  if (typeof login === "string" && LOGIN_RE.test(login)) return `@${login}`;
  return `"${sanitizeForDisplay(typeof login === "string" ? login : "")}"`;
}

function clamp(text: string, max = MAX_POST_LEN): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The ➕/➖ post. Pure — exported so the exact shape is testable without a
 * transport, and so `apply.ts` cannot accidentally build a different one.
 */
export function planChangePost(entry: PlanChangeEntry, mapUrl: string): string {
  const marker = entry.verb === "ADD" ? "➕" : "➖";
  const action = entry.verb === "ADD" ? "added" : "removed";
  const where =
    entry.section === null
      ? ""
      : ` under "${sanitizeForDisplay(entry.section)}"`;
  const line =
    `${marker} Plan body changed — #${entry.displayId}: ${action} ${entry.url}${where}, ` +
    `proposed by ${safeLogin(entry.proposer)}: "${sanitizeForDisplay(entry.why)}" ` +
    `· revision ${entry.revision} · ${mapUrl}`;
  return clamp(`${line}\n${FOOTER}`);
}

/**
 * The ✅ post — one item or a same-day digest, always one post.
 * `items` must be non-empty; an empty batch is not a post with nothing in it,
 * it is no post at all (see `flushCompletions`).
 */
export function completionPost(items: readonly CompletionItem[], mapUrl: string): string | null {
  if (items.length === 0) return null;
  const line = (i: CompletionItem): string =>
    `${i.repo}#${i.number} — "${sanitizeForDisplay(i.title)}" · verified: closed on GitHub · ` +
    `${i.closingPrUrl ?? i.url}`;
  if (items.length === 1) {
    return clamp(`✅ ${line(items[0]!)}\n${FOOTER}`);
  }
  const header = `✅ Plan items completed — ${items.length} today · ${mapUrl}`;
  // Budgeted, not clamped. A digest that overran the platform's message limit
  // and got TRUNCATED would silently drop items off the end of the ledger —
  // and the ledger's whole value is that it can be trusted backwards. So lines
  // are admitted only while both the count cap and the length budget allow,
  // room is reserved for the "…and N more" line, and the overflow is STATED.
  const rendered: string[] = [];
  const tailReserve = 48;
  let used = header.length + FOOTER.length + 2;
  for (const item of items) {
    if (rendered.length >= MAX_BATCH_ITEMS) break;
    const candidate = `• ${line(item)}`;
    if (used + candidate.length + 1 + tailReserve > MAX_POST_LEN) break;
    rendered.push(candidate);
    used += candidate.length + 1;
  }
  const omitted = items.length - rendered.length;
  const tail = omitted > 0 ? `\n• …and ${omitted} more (see the map)` : "";
  return clamp(`${header}\n${rendered.join("\n")}${tail}\n${FOOTER}`);
}

/**
 * The RECONCILE CATCH-UP post (W3a, issue #2): ONE post, labelled exactly
 * `✅ Catch-up — since <timestamp of last ledger entry>:`, itemising every
 * missed event the pass found.
 *
 * `lines` are built by `reconcile.ts` and are already sanitised there; they are
 * re-sanitised here anyway, for the same reason `state.ts` re-caps strings that
 * `intake.ts` already capped — a display guarantee that depends on every caller
 * remembering is not a guarantee.
 *
 * Budgeted, never truncated, exactly as `completionPost` is: a catch-up that
 * silently lost its last three lines to a message-length limit would be a
 * ledger entry that is wrong about what it caught up on, which is worse than
 * one that says "…and N more".
 */
export function catchUpPost(
  lines: readonly string[],
  sinceIso: string,
  mapUrl: string,
): { content: string; rendered: number } | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const header = `✅ Catch-up — since ${sanitizeForDisplay(sinceIso)}: · ${mapUrl}`;
  const rendered: string[] = [];
  const tailReserve = 48;
  let used = header.length + FOOTER.length + 2;
  for (const raw of lines) {
    if (rendered.length >= MAX_BATCH_ITEMS) break;
    const candidate = `• ${sanitizeForDisplay(typeof raw === "string" ? raw : "")}`;
    if (used + candidate.length + 1 + tailReserve > MAX_POST_LEN) break;
    rendered.push(candidate);
    used += candidate.length + 1;
  }
  if (rendered.length === 0) return null;
  const omitted = lines.length - rendered.length;
  const tail = omitted > 0 ? `\n• …and ${omitted} more (see the map)` : "";
  // `rendered` is returned, not just the text: the caller marks drift as
  // "covered" so it never repeats, and marking an item covered that this post
  // did NOT actually name would delete it from the ledger silently. The count
  // of lines that really went out is therefore part of the contract.
  return {
    content: clamp(`${header}\n${rendered.join("\n")}${tail}\n${FOOTER}`),
    rendered: rendered.length,
  };
}

/**
 * Does this channel message record the ➕/➖ ledger entry for proposal
 * `displayId` about `url`? The channel-side half of the double-post question.
 *
 * ANCHORED AT POSITION 0, deliberately. Every post Atlas makes puts untrusted
 * text (a why-field, an issue title) somewhere in the MIDDLE — never at the
 * start, which is always a marker this module chose. So an attacker who titles
 * a GitHub issue `➕ Plan body changed — #3: added <url>` gets that string
 * quoted into the middle of a ✅ post and still cannot make this function say
 * yes. A `content.includes(...)` version of this check was forgeable exactly
 * that way, and forging it would SUPPRESS a catch-up line — a silent hole in
 * the ledger, which is the failure this whole slice exists to close.
 */
export function messageRecordsPlanChange(
  content: string,
  displayId: number,
  url: string,
): boolean {
  if (typeof content !== "string" || typeof url !== "string" || url.length === 0) return false;
  if (!Number.isSafeInteger(displayId) || displayId <= 0) return false;
  const added = `➕ Plan body changed — #${displayId}: `;
  const removed = `➖ Plan body changed — #${displayId}: `;
  if (!content.startsWith(added) && !content.startsWith(removed)) return false;
  return mentionsUrl(content, url);
}

/**
 * Does this text reference EXACTLY this issue URL?
 *
 * The trailing-digit guard is the same one `apply.ts`'s `lineMentionsUrl`
 * carries, and it is load-bearing for the same reason: a bare
 * `content.includes(url)` lets `…/issues/12` satisfy a search for
 * `…/issues/1`. Here that would mean a ➕ post about one issue answering for a
 * DIFFERENT one — i.e. subtracting a real drift item from a catch-up on the
 * strength of a substring. (Found by the test that asserts it; the display-id
 * anchor above happens to make it unexploitable today, since two proposals
 * never share a number, but a guard that only works because of a neighbouring
 * invariant is one refactor away from not working.)
 *
 * Duplicated rather than imported: `apply.ts` already imports this module, so
 * reaching the other way would close a cycle. Two copies of eight lines is the
 * cheaper price than a dependency loop through the effect layer.
 */
function mentionsUrl(content: string, url: string): boolean {
  let from = 0;
  for (;;) {
    const at = content.indexOf(url, from);
    if (at < 0) return false;
    const after = content[at + url.length];
    if (after === undefined || !/[0-9]/.test(after)) return true;
    from = at + 1;
  }
}

/** The UTC day number for an epoch-ms instant. Deterministic; no host timezone. */
export function utcDay(ts: number): number {
  return Math.floor(ts / 86_400_000);
}

export type FlushOutcome =
  /** Nothing was queued. */
  | { kind: "empty" }
  /** A post already went out on this UTC day; the queue is held for the next one. */
  | { kind: "held"; pending: number }
  /** The transport refused/failed. Items stay queued — nothing is lost, nothing is claimed. */
  | { kind: "failed"; pending: number }
  | { kind: "posted"; receipt: PostReceipt; items: readonly CompletionItem[] };

/**
 * The channel-pinned ledger. One instance per process; holds the completion
 * queue and the "has today already had its post" flag.
 */
export class DiscordLedger {
  private readonly queue: CompletionItem[] = [];
  private lastPostedDay: number | null = null;

  constructor(
    private readonly cfg: EffectsConfig,
    private readonly transport: LedgerTransport,
  ) {}

  /** The channel every post goes to. Read-only; there is no setter. */
  get channelId(): string {
    return this.cfg.channelId;
  }

  /**
   * The ➕/➖ ledger entry — the second half of J3's atomic pair. NOT batched:
   * a plan-body change is the event the map-and-ledger rule binds to a specific
   * edit, and holding it would mean the map and the ledger disagree for a day.
   */
  async postPlanChange(entry: PlanChangeEntry): Promise<PostReceipt | null> {
    const content = planChangePost(entry, this.cfg.planUrl);
    return this.send(content);
  }

  /**
   * The reconcile catch-up (W3a). NOT batched and NOT day-limited, for the same
   * reason `postPlanChange` is not: a catch-up is emitted only when a pass has
   * already established that the ledger is BEHIND, and holding it for a day
   * would leave the drift unrecorded while the next pass re-detects it. The
   * silence rule is upstream of this method — `reconcile.ts` does not call it
   * at all when there is nothing to say.
   */
  async postCatchUp(
    lines: readonly string[],
    sinceIso: string,
  ): Promise<{ receipt: PostReceipt; rendered: number } | null> {
    const built = catchUpPost(lines, sinceIso, this.cfg.planUrl);
    if (built === null) return null;
    const receipt = await this.send(built.content);
    if (receipt === null) return null;
    return { receipt, rendered: built.rendered };
  }

  /** Queue a completion for the next flush. Never posts by itself. */
  enqueueCompletion(item: CompletionItem): void {
    if (this.queue.some((q) => q.url === item.url)) return; // idempotent within a queue
    this.queue.push(item);
  }

  /** What is waiting to go out. Exposed for the watcher's logging and for tests. */
  pending(): readonly CompletionItem[] {
    return [...this.queue];
  }

  /**
   * Emit the day's single ✅ post, if this day has not had one yet.
   * On success the queue is drained; on failure it is kept intact — the caller
   * records nothing, so the next pass tries again.
   */
  async flushCompletions(now: number = Date.now()): Promise<FlushOutcome> {
    if (this.queue.length === 0) return { kind: "empty" };
    const day = utcDay(now);
    if (this.lastPostedDay !== null && this.lastPostedDay >= day) {
      return { kind: "held", pending: this.queue.length };
    }
    const items = [...this.queue];
    const content = completionPost(items, this.cfg.planUrl);
    if (content === null) return { kind: "empty" };
    const receipt = await this.send(content, now);
    if (receipt === null) return { kind: "failed", pending: this.queue.length };
    this.queue.length = 0;
    this.lastPostedDay = day;
    return { kind: "posted", receipt, items };
  }

  private async send(content: string, now: number = Date.now()): Promise<PostReceipt | null> {
    if (typeof content !== "string" || content.trim().length === 0) return null;
    let messageId: string | null;
    try {
      // The channel id comes from `this.cfg` on every single call — there is no
      // path by which a caller supplies one.
      messageId = await this.transport.post(this.cfg.channelId, content);
    } catch (err) {
      warn(`transport threw: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (typeof messageId !== "string" || messageId.length === 0) {
      warn("transport returned no message id — treating the post as failed");
      return null;
    }
    return { messageId, channelId: this.cfg.channelId, postedAt: now };
  }
}
