/**
 * Atlas persistence — DB-authoritative work-item lifecycle over an
 * agent-state instance, for the proposal-intake state machine (W2a) and the
 * ratification gate's transitions (W2b, issue #3; the-metafactory/vision#9
 * §5). Pattern copied from metafactory-cortex-agent-
 * escort's brain/state.ts (verified against it directly): SQLite is the
 * single source of truth, read-through per call, with the SAME inverted
 * fail-soft posture (state is memory, not authority — a missing/broken DB
 * degrades to a transient in-memory store rather than failing boot).
 *
 * ── Mapping (schema is agent-state's, verbatim — no parallel schema) ───────
 * Each proposal = ONE work_item, kind `proposal`, id = a stable key derived
 * by the caller (proposal.ts uses the source comment's id — see there for
 * why). The phases map onto agent-state's constrained status vocabulary (the
 * schema CHECKs status):
 *
 *   intake     → pending        (work_item_created)
 *   validated  → in_flight      (work_item_claimed + work_item_annotated
 *                                 with the ground-truth read: issue_open)
 *   surfaced   → waiting_human  (work_item_parked — mirrors escort's own
 *                                 naming for exactly this shape of
 *                                 transition: "parked, awaiting a human")
 *   ratified   → in_flight      (work_item_ratified — W2b/#3; DISAMBIGUATED
 *                                 from `validated` by the stored ratification
 *                                 note, see `rowPhase`)
 *   declined   → failed         (work_item_resolved, reason "validation" from
 *                                 the validator, or "declined" from the gate)
 *   applied    → done           (work_item_resolved, reason "applied" — W2c;
 *                                 the transition exists here already because
 *                                 it takes a RatificationCertificate and
 *                                 nothing else, see `markApplied`)
 *   posted     → done           (work_item_posted — W2c/#1; DISAMBIGUATED from
 *                                 `applied` by the stored `$.posted` receipt,
 *                                 exactly as `ratified` is disambiguated from
 *                                 `validated`. `applied` therefore names the
 *                                 real, expected, recoverable state "the map
 *                                 changed but the ledger did not", which is
 *                                 what a failed ledger post PARKS in and what
 *                                 W3a's reconcile loop goes looking for.)
 *
 * ── The two ways out of `waiting_human` (W2b, issue #3) ─────────────────────
 * A surfaced proposal leaves `waiting_human` through EXACTLY two methods —
 * `markRatified` and `markDeclinedByRatifier` — and nothing else in this file
 * accepts `waiting_human` as a source status (`markDeclined`, the validator's
 * decline, explicitly refuses it).
 *
 * Both now require a `GateAuthority` (issue #7, finding 4). The state layer
 * still does not RUN an identity check; it demands proof that one was run.
 * Until #7 the argument here was that the transition's shape was narrow enough
 * that "the gate is the only place identity CAN be checked" — but that argument
 * only ever held for `markApplied`. `markRatified` was a public method taking a
 * caller-supplied `principal` STRING with zero validation, so a caller that
 * never touched ratify.ts, identity.ts or a `GateMessage` could record a
 * ratification naming any principal it liked and then mint a genuine
 * certificate from it. The only thing preventing that was "no other module
 * calls it" — precisely the property the certificate machinery exists in order
 * NOT to depend on. Now the principal a ratification is recorded under is read
 * off the authority (i.e. off the deployment's CONFIG), and an authority can
 * only be obtained from `authorizeRatifierAction`, which re-runs the self-block
 * and the principal-map resolution itself.
 *
 * ── Unlike escort: no orphan-sweep dance ────────────────────────────────────
 * Escort's state.ts has a `pending` phase that waits on an ASYNC host
 * round-trip (`create_private_thread` → `thread_created`), so a crash
 * mid-flight can strand a row — hence its boot sweep + lazy orphan guard.
 * This slice has no such async gap: every transition here is a single
 * synchronous call from proposal.ts's pipeline (parse → validate → record),
 * so there is nothing to strand and nothing to sweep. A future slice that
 * adds an async host round-trip (e.g. posting the surfaced summary for
 * real) would need to reintroduce that pattern — deliberately deferred, not
 * forgotten.
 *
 * ── Text hygiene ─────────────────────────────────────────────────────────
 * The why-field IS stored here (unlike escort, which stores no message text
 * at all) — that is the explicit spec requirement (issue #2: "the free-text
 * why is DATA: store it quoted, never interpreted"). It is stored inside the
 * JSON `payload` column, which the agent-state dashboard renders only
 * indirectly (id/kind/status/owner/timestamps) — never evaluated, never
 * interpolated into a shell/SQL/HTML context anywhere in this file or its
 * callers. Every stored string is length-capped (again, redundantly, on top
 * of intake.ts's own caps) before it reaches SQLite.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isGateAuthority, type ConfiguredRatifier, type GateAuthority } from "./identity";
import type { ProposalVerb } from "./intake";
import {
  certificateMatchesRecord,
  certificateMatchesStorage,
  type RatificationCertificate,
  type StoredRatification,
} from "./ratification";

// ── Schema: verbatim copy of agent-state's migrations/0001-initial.sql ─────
// (agent-state v0.3.0 — the same copy metafactory-cortex-agent-escort's
// brain/state.ts carries, reproduced here so this module interoperates with
// agent-state's own scripts against a DB this module created). If agent-state
// ships a 0002 migration, bump this module in lockstep with escort's.
const MIGRATION_0001 = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS work_items (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL,
  owner_agent  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  notes        TEXT,
  CHECK (status IN ('pending','in_flight','waiting_human','done','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_work_items_kind_status
  ON work_items(kind, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_items_owner
  ON work_items(owner_agent, updated_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,
  actor         TEXT,
  work_item_id  TEXT,
  payload       TEXT NOT NULL,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_work_item ON events(work_item_id);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

const MIGRATION_VERSION = "0001";

/**
 * Atlas-OWNED auxiliary index — deliberately NOT part of the block above.
 * `MIGRATION_0001` is a verbatim copy of agent-state's own schema (see file
 * header): version-gated so it is applied exactly once, in lockstep with
 * agent-state's migrations. This table is not agent-state's concern at all —
 * agent-state's scripts never read it — so it is created unconditionally,
 * every open, guarded only by `IF NOT EXISTS`, and lives outside the
 * `schema_migrations` version gate entirely (atlas#8, finding 1).
 *
 * It exists to answer `hasSeenGateMessage` in O(1) instead of scanning
 * `events` filtered by `type IN (...)` — a scan whose cost is set by however
 * many rows carry one of `GATE_EVENT_TYPES`, and `work_item_resolved` is
 * written once per DECLINED intake comment, i.e. once per invalid `ADD:` /
 * `REMOVE:` comment from ANYONE (`markDeclined`). An outsider spamming that
 * path inflates the very bucket the replay check must scan on every
 * legitimate gate message afterwards — measured by adversarial review at
 * ~780× at 100k rows. A dedicated table keyed on the replay key itself moves
 * the cost off that population entirely: this table only ever holds rows
 * that ACTUALLY carry a `gate_message_id` (see `indexGateReplayKey`), so
 * `markDeclined`'s validation-only `work_item_resolved` events never land
 * here at all.
 */
const GATE_REPLAY_KEYS_SCHEMA = `
CREATE TABLE IF NOT EXISTS gate_replay_keys (
  key       TEXT PRIMARY KEY,
  event_id  INTEGER NOT NULL,
  type      TEXT NOT NULL,
  ts        INTEGER NOT NULL
);
`;

/**
 * THE OWNED-THREAD REGISTRY (atlas#22 + atlas#25) — the second Atlas-owned
 * auxiliary table, created on the same terms as `gate_replay_keys` above:
 * outside agent-state's version gate, every open, `IF NOT EXISTS`.
 *
 * ── Why it must be DURABLE, not a Map ──────────────────────────────────────
 * It is an ADMISSION input. A thread Atlas forgets is a thread Atlas goes deaf
 * in — the principal keeps typing `RATIFY 1` into a thread nobody is listening
 * to and gets silence, because a non-admitted task is refused WITHOUT a reply
 * by design (`runtime.ts`). A daemon restart is routine (`maxRestarts: 3`, a
 * config reload, a host redeploy), so an in-memory registry would turn every
 * restart into a silently broken conversation. Restart-safety is the whole
 * point of the table.
 *
 * ── What may be written here ───────────────────────────────────────────────
 * ONLY a host-resolved `thread_created.thread_id` that `runtime.ts` correlated
 * to a `create_private_thread` IT emitted. Never a value read off an inbound
 * task's `source`, never anything derived from message text. This is the one
 * table whose contents WIDEN what Atlas will act on, so its write path is
 * deliberately the narrowest in the pack: one caller, one correlated event,
 * one shape check (`OWNED_THREAD_ID_RE`).
 *
 * `task_id` is the request's correlation id, kept for audit only — nothing
 * reads it to make a decision. Rows are never expired on a clock: a thread
 * Discord has archived is still a thread whose messages Atlas must hear if the
 * platform ever delivers one, and time-based expiry would reintroduce exactly
 * the deafness this table exists to remove.
 */
const OWNED_THREADS_SCHEMA = `
CREATE TABLE IF NOT EXISTS owned_threads (
  thread_id  TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  opened_at  INTEGER NOT NULL
);
`;

/**
 * Atlas-OWNED auxiliary tables (atlas#28) — same posture as
 * `GATE_REPLAY_KEYS_SCHEMA` above: outside the `schema_migrations` version
 * gate, created unconditionally every open, guarded only by `IF NOT EXISTS`.
 *
 * These feed the `atlas status` CLI's zero-network "ledger view" (issue #28):
 * a status answer must be instant and offline BY DEFAULT, which means the
 * plan body's raw text and a linked issue's title have to be cached
 * SOMEWHERE durable rather than fetched fresh on every invocation — the same
 * "cache at watch time" decision issue #28 makes explicitly for titles,
 * extended to the one other thing the status tool needs and nothing already
 * caches: the plan body itself (`watch.ts` already fetches it every pass).
 *
 * `plan_body_cache` is a SINGLETON row (`id` CHECK'd to `1`) — there is
 * exactly one configured plan, so exactly one cached snapshot; a newer write
 * replaces the older one outright. History of past snapshots is not this
 * table's job (the `events` log already keeps that, via `reconcile_completed`
 * and `work_item_resolved`'s `plan_revision` fields).
 */
const PLAN_STATUS_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS plan_body_cache (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  body       TEXT NOT NULL,
  revision   TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS linked_issue_title_cache (
  url        TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`;

/**
 * The shape a platform thread id must have before it is stored or matched.
 * Discord snowflakes are decimal digit strings; this repo's fixtures use
 * `thread-fixture-…`. Deliberately permissive about WHICH characters (a pack
 * must not encode one platform's id grammar as a security boundary) and strict
 * about the two things that matter: no whitespace and a bound — so a stored id
 * can never be a sentence, and a blank/absent channel on an inbound task can
 * never match a stored row.
 */
const OWNED_THREAD_ID_RE = /^[A-Za-z0-9:_.-]{1,128}$/;

/**
 * Values that PASS the shape check above but can only ever be a bug by the
 * time they reach this table: the STRING FORMS of absent/empty values, which
 * is exactly what a mis-serialised or coerced id looks like once it is a
 * string. No path that produces one is proven — this is a denylist on the one
 * table that WIDENS admission, and one line is a cheap way to make "a
 * stringified `undefined` became an admitted room" impossible rather than
 * merely unobserved (adversarial review, nit 1). It is not theoretical
 * paranoia either: cortex's own config layer coerces an absent
 * `agentChannelId` to the literal string `"undefined"` under the zod it ships
 * (4.3.6), so this class of value demonstrably exists in this ecosystem.
 * Compared case-insensitively: `Null` is no more a thread id than `null`.
 */
const IMPLAUSIBLE_THREAD_IDS: ReadonlySet<string> = new Set([
  "undefined",
  "null",
  "nan",
  "none",
  "nil",
  "false",
  "true",
  "0",
  "-1",
]);

/** True when `id` is a plausible platform thread id. Never throws. */
export function isPlausibleThreadId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (!OWNED_THREAD_ID_RE.test(id)) return false;
  return !IMPLAUSIBLE_THREAD_IDS.has(id.toLowerCase());
}

/**
 * Plan bodies are operator-sized (GitHub's own issue-body ceiling is 65536
 * bytes — see `effects/gh.ts`'s `MAX_BODY_BYTES`) but this cache has no
 * upstream enforcement of that limit of its own, so it caps defensively,
 * well above GitHub's real ceiling — the same "cap rather than trust an
 * upstream bound" discipline every other stored field in this file follows.
 */
const MAX_PLAN_BODY_CACHE_LEN = 100_000;

/** owner_agent + event actor for everything this brain writes. */
const OWNER = "atlas";
/** The one work_item kind this slice creates. */
const KIND = "proposal";

/**
 * The event types the ratification gate writes a `gate_message_id` into — and
 * therefore the only types `indexGateReplayKey` will admit into
 * `gate_replay_keys`, i.e. the only types `hasSeenGateMessage` will honour as
 * a replay record. Keep this list and the gate's event names in lockstep: a
 * gate event type missing here is a replay the gate would not notice.
 *
 * Enforced at WRITE time now (atlas#8, finding 1), not at read time: an
 * earlier version filtered `type IN (...)` inside `hasSeenGateMessage`'s own
 * query, which is exactly the scan this list now lets that method skip
 * entirely. The scoping property this list provides — "an unrelated future
 * slice that happens to put a `gate_message_id` in a payload cannot burn a
 * key" — is unchanged; only which side of the write/read boundary checks it
 * has moved.
 * (These are literals, interpolated into SQL; they are compile-time constants
 * from this file, never caller input.)
 */
const GATE_EVENT_TYPES = [
  "gate_command_too_long",
  "work_item_ratified",
  "work_item_resolved",
  "ratification_gate_rejected",
  "gate_nothing_to_ratify",
  "gate_state_unavailable",
] as const;

/**
 * One-time backfill, paid ONCE at upgrade — never a per-message cost. Without
 * it, a message ratified/declined/rejected before this migration would read
 * as "not seen" the first time `gate_replay_keys` is queried after upgrade,
 * because the new table starts empty while `events` already holds months of
 * history. The underlying transitions (`markRatified`,
 * `markDeclinedByRatifier`) are guarded independently by work-item status
 * (see their own docstrings), so this is not the only line of defence against
 * a stale redelivery — but the audit-only gate events
 * (`ratification_gate_rejected` etc.) have no such second guard, so without a
 * backfill a redelivered pre-upgrade rejection would log a duplicate row.
 * Guarded by `json_valid` exactly like `jsonField`, for the same reason: a
 * malformed row written by another tool sharing this DB must not abort the
 * whole backfill.
 */
function backfillGateReplayKeys(db: Database): void {
  const typesList = GATE_EVENT_TYPES.map((t) => `'${t}'`).join(", ");
  const keyExpr = `CASE WHEN json_valid(payload) THEN json_extract(payload, '$.gate_message_id') END`;
  db.exec(`
    INSERT OR IGNORE INTO gate_replay_keys (key, event_id, type, ts)
    SELECT ${keyExpr} AS key, id, type, ts
    FROM events
    WHERE type IN (${typesList})
      AND ${keyExpr} IS NOT NULL;
  `);
}

const MAX_FIELD_LEN = 2_000;
const MAX_ID_LEN = 256;
function cap(s: string, max = MAX_FIELD_LEN): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * The bounded form of an IDENTITY string (a work-item id, a platform message
 * id). Unlike `cap`, this never merges two distinct inputs into one value:
 * truncating an identity key silently makes two different things the same
 * thing — two proposals collapsing onto one work item, or two messages sharing
 * one replay key. Anything over the bound is replaced by a SHA-256 digest,
 * which is bounded, deterministic, and injective for every input we will ever
 * see.
 */
function boundedKey(s: string): string {
  if (typeof s !== "string") return "";
  if (s.length <= MAX_ID_LEN) return s;
  return `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
}

/**
 * The replay key for one inbound gate message: platform, author, message id.
 *
 * NOT the bare message id (adversarial review): id spaces are per-platform, so
 * an unscoped key lets a message id from one platform collide with a future
 * one from another — and because the replay check necessarily runs before
 * identity resolution, the party who gets to write the colliding row first is
 * an outsider, silently eating the principal's next verb. Exported so ratify.ts
 * and this module derive the identical key from the identical inputs.
 *
 * LENGTH-PREFIXED, not merely delimiter-joined. An earlier version joined on
 * U+001F and asserted in its own docstring that the delimiter "cannot occur in
 * any of them" -- while enforcing nothing, and while identity.ts happily
 * admits ids containing U+001F. That made ("discord", "A<US>B", "C") and
 * ("discord", "A", "B<US>C") the SAME key. Length prefixes make the encoding
 * injective for ANY component bytes -- the same treatment identity.ts's own
 * map key already gets. Asserting a delimiter is safe is not the same as it
 * being safe.
 *
 * Callers MUST pass RAW components. boundedKey is applied to the FINISHED
 * string, so pre-truncating or pre-hashing a component here yields a different
 * key than a caller who does not -- which is exactly how the two sides
 * silently drifted apart once already.
 */
export function gateMessageKey(platform: string, authorId: string, messageId: string): string {
  if (
    typeof platform !== "string" ||
    typeof authorId !== "string" ||
    typeof messageId !== "string" ||
    platform.length === 0 ||
    authorId.length === 0 ||
    messageId.length === 0
  ) {
    return "";
  }
  return boundedKey(
    `${platform.length}:${platform}\x1f${authorId.length}:${authorId}\x1f${messageId.length}:${messageId}`,
  );
}

/**
 * `json_extract` RAISES on a row whose JSON column is malformed — and
 * `notesToObject` deliberately TOLERATES non-JSON notes ("non-JSON operator
 * text preserved under `text`"), so the value the JS layer is designed to
 * survive is exactly the one that would blow up the SQL layer. A single such
 * row (written by an operator, or by agent-state's own scripts against this
 * shared DB) would throw, be caught by `AtlasProposals.run`'s catch-all,
 * misdiagnosed as "the DB is broken", and silently degrade the whole store to
 * memory-only — disabling the ratification gate until restart, while replying
 * "nothing to ratify" to the principal.
 *
 * So every json_* call in this file is wrapped: invalid JSON yields NULL and
 * matches nothing, instead of taking the process's state layer down with it.
 * The CASE (rather than an `AND json_valid(...)` conjunct) is deliberate —
 * SQLite does not guarantee AND short-circuit evaluation order. `json_type`
 * raises on malformed JSON exactly as `json_extract` does, so it goes through
 * here too: an earlier version left one bare `json_type` in the WHERE clause
 * and relied on the neighbouring guarded terms being evaluated first — which
 * is the very assumption the sentence above says cannot be made.
 */
function jsonField(column: string, path: string, fn: "json_extract" | "json_type" = "json_extract"): string {
  return `CASE WHEN json_valid(${column}) THEN ${fn}(${column}, '${path}') END`;
}

export type ProposalPhase =
  | "intake"
  | "validated"
  | "surfaced"
  | "ratified"
  | "declined"
  | "applied"
  /**
   * The plan body was edited AND the ledger entry landed (W2c, issue #1). Like
   * `ratified`, this phase is READ OFF ITS EVIDENCE — the stored `$.posted`
   * receipt — not off a flag that happens to accompany it. `applied` therefore
   * means precisely "the map changed and the ledger has not caught up", which
   * is exactly the population W3a's reconcile loop must find.
   */
  | "posted";

export interface ProposalRecord {
  id: string;
  phase: ProposalPhase;
  verb: ProposalVerb;
  url: string;
  section: string | null;
  why: string;
  proposer: string;
  /** Set once `markSurfaced` has run — the short human-facing `RATIFY <id>`. */
  displayId: number | null;
  /**
   * The durable ratification, or `null`. This field IS the `ratified` phase —
   * see `rowPhase` below: the phase is not a status flag that happens to
   * accompany the evidence, it is READ OFF the evidence. There is no
   * representable state in which a row claims to be ratified while the
   * ratification record is absent.
   */
  ratification: StoredRatification | null;
  /** The plan-body edit's receipt, once `applied`. `null` before that (W2c). */
  applied: AppliedReceipt | null;
  /** The ledger post's receipt, once `posted`. `null` before that (W2c). */
  posted: PostedReceipt | null;
}

/** The receipt for half (a) of the atomic pair: the plan body was edited. */
export interface AppliedReceipt {
  /**
   * The body-revision identity produced by `plan-revision.ts`'s
   * `planBodyRevision` (atlas#26) — a hash of the plan body itself, NOT
   * GitHub's `updatedAt` for the issue. `updatedAt` advances on comments,
   * label changes, and cross-references from other issues/PRs, so it never
   * meant "the body revision" — that was the bug atlas#26 fixed. A value
   * recorded before that fix is a legacy `updatedAt` ISO timestamp; see
   * `isHashedPlanRevision` for how reconcile tells the two apart.
   */
  readonly revision: string;
  readonly ts: number;
  /**
   * The checkbox-insensitive twin of `revision` (`plan-revision.ts`'s
   * `planBodyRevisionNormalized`, atlas#34) — OPTIONAL so every existing
   * caller and fixture that builds a receipt without it keeps compiling.
   * `apply.ts` always supplies it now; a receipt recorded without one (a
   * fixture, or a row written before atlas#34) reads back as "no normalised
   * baseline for this revision", which `reconcile.ts` treats exactly like a
   * legacy revision — a safe absence, never a false match.
   */
  readonly normalizedRevision?: string;
}

/** The receipt for half (b): the ledger entry landed. */
export interface PostedReceipt {
  /** The platform message id of the ledger post. */
  readonly messageId: string;
  /** The channel it landed in — recorded so an audit can prove WHERE, not just that. */
  readonly channelId: string;
  readonly ts: number;
}

interface WorkItemRow {
  id: string;
  status: string;
  payload: string;
  notes: string | null;
}

export interface AtlasStateOptions {
  /** Instance dir holding state.sqlite (created if missing). */
  dir: string;
  /**
   * Installed agent-state bundle root (for dashboard.ts regen). `null`
   * disables dashboard regeneration entirely (tests use this).
   */
  bundleDir?: string | null;
  /**
   * Fired (fire-and-forget) after EVERY work-item transition this store makes
   * — W3a, issue #2: *"regenerate `dashboard.md` on every state change"*.
   *
   * It is a hook rather than a direct call because Atlas's plan dashboard is
   * derived from the PLAN BODY as well as from state, and fetching the plan
   * body is an async network read that must never happen inside a SQLite
   * transaction. So the state layer announces "something moved" and
   * `brain/dashboard.ts` decides what to do about it; `brain/main.ts` is what
   * wires the two together. Errors are swallowed here for the same reason
   * `regenDashboard` swallows its own: a dashboard is a derived view, and a
   * failure to redraw it must never roll back or mask a real transition.
   */
  onTransition?: (() => void) | null;
  /**
   * Debounce window (ms) for coalescing `regenDashboard`'s subprocess spawn
   * (atlas#8, finding 5). Defaults to `DEFAULT_DASHBOARD_DEBOUNCE_MS`. Tests
   * override this to a small value so a burst of calls collapses onto one
   * timer deterministically, without waiting out a production-sized window.
   */
  dashboardDebounceMs?: number;
  /**
   * Injectable seam for the dashboard-regen subprocess, defaulting to a thin
   * wrapper over `Bun.spawn`. Exists so tests can count/observe spawns
   * without actually shelling out to `bun` (which needs a real bundle dir and
   * a real `dashboard.ts`, and is exactly the cost this fix bounds) —
   * narrowed to the one property this module reads off the result.
   */
  spawnDashboardProcess?: DashboardSpawnFn;
}

/** The subset of `Bun.Subprocess` this module actually reads. */
export interface DashboardSpawnResult {
  readonly exited: Promise<number>;
}

/** The subset of `Bun.spawn`'s signature this module actually calls. */
export type DashboardSpawnFn = (
  cmd: readonly string[],
  opts: {
    env: Record<string, string | undefined>;
    stdout: "ignore";
    stderr: "ignore";
    stdin: "ignore";
  },
) => DashboardSpawnResult;

/** `Bun.spawn` itself, narrowed to `DashboardSpawnFn`'s shape. */
const defaultSpawnDashboardProcess: DashboardSpawnFn = (cmd, opts) =>
  Bun.spawn(cmd as string[], opts);

/**
 * Default debounce window for coalescing dashboard-regen spawns. Large enough
 * that a burst of transitions from one inbound task (or several tasks that
 * land within the same tick) collapses onto a single timer; small enough that
 * an operator watching the dashboard after a single real change does not
 * perceive a delay.
 */
const DEFAULT_DASHBOARD_DEBOUNCE_MS = 250;

/**
 * `~/.config/cortex/agents/atlas` — matches arc-manifest.yaml's `owns.state`.
 *
 * This is NOT the pre-XDG-split legacy path (atlas#19's premise correction):
 * cortex's `~/.config/metafactory/cortex` move (cortex#1869) is scoped to
 * config FILES only (`config-path.ts`'s own header: "does NOT touch the live
 * runtime state the same directory also holds — `state/`, `networks/`,
 * `logs/`, `personas/`"). Per-agent instance state is a SEPARATE resolver,
 * `resolveInstanceDir()` in cortex's `src/common/agents/agent-state-scaffold.ts`,
 * which builds `~/.config/<host>/agents/<id>` with `host` defaulting to the
 * literal string `"cortex"` at every call site — never derived from
 * `cortexConfigDir()`/`METAFACTORY_DIRNAME`. So the flat `~/.config/cortex/agents/`
 * tree IS the canonical, current location for agent instance state, and this
 * already agrees with it. Verified empirically on a live host: `~/.config/
 * metafactory/cortex` has no `agents/` subdirectory at all, while `~/.config/
 * cortex/agents/` holds every installed agent's real instance dir (escort,
 * luna, sage, …).
 */
export function defaultInstanceDir(): string {
  return join(homedir(), ".config", "cortex", "agents", "atlas");
}

/** Injectable `{home, env}` seam for hermetic tests (mirrors cortex's `ArcPackReposDirSeam`). */
export interface BundleDirSeam {
  home?: string;
  env?: Record<string, string | undefined>;
}

/**
 * arc's canonical package-repos dir, byte-mirroring arc's own `dataRoot/repos`
 * resolution (`arc/src/lib/paths.ts` `reposDir`) and cortex's
 * `arcCanonicalPackReposDir()` (`src/common/config/arc-pack-repos-dir.ts`,
 * cortex#2007): `($XDG_DATA_HOME` trimmed, or `~/.local/share`) / metafactory
 * / arc / repos.
 */
function arcCanonicalPackReposDir(seam?: BundleDirSeam): string {
  const home = seam?.home ?? homedir();
  const raw = (seam?.env ?? process.env).XDG_DATA_HOME?.trim();
  const base = raw ? raw : join(home, ".local", "share");
  return join(base, "metafactory", "arc", "repos");
}

/**
 * arc's LEGACY (pre-arc#287) package-repos dir `~/.config/metafactory/pkg/repos`
 * — the path a `singleTree` / `ARC_CONFIG_ROOT`-override install still uses.
 * Read-fallback only, existence-gated in {@link defaultBundleDir}.
 */
function legacyArcPackReposDir(seam?: BundleDirSeam): string {
  return join(seam?.home ?? homedir(), ".config", "metafactory", "pkg", "repos");
}

/**
 * Where `arc` installs the agent-state bundle on a cortex host.
 *
 * Existence-gated, mirroring arc's own `dataRoot/repos` resolution and
 * cortex's `resolveArcPackReposDir()` (cortex#2007): the canonical XDG tree
 * wins if it exists (a default / migrated box), else the legacy
 * `~/.config/metafactory/pkg/repos` tree if IT exists (a singleTree /
 * `ARC_CONFIG_ROOT`-override install), else the canonical path as the
 * fresh-host default.
 *
 * Before this fix (atlas#15/#19) this unconditionally returned the legacy
 * path — arc's PRE-#287 default. On a real, migrated host BOTH trees exist,
 * so this failed quietly rather than loudly: `regenDashboard` ran against a
 * legacy clone dated 27 April rather than the current bundle arc actually
 * installs at `~/.local/share/metafactory/arc/repos/agent-state` — a worse
 * outcome than a no-op, because the dashboard looked live while being
 * produced by months-stale code. Existence-gating (rather than a bare
 * canonical-string swap) means a `singleTree` install that genuinely still
 * has content ONLY at the legacy path keeps resolving there, instead of
 * silently pointing at an empty canonical dir.
 */
export function defaultBundleDir(seam?: BundleDirSeam): string {
  const canonical = join(arcCanonicalPackReposDir(seam), "agent-state");
  if (existsSync(canonical)) return canonical;
  const legacy = join(legacyArcPackReposDir(seam), "agent-state");
  if (existsSync(legacy)) return legacy;
  return canonical;
}

function warn(msg: string): void {
  process.stderr.write(`atlas: state: ${msg}\n`);
}

/**
 * agent-state's status vocabulary is CHECK-constrained to six values, and this
 * pipeline has more phases than that — so `in_flight` and `done` are
 * disambiguated by the presence of the stored ratification rather than by a
 * parallel status column. That is deliberate, not a workaround: it makes the
 * phase and its evidence the SAME fact. A row cannot read as `ratified` unless
 * a well-formed `$.ratification` note is really there, so there is no way to
 * "mark something ratified" without the record that authorises the effect.
 *
 * `done` with no ratification returns `null` (unrecognised) rather than
 * `applied` — this pipeline never produces such a row, and a row that appeared
 * by other means must not be treated as a legitimately applied change.
 */
function rowPhase(
  status: string,
  ratification: StoredRatification | null,
  posted: PostedReceipt | null,
): ProposalPhase | null {
  switch (status) {
    case "pending":
      return "intake";
    case "in_flight":
      return ratification !== null ? "ratified" : "validated";
    case "waiting_human":
      return "surfaced";
    case "failed":
      return "declined";
    case "done":
      // Same rule as `ratified` above, one step further along: the phase is the
      // evidence. A `done` row with a ratification is `applied`; add the ledger
      // post's receipt and it is `posted`. A `done` row with neither is not a
      // row this pipeline produced, and is reported as unrecognised.
      if (ratification === null) return null;
      return posted !== null ? "posted" : "applied";
    default:
      // 'cancelled' is not reachable from any transition in this pack.
      return null;
  }
}

/**
 * Re-validate the ratification note read back off disk. It crossed a JSON
 * boundary, so nothing about its shape is assumed: every field must be present
 * and of the right type, or there is NO ratification (fail closed — a
 * half-written or hand-edited note authorises nothing).
 */
function parseStoredRatification(value: unknown): StoredRatification | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const principal = o.principal;
  const platform = o.platform;
  const platformId = o.platform_id;
  const messageId = o.message_id;
  const displayId = o.display_id;
  const ts = o.ts;
  if (typeof principal !== "string" || principal.length === 0) return null;
  if (typeof platform !== "string" || platform.length === 0) return null;
  if (typeof platformId !== "string" || platformId.length === 0) return null;
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  if (typeof displayId !== "number" || !Number.isSafeInteger(displayId) || displayId <= 0) {
    return null;
  }
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0) return null;
  return { principal, platform, platformId, messageId, displayId, ts };
}

/**
 * Re-validate an `$.applied` receipt read back off disk. Same discipline as
 * `parseStoredRatification`: it crossed a JSON boundary, so nothing about its
 * shape is assumed and a malformed receipt is NO receipt.
 */
function parseAppliedReceipt(value: unknown): AppliedReceipt | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const revision = o.revision;
  const ts = o.ts;
  if (typeof revision !== "string" || revision.length === 0) return null;
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0) return null;
  return { revision, ts };
}

/** Re-validate a `$.posted` receipt read back off disk. See above. */
function parsePostedReceipt(value: unknown): PostedReceipt | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const messageId = o.message_id;
  const channelId = o.channel_id;
  const ts = o.ts;
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  if (typeof channelId !== "string" || channelId.length === 0) return null;
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0) return null;
  return { messageId, channelId, ts };
}

/**
 * Field-for-field equality of two ratification records. Used by `markRatified`
 * to prove the row it just wrote is the row storage now reports — see the
 * read-back block there.
 */
function sameRatification(a: StoredRatification, b: StoredRatification): boolean {
  return (
    a.principal === b.principal &&
    a.platform === b.platform &&
    a.platformId === b.platformId &&
    a.messageId === b.messageId &&
    a.displayId === b.displayId &&
    a.ts === b.ts
  );
}

/**
 * Module-private sentinel: the in-transaction read-back did not agree with the
 * writes that were about to be committed. Thrown so the transaction ROLLS BACK
 * — never caught by `AtlasProposals.run` (`markRatified` catches it itself),
 * because it is a disagreement about content, not a storage failure, and the
 * store is still perfectly readable.
 */
class RatificationReadbackFailed extends Error {}

function serializeRatification(r: StoredRatification): Record<string, unknown> {
  return {
    principal: r.principal,
    platform: r.platform,
    platform_id: r.platformId,
    message_id: r.messageId,
    display_id: r.displayId,
    ts: r.ts,
  };
}

/** Is this string a parseable JSON *object* (not an array, not a scalar)? */
function isJsonObject(s: string): boolean {
  try {
    const parsed: unknown = JSON.parse(s);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function notesToObject(notes: string | null): Record<string, unknown> {
  if (notes === null || notes.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(notes);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — non-JSON operator text preserved under `text`
  }
  return { text: notes };
}

function rowToRecord(row: WorkItemRow): ProposalRecord | null {
  const notesEarly = notesToObject(row.notes);
  const ratification = parseStoredRatification(notesEarly.ratification);
  const applied = parseAppliedReceipt(notesEarly.applied);
  const posted = parsePostedReceipt(notesEarly.posted);
  const phase = rowPhase(row.status, ratification, posted);
  if (phase === null) return null;
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const verb = payload.verb;
  const url = payload.url;
  const why = payload.why;
  const proposer = payload.proposer;
  if (
    (verb !== "ADD" && verb !== "REMOVE") ||
    typeof url !== "string" ||
    typeof why !== "string" ||
    typeof proposer !== "string"
  ) {
    return null;
  }
  const section = typeof payload.section === "string" ? payload.section : null;
  const displayIdRaw = notesEarly.display_id;
  const displayId =
    typeof displayIdRaw === "number" && Number.isFinite(displayIdRaw) ? displayIdRaw : null;
  return {
    id: row.id,
    phase,
    verb,
    url,
    section,
    why,
    proposer,
    displayId,
    ratification,
    applied,
    posted,
  };
}

/**
 * The raw DB layer. Methods THROW on SQLite failure — `AtlasProposals`
 * (below) is the single owner of degradation, matching escort's split.
 */
export class AtlasStateStore {
  private readonly db: Database;
  private readonly dir: string;
  private readonly bundleDir: string | null;
  private readonly onTransition: (() => void) | null;
  private dashboardWarned = false;
  private readonly dashboardDebounceMs: number;
  private readonly spawnDashboardProcess: DashboardSpawnFn;
  /** Debounce timer, coalescing a burst of calls onto one pending spawn. */
  private dashboardRegenTimer: ReturnType<typeof setTimeout> | null = null;
  /** A spawn is currently running. */
  private dashboardRegenRunning = false;
  /** A transition arrived while a spawn was running; run one more after. */
  private dashboardRegenPending = false;

  private constructor(
    db: Database,
    dir: string,
    bundleDir: string | null,
    onTransition: (() => void) | null,
    dashboardDebounceMs: number,
    spawnDashboardProcess: DashboardSpawnFn,
  ) {
    this.db = db;
    this.dir = dir;
    this.bundleDir = bundleDir;
    this.onTransition = onTransition;
    this.dashboardDebounceMs = dashboardDebounceMs;
    this.spawnDashboardProcess = spawnDashboardProcess;
  }

  /** The instance dir — where dashboards and retros are written alongside the DB. */
  get instanceDir(): string {
    return this.dir;
  }

  /** Fail-soft open: any error logs to stderr and returns `null`. */
  static open(opts: AtlasStateOptions): AtlasStateStore | null {
    try {
      mkdirSync(opts.dir, { recursive: true });
      const db = new Database(join(opts.dir, "state.sqlite"));
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA busy_timeout = 5000;");
      applyMigration(db);
      warn(`open — ${join(opts.dir, "state.sqlite")}`);
      return new AtlasStateStore(
        db,
        opts.dir,
        opts.bundleDir ?? null,
        opts.onTransition ?? null,
        opts.dashboardDebounceMs ?? DEFAULT_DASHBOARD_DEBOUNCE_MS,
        opts.spawnDashboardProcess ?? defaultSpawnDashboardProcess,
      );
    } catch (err) {
      warn(
        `unavailable, running memory-only: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Read-only open (atlas#28) — for the `atlas status` CLI, and for nothing
   * else. Opens `state.sqlite` with `SQLITE_OPEN_READONLY` and runs NO
   * migration: a migration is a schema WRITE (`CREATE TABLE`, `PRAGMA
   * journal_mode`), and a handle opened this way must be STRUCTURALLY unable
   * to attempt one, not merely relied on not to. If the file has never been
   * created (no daemon has ever run here), or the open fails for any other
   * reason, this fails soft exactly like `open` does above: `null`, logged,
   * never thrown — the CLI reports "no local state yet" rather than crashing.
   *
   * This is the ONLY sanctioned way anything outside the daemon process may
   * read `state.sqlite`. SQLite readers never block a WAL writer and a
   * read-only handle cannot itself acquire a write lock, so a concurrently
   * running daemon is untouched by it — and every write-shaped method on the
   * returned instance (e.g. `createIntake`, `markRatified`) would throw
   * "attempt to write a readonly database" at the SQLite layer if a caller
   * somehow reached for one, which is a second, structural line of defence
   * on top of "the status CLI's code never calls them".
   */
  static openReadOnly(dir: string): AtlasStateStore | null {
    try {
      const path = join(dir, "state.sqlite");
      if (!existsSync(path)) {
        warn(`read-only open: no state.sqlite at ${path} — nothing has run here yet`);
        return null;
      }
      const db = new Database(path, { readonly: true });
      return new AtlasStateStore(
        db,
        dir,
        null,
        null,
        DEFAULT_DASHBOARD_DEBOUNCE_MS,
        defaultSpawnDashboardProcess,
      );
    } catch (err) {
      warn(`read-only open failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  get(id: string): ProposalRecord | null {
    const row = this.getRow(boundedKey(id));
    return row ? rowToRecord(row) : null;
  }

  /**
   * Phase `intake`: enqueue the work_item. Idempotent no-op if a row for this
   * id already exists in ANY status — a redelivered/reprocessed comment must
   * never create a second work item or trigger a second reply.
   */
  createIntake(
    id: string,
    verb: ProposalVerb,
    url: string,
    section: string | null,
    why: string,
    proposer: string,
  ): void {
    const capId = boundedKey(id);
    if (this.getRow(capId) !== null) return; // idempotent — see file header
    const ts = Date.now();
    const payload = JSON.stringify({
      verb,
      url: cap(url, 300),
      section: section === null ? null : cap(section, 80),
      why: cap(why),
      proposer: cap(proposer, 256),
    });
    this.db
      .query(
        `INSERT INTO work_items (id, kind, payload, status, owner_agent, created_at, updated_at, notes)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL)`,
      )
      .run(capId, KIND, payload, OWNER, ts, ts);
    this.appendEvent("work_item_created", capId, { kind: KIND, verb, status: "pending" }, ts);
    this.regenDashboard();
  }

  /** Phase `validated`: pending → in_flight, annotate the ground-truth read. */
  markValidated(id: string, issueOpen: boolean): void {
    const capId = boundedKey(id);
    const row = this.getRow(capId);
    if (row === null || row.status !== "pending") return; // out of sync — leave alone
    const ts = Date.now();
    this.db
      .query(`UPDATE work_items SET status = 'in_flight', owner_agent = ?, updated_at = ? WHERE id = ?`)
      .run(OWNER, ts, capId);
    this.appendEvent("work_item_claimed", capId, { status: "in_flight" }, ts);
    this.annotate(capId, { issue_open: issueOpen }, ts);
    this.regenDashboard();
  }

  /**
   * Phase `surfaced`: in_flight → waiting_human. Assigns and returns the
   * monotonic human-facing display id (`RATIFY <id>`) — a simple running
   * count of proposal work_items, a scoping decision this module makes since
   * the issue does not specify an id scheme (see the report for the callout).
   * Does NOT take the composed summary text — callers build that from the
   * returned id (via templates.ts) and record it with `recordSummary` below,
   * so the id is only ever computed once.
   *
   * Returns `null` (rather than throwing) when the row is missing or not
   * `in_flight` — a precondition violation is a LOGIC error, not a SQLite
   * failure, and must never be treated as one: `AtlasProposals.run` (below)
   * catches everything a DB-layer method throws and degrades the WHOLE store
   * to memory-only on the assumption "the DB itself is broken". A thrown
   * precondition check would trip that same catch-all and silently degrade
   * durability for every other in-flight proposal too — out of proportion
   * for what is simply "called out of order". Every other method in this
   * class already follows this no-throw-on-precondition discipline
   * ("out of sync — leave alone"); this one now matches.
   *
   * ── Surfacing happens AT MOST ONCE per work item (W2b hardening) ──────────
   * `in_flight` is not a sufficient precondition on its own, because W2b gave
   * `in_flight` a second meaning: `ratified`. Without the two guards below, a
   * caller could re-park an ALREADY-RATIFIED row — which would (a) let the
   * principal's decision be undone by a later `DECLINE` on the recycled
   * number, and (b) hand out a display id that `nextDisplayId` (which counts
   * rows that already HAVE an id, so it does not advance on reassignment) will
   * hand out again, colliding two proposals onto one number and bricking both
   * behind `findSurfacedByDisplayId`'s ambiguity guard. Found by adversarial
   * review; both were demonstrable before these two lines existed.
   */
  markSurfaced(id: string): number | null {
    const capId = boundedKey(id);
    const row = this.getRow(capId);
    if (row === null || row.status !== "in_flight") return null;
    // Both guards below read `notes`. `notesToObject` deliberately tolerates
    // non-JSON notes by wrapping them as `{ text: … }` — which would make BOTH
    // guards read false and let a ratified row be re-parked. So unparseable
    // notes on an in_flight row are themselves disqualifying: we cannot see
    // what is in there, therefore we do not re-park it.
    if (row.notes !== null && row.notes.length > 0 && !isJsonObject(row.notes)) return null;
    const notes = notesToObject(row.notes);
    // Never re-park a ratified row: `in_flight` also means `ratified`.
    if (parseStoredRatification(notes.ratification) !== null) return null;
    // Never re-issue a display id: ids are assigned once and never recycled.
    if (notes.display_id !== undefined && notes.display_id !== null) return null;
    const ts = Date.now();
    const displayId = this.nextDisplayId();
    this.db
      .query(`UPDATE work_items SET status = 'waiting_human', updated_at = ? WHERE id = ?`)
      .run(ts, capId);
    this.appendEvent("work_item_parked", capId, { status: "waiting_human", display_id: displayId }, ts);
    this.annotate(capId, { display_id: displayId }, ts);
    this.regenDashboard();
    return displayId;
  }

  /** Record the composed surfaced-summary text against an already-parked row. */
  recordSummary(id: string, summaryText: string): void {
    const capId = boundedKey(id);
    const row = this.getRow(capId);
    if (row === null || row.status !== "waiting_human") return;
    this.annotate(capId, { summary: cap(summaryText) }, Date.now());
  }

  // ── W2b, the ratification gate (issue #3) ────────────────────────────────

  /**
   * Look up the ONE currently-`surfaced` proposal carrying this display id —
   * the id a human types in `RATIFY <n>`.
   *
   * Two structural properties this query gives the gate for free:
   *   - `status = 'waiting_human'` is in the WHERE clause, so a work item that
   *     is still in `intake`/`validated`, or already `ratified`/`declined`/
   *     `applied`, is not merely rejected later — it is NOT FOUND. The
   *     "premature RATIFY" and "replay RATIFY" cases are therefore the same
   *     single code path as "unknown id", with no separate branch to get wrong.
   *   - `LIMIT 2` + a refusal on two hits: a display-id collision (which
   *     `nextDisplayId` is designed to make impossible) would be ambiguous
   *     about WHICH proposal a verb ratifies. Ambiguity on this path resolves
   *     to `null`, never to a guess.
   */
  findSurfacedByDisplayId(displayId: number): ProposalRecord | null {
    if (!Number.isSafeInteger(displayId) || displayId <= 0) return null;
    const rows = this.db
      .query<WorkItemRow, [string, number]>(
        // The json_type guard matters: json_extract COERCES a JSON `true` to
        // the integer 1, so a row whose display_id note is a boolean would
        // answer to `RATIFY 1`. Requiring the stored type to actually BE an
        // integer removes the coercion instead of hoping no one writes one.
        `SELECT id, status, payload, notes FROM work_items
          WHERE kind = ? AND status = 'waiting_human'
            AND ${jsonField("notes", "$.display_id")} = ?
            AND ${jsonField("notes", "$.display_id")} IS NOT NULL
            AND ${jsonField("notes", "$.display_id", "json_type")} = 'integer'
          LIMIT 2`,
      )
      .all(KIND, displayId);
    if (rows.length !== 1) return null;
    return rowToRecord(rows[0]!);
  }

  /**
   * Has any gate decision already been recorded for this message?
   * Replay defence at the MESSAGE level (the work-item level is covered by
   * `findSurfacedByDisplayId`'s status filter): a redelivered ratification
   * message must not produce a second decision or a second reply.
   *
   * The key is `platform \x1f author \x1f messageId`, not the bare message id
   * (adversarial review, three findings in one):
   *   - unscoped, a message id from ANOTHER platform's id space could collide
   *     with a future id from the principal's, silently eating their verb —
   *     and because the replay check runs before identity, an outsider is the
   *     one who gets to write the colliding row;
   *   - `boundedKey` hashes rather than truncates, so two long ids sharing a
   *     256-char prefix are no longer one replay key;
   *   - only `GATE_EVENT_TYPES` events are ever admitted into
   *     `gate_replay_keys` (`indexGateReplayKey`, enforced at write time), so
   *     an unrelated future slice that happens to put a `gate_message_id` in
   *     a payload cannot burn a key.
   *
   * ── O(1) via `gate_replay_keys`, not a scan of `events` (atlas#8, finding 1) ─
   * This used to be `SELECT 1 FROM events WHERE type IN (...) AND
   * json_extract(payload, '$.gate_message_id') = ?` — a scan bounded only by
   * how many rows carry one of `GATE_EVENT_TYPES`, and `work_item_resolved`
   * is written once per DECLINED intake comment (`markDeclined`), i.e. once
   * per invalid public comment from anyone. An outsider spamming that path
   * inflated the very bucket this lookup scanned on every subsequent
   * legitimate gate message. `gate_replay_keys` is keyed on the replay key
   * itself (its PRIMARY KEY), so this is a single indexed point lookup whose
   * cost does not grow with how many unrelated events exist.
   */
  hasSeenGateMessage(key: string): boolean {
    const bounded = boundedKey(key);
    if (bounded.length === 0) return false;
    const row = this.db
      .query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM gate_replay_keys WHERE key = ? LIMIT 1`,
      )
      .get(bounded);
    return row !== null && row !== undefined;
  }

  /**
   * Phase `ratified`: waiting_human → in_flight + the durable ratification.
   *
   * Wrapped in a TRANSACTION on purpose. Without it, a crash between the
   * status update and the note write would leave a row at `in_flight` with no
   * ratification — which `rowPhase` reads as `validated`, a phase from which
   * `markRatified` refuses to run, permanently stranding the proposal. The
   * transaction makes "status moved" and "evidence stored" a single fact,
   * which is the same invariant the certificate depends on.
   *
   * Returns the ratification as READ BACK from storage (never the in-memory
   * value that was just written) — so a caller can only proceed on what
   * durably persisted. `null` on any precondition violation, per this class's
   * no-throw-on-precondition discipline.
   *
   * ── The read-back happens INSIDE the transaction (issue #6, finding 3) ─────
   * It used to be a separate `this.readRatification(capId)` AFTER the
   * transaction had committed. That is a commit followed by a FALLIBLE read,
   * and the failure mode is the worst one this pack has: the read throws (a
   * single injected `SQLITE_IOERR` reproduces it), `AtlasProposals.run` swallows
   * it and returns `null`, and ratify.ts reads `null` as "not recorded" and
   * tells the principal *"Nothing was changed and the proposal is still awaiting
   * a decision"* — while storage holds a committed `status='in_flight'`, a
   * `$.ratification` note, and a `work_item_ratified` event. A split brain on
   * the one question the trust path exists to answer, from which W2c could later
   * mint a valid certificate and perform the public plan edit the principal was
   * told never happened.
   *
   * Doing the read-back inside the committing transaction removes the window
   * rather than narrowing it. There are now exactly two outcomes and both are
   * honest:
   *   - the read succeeds and agrees → COMMIT, and the value returned is what
   *     durably persisted (the original property, unweakened);
   *   - the read throws, or disagrees with what was written → ROLLBACK, so
   *     nothing was committed, and every `null`/throw out of this method is a
   *     truthful "nothing changed".
   * There is no third outcome, because there is no fallible operation left
   * between COMMIT and `return`. (`regenDashboard` below is fire-and-forget and
   * catches its own errors; it reads nothing this method reports on.)
   *
   * ── The authority is the identity (issue #7, finding 4) ───────────────────
   * `ratifier` is a `GateAuthority` — it replaces what used to be a plain
   * `{ principal, platform, platformId, messageId }` object literal that any
   * caller could write out by hand. Every identity field below is read
   * OFF it, so there is no longer any way to tell this method who ratified: the
   * `principal` it records is the one the deployment is configured for, checked
   * by `authorizeRatifierAction` against the self-block and the principal-map
   * at the moment the authority was granted. `isGateAuthority` is the runtime
   * half (the type alone is a speed bump — see ratification.ts's header on
   * `structuredClone`/`Object.assign`/`as unknown as`), and a refusal is a
   * `null` like every other precondition violation here.
   */
  markRatified(id: string, ratifier: GateAuthority): StoredRatification | null {
    // A ratification that did not come through the gate is not a ratification.
    if (!isGateAuthority(ratifier)) return null;
    const capId = boundedKey(id);
    const principal = cap(ratifier.principal, MAX_ID_LEN);
    const platform = cap(ratifier.platform, 64);
    const platformId = cap(ratifier.platformId, MAX_ID_LEN);
    const messageId = boundedKey(ratifier.messageId);
    // ALL THREE components RAW, exactly as ratify.ts passes them.
    // `gateMessageKey` bounds the FINISHED string, so handing it a pre-`cap`ped
    // platform / platform id / message id yields a different key than the
    // caller computes, and the replay lookup silently stops matching.
    //
    // This was gotten half-right once already: the message id was fixed while
    // `platform` and `platformId` were left truncated, so RATIFY drifted while
    // DECLINE — which passes raw values — did not. Two exits from one room
    // disagreeing about the key is exactly the asymmetry this pair of methods
    // is supposed not to have. Derive from the PARAMETERS, never the locals.
    const gateKey = gateMessageKey(ratifier.platform, ratifier.platformId, ratifier.messageId);
    if (
      principal.length === 0 ||
      platform.length === 0 ||
      platformId.length === 0 ||
      messageId.length === 0 ||
      gateKey.length === 0
    ) {
      return null;
    }

    // The precondition READ happens INSIDE the transaction, together with the
    // writes it authorises. Reading first and writing after would be a
    // check-then-act window: this brain is single-threaded, but the DB is WAL
    // with a 5s busy timeout and agent-state ships its own scripts against the
    // same file, so "nothing else writes here" is an assumption worth not
    // making on the trust path.
    const ts = Date.now();
    const txn = this.db.transaction((): StoredRatification | null => {
      const row = this.getRow(capId);
      if (row === null || row.status !== "waiting_human") return null;
      const existingNotes = notesToObject(row.notes);
      // A row already carrying a ratification must never be re-ratified, even
      // if its status somehow read `waiting_human`. Belt and braces.
      if (parseStoredRatification(existingNotes.ratification) !== null) return null;
      const displayIdRaw = existingNotes.display_id;
      if (
        typeof displayIdRaw !== "number" ||
        !Number.isSafeInteger(displayIdRaw) ||
        displayIdRaw <= 0
      ) {
        return null; // surfaced without a display id is not a ratifiable state
      }
      const stored: StoredRatification = {
        principal,
        platform,
        platformId,
        messageId,
        displayId: displayIdRaw,
        ts,
      };
      this.db
        .query(`UPDATE work_items SET status = 'in_flight', owner_agent = ?, updated_at = ? WHERE id = ?`)
        .run(OWNER, ts, capId);
      this.db
        .query(`UPDATE work_items SET notes = ?, updated_at = ? WHERE id = ?`)
        .run(
          JSON.stringify({ ...existingNotes, ratification: serializeRatification(stored) }),
          ts,
          capId,
        );
      this.appendEvent(
        "work_item_ratified",
        capId,
        {
          status: "in_flight",
          // The REPLAY key (platform-scoped), not the bare message id — this
          // is what `hasSeenGateMessage` matches on. `message_id` inside
          // serializeRatification below keeps the raw id for the audit trail.
          gate_message_id: gateKey,
          ...serializeRatification(stored),
        },
        ts,
      );
      // Read back what was just written, THROUGH THE SAME READ PATH the
      // certificate is later minted from (`readRatificationByKey` — the
      // json-boundary re-validation AND the append-only event check, not a
      // convenient shortcut). Still inside the transaction, so a failure here
      // un-writes the rows above instead of contradicting them.
      const durable = this.readRatificationByKey(capId);
      if (durable === null) {
        throw new RatificationReadbackFailed(
          `ratification for ${capId} was not readable back inside its own transaction`,
        );
      }
      if (!sameRatification(durable, stored)) {
        throw new RatificationReadbackFailed(
          `ratification read back for ${capId} does not match what was written`,
        );
      }
      // What STORAGE says, not the in-memory `stored` — the caller must only
      // ever proceed on a durable read (see ratification.ts's file header).
      return durable;
    });
    let outcome: StoredRatification | null;
    try {
      outcome = txn();
    } catch (err) {
      if (err instanceof RatificationReadbackFailed) {
        // The transaction rolled back, so `null` here is TRUE: nothing was
        // committed. Not rethrown — the store is readable, so degrading the
        // whole process (which `run`'s catch-all would do) would be a
        // misdiagnosis of a content disagreement as a storage failure.
        warn(`markRatified rolled back — ${err.message}`);
        return null;
      }
      // A real storage failure. The transaction rolled back too, so
      // `AtlasProposals.run`'s degradation path also reports truthfully.
      throw err;
    }
    if (outcome === null) return null;
    this.regenDashboard();
    return outcome;
  }

  /**
   * The durable ratification for a work item, or `null`. Requires BOTH halves
   * of the record — the `$.ratification` note AND the append-only
   * `work_item_ratified` event — because either one alone is drift, and drift
   * here means someone (or some bug) touched the audit trail.
   *
   * `in_flight` ONLY — i.e. the `ratified` phase, never `applied`. This is the
   * difference between "a ratification exists" and "a ratification is still
   * OUTSTANDING", and the certificate must mean the second: it is the token
   * W2c will carry to perform a real, public, one-way plan edit and ledger
   * post. An adversarial review showed that accepting `done` here let a fresh,
   * fully-valid, WeakSet-blessed certificate be minted for an ALREADY-APPLIED
   * work item — `markApplied`'s own status gate stops a second state
   * transition, but nothing on that certificate would have told a retrying
   * caller the effect had already happened, and it would have double-posted.
   * Read-back for audit purposes should query the events table directly.
   */
  readRatification(id: string): StoredRatification | null {
    return this.readRatificationByKey(boundedKey(id));
  }

  /**
   * `readRatification`'s body, taking an ALREADY-bounded key. Split out so
   * `markRatified`'s in-transaction read-back goes through the identical
   * checks — same status gate, same JSON re-validation, same append-only event
   * requirement — rather than a cheaper lookalike that could drift from it.
   */
  private readRatificationByKey(capId: string): StoredRatification | null {
    const row = this.getRow(capId);
    if (row === null) return null;
    if (row.status !== "in_flight") return null; // `ratified` only, never `applied`
    const stored = parseStoredRatification(notesToObject(row.notes).ratification);
    if (stored === null) return null;
    const evt = this.db
      .query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM events
          WHERE work_item_id = ? AND type = 'work_item_ratified' LIMIT 1`,
      )
      .get(capId);
    if (evt === null || evt === undefined) return null;
    return stored;
  }

  /**
   * Phase `declined` by the ratifier: waiting_human → failed, with the
   * principal's own reason recorded. Distinct from `markDeclined` (which
   * handles VALIDATION failures out of intake/validated) because the source
   * phase and the recorded actor are different facts; collapsing them would
   * make the audit trail lie about who declined what.
   *
   * Preconditions are the SAME set `markRatified` enforces, deliberately: an
   * adversarial review found that the two transitions out of `waiting_human`
   * had asymmetric validation, so a row that `markRatified` correctly refused
   * (no usable display id) was still declinable. Two doors out of one room
   * should need the same key.
   *
   * That is why this takes a `GateAuthority` too (issue #7). The finding named
   * `markRatified`, but guarding only one exit would have RE-CREATED the exact
   * asymmetry the paragraph above exists to prevent — and a decline is a
   * recorded decision that kills a proposal, so it is a real transition, not a
   * read. Same key, both doors.
   */
  markDeclinedByRatifier(id: string, decliner: GateAuthority, reason: string): boolean {
    if (!isGateAuthority(decliner)) return false;
    const capId = boundedKey(id);
    const ts = Date.now();
    // Precondition read inside the transaction — same reasoning as markRatified.
    return this.db.transaction((): boolean => {
      const row = this.getRow(capId);
      if (row === null || row.status !== "waiting_human") return false;
      const notes = notesToObject(row.notes);
      if (parseStoredRatification(notes.ratification) !== null) return false;
      const displayIdRaw = notes.display_id;
      if (
        typeof displayIdRaw !== "number" ||
        !Number.isSafeInteger(displayIdRaw) ||
        displayIdRaw <= 0
      ) {
        return false;
      }
      this.db
        .query(`UPDATE work_items SET status = 'failed', updated_at = ? WHERE id = ?`)
        .run(ts, capId);
      this.appendEvent(
        "work_item_resolved",
        capId,
        {
          status: "failed",
          reason: "declined",
          gate_message_id: gateMessageKey(decliner.platform, decliner.platformId, decliner.messageId),
          declined_by: cap(decliner.principal, MAX_ID_LEN),
          declined_by_platform: cap(decliner.platform, 64),
          declined_by_platform_id: cap(decliner.platformId, MAX_ID_LEN),
          // The principal's free text. DATA, exactly like a proposal's why —
          // stored, never interpreted (see this file's Text hygiene header).
          declined_reason: cap(reason),
        },
        ts,
      );
      this.regenDashboard();
      return true;
    })();
  }

  /**
   * Phase `applied`: ratified (in_flight + ratification) → done.
   *
   * THE INVARIANT, enforced three ways (issue #3 acceptance bullet 6):
   *   1. Type level — the ONLY parameter identifying the work item is a
   *      `RatificationCertificate`, which cannot be constructed outside
   *      `ratification.ts` and is only ever minted from a durable read. There
   *      is deliberately no `markApplied(id: string)` overload for a caller to
   *      reach for instead.
   *   2. Object identity — `certificateMatchesStorage` requires the
   *      certificate to be one `ratification.ts` actually minted (a private
   *      `WeakSet`), which is what closes the `structuredClone` /
   *      `Object.assign` / `as unknown as` forgeries the type alone does not.
   *   3. Storage — it then re-reads the ratification NOW and compares it
   *      field-by-field, AND checks the ratifier is the principal this
   *      deployment is configured for. A certificate that was valid a minute
   *      ago cannot apply against a record that has since changed, and a
   *      certificate naming some other ratifier cannot apply at all.
   * Plus `status = 'in_flight'` gating, which makes a second apply a no-op,
   * and a transaction around the whole check-then-act.
   *
   * `expectedRatifier` is required for the reason spelled out in
   * `certificateMatchesStorage`: the certificate proves a ratification is
   * stored, not that the right person made it. Callers pass their
   * `RatifyIdentityConfig.ratifier`.
   *
   * It is a `ConfiguredRatifier`, not a string, because a string made the check
   * VACUOUS (issue #7): `markApplied(cert, cert.ratifierPrincipalId)` answered
   * the question out of the certificate under inspection and returned `true`.
   * The branded witness can only come from a built config, so the natural
   * call-site typo is now a compile error rather than a silent no-op check.
   *
   * The effects themselves are W2c's; this transition exists here so that
   * W2c is BORN unable to express "apply without ratification".
   */
  markApplied(
    cert: RatificationCertificate,
    expectedRatifier: ConfiguredRatifier,
    /**
     * The plan-body revision this apply produced (W2c). Positional with a
     * `null` default rather than an optional property, so existing callers are
     * untouched and `exactOptionalPropertyTypes` has nothing to complain about.
     * A receipt is not required for the TRANSITION to be legitimate — the
     * certificate is what authorises it — but an apply that records no
     * revision is an apply W3a's reconcile cannot check against the map, so
     * every real caller passes one.
     */
    receipt: AppliedReceipt | null = null,
  ): boolean {
    const capId = boundedKey(cert.workItemId);
    const ts = Date.now();
    // The whole check-then-act inside one transaction. `markRatified` already
    // does this; the transition that authorises the actual EFFECT has more
    // reason to, not less.
    return this.db.transaction((): boolean => {
      const row = this.getRow(capId);
      if (row === null || row.status !== "in_flight") return false;
      if (!certificateMatchesStorage(this, cert, expectedRatifier)) return false;
      this.db
        .query(`UPDATE work_items SET status = 'done', updated_at = ? WHERE id = ?`)
        .run(ts, capId);
      if (receipt !== null) {
        const notes = notesToObject(row.notes);
        this.db
          .query(`UPDATE work_items SET notes = ?, updated_at = ? WHERE id = ?`)
          .run(
            JSON.stringify({
              ...notes,
              applied: { revision: cap(receipt.revision, 128), ts },
            }),
            ts,
            capId,
          );
      }
      this.appendEvent(
        "work_item_resolved",
        capId,
          {
          status: "done",
          reason: "applied",
          // NOT `gate_message_id`: an apply is not an inbound gate message, so
          // it must not register as one in the replay index. The ratifying
          // message is recorded here purely as an audit backlink.
          ratified_message_id: cert.messageId,
          plan_revision: receipt === null ? null : cap(receipt.revision, 128),
          plan_revision_normalized:
            receipt === null || typeof receipt.normalizedRevision !== "string" || receipt.normalizedRevision.length === 0
              ? null
              : cap(receipt.normalizedRevision, 128),
        },
        ts,
      );
      this.regenDashboard();
      return true;
    })();
  }

  /**
   * Phase `posted`: applied (done + ratification) → done + the ledger receipt.
   *
   * The second half of J3's atomic pair, recorded AFTER the fact — this method
   * causes no effect, it records that one already happened, so that the
   * "applied but never posted" population (the one W3a's reconcile loop exists
   * to find and the one issue #1 requires an apply to PARK in) is a state Atlas
   * can actually see rather than infer.
   *
   * It is still guarded, and guarded the same way everything on this path is
   * (issue #7's lesson: an unguarded public transition is a transition, however
   * innocuous it looks). It takes ONLY a certificate — no work-item-id
   * overload — plus the CONFIGURED ratifier, and re-verifies both against the
   * ratification note still stored on the applied row via
   * `certificateMatchesRecord`. `certificateMatchesStorage` cannot be used
   * here: `readRatification` deliberately answers for `in_flight` only, so it
   * goes quiet the moment `markApplied` lands.
   *
   * Returns `false` — never throws, never overwrites — when the row is not
   * `done`, when the certificate does not match, or when a posted receipt is
   * ALREADY recorded. Constitution rule 4: a ledger receipt is written once and
   * never edited; a correction is a new post, not a rewritten one.
   */
  markPosted(
    cert: RatificationCertificate,
    expectedRatifier: ConfiguredRatifier,
    receipt: PostedReceipt,
  ): boolean {
    if (
      receipt === null ||
      typeof receipt !== "object" ||
      typeof receipt.messageId !== "string" ||
      receipt.messageId.length === 0 ||
      typeof receipt.channelId !== "string" ||
      receipt.channelId.length === 0
    ) {
      return false;
    }
    const capId = boundedKey(cert.workItemId);
    const ts = Date.now();
    return this.db.transaction((): boolean => {
      const row = this.getRow(capId);
      if (row === null || row.status !== "done") return false;
      const notes = notesToObject(row.notes);
      if (parsePostedReceipt(notes.posted) !== null) return false; // never rewritten
      const stored = parseStoredRatification(notes.ratification);
      if (!certificateMatchesRecord(cert, stored, expectedRatifier)) return false;
      this.db
        .query(`UPDATE work_items SET notes = ?, updated_at = ? WHERE id = ?`)
        .run(
          JSON.stringify({
            ...notes,
            posted: {
              message_id: cap(receipt.messageId, MAX_ID_LEN),
              channel_id: cap(receipt.channelId, MAX_ID_LEN),
              ts,
            },
          }),
          ts,
          capId,
        );
      this.appendEvent(
        "work_item_posted",
        capId,
        {
          status: "done",
          message_id: cap(receipt.messageId, MAX_ID_LEN),
          channel_id: cap(receipt.channelId, MAX_ID_LEN),
        },
        ts,
      );
      this.regenDashboard();
      return true;
    })();
  }

  // ── W2c, the completion watcher (issue #1, J4) ───────────────────────────

  /**
   * Has a ✅ for this issue URL already gone out?
   *
   * DURABLE by design: an in-process set would re-announce every closed plan
   * item after a restart, and the ledger's whole value is that it can be
   * trusted backwards. The event type is deliberately NOT one of
   * `GATE_EVENT_TYPES`, so a completion record can never burn a gate replay
   * key — the same separation the gate's own type filter exists to enforce.
   */
  hasAnnouncedCompletion(issueUrl: string): boolean {
    const key = boundedKey(cap(issueUrl, 300));
    if (key.length === 0) return false;
    const row = this.db
      .query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM events
          WHERE type = 'completion_announced'
            AND ${jsonField("payload", "$.issue_url")} = ?
          LIMIT 1`,
      )
      .get(key);
    return row !== null && row !== undefined;
  }

  /** Record that a ✅ carrying this issue URL landed. Append-only; never updated. */
  recordCompletionAnnounced(issueUrl: string, messageId: string): void {
    const key = boundedKey(cap(issueUrl, 300));
    if (key.length === 0) return;
    this.db
      .query(`INSERT INTO events (ts, type, actor, work_item_id, payload) VALUES (?, ?, ?, NULL, ?)`)
      .run(
        Date.now(),
        "completion_announced",
        OWNER,
        JSON.stringify({ issue_url: key, message_id: cap(messageId, MAX_ID_LEN) }),
      );
  }

  // ── W3a, the reconcile loop (issue #2, J5) ───────────────────────────────
  //
  // Every method in this block is a READ, except the three explicitly named
  // `record…`. Reconcile is read-only apart from the catch-up post itself and
  // the records that make that post converge — so this block is deliberately
  // shaped as "many readers, three narrow writers", and none of the writers
  // touches a work item's STATUS. No phase transition is reachable from here,
  // and no certificate is minted or consumed: a catch-up entry is a ledger
  // line about work that already happened, never an authorisation for new work.

  /**
   * THE DOUBLE-POST MARKER — the durable half of "did the ledger post land?".
   *
   * `apply.ts` ends in one of two parked shapes when the atomic pair breaks,
   * and from STORAGE ALONE they are identical: both are `done` + a ratification
   * + an `applied` receipt + no `posted` receipt (see `rowPhase`). The
   * difference — `postLanded` on the `applied-not-posted` outcome — was known
   * only to the in-process caller and died with it.
   *
   * That difference is the single most dangerous fact in this slice. If the post
   * DID land and reconcile itemises the item as "ledger entry missing", the
   * catch-up asserts something false about a public, append-only ledger — the
   * one corruption issue #2 says must never happen. So the fact is written down
   * AT THE MOMENT IT IS KNOWN rather than inferred later: `apply.ts` records
   * this marker on the `postLanded: true` branch, and reconcile treats its
   * presence as "may already have posted — do not post again".
   *
   * The residual window is honest and narrow: a crash between the ledger post
   * landing and this marker committing leaves an item that LOOKS like it was
   * never posted. The channel cross-check in `reconcile.ts` exists for exactly
   * that window, and it is SUBTRACTIVE ONLY — it can remove an item from a
   * catch-up, never add one.
   */
  recordLedgerPostUnrecorded(workItemId: string, messageId: string): void {
    const capId = boundedKey(workItemId);
    if (capId.length === 0) return;
    this.db
      .query(`INSERT INTO events (ts, type, actor, work_item_id, payload) VALUES (?, ?, ?, NULL, ?)`)
      .run(
        Date.now(),
        "ledger_post_unrecorded",
        OWNER,
        JSON.stringify({ work_item_id: capId, message_id: cap(messageId, MAX_ID_LEN) }),
      );
  }

  /**
   * Did a ledger post for this work item LAND without its receipt recording?
   * `true` means "a post may already exist" — reconcile must then stay silent
   * about this item. Note `work_item_id` is NULL on the event row (it is an
   * audit fact about a post, not a work-item transition), so the id is matched
   * out of the payload.
   */
  hasLedgerPostUnrecorded(workItemId: string): boolean {
    const capId = boundedKey(workItemId);
    if (capId.length === 0) return false;
    const row = this.db
      .query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM events
          WHERE type = 'ledger_post_unrecorded'
            AND ${jsonField("payload", "$.work_item_id")} = ?
          LIMIT 1`,
      )
      .get(capId);
    return row !== null && row !== undefined;
  }

  /**
   * Every work item parked in `applied` — the map changed and the ledger did
   * not. This is the population W3a exists to find; `rowPhase` is what defines
   * it, so the filter goes through `rowToRecord` rather than re-deriving the
   * rule in SQL (two statements of one invariant is how they drift apart).
   */
  appliedUnposted(limit = 200): ProposalRecord[] {
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 200;
    const rows = this.db
      .query<WorkItemRow, [string, number]>(
        `SELECT id, status, payload, notes FROM work_items
          WHERE kind = ? AND status = 'done'
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
      .all(KIND, bounded);
    const out: ProposalRecord[] = [];
    for (const row of rows) {
      const record = rowToRecord(row);
      if (record !== null && record.phase === "applied") out.push(record);
    }
    return out;
  }

  /**
   * The most recently touched proposal work items, newest first. The
   * dashboard's work-item half (W3a): it needs every LIVE proposal, not one
   * looked up by id, and it is the only consumer — hence a bounded read rather
   * than an unbounded `all()`. Rows `rowToRecord` cannot recognise are dropped,
   * exactly as `get` drops them.
   */
  recentProposals(limit = 500): ProposalRecord[] {
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 2_000) : 500;
    const rows = this.db
      .query<WorkItemRow, [string, number]>(
        `SELECT id, status, payload, notes FROM work_items
          WHERE kind = ?
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(KIND, bounded);
    const out: ProposalRecord[] = [];
    for (const row of rows) {
      const record = rowToRecord(row);
      if (record !== null) out.push(record);
    }
    return out;
  }

  /**
   * The recorded ✅ announcement for one issue URL — its message id and when it
   * was recorded — or `null`. The message id is what lets a channel cross-check
   * ask "is that post still there?"; the timestamp is what keeps the answer
   * honest, because a message id absent from a BOUNDED read window means
   * "scrolled out of view", not "deleted", unless the announcement is newer
   * than the oldest message the window contains.
   */
  completionAnnouncement(issueUrl: string): { messageId: string; ts: number } | null {
    const key = boundedKey(cap(issueUrl, 300));
    if (key.length === 0) return null;
    const row = this.db
      .query<{ ts: number; message_id: string | null }, [string]>(
        `SELECT ts, ${jsonField("payload", "$.message_id")} AS message_id FROM events
          WHERE type = 'completion_announced'
            AND ${jsonField("payload", "$.issue_url")} = ?
          ORDER BY ts DESC LIMIT 1`,
      )
      .get(key);
    if (row === null || row === undefined) return null;
    const messageId = typeof row.message_id === "string" ? row.message_id : "";
    if (messageId.length === 0) return null;
    if (!Number.isSafeInteger(row.ts) || row.ts <= 0) return null;
    return { messageId, ts: row.ts };
  }

  /**
   * When the most recent LEDGER ENTRY Atlas knows about was recorded — the
   * anchor the catch-up post is labelled with ("since <timestamp>"). Three
   * event types qualify, and only three: a ➕/➖ receipt, a ✅ announcement, and
   * a previous catch-up. `null` when Atlas has never recorded one.
   */
  lastLedgerEntryTs(): number | null {
    const row = this.db
      .query<{ ts: number | null }, []>(
        `SELECT MAX(ts) AS ts FROM events
          WHERE type IN ('work_item_posted', 'completion_announced', 'reconcile_catchup_recorded')`,
      )
      .get();
    const ts = row?.ts ?? null;
    return typeof ts === "number" && Number.isSafeInteger(ts) && ts > 0 ? ts : null;
  }

  /**
   * Every plan-body revision Atlas can ACCOUNT FOR: the revisions its own
   * applies produced, plus the revisions past reconcile passes observed and
   * wrote down. A live revision outside this set is a plan-body edit with no
   * matching ➕/➖ event — detector (c).
   */
  observedPlanRevisions(limit = 1_000): Set<string> {
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 5_000) : 1_000;
    const rows = this.db
      .query<{ revision: string | null }, [number]>(
        `SELECT revision FROM (
           SELECT ts, ${jsonField("payload", "$.plan_revision")} AS revision FROM events
             WHERE type IN ('work_item_resolved', 'reconcile_completed')
         )
         WHERE revision IS NOT NULL
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(bounded);
    const out = new Set<string>();
    for (const row of rows) {
      if (typeof row.revision === "string" && row.revision.length > 0) out.add(row.revision);
    }
    return out;
  }

  /**
   * The last plan-body revision reconcile could account for, exact hash AND
   * normalised hash together (`plan-revision.ts`'s `PlanRevisionBaseline`,
   * atlas#34) — the freshest of EITHER an apply's `work_item_resolved` or a
   * reconcile pass's own `reconcile_completed`, by timestamp. This is the
   * baseline detector (c) diffs the CURRENT body against to tell "only a
   * checkbox marker changed" from "something else did".
   *
   * `null` when there is no accounted revision yet, OR when the freshest one
   * predates atlas#34 and so was never recorded with a normalised twin — the
   * two are deliberately collapsed into the same answer, because a caller
   * that cannot tell "no baseline" from "an unusable one" apart must fail
   * closed to the SAME safe default: fall back to reporting drift as before,
   * rather than risk matching a checkbox-only diff against a baseline that
   * was never actually verified.
   */
  lastAccountedPlanRevision(): { revision: string; normalized: string } | null {
    const row = this.db
      .query<{ revision: string | null; normalized: string | null }, []>(
        `SELECT revision, normalized FROM (
           SELECT ts,
                  ${jsonField("payload", "$.plan_revision")} AS revision,
                  ${jsonField("payload", "$.plan_revision_normalized")} AS normalized
             FROM events
             WHERE type IN ('work_item_resolved', 'reconcile_completed')
         )
         WHERE revision IS NOT NULL
         ORDER BY ts DESC LIMIT 1`,
      )
      .get();
    if (row === null || row === undefined) return null;
    if (typeof row.revision !== "string" || row.revision.length === 0) return null;
    if (typeof row.normalized !== "string" || row.normalized.length === 0) return null;
    return { revision: row.revision, normalized: row.normalized };
  }

  /**
   * Has THIS revision already been given its one grace pass (atlas#34)? A
   * checkbox-only revision reconcile cannot yet corroborate is not reported
   * the first time it is seen — the watcher may simply not have caught up —
   * so this answers "have we already deferred this exact revision once",
   * which is what tells the SECOND sighting to report rather than defer
   * again. Keyed on the revision itself, same shape as `hasReconcileCatchUp`.
   */
  hasDeferredChecklistRevision(revision: string): boolean {
    const key = boundedKey(cap(revision, 128));
    if (key.length === 0) return false;
    const row = this.db
      .query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM events
          WHERE type = 'reconcile_checklist_deferred'
            AND ${jsonField("payload", "$.revision")} = ?
          LIMIT 1`,
      )
      .get(key);
    return row !== null && row !== undefined;
  }

  /** Record that this revision has now been given its one grace pass. */
  recordDeferredChecklistRevision(revision: string): void {
    const key = boundedKey(cap(revision, 128));
    if (key.length === 0) return;
    this.db
      .query(`INSERT INTO events (ts, type, actor, work_item_id, payload) VALUES (?, ?, ?, NULL, ?)`)
      .run(Date.now(), "reconcile_checklist_deferred", OWNER, JSON.stringify({ revision: key }));
  }

  /**
   * Has a reconcile pass ever completed? The FIRST pass establishes the
   * revision baseline instead of reporting on it: Atlas cannot honestly claim a
   * plan-body edit is unaccounted-for when it has no record of any edit at all,
   * and an install-time catch-up naming every pre-existing revision would be
   * noise in a channel whose whole value is that it is not noisy.
   */
  hasReconciled(): boolean {
    const row = this.db
      .query<{ one: number }, []>(
        `SELECT 1 AS one FROM events WHERE type = 'reconcile_completed' LIMIT 1`,
      )
      .get();
    return row !== null && row !== undefined;
  }

  /**
   * Has a catch-up already covered this drift? THE convergence mechanism: a
   * drift item that has been itemised once is never itemised again, so the
   * second reconcile after a catch-up is silent — the property issue #2 asks
   * to be asserted.
   */
  hasReconcileCatchUp(driftKey: string): boolean {
    const key = boundedKey(cap(driftKey, 512));
    if (key.length === 0) return false;
    const row = this.db
      .query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM events
          WHERE type = 'reconcile_catchup_recorded'
            AND ${jsonField("payload", "$.drift_key")} = ?
          LIMIT 1`,
      )
      .get(key);
    return row !== null && row !== undefined;
  }

  /**
   * Record that a landed catch-up post covered this drift. Written ONLY after
   * the post lands (same discipline as `recordCompletionAnnounced`): a catch-up
   * that failed to post records nothing, so the next pass retries it.
   */
  recordReconcileCatchUp(driftKey: string, messageId: string): void {
    const key = boundedKey(cap(driftKey, 512));
    if (key.length === 0) return;
    this.db
      .query(`INSERT INTO events (ts, type, actor, work_item_id, payload) VALUES (?, ?, ?, NULL, ?)`)
      .run(
        Date.now(),
        "reconcile_catchup_recorded",
        OWNER,
        JSON.stringify({ drift_key: key, message_id: cap(messageId, MAX_ID_LEN) }),
      );
  }

  /**
   * Close out one reconcile pass. Written on EVERY pass, including a pass that
   * found nothing — because "silence" is a statement about the CHANNEL, never
   * about the event log. The drift count recorded here is the health metric the
   * weekly retro reports, and a metric that is only written when it is non-zero
   * cannot be shown to trend to zero.
   */
  recordReconcilePass(
    driftCount: number,
    planRevision: string | null,
    planRevisionNormalized: string | null,
    catchUpMessageId: string | null,
  ): void {
    this.db
      .query(`INSERT INTO events (ts, type, actor, work_item_id, payload) VALUES (?, ?, ?, NULL, ?)`)
      .run(
        Date.now(),
        "reconcile_completed",
        OWNER,
        JSON.stringify({
          drift_count: Number.isSafeInteger(driftCount) && driftCount >= 0 ? driftCount : 0,
          plan_revision: planRevision === null ? null : cap(planRevision, 128),
          // atlas#34: only ever meaningful alongside a non-null `plan_revision` —
          // see `lastAccountedPlanRevision`, which reads the two as a pair.
          plan_revision_normalized: planRevisionNormalized === null ? null : cap(planRevisionNormalized, 128),
          catch_up_message_id: catchUpMessageId === null ? null : cap(catchUpMessageId, MAX_ID_LEN),
        }),
      );
  }

  // ── W3a, the weekly retro's counters (issue #2, item 3) ──────────────────

  /** `type → count` for every event in `[fromTs, toTs)`. Aggregated in SQL. */
  countEventTypes(fromTs: number, toTs: number): Record<string, number> {
    if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs)) return {};
    const rows = this.db
      .query<{ type: string; n: number }, [number, number]>(
        `SELECT type, COUNT(*) AS n FROM events WHERE ts >= ? AND ts < ? GROUP BY type`,
      )
      .all(fromTs, toTs);
    const out: Record<string, number> = {};
    for (const row of rows) out[row.type] = row.n;
    return out;
  }

  /**
   * `reason → count` over `work_item_resolved` in `[fromTs, toTs)`. A separate
   * query because "declined" and "applied" are both resolutions and the retro
   * must not conflate them — the reason lives in the payload, not the type.
   */
  countResolvedReasons(fromTs: number, toTs: number): Record<string, number> {
    if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs)) return {};
    const rows = this.db
      .query<{ reason: string | null; n: number }, [number, number]>(
        `SELECT ${jsonField("payload", "$.reason")} AS reason, COUNT(*) AS n FROM events
          WHERE type = 'work_item_resolved' AND ts >= ? AND ts < ?
          GROUP BY reason`,
      )
      .all(fromTs, toTs);
    const out: Record<string, number> = {};
    for (const row of rows) {
      if (typeof row.reason === "string" && row.reason.length > 0) out[row.reason] = row.n;
    }
    return out;
  }

  /**
   * How many reconcile passes actually POSTED a catch-up in `[fromTs, toTs)`.
   * Distinct from the drift total: one post can carry many items, and the retro
   * reports "posts made" and "drift found" as two different facts.
   */
  countCatchUpPosts(fromTs: number, toTs: number): number {
    if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs)) return 0;
    const row = this.db
      .query<{ n: number }, [number, number]>(
        `SELECT COUNT(*) AS n FROM events
          WHERE type = 'reconcile_completed' AND ts >= ? AND ts < ?
            AND ${jsonField("payload", "$.catch_up_message_id")} IS NOT NULL`,
      )
      .get(fromTs, toTs);
    return row?.n ?? 0;
  }

  /** Total drift found by reconcile in `[fromTs, toTs)` — the health metric. */
  sumReconcileDrift(fromTs: number, toTs: number): number {
    if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs)) return 0;
    const row = this.db
      .query<{ total: number | null }, [number, number]>(
        `SELECT SUM(${jsonField("payload", "$.drift_count")}) AS total FROM events
          WHERE type = 'reconcile_completed' AND ts >= ? AND ts < ?`,
      )
      .get(fromTs, toTs);
    const total = row?.total ?? 0;
    return typeof total === "number" && Number.isFinite(total) ? total : 0;
  }

  /**
   * An append-only audit event with NO work item attached — how a rejected
   * gate attempt (self-ratify, unmapped author, wrong principal) is recorded.
   * `work_item_id` is NULL, which the FK permits.
   *
   * Volume note: this is a write triggered by inbound messages, so callers
   * MUST gate it (ratify.ts logs only verb-SHAPED attempts, never ordinary
   * chat) or an unbounded log-growth vector opens up. Every string is capped
   * here regardless — this row can contain attacker-influenced text.
   */
  recordGateEvent(type: string, payload: Record<string, unknown>): void {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      safe[cap(k, 64)] = typeof v === "string" ? cap(v, 512) : v;
    }
    const ts = Date.now();
    const cappedType = cap(type, 64);
    const result = this.db
      .query(`INSERT INTO events (ts, type, actor, work_item_id, payload) VALUES (?, ?, ?, NULL, ?)`)
      .run(ts, cappedType, OWNER, JSON.stringify(safe));
    this.indexGateReplayKey(cappedType, result.lastInsertRowid, safe, ts);
  }

  /**
   * Phase `declined`: (pending|in_flight) → failed. `failedCheck` is the one
   * named reason the templated reply quotes (issue #2 item 4); the work
   * item's stored `reason` is always the literal `"validation"`.
   *
   * NOTE the source-phase guard below excludes `waiting_human`: a SURFACED
   * proposal can only be declined through `markDeclinedByRatifier`, i.e. only
   * by the gate. Validation cannot retroactively kill something already put in
   * front of the principal. It also refuses any row carrying a ratification —
   * `in_flight` covers both `validated` and `ratified`, and a validation
   * decline must never be able to touch a ratified record.
   */
  markDeclined(id: string, failedCheck: string): void {
    const capId = boundedKey(id);
    const row = this.getRow(capId);
    if (row === null) return;
    if (row.status !== "pending" && row.status !== "in_flight") return; // never re-resolve a terminal row
    if (parseStoredRatification(notesToObject(row.notes).ratification) !== null) return;
    const ts = Date.now();
    this.db
      .query(`UPDATE work_items SET status = 'failed', updated_at = ? WHERE id = ?`)
      .run(ts, capId);
    this.appendEvent(
      "work_item_resolved",
      capId,
      { status: "failed", reason: "validation", failed_check: cap(failedCheck, 200) },
      ts,
    );
    this.regenDashboard();
  }

  // ── The owned-thread registry (atlas#22 + atlas#25) ──────────────────────

  /**
   * Record a thread Atlas itself opened, so a message posted in it is
   * admitted after a restart. `threadId` MUST be a host-resolved
   * `thread_created.thread_id` correlated to this brain's own
   * `create_private_thread` — see `OWNED_THREADS_SCHEMA` and the single caller
   * in `runtime.ts`.
   *
   * Returns `true` only when the row is durably present afterwards. A
   * malformed id is refused (`false`) rather than stored: this table decides
   * what Atlas will ACT on, so a value that does not look like a platform id
   * has no business widening admission. `INSERT OR IGNORE` makes a repeat
   * (host redelivery, a re-correlated event) a no-op that still reports
   * success — the row exists, which is the property callers care about.
   */
  recordOwnedThread(threadId: string, taskId: string, now: number = Date.now()): boolean {
    if (!isPlausibleThreadId(threadId)) return false;
    this.db
      .query(`INSERT OR IGNORE INTO owned_threads (thread_id, task_id, opened_at) VALUES (?, ?, ?)`)
      .run(threadId, boundedKey(typeof taskId === "string" ? taskId : ""), now);
    return this.isOwnedThread(threadId);
  }

  /**
   * Is this channel id a thread Atlas opened? The admission half of the
   * registry — an indexed point lookup on the PRIMARY KEY, called once per
   * inbound task that is not already the bound channel.
   *
   * The shape check runs BEFORE the query, not as a nicety: it is what makes
   * `""` (a task with no channel at all) unable to match, independently of
   * what any other row in the table happens to contain.
   */
  isOwnedThread(threadId: string): boolean {
    if (!isPlausibleThreadId(threadId)) return false;
    const row = this.db
      .query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM owned_threads WHERE thread_id = ? LIMIT 1`,
      )
      .get(threadId);
    return row !== null && row !== undefined;
  }

  /** How many threads Atlas owns. Observability only — no decision reads it. */
  ownedThreadCount(): number {
    const row = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM owned_threads`).get();
    return row?.n ?? 0;
  }

  // ── atlas#28: the status cache + the watch-pass marker ───────────────────
  //
  // Everything in this block is either a durable write `watch.ts` makes on
  // its own already-scheduled pass, or a read the STATUS CLI makes through
  // `openReadOnly` above. Nothing here is reachable from admission or thread
  // handling — it is a sibling concern (freshness + a zero-network ledger
  // view), not a change to either.

  /**
   * Cache the plan body's raw text plus its `plan-revision.ts` hash, at the
   * moment `watch.ts` (which already fetches it every pass) reads it.
   * Singleton row — see `PLAN_STATUS_CACHE_SCHEMA`'s header for why an
   * `INSERT OR REPLACE` is correct here and not elsewhere in this file.
   */
  recordPlanBodyCache(body: string, revision: string, ts: number = Date.now()): void {
    this.db
      .query(
        `INSERT INTO plan_body_cache (id, body, revision, fetched_at) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET body = excluded.body, revision = excluded.revision,
             fetched_at = excluded.fetched_at`,
      )
      .run(cap(body, MAX_PLAN_BODY_CACHE_LEN), cap(revision, 128), ts);
  }

  /** The cached plan-body snapshot, or `null` if none has ever landed. */
  getPlanBodyCache(): { body: string; revision: string; fetchedAt: number } | null {
    const row = this.db
      .query<{ body: string; revision: string; fetched_at: number }, []>(
        `SELECT body, revision, fetched_at FROM plan_body_cache WHERE id = 1`,
      )
      .get();
    if (row === null || row === undefined) return null;
    return { body: row.body, revision: row.revision, fetchedAt: row.fetched_at };
  }

  /**
   * Cache one linked issue's title — issue #28's D1(a): cheap, at the exact
   * point `watch.ts` already reads it, so the default (offline) status path
   * has something better to show than a bare URL. Titles may go stale on a
   * rename; that staleness is disclosed by the status tool's freshness
   * block, not hidden here.
   */
  recordLinkedIssueTitle(url: string, title: string, ts: number = Date.now()): void {
    const key = boundedKey(cap(url, 300));
    if (key.length === 0) return;
    this.db
      .query(
        `INSERT INTO linked_issue_title_cache (url, title, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT(url) DO UPDATE SET title = excluded.title, fetched_at = excluded.fetched_at`,
      )
      .run(key, cap(title, 200), ts);
  }

  /** The cached title for a linked-issue URL, or `null` if never fetched. */
  getLinkedIssueTitle(url: string): { title: string; fetchedAt: number } | null {
    const key = boundedKey(cap(url, 300));
    if (key.length === 0) return null;
    const row = this.db
      .query<{ title: string; fetched_at: number }, [string]>(
        `SELECT title, fetched_at FROM linked_issue_title_cache WHERE url = ?`,
      )
      .get(key);
    if (row === null || row === undefined) return null;
    return { title: row.title, fetchedAt: row.fetched_at };
  }

  /**
   * Mark one watcher pass complete — written on EVERY pass (same discipline
   * `recordReconcilePass` already follows for reconcile), not only when a
   * closure is found. Without this, "how current can the ledger view
   * possibly be" was simply not observable: a poll that found nothing new
   * left no trace at all.
   */
  recordWatchPass(ts: number = Date.now()): void {
    this.db
      .query(`INSERT INTO events (ts, type, actor, work_item_id, payload) VALUES (?, ?, ?, NULL, ?)`)
      .run(ts, "watch_pass_completed", OWNER, JSON.stringify({}));
  }

  /** When the watcher last completed a pass, or `null` if it never has. */
  lastWatchPassTs(): number | null {
    const row = this.db
      .query<{ ts: number | null }, []>(
        `SELECT MAX(ts) AS ts FROM events WHERE type = 'watch_pass_completed'`,
      )
      .get();
    const ts = row?.ts ?? null;
    return typeof ts === "number" && Number.isSafeInteger(ts) && ts > 0 ? ts : null;
  }

  /**
   * The last completed reconcile pass — when, and how much drift it found.
   * `null` if reconcile has never run. `hasReconciled` already answers the
   * boolean; this is the same fact plus the two numbers a freshness block
   * needs (`recordReconcilePass` writes both onto the identical event).
   */
  lastReconcilePass(): { ts: number; driftCount: number } | null {
    const row = this.db
      .query<{ ts: number; drift_count: number | null }, []>(
        `SELECT ts, ${jsonField("payload", "$.drift_count")} AS drift_count FROM events
          WHERE type = 'reconcile_completed' ORDER BY ts DESC LIMIT 1`,
      )
      .get();
    if (row === null || row === undefined) return null;
    const driftCount =
      typeof row.drift_count === "number" && Number.isFinite(row.drift_count) ? row.drift_count : 0;
    return { ts: row.ts, driftCount };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // fail-soft to the end
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Counts only work_items that have ALREADY been assigned a display id
   * (i.e. previously surfaced proposals), not the total row count — total
   * row count would double-count: two proposals created before either is
   * surfaced would both read the same "count so far" and collide on the
   * same RATIFY id. Counting assigned ids instead makes each call read a
   * value one higher than the last successful assignment, guaranteeing a
   * gapless, collision-free 1, 2, 3, … sequence (single sequential brain
   * process — no concurrent writers to this table).
   */
  private nextDisplayId(): number {
    const row = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM work_items
          WHERE kind = ? AND notes IS NOT NULL
            AND ${jsonField("notes", "$.display_id")} IS NOT NULL`,
      )
      .get(KIND);
    return (row?.n ?? 0) + 1;
  }

  private getRow(id: string): WorkItemRow | null {
    return (
      this.db
        .query<WorkItemRow, [string]>(
          `SELECT id, status, payload, notes FROM work_items WHERE id = ?`,
        )
        .get(id) ?? null
    );
  }

  private appendEvent(type: string, workItemId: string, payload: unknown, ts: number): void {
    const result = this.db
      .query(`INSERT INTO events (ts, type, actor, work_item_id, payload) VALUES (?, ?, ?, ?, ?)`)
      .run(ts, type, OWNER, workItemId, JSON.stringify(payload));
    this.indexGateReplayKey(type, result.lastInsertRowid, payload, ts);
  }

  /**
   * Populate `gate_replay_keys` for ONE event, iff it is both a type this
   * store treats as a gate decision (`GATE_EVENT_TYPES`) AND actually carries
   * a non-empty string `gate_message_id` in its payload. Called from every
   * event-insertion point (`appendEvent` above, `recordGateEvent` below) so
   * no call site can forget it — the alternative (each of the ~4 places that
   * set `gate_message_id` remembering to index it too) is the same
   * "same fix, several places, one of them drifts" shape that produced
   * atlas#8 finding 1 in the first place (`ratify.test.ts:1297-1316` guarding
   * the fix rather than the property).
   *
   * `INSERT OR IGNORE`: a key can only legitimately appear once (it is
   * checked via `hasSeenGateMessage` before any caller records a decision),
   * so a collision here is itself a replay slipping through a race — silently
   * keeping the FIRST record is the correct, fail-safe resolution, not an
   * error.
   */
  private indexGateReplayKey(
    type: string,
    eventId: number | bigint,
    payload: unknown,
    ts: number,
  ): void {
    if (!(GATE_EVENT_TYPES as readonly string[]).includes(type)) return;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
    const raw = (payload as Record<string, unknown>).gate_message_id;
    if (typeof raw !== "string" || raw.length === 0) return;
    this.db
      .query(
        `INSERT OR IGNORE INTO gate_replay_keys (key, event_id, type, ts) VALUES (?, ?, ?, ?)`,
      )
      .run(raw, typeof eventId === "bigint" ? Number(eventId) : eventId, type, ts);
  }

  /** agent-state's annotate: shallow JSON merge into notes + its own event. */
  private annotate(id: string, patch: Record<string, unknown>, ts: number): void {
    const row = this.getRow(id);
    if (row === null) return;
    const base = notesToObject(row.notes);
    this.db
      .query(`UPDATE work_items SET notes = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ ...base, ...patch }), ts, id);
    this.appendEvent("work_item_annotated", id, { keys: Object.keys(patch) }, ts);
  }

  /**
   * Best-effort `dashboard.md` regen via agent-state's own documented
   * workflow, exactly mirroring escort's fire-and-forget subprocess call —
   * except the actual spawn is now debounced/coalesced (atlas#8, finding 5;
   * see `scheduleDashboardSpawn`).
   */
  private regenDashboard(): void {
    // W3a: announce the transition FIRST, and independently of the agent-state
    // bundle. Atlas's own plan dashboard must redraw on every state change even
    // on a host where the agent-state bundle is absent (the `bundleDir === null`
    // early return below), which is exactly the case every test runs in. This
    // hook is NOT debounced — it only sets a flag (`runtime.ts`'s own
    // coalescing owns the redraw timing) and must fire every transition so
    // that flag is never missed.
    if (this.onTransition !== null) {
      try {
        this.onTransition();
      } catch (err) {
        warn(`transition hook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.bundleDir === null) return;
    this.scheduleDashboardSpawn();
  }

  /**
   * Debounce + coalesce the `dashboard.ts regen` subprocess (atlas#8,
   * finding 5). `regenDashboard` used to call `Bun.spawn` unconditionally —
   * no debounce, no queue, no cap — from 8 call sites that are ALL reachable
   * from an outsider's inbound comment (every intake/gate transition calls
   * it). A burst of N public comments was N bare subprocess spawns, with
   * nothing bounding N.
   *
   * The bound here is deliberately COUNT-based, not a hope that subprocesses
   * happen to overlap:
   *   - a call arriving while a timer is already pending returns immediately
   *     — it does not start a second timer, it rides the one already
   *     scheduled. So however many transitions land inside one debounce
   *     window, exactly one timer — and, once it fires, exactly one spawn —
   *     comes out the other side.
   *   - a call arriving while a spawn is actually RUNNING sets `pending`
   *     instead of scheduling a new timer. When that spawn's process exits,
   *     `finishDashboardSpawn` checks `pending` and schedules exactly ONE
   *     more debounced spawn if anything arrived meanwhile — never one per
   *     caller.
   * Either branch preserves the guarantee `regenDashboard` exists for: the
   * dashboard still ends up reflecting the latest state once the burst
   * settles (coalescing drops no information — the LAST scheduled spawn
   * always runs) — it is dropping duplicate PROCESSES, never the final
   * regeneration.
   */
  private scheduleDashboardSpawn(): void {
    if (this.dashboardRegenRunning) {
      this.dashboardRegenPending = true;
      return;
    }
    if (this.dashboardRegenTimer !== null) return; // already coalesced onto the pending timer
    const timer = setTimeout(() => {
      this.dashboardRegenTimer = null;
      this.spawnDashboardRegen();
    }, this.dashboardDebounceMs);
    // Never let this timer alone keep the process alive — every path that
    // matters here (tests, and the daemon's own `process.exit()` shutdown in
    // `main.ts`) ends explicitly, and a lingering ref would only matter to a
    // caller that is otherwise idle, which a debounced background regen must
    // not do.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.dashboardRegenTimer = timer;
  }

  /** The actual (debounced) spawn. Never called directly — only via the scheduler above. */
  private spawnDashboardRegen(): void {
    if (this.bundleDir === null) return;
    this.dashboardRegenRunning = true;
    try {
      const script = join(this.bundleDir, "skill", "scripts", "dashboard.ts");
      if (!existsSync(script)) {
        if (!this.dashboardWarned) {
          this.dashboardWarned = true;
          warn(`dashboard regen skipped — agent-state bundle not found at ${this.bundleDir}`);
        }
        this.finishDashboardSpawn();
        return;
      }
      const proc = this.spawnDashboardProcess(["bun", script, "regen"], {
        env: { ...process.env, MF_INSTANCE_DIR: this.dir },
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      void proc.exited
        .then((code) => {
          if (code !== 0) warn(`dashboard regen exited ${code}`);
        })
        .catch(() => {})
        .finally(() => {
          this.finishDashboardSpawn();
        });
    } catch (err) {
      warn(`dashboard regen failed: ${err instanceof Error ? err.message : String(err)}`);
      this.finishDashboardSpawn();
    }
  }

  /** Clears the running flag and, if anything arrived meanwhile, re-arms the debounce ONCE. */
  private finishDashboardSpawn(): void {
    this.dashboardRegenRunning = false;
    if (this.dashboardRegenPending) {
      this.dashboardRegenPending = false;
      this.scheduleDashboardSpawn();
    }
  }
}

/**
 * The degraded mode: a transient in-process store with the same surface as
 * the DB layer, used only while the DB is unavailable.
 */
class MemoryProposals {
  private readonly byId = new Map<string, ProposalRecord>();
  private nextDisplayIdCounter = 1;

  get(id: string): ProposalRecord | null {
    const r = this.byId.get(id);
    return r ? { ...r } : null;
  }

  createIntake(
    id: string,
    verb: ProposalVerb,
    url: string,
    section: string | null,
    why: string,
    proposer: string,
  ): void {
    if (this.byId.has(id)) return;
    this.byId.set(id, {
      id,
      phase: "intake",
      verb,
      url,
      section,
      why,
      proposer,
      displayId: null,
      ratification: null,
      applied: null,
      posted: null,
    });
  }

  markValidated(id: string): void {
    const r = this.byId.get(id);
    if (r === undefined || r.phase !== "intake") return;
    r.phase = "validated";
  }

  markSurfaced(id: string): number | null {
    const r = this.byId.get(id);
    if (r === undefined || r.phase !== "validated") return null;
    const displayId = this.nextDisplayIdCounter++;
    r.phase = "surfaced";
    r.displayId = displayId;
    return displayId;
  }

  recordSummary(_id: string, _summaryText: string): void {
    // Memory mode keeps no notes/summary text — degraded durability only,
    // matching the phase/id fields, which ARE kept (see get()).
  }

  markDeclined(id: string): void {
    const r = this.byId.get(id);
    if (r === undefined) return;
    if (r.phase !== "intake" && r.phase !== "validated") return;
    r.phase = "declined";
  }

  // ── The ratification gate in degraded mode: FAIL CLOSED ──────────────────
  //
  // This is a deliberate inversion of this file's fail-SOFT posture, and the
  // one place the inversion is correct. Everywhere else, "state is memory, not
  // authority" means a broken DB degrades gracefully rather than blocking
  // Atlas. But a ratification is not memory — it is the AUDIT RECEIPT that
  // authorises a public, irreversible-ish effect on someone else's plan
  // (constitution rules 1 and 4). Recording it somewhere that evaporates on
  // restart, and then acting on it, would mean an effect landed with no
  // surviving evidence of who authorised it.
  //
  // So in degraded mode the gate does not transition and mints nothing. The
  // proposal stays `surfaced`, the principal gets a templated "state is
  // degraded, ratification not recorded" reply, and the SAME verb works again
  // once the DB is back. Fail-closed AND recoverable — the item is not lost,
  // it is simply not actioned on an audit trail that does not exist.

  // NOTE there is deliberately no `findSurfacedByDisplayId` here (issue #6,
  // finding 2). "Is proposal #3 currently awaiting a decision?" is a question
  // about DURABLE state, and a store that cannot see durable state has no
  // honest answer to it — least of all `null`, which the caller cannot tell
  // apart from "there is no such proposal". Answering that question is
  // therefore lifted to `AtlasProposals.lookupSurfacedByDisplayId`, which
  // returns `unavailable` whenever this class is the one being consulted.

  /** No durable event log in degraded mode — nothing has been "seen". */
  hasSeenGateMessage(): boolean {
    return false;
  }

  /**
   * Always `false` — the owned-thread registry is FAIL-CLOSED in degraded
   * mode, on the same reasoning as the ratification block above and with a
   * sharper edge. This table is an ADMISSION input: an in-memory copy would
   * widen what Atlas acts on using state that evaporates on restart, and the
   * failure it produces is the exact one atlas#22 exists to remove — a thread
   * Atlas invited a reply into and can no longer hear. `runtime.ts` closes the
   * loop from the other side: it never REQUESTS a thread while the store is
   * not durable, so a degraded Atlas keeps the whole conversation in the bound
   * channel, where it can still be heard.
   */
  recordOwnedThread(): boolean {
    return false;
  }

  /** Always `false`: a thread this store cannot remember is one it must not admit. */
  isOwnedThread(): boolean {
    return false;
  }

  /** Always `null`: no durable ratification is possible here. See the block comment above. */
  markRatified(): StoredRatification | null {
    return null;
  }

  /** Always `null`: no certificate can be minted from a store that does not persist. */
  readRatification(): StoredRatification | null {
    return null;
  }

  /** Always `false`: a decline is a recorded decision too, and this store records nothing durable. */
  markDeclinedByRatifier(): boolean {
    return false;
  }

  /** Always `false`: unreachable in practice (no certificate can exist for a memory row). */
  markApplied(): boolean {
    return false;
  }

  /** Always `false`: a receipt this store cannot keep is a receipt it must not claim. */
  markPosted(): boolean {
    return false;
  }

  /**
   * Always `true` — and note which way round that is. This method answers "may
   * I skip announcing?", so the FAIL-CLOSED answer is "yes, treat it as already
   * announced". `false` would authorise a ✅ post whose announcement this store
   * cannot record, and the next pass would post it again, and the next: an
   * effect loop driven by the absence of durability. (`watch.ts` also refuses
   * to run at all while the store is degraded; this is the second lock.)
   */
  hasAnnouncedCompletion(): boolean {
    return true;
  }

  /** Nothing durable to record — see `recordGateEvent` above. */
  recordCompletionAnnounced(): void {
    // deliberately empty; degraded mode records nothing.
  }

  /** atlas#28: nothing durable to cache in degraded mode — the status CLI reads storage directly anyway. */
  recordPlanBodyCache(): void {
    // deliberately empty
  }

  /** atlas#28: see `recordPlanBodyCache` above. */
  recordLinkedIssueTitle(): void {
    // deliberately empty
  }

  /** atlas#28: see `recordPlanBodyCache` above. */
  recordWatchPass(): void {
    // deliberately empty
  }

  // ── W3a in degraded mode: every answer is the one that CAUSES NO POST ─────
  //
  // `reconcile.ts` refuses the whole pass while the store is degraded, so none
  // of these are reachable from it. They are written fail-closed anyway,
  // because "unreachable" is a claim about today's call graph and the ledger's
  // integrity should not rest on one. Note which way round each is: the
  // question is always answered so that reconcile stays SILENT.

  /** `true`: a post may already have landed. Never re-post on a guess. */
  hasLedgerPostUnrecorded(): boolean {
    return true;
  }

  /** `true`: treat every drift as already covered. Silence over duplication. */
  hasReconcileCatchUp(): boolean {
    return true;
  }

  /** Nothing is parked where this store can see it. */
  appliedUnposted(): ProposalRecord[] {
    return [];
  }

  /** Degraded mode keeps no durable queue to draw a dashboard from. */
  recentProposals(): ProposalRecord[] {
    return [];
  }

  /** No durable announcement to cross-check. */
  completionAnnouncement(): { messageId: string; ts: number } | null {
    return null;
  }

  /** No durable ledger history. */
  lastLedgerEntryTs(): number | null {
    return null;
  }

  /** No accounted-for revisions — and no way to report on one either. */
  observedPlanRevisions(): Set<string> {
    return new Set<string>();
  }

  /** No durable baseline — a degraded store cannot classify a checkbox diff. */
  lastAccountedPlanRevision(): { revision: string; normalized: string } | null {
    return null;
  }

  /**
   * `false` — i.e. "always defer, never report". Unreachable via
   * `reconcile.ts` (it refuses the whole pass while degraded), but the same
   * "every answer is the one that causes no post" posture as its W3a siblings.
   */
  hasDeferredChecklistRevision(): boolean {
    return false;
  }

  recordDeferredChecklistRevision(): void {
    // deliberately empty; degraded mode records nothing.
  }

  /**
   * `true` — i.e. "not the first pass". The first-pass branch is the one that
   * SUPPRESSES revision drift, and a degraded store must not be able to claim
   * a baseline it cannot store; claiming the pass is a later one keeps the
   * baseline unwritten rather than falsely recorded.
   */
  hasReconciled(): boolean {
    return true;
  }

  recordLedgerPostUnrecorded(): void {
    // deliberately empty; degraded mode records nothing.
  }

  recordReconcileCatchUp(): void {
    // deliberately empty; degraded mode records nothing.
  }

  recordReconcilePass(): void {
    // deliberately empty; degraded mode records nothing.
  }

  countEventTypes(): Record<string, number> {
    return {};
  }

  countResolvedReasons(): Record<string, number> {
    return {};
  }

  countCatchUpPosts(): number {
    return 0;
  }

  sumReconcileDrift(): number {
    return 0;
  }

  recordGateEvent(): void {
    // Audit events are durable-or-nothing; degraded mode drops them rather
    // than pretending. The caller's stderr warning from `AtlasProposals.run`
    // is the operator-visible signal that the store degraded.
  }
}

/**
 * The answer to "is display id N currently awaiting a decision?".
 *
 * Three-valued ON PURPOSE (issue #6, finding 2). The old two-valued
 * `ProposalRecord | null` collapsed two facts a caller must not confuse:
 *   - `absent`      — storage was read, and no proposal with that number is
 *                     awaiting a decision. An assertion about the queue.
 *   - `unavailable` — storage could not be read at all. An assertion about
 *                     ATLAS, and about nothing else. Answering `absent` here
 *                     told the principal "no proposal with that number is
 *                     currently awaiting a decision. Nothing was changed."
 *                     about a row sitting in `waiting_human` on disk, and kept
 *                     saying it for every subsequent verb until restart.
 * Callers route `unavailable` to `stateDegradedReply`, never to
 * `nothingToRatifyReply`.
 */
export type SurfacedLookup =
  | { kind: "found"; record: ProposalRecord }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string };

/** What `AtlasProposals.degradation()` reports once durability has been lost. */
export interface StateDegradation {
  /** Epoch ms at which durable state stopped being readable. */
  readonly since: number;
  /** The underlying error message, or why no store existed at start-up. */
  readonly reason: string;
  /** How many storage failures have been observed (0 = never had a store). */
  readonly storageFailures: number;
}

/**
 * What callers actually hold: DB-authoritative reads/writes with the
 * inverted fail-soft (state is memory, not authority) — identical posture to
 * escort's EscortSessions.
 */
export class AtlasProposals {
  private db: AtlasStateStore | null;
  private memory: MemoryProposals | null;
  private degradedSince: number | null;
  private degradedReason: string | null;
  private storageFailures = 0;

  constructor(db: AtlasStateStore | null) {
    this.db = db;
    this.memory = db === null ? new MemoryProposals() : null;
    // A store that never had a DB is degraded from birth, not "empty". It
    // cannot see the durable queue either, and must say so rather than report
    // every proposal as absent.
    this.degradedSince = db === null ? Date.now() : null;
    this.degradedReason =
      db === null ? "no durable state store was available at start-up" : null;
  }

  /** True while durable storage is readable. The gate's honesty hinges on it. */
  isDurable(): boolean {
    return this.db !== null;
  }

  /**
   * Non-null once durability has been lost — the machine-readable form of the
   * stderr line `run` emits, for a health surface / status command to report.
   * Degradation is still PERMANENT until restart (this class deliberately does
   * not reopen the DB: an automatic retry loop against a genuinely failing
   * disk is its own hazard, and re-acquiring the ability to act must be an
   * explicit, supervised event on the trust path). Making it observable is the
   * part that was missing.
   */
  degradation(): StateDegradation | null {
    if (this.degradedSince === null || this.degradedReason === null) return null;
    return {
      since: this.degradedSince,
      reason: this.degradedReason,
      storageFailures: this.storageFailures,
    };
  }

  get(id: string): ProposalRecord | null {
    return this.run(
      (db) => db.get(id),
      (m) => m.get(id),
    );
  }

  createIntake(
    id: string,
    verb: ProposalVerb,
    url: string,
    section: string | null,
    why: string,
    proposer: string,
  ): void {
    this.run(
      (db) => db.createIntake(id, verb, url, section, why, proposer),
      (m) => m.createIntake(id, verb, url, section, why, proposer),
    );
  }

  markValidated(id: string, issueOpen: boolean): void {
    this.run(
      (db) => db.markValidated(id, issueOpen),
      (m) => m.markValidated(id),
    );
  }

  markSurfaced(id: string): number | null {
    return this.run(
      (db) => db.markSurfaced(id),
      (m) => m.markSurfaced(id),
    );
  }

  recordSummary(id: string, summaryText: string): void {
    this.run(
      (db) => db.recordSummary(id, summaryText),
      (m) => m.recordSummary(id, summaryText),
    );
  }

  markDeclined(id: string, failedCheck: string): void {
    this.run(
      (db) => db.markDeclined(id, failedCheck),
      (m) => m.markDeclined(id),
    );
  }

  // ── W2b, the ratification gate (issue #3) ────────────────────────────────

  /**
   * The gate's lookup. Three-valued so "I cannot see storage" is never
   * delivered to the principal as "no such proposal" (issue #6, finding 2).
   *
   * Durability is checked BOTH SIDES of the read, and both checks are load
   * bearing:
   *   - BEFORE, because a store that is already degraded (or never had a DB)
   *     would otherwise answer out of an empty in-memory map;
   *   - AFTER, because `run` degrades on a throw and then FALLS THROUGH to the
   *     memory branch, so the very call that broke durability returns a `null`
   *     that looks exactly like a clean miss. That fall-through is the whole
   *     mechanism of the reported bug.
   */
  lookupSurfacedByDisplayId(displayId: number): SurfacedLookup {
    const before = this.unavailable();
    if (before !== null) return before;
    const record = this.run<ProposalRecord | null>(
      (db) => db.findSurfacedByDisplayId(displayId),
      // Not consulted: a degraded store's honest answer is `unavailable`, and
      // the check below turns this `null` into exactly that.
      () => null,
    );
    const after = this.unavailable();
    if (after !== null) return after;
    return record === null ? { kind: "absent" } : { kind: "found", record };
  }

  private unavailable(): { kind: "unavailable"; reason: string } | null {
    if (this.db !== null) return null;
    return { kind: "unavailable", reason: this.degradedReason ?? "durable state is unreadable" };
  }

  hasSeenGateMessage(messageId: string): boolean {
    return this.run(
      (db) => db.hasSeenGateMessage(messageId),
      (m) => m.hasSeenGateMessage(),
    );
  }

  // ── The owned-thread registry (atlas#22 + atlas#25) ──────────────────────

  /**
   * Record a thread Atlas opened. `false` when it was not durably stored —
   * a malformed id, a degraded store, or a storage failure. The caller
   * (`runtime.ts`) treats `false` as "do not converse in that thread": a
   * thread Atlas cannot remember is a thread it will be deaf in, and it must
   * not invite a reply there.
   */
  recordOwnedThread(threadId: string, taskId: string, now?: number): boolean {
    return this.run(
      (db) => db.recordOwnedThread(threadId, taskId, now ?? Date.now()),
      (m) => m.recordOwnedThread(),
    );
  }

  /**
   * Is this inbound channel id a thread Atlas opened? The second half of
   * `runtime.ts`'s admission union.
   *
   * A degraded store answers `false` — deliberately, and it is the safe
   * direction: admission NARROWS to the configured channel (which is exactly
   * pre-atlas#22 behaviour), never widens, when Atlas cannot read its own
   * record of what it opened.
   */
  isOwnedThread(threadId: string): boolean {
    return this.run(
      (db) => db.isOwnedThread(threadId),
      (m) => m.isOwnedThread(),
    );
  }

  /** See `AtlasStateStore.markRatified` — the authority-only ratify transition. */
  markRatified(id: string, authority: GateAuthority): StoredRatification | null {
    return this.run(
      (db) => db.markRatified(id, authority),
      (m) => m.markRatified(),
    );
  }

  /** Satisfies `RatificationReader` — the port `requireRatification` reads through. */
  readRatification(id: string): StoredRatification | null {
    return this.run(
      (db) => db.readRatification(id),
      (m) => m.readRatification(),
    );
  }

  markDeclinedByRatifier(id: string, decliner: GateAuthority, reason: string): boolean {
    return this.run(
      (db) => db.markDeclinedByRatifier(id, decliner, reason),
      (m) => m.markDeclinedByRatifier(),
    );
  }

  /** See `AtlasStateStore.markApplied` — the certificate-only apply transition. */
  markApplied(
    cert: RatificationCertificate,
    expectedRatifier: ConfiguredRatifier,
    receipt: AppliedReceipt | null = null,
  ): boolean {
    return this.run(
      (db) => db.markApplied(cert, expectedRatifier, receipt),
      (m) => m.markApplied(),
    );
  }

  /** See `AtlasStateStore.markPosted` — the certificate-only ledger-receipt transition. */
  markPosted(
    cert: RatificationCertificate,
    expectedRatifier: ConfiguredRatifier,
    receipt: PostedReceipt,
  ): boolean {
    return this.run(
      (db) => db.markPosted(cert, expectedRatifier, receipt),
      (m) => m.markPosted(),
    );
  }

  /** See `AtlasStateStore.hasAnnouncedCompletion`. Degraded mode answers `true` (fail closed). */
  hasAnnouncedCompletion(issueUrl: string): boolean {
    return this.run(
      (db) => db.hasAnnouncedCompletion(issueUrl),
      (m) => m.hasAnnouncedCompletion(),
    );
  }

  /** See `AtlasStateStore.recordCompletionAnnounced`. */
  recordCompletionAnnounced(issueUrl: string, messageId: string): void {
    this.run(
      (db) => db.recordCompletionAnnounced(issueUrl, messageId),
      (m) => m.recordCompletionAnnounced(),
    );
  }

  // ── atlas#28: written from `watch.ts`'s already-scheduled pass; read back
  // read-only by the `atlas status` CLI via `AtlasStateStore.openReadOnly`.

  /** See `AtlasStateStore.recordPlanBodyCache`. */
  recordPlanBodyCache(body: string, revision: string): void {
    this.run(
      (db) => db.recordPlanBodyCache(body, revision),
      (m) => m.recordPlanBodyCache(),
    );
  }

  /** See `AtlasStateStore.recordLinkedIssueTitle`. */
  recordLinkedIssueTitle(url: string, title: string): void {
    this.run(
      (db) => db.recordLinkedIssueTitle(url, title),
      (m) => m.recordLinkedIssueTitle(),
    );
  }

  /** See `AtlasStateStore.recordWatchPass`. */
  recordWatchPass(ts?: number): void {
    this.run(
      (db) => db.recordWatchPass(ts),
      (m) => m.recordWatchPass(),
    );
  }

  recordGateEvent(type: string, payload: Record<string, unknown>): void {
    this.run(
      (db) => db.recordGateEvent(type, payload),
      (m) => m.recordGateEvent(),
    );
  }

  // ── W3a, the reconcile loop (issue #2) ───────────────────────────────────
  // Thin pass-throughs; every degraded answer is the fail-closed one — see
  // `MemoryProposals`'s W3a block for which way round each of them is.

  /** See `AtlasStateStore.recordLedgerPostUnrecorded` — THE double-post marker. */
  recordLedgerPostUnrecorded(workItemId: string, messageId: string): void {
    this.run(
      (db) => db.recordLedgerPostUnrecorded(workItemId, messageId),
      (m) => m.recordLedgerPostUnrecorded(),
    );
  }

  /** See `AtlasStateStore.hasLedgerPostUnrecorded`. Degraded answers `true`. */
  hasLedgerPostUnrecorded(workItemId: string): boolean {
    return this.run(
      (db) => db.hasLedgerPostUnrecorded(workItemId),
      (m) => m.hasLedgerPostUnrecorded(),
    );
  }

  /** Work items parked in `applied` — the recovery population. */
  appliedUnposted(limit?: number): ProposalRecord[] {
    return this.run(
      (db) => db.appliedUnposted(limit),
      (m) => m.appliedUnposted(),
    );
  }

  /** Every live proposal, newest first — the dashboard's work-item half. */
  recentProposals(limit?: number): ProposalRecord[] {
    return this.run(
      (db) => db.recentProposals(limit),
      (m) => m.recentProposals(),
    );
  }

  completionAnnouncement(issueUrl: string): { messageId: string; ts: number } | null {
    return this.run(
      (db) => db.completionAnnouncement(issueUrl),
      (m) => m.completionAnnouncement(),
    );
  }

  lastLedgerEntryTs(): number | null {
    return this.run(
      (db) => db.lastLedgerEntryTs(),
      (m) => m.lastLedgerEntryTs(),
    );
  }

  observedPlanRevisions(limit?: number): Set<string> {
    return this.run(
      (db) => db.observedPlanRevisions(limit),
      (m) => m.observedPlanRevisions(),
    );
  }

  lastAccountedPlanRevision(): { revision: string; normalized: string } | null {
    return this.run(
      (db) => db.lastAccountedPlanRevision(),
      (m) => m.lastAccountedPlanRevision(),
    );
  }

  hasDeferredChecklistRevision(revision: string): boolean {
    return this.run(
      (db) => db.hasDeferredChecklistRevision(revision),
      (m) => m.hasDeferredChecklistRevision(),
    );
  }

  recordDeferredChecklistRevision(revision: string): void {
    this.run(
      (db) => db.recordDeferredChecklistRevision(revision),
      (m) => m.recordDeferredChecklistRevision(),
    );
  }

  hasReconciled(): boolean {
    return this.run(
      (db) => db.hasReconciled(),
      (m) => m.hasReconciled(),
    );
  }

  /** See `AtlasStateStore.hasReconcileCatchUp` — the convergence mechanism. */
  hasReconcileCatchUp(driftKey: string): boolean {
    return this.run(
      (db) => db.hasReconcileCatchUp(driftKey),
      (m) => m.hasReconcileCatchUp(),
    );
  }

  recordReconcileCatchUp(driftKey: string, messageId: string): void {
    this.run(
      (db) => db.recordReconcileCatchUp(driftKey, messageId),
      (m) => m.recordReconcileCatchUp(),
    );
  }

  recordReconcilePass(
    driftCount: number,
    planRevision: string | null,
    planRevisionNormalized: string | null,
    catchUpMessageId: string | null,
  ): void {
    this.run(
      (db) => db.recordReconcilePass(driftCount, planRevision, planRevisionNormalized, catchUpMessageId),
      (m) => m.recordReconcilePass(),
    );
  }

  countEventTypes(fromTs: number, toTs: number): Record<string, number> {
    return this.run(
      (db) => db.countEventTypes(fromTs, toTs),
      (m) => m.countEventTypes(),
    );
  }

  countResolvedReasons(fromTs: number, toTs: number): Record<string, number> {
    return this.run(
      (db) => db.countResolvedReasons(fromTs, toTs),
      (m) => m.countResolvedReasons(),
    );
  }

  countCatchUpPosts(fromTs: number, toTs: number): number {
    return this.run(
      (db) => db.countCatchUpPosts(fromTs, toTs),
      (m) => m.countCatchUpPosts(),
    );
  }

  sumReconcileDrift(fromTs: number, toTs: number): number {
    return this.run(
      (db) => db.sumReconcileDrift(fromTs, toTs),
      (m) => m.sumReconcileDrift(),
    );
  }

  close(): void {
    this.db?.close();
  }

  private run<T>(dbFn: (db: AtlasStateStore) => T, memFn: (m: MemoryProposals) => T): T {
    if (this.db !== null) {
      try {
        return dbFn(this.db);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.storageFailures += 1;
        this.degradedSince = Date.now();
        this.degradedReason = reason;
        // Loud on purpose (issue #6 item 3). The old line read like a routine
        // fallback; what actually happened is that the ratification gate is now
        // shut for the lifetime of the process, so the operator needs to see
        // the consequence, not just the cause.
        warn(
          `DEGRADED — durable state is unreadable and this process will NOT recover ` +
            `until restart. The ratification gate now refuses every RATIFY/DECLINE, ` +
            `mints no certificates, and records no audit events. Cause: ${reason}`,
        );
        this.db.close();
        this.db = null;
        this.memory = new MemoryProposals();
      }
    }
    return memFn(this.memory as MemoryProposals);
  }
}

/**
 * Resolve instance + bundle dirs from the environment and open the store.
 *   ATLAS_STATE_DIR        → instance dir (default ~/.config/cortex/agents/atlas)
 *   ATLAS_AGENT_STATE_DIR  → agent-state bundle root (default arc install path)
 * Never throws; `null` = run memory-only.
 */
export function openAtlasStateFromEnv(
  /** W3a: the plan-dashboard redraw hook. See `AtlasStateOptions.onTransition`. */
  onTransition: (() => void) | null = null,
): AtlasStateStore | null {
  const dirEnv = process.env.ATLAS_STATE_DIR;
  const bundleEnv = process.env.ATLAS_AGENT_STATE_DIR;
  return AtlasStateStore.open({
    dir: dirEnv !== undefined && dirEnv.length > 0 ? dirEnv : defaultInstanceDir(),
    bundleDir: bundleEnv !== undefined && bundleEnv.length > 0 ? bundleEnv : defaultBundleDir(),
    onTransition,
  });
}

function applyMigration(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const existing = db
    .query<{ version: string }, [string]>(`SELECT version FROM schema_migrations WHERE version = ?`)
    .get(MIGRATION_VERSION);
  if (!existing) {
    db.transaction(() => {
      db.exec(MIGRATION_0001);
      db.query(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(
        MIGRATION_VERSION,
        Date.now(),
      );
    })();
  }

  // Atlas-owned auxiliary index (atlas#8) — deliberately OUTSIDE the version
  // gate above, which tracks parity with agent-state's own schema only. Run
  // every open; `IF NOT EXISTS` makes it a no-op after the first. The
  // backfill runs exactly once, the moment the table is first created.
  const hadReplayTable =
    db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gate_replay_keys'`,
      )
      .get() !== null;
  db.exec(GATE_REPLAY_KEYS_SCHEMA);
  if (!hadReplayTable) {
    db.transaction(() => {
      backfillGateReplayKeys(db);
    })();
  }

  // The owned-thread registry (atlas#22/#25) — same terms as the table above:
  // Atlas-owned, outside the agent-state version gate, `IF NOT EXISTS` every
  // open. There is nothing to backfill: before this table existed Atlas owned
  // no threads, so an empty table is the accurate history, not a gap.
  //
  // NOTE this runs from `applyMigration`, which is on the READ-WRITE open path
  // ONLY — `openReadOnly` (atlas#28) constructs the store without it, because a
  // read-only handle cannot `CREATE TABLE` at all. That is why the status CLI
  // can open a DB this table has never touched: it never gets here, and it
  // never queries `owned_threads` either (admission is a daemon concern). Both
  // halves are pinned by a test in `state.test.ts`.
  db.exec(OWNED_THREADS_SCHEMA);

  // atlas#28's status cache — same "outside the version gate, IF NOT EXISTS"
  // posture as the replay-key table above. Nothing to backfill: an empty
  // cache just means the status CLI's ledger view has nothing yet, which it
  // already has to report honestly (no watcher pass has ever landed).
  db.exec(PLAN_STATUS_CACHE_SCHEMA);
}
