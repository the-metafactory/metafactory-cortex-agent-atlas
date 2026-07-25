/**
 * `cortex-brain/v1` — the BRAIN'S half of the wire protocol.
 *
 * Deliberately a MINIMAL local implementation, not an import from cortex: a bot
 * pack runs against whatever cortex happens to be installed, so the only shared
 * contract is the WIRE FORMAT. cortex's `src/brain/protocol.ts` is the
 * normative spec; every shape below was reconciled against it (and against
 * `src/brain/daemon-brain-host.ts`, which is what actually enforces them).
 *
 * JSONL: one JSON object per line, every line `{ "v": 1, "type": … }`.
 *
 * ── The mirror rule ────────────────────────────────────────────────────────
 * cortex is TOLERANT about what a brain emits; a brain must be equally tolerant
 * about what cortex sends. `parseEventLine` returns `null` for an unknown type
 * or malformed JSON and the caller drops-and-logs — never a throw, never an
 * exit. A cortex on a newer minor that adds an event type must not be able to
 * kill this daemon.
 *
 * ── What Atlas deliberately does NOT speak ─────────────────────────────────
 * The effect union below is a SUBSET of the protocol's, and each omission is a
 * decision, not an oversight:
 *
 *   - `ask_principal` — Atlas's ratification gate is its OWN (`ratify.ts`):
 *     principal identity is resolved from Atlas's configured principal-map
 *     against the platform-authenticated author id, and the decision is
 *     durably certified before any effect. Routing that through the host's
 *     gate would put a second, differently-shaped authority on the trust path.
 *     One gate, one certificate discipline.
 *   - `dispatch` — Atlas commands no fleet work (`dispatch_capabilities: []`).
 *   - `create_private_thread` — Atlas's audience is one public channel.
 *   - `post_log` — Atlas declares no `presence.discord.logChannelId`, so the
 *     host would refuse it `cant_do`. `log` covers diagnostics.
 *   - `compose` — the hybrid voice is W3b (issue #3), not this slice. The
 *     manifest carries the opt-in; the brain does not use it yet, which is
 *     exactly spec §8's "the full loop runs with compose disabled".
 *
 * Adding one later is additive on the wire; leaving them out keeps the audit
 * surface of "what can Atlas ask the host to do" to two verbs: `post` and
 * `log`, plus the mandatory `result`.
 */

export const V = 1 as const;

// ── Cortex → brain events ───────────────────────────────────────────────────

/**
 * Where a task originated. HOST-AUTHORITATIVE in every field: `user` is the
 * platform-AUTHENTICATED author id (cortex's `buildBrainTaskPayload` sets it
 * from `InboundMessage.authorId`), and `channel` is the parent channel id (a
 * threaded message carries the thread separately in `thread`). Atlas's whole
 * trust root is `surface` + `user` — see `ratify.ts`'s file header.
 */
export interface TaskSource {
  surface: string;
  channel: string;
  thread: string;
  user: string;
  adapter_instance?: string;
}

export interface TaskEvent {
  v: 1;
  type: "task";
  /**
   * The host's correlation id for this unit of work — cortex sets it to the
   * inbound envelope's id (`brain-consumer.ts`: `const correlationId =
   * envelope.id`). It is therefore STABLE across a JetStream redelivery of the
   * same inbound message and DISTINCT between two different messages, which is
   * what makes it usable as Atlas's idempotency key. See `runtime.ts`.
   */
  task_id: string;
  capability: string;
  payload: Record<string, unknown>;
  source: TaskSource;
  /** Per-task lifecycle only; a daemon receives the persona once, in `hello`. */
  persona?: string;
}

/** A follow-up in an OPEN task's thread. */
export interface MessageEvent {
  v: 1;
  type: "message";
  task_id: string;
  text: string;
  user: string;
}

/** The answer to an `ask_principal`. Atlas never emits one — see the header. */
export interface GateVerdictEvent {
  v: 1;
  type: "gate_verdict";
  task_id: string;
  gate: string;
  verdict: "pass" | "fail";
  notes?: string;
  principal: string;
}

export interface CancelEvent {
  v: 1;
  type: "cancel";
  task_id: string;
}

export interface ShutdownEvent {
  v: 1;
  type: "shutdown";
  deadline_ms: number;
}

/**
 * cortex refused one of this brain's effects. Carries the WIDER host taxonomy
 * (the brain's three kinds plus `policy_denied` / `compliance_block`).
 *
 * Load-bearing for Atlas: it is the ONLY signal that a `post` did not leave the
 * host. See `transport.ts` — a ledger post that is rejected must not be allowed
 * to look like a post that landed.
 */
export interface EffectRejectedEvent {
  v: 1;
  type: "effect_rejected";
  task_id: string;
  effect: string;
  reason: { kind: string; detail: string; retry_after_ms?: number };
}

/** The daemon handshake, emitted once by the host after the socket authenticates. */
export interface HelloEvent {
  v: 1;
  type: "hello";
  persona: string;
  /** HOST-AUTHORITATIVE agent id. The brain never asserts its own. */
  agent: string;
  protocol: string;
}

export interface ThreadCreatedEvent {
  v: 1;
  type: "thread_created";
  task_id: string;
  thread_id: string;
}

export interface ComposedEvent {
  v: 1;
  type: "composed";
  task_id: string;
  compose_id: string;
  text: string;
}

export type BrainEvent =
  | TaskEvent
  | MessageEvent
  | GateVerdictEvent
  | CancelEvent
  | ShutdownEvent
  | EffectRejectedEvent
  | HelloEvent
  | ThreadCreatedEvent
  | ComposedEvent;

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "task",
  "message",
  "gate_verdict",
  "cancel",
  "shutdown",
  "effect_rejected",
  "hello",
  "thread_created",
  "composed",
]);

/**
 * Tolerant parse of ONE cortex → brain line. Unknown type, wrong protocol
 * version, or malformed JSON → `null` (drop-and-log at the caller). Never
 * throws.
 *
 * Note the SHAPE checks are deliberately shallow — this is the mirror rule, not
 * a validator. cortex encodes these lines from its own typed union and strips
 * stray keys before serialising, so the brain's job is to recognise the type
 * and tolerate everything else. Every field Atlas actually acts on is
 * re-validated where it is used (`runtime.ts` re-checks `source.user`,
 * `source.channel` and `payload.text` before either reaches a decision).
 */
export function parseEventLine(line: string): BrainEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== V || typeof obj.type !== "string") return null;
  if (!KNOWN_EVENT_TYPES.has(obj.type)) return null;
  return obj as unknown as BrainEvent;
}

// ── Brain → cortex effects ──────────────────────────────────────────────────

/**
 * `post` — cortex posts `text` to THE TASK'S OWN surface/thread.
 *
 * There is deliberately no channel field in the protocol: a brain cannot name a
 * target, the host derives it from the task's recorded source. Atlas's "one
 * channel, from config, never from content" rule therefore cannot be enforced
 * by this effect alone — it is enforced in `transport.ts`, which refuses to
 * emit a `post` at all unless the live task's source channel IS the configured
 * ledger channel.
 */
export interface PostEffect {
  v: 1;
  type: "post";
  task_id: string;
  text: string;
}

/**
 * `result` — closes the task. A `failed` result MUST carry a typed reason; a
 * `complete` one must not pretend to (cortex models this as a discriminated
 * union and REJECTS a `complete` carrying a `reason`).
 */
export type ResultEffect =
  | { v: 1; type: "result"; task_id: string; status: "complete"; summary?: string }
  | {
      v: 1;
      type: "result";
      task_id: string;
      status: "failed";
      reason: { kind: "cant_do" | "not_now" | "wont_do"; detail: string; retry_after_ms?: number };
    };

/** `log` — a diagnostic line; task-agnostic, never surfaced to the principal. */
export interface LogEffect {
  v: 1;
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  text: string;
}

export type BrainEffect = PostEffect | ResultEffect | LogEffect;

/** One effect → one JSONL line (no trailing newline). */
export function encodeEffectLine(effect: BrainEffect): string {
  return JSON.stringify(effect);
}

// ── Incremental JSONL decoder (chunked socket input) ────────────────────────

/**
 * Feeds arbitrary chunks in, yields COMPLETE lines out, buffering the partial
 * tail across calls. UTF-8 streaming, so a chunk boundary in the middle of a
 * multibyte codepoint is handled rather than corrupted — the socket splits
 * wherever the kernel decides, not where the JSON does.
 */
export class JsonlDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");

  push(chunk: Uint8Array | string): string[] {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.length > 0) lines.push(trimmed);
      idx = this.buffer.indexOf("\n");
    }
    return lines;
  }
}
