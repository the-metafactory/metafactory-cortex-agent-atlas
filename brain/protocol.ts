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
 *   - `post_log` — Atlas declares no `presence.discord.logChannelId`, so the
 *     host would refuse it `cant_do`. `log` covers diagnostics.
 *   - `compose` — the hybrid voice is W3b (issue #3), not this slice. The
 *     manifest carries the opt-in; the brain does not use it yet, which is
 *     exactly spec §8's "the full loop runs with compose disabled".
 *
 * Adding one later is additive on the wire; leaving them out keeps the audit
 * surface of "what can Atlas ask the host to do" to three verbs: `post`,
 * `create_private_thread` and `log`, plus the mandatory `result`.
 *
 * ── `create_private_thread` — spoken since atlas#22/#25 ────────────────────
 * It is the ONLY route by which Atlas can ever hear a reply typed in a thread
 * (see `TaskSource` below: the shipped adapter sends no parent-channel signal,
 * so "a thread under my channel" is not a question this protocol can answer —
 * "a thread I opened, and durably recorded opening" is). The effect names no
 * channel; the host derives the parent from the agent's OWN
 * `presence.discord.agentChannelId` binding, so speaking it cannot widen the
 * one-channel universe by construction.
 *
 * THREE facts about the shipped host, verified against cortex and recorded
 * here because each one bounds what this pack can claim:
 *
 *   1. The effect is wired ONLY for agents flagged `openOnboarding: true`
 *      (cortex `src/runner/brain-consumer-boot.ts`: `wireCreatePrivateThread =
 *      isOpenOnboarding && discordAgentChannelId !== undefined`). Atlas is not
 *      anon-reachable and must not become so to buy a thread, so on today's
 *      cortex every `create_private_thread` Atlas emits comes back
 *      `effect_rejected`/`cant_do`. `runtime.ts` treats that as a first-class
 *      outcome — it falls back to conversing in the bound channel, exactly as
 *      before this slice — rather than as an error.
 *   2. There is no PUBLIC-thread variant on this protocol. cortex ships
 *      `create_private_thread` and nothing else, and the Discord adapter
 *      creates `ChannelType.PrivateThread`. atlas#25 records a preference for
 *      a PUBLIC thread; that preference cannot be expressed here, which is why
 *      the request is opt-in and OFF by default (`EffectsConfig.
 *      threadConversation`) rather than silently shipping the other choice.
 *   3. A `post` on a task whose thread has been created is RETARGETED into
 *      that thread by the host (cortex#2248, `onThreadCreated`), before the
 *      brain even sees `thread_created`. So conversation follows the thread
 *      automatically — and a LEDGER entry on such a task cannot be steered
 *      back to the parent channel by any means this protocol offers.
 *      `transport.ts` refuses it rather than writing the ledger somewhere
 *      else; see its header.
 */

export const V = 1 as const;

// ── Cortex → brain events ───────────────────────────────────────────────────

/**
 * Where a task originated. This block is the CANONICAL statement of what each
 * field actually is — atlas#22, atlas#24 and atlas#25 all found a prior
 * version of it overstating that, and all three now point HERE rather than
 * asserting their own paraphrase. Two things changed from the original claim
 * ("HOST-AUTHORITATIVE in every field") and both matter to how this brain
 * treats `source`.
 *
 * ── `channel` is NOT a parent channel id (atlas#22) ─────────────────────────
 * The original comment claimed "a threaded message carries the thread
 * separately in `thread`", implying `channel` stays the parent. That is false
 * for the shipped adapter: `metafactory-cortex-adapter-discord/src/index.ts`
 * sets `channelId: channel.id` where `channel = message.channel` — for a
 * message posted IN A THREAD, `channel.id` is the THREAD's own snowflake, and
 * cortex passes it straight through as `source.channel`
 * (`buildBrainTaskPayload`/`deriveTaskSource` set `thread` to the SAME value).
 * So today there is NO parent-channel signal on the wire at all: `channel` and
 * `thread` are the same id whenever the message came from a thread, and a
 * consumer that needs "is this the bound channel OR a thread under it" cannot
 * answer that from this event — it would need a reliable parent signal the
 * adapter does not currently send.
 *
 * ── What `runtime.ts` therefore admits (atlas#22 + atlas#25) ────────────────
 * `channel` is treated as an OPAQUE, EXACT-MATCH id — it is never parsed,
 * never assumed to be a parent, never derived from. Admission is the union of
 * exactly two config/state-pinned sets:
 *
 *   1. the ONE configured ledger channel (`EffectsConfig.channelId`), and
 *   2. a thread ATLAS ITSELF OPENED and durably recorded opening — the
 *      owned-thread registry in `state.ts` (`owned_threads`), written only
 *      from a host-resolved `thread_created` id that Atlas correlated to its
 *      own `create_private_thread` request.
 *
 * The second set is not a relaxation of the first: membership is decided by
 * Atlas's own write record, never by anything on this event. A thread Atlas
 * did not open — including one opened by the principal directly under the
 * bound channel — is refused exactly as any foreign channel is, in silence,
 * because this event carries nothing that could distinguish it from a thread
 * in a room Atlas has never heard of. That is the whole reason atlas#22's
 * "admit a thread whose parent is the bound channel" option does not exist.
 *
 * ── "HOST-AUTHORITATIVE" describes cortex's INTENT, not a wire guarantee
 *    (atlas#24) ──────────────────────────────────────────────────────────────
 * On the path this protocol was DESIGNED around — a real inbound surface
 * message — every field here does come from authenticated platform data:
 * cortex's `dispatchInboundToBrain` builds the task from an `InboundMessage`
 * (`user` ← `authorId`, `surface` ← `platform`, `channel`/`thread` ← the
 * adapter's own ids, `adapter_instance` ← the live adapter connection's own
 * `instanceId`), and publishes it onto the `brain.>` subject family this
 * brain's `task` events arrive on.
 *
 * But nothing downstream of that publish re-checks WHERE a `task` event on
 * that subject actually came from. Verified directly against cortex: the
 * consumer that turns a bus envelope into this exact shape
 * (`deriveTaskSource`, `src/bus/brain-consumer.ts`) reads
 * `payload.response_routing`/`payload.user` VERBATIM off whatever envelope it
 * is handed, with no check on who published it, and the daemon's own bus
 * credential for that subject is minted with no narrower `pub` scope
 * (cortex's `network-make-live-adapters.ts` → arc's `nats add-bot`, no
 * `--pub`/`--sub`) — nor does any account-level default restrict a second bot
 * under the same agents account. So a `task` event carrying this shape is, on
 * the wire, exactly as trustworthy as "some bus-authenticated publisher chose
 * to send it" — no more.
 *
 * Consequence for THIS brain: `surface`/`channel`/`user` are treated as
 * ADMITTED-BY-CONFIG, never as self-authenticating — see `runtime.ts`'s
 * `serveTask` (channel admission) and `effects/config.ts` (the
 * `trustedAdapterInstances` check on `adapter_instance`, atlas#24). Neither
 * check is cryptographic; both are the deployment saying, in config, which
 * channel and which adapter connection it will act on. The open question
 * neither check can close — whether NATS subject permissions restrict who can
 * publish onto `brain.>` at all — is a bus/deployment question outside this
 * repo, recorded rather than assumed (see atlas#24's disposition).
 */
export interface TaskSource {
  surface: string;
  channel: string;
  thread: string;
  user: string;
  /**
   * Set by cortex only on a genuine live-surface task (the real adapter
   * connection's own `instanceId`) — absent is normal for anything else that
   * could reach this subject. NOT independently authenticated on the wire (see
   * above): this brain's own admission check is what gives it meaning.
   */
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

/**
 * The answer to a `create_private_thread` (cortex#2206), correlated by
 * `task_id`. `thread_id` is the HOST-RESOLVED platform id — the brain never
 * chose it, and it is the ONLY value Atlas ever writes into its owned-thread
 * registry. There is no failure variant: a refused or failed create comes back
 * as `effect_rejected` with `effect: "create_private_thread"`.
 *
 * By the time this arrives the host has ALREADY retargeted the task's
 * conversation into the thread (cortex#2248) — so a `post` emitted on seeing
 * this event lands in the thread, never racing the parent channel.
 */
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

/**
 * `create_private_thread` — ask the host to open a thread off the AGENT'S OWN
 * bound channel and put people in it (cortex#2206). Mirrors the shipped wire
 * shape exactly (cortex `src/brain/protocol.ts`,
 * `CreatePrivateThreadEffectSchema`).
 *
 * Deliberately carries NO channel field, and that absence is the security
 * property, not an omission: the host derives the parent from
 * `presence.discord.agentChannelId`, so this effect cannot open a thread
 * anywhere Atlas is not already bound — there is no field here to point
 * somewhere else even if this code wanted to.
 *
 * `members` is the real shipped wire type (`"source" | string[]`), left OPEN
 * to match cortex rather than narrowed. Atlas's own USAGE stays narrower than
 * the type permits: `runtime.ts` only ever constructs the literal `"source"`,
 * which the host resolves SERVER-SIDE to the triggering task's own recorded
 * source user — never to anything this brain put on the wire, and never to
 * anything read out of a message body.
 *
 * `name` is Atlas-generated (`Proposal #<n>`) — a display id this brain minted
 * itself. Message text never reaches it; see `runtime.ts`'s `threadName`.
 */
export type CreateThreadMembers = "source" | string[];

export interface CreateThreadEffect {
  v: 1;
  type: "create_private_thread";
  task_id: string;
  /** Host truncates to Discord's 100-char cap; Atlas stays far under it. */
  name: string;
  members: CreateThreadMembers;
}

export type BrainEffect = PostEffect | ResultEffect | LogEffect | CreateThreadEffect;

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
