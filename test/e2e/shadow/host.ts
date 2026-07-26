/**
 * The cortex host double the shadow rehearsal drives Atlas through.
 *
 * This is the SAME shape as `brain/wiring.e2e.test.ts`'s `FakeCortexHost` — a
 * real unix socket, a real `bun brain/main.ts` subprocess, a real auth
 * handshake, cortex's own `buildEnv`/`collectBrainSecrets` env filter — with one
 * deliberate difference: the rehearsal does NOT fake `gh`. The brain it spawns
 * talks to a live GitHub through the audit shim, so everything below the socket
 * is production code against a real remote.
 *
 * Why a host double at all, rather than a real cortex? Because the rehearsal
 * needs a Discord surface it can inspect and can never mis-address, and cortex
 * would need a bot token, a guild and a channel to give it one. The `post`
 * effect is the whole ledger contract (`transport.ts`: the brain cannot name a
 * channel; the host derives the target from the task it owns), so a host that
 * records `post` effects observes exactly what a live channel would receive —
 * with none of the risk of a real channel id existing anywhere in this repo.
 * That is the "fully faked transport" half of the W4 brief; the plan repo is the
 * real half.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACK_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const MAIN = join(PACK_ROOT, "brain", "main.ts");

/** cortex's `RUNNER_OWNED_ENV_KEYS` — a declared secret may not shadow one. */
export const RUNNER_OWNED_ENV_KEYS = new Set(["PATH", "HOME", "LANG", "TMPDIR"]);

/** The names `agent.yaml` declares under `runtime.brain.secrets`. */
export function declaredSecrets(): string[] {
  const yaml = readFileSync(join(PACK_ROOT, "agent.yaml"), "utf8");
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^\s{4}secrets:\s*$/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s{6}-\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
    if (m !== null) {
      out.push(m[1]!);
      continue;
    }
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    break;
  }
  return out;
}

/**
 * cortex's `collectBrainSecrets` + `buildEnv`, faithfully: the brain sees the
 * four runner-owned keys, the socket vars, and NOTHING except the DECLARED names
 * present in the host's own environment.
 */
export function buildBrainEnv(opts: {
  hostEnv: Record<string, string>;
  socketPath: string;
  token: string;
  scratchDir: string;
  path: string;
  home: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: opts.path,
    HOME: opts.home,
    LANG: "en_US.UTF-8",
    TMPDIR: opts.scratchDir,
    CORTEX_BRAIN_SOCKET: opts.socketPath,
    CORTEX_BRAIN_SOCKET_TOKEN: opts.token,
    CORTEX_BRAIN_LIFECYCLE: "daemon",
  };
  for (const name of declaredSecrets()) {
    const value = opts.hostEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export interface HostEffect {
  type: string;
  [k: string]: unknown;
  /**
   * WHERE this effect landed, decided by the host exactly as cortex decides
   * it (atlas#22/#25). Set on `post` only: the task's own source channel,
   * unless that task has been RETARGETED into a thread the brain asked for
   * (cortex#2248), in which case it is the thread's id. The brain never names
   * it — that is the whole point of `PostEffect` having no channel field, and
   * a harness that let the brain choose would be validating a wire that does
   * not exist.
   */
  landedIn?: string;
}

/**
 * How the host answers a `create_private_thread` (cortex#2206). The default
 * models TODAY'S cortex for Atlas: `refuse`, because the effect is wired for
 * `openOnboarding` agents only (`brain-consumer-boot.ts`) and Atlas is not
 * one. `create` models the cortex the thread work is written against;
 * `silent` models a host that never answers at all.
 */
export type ThreadPolicy = "refuse" | "create" | "silent";

export class FakeCortexHost {
  readonly effects: HostEffect[] = [];
  readonly stderr: string[] = [];
  private server: ReturnType<typeof Bun.listen> | null = null;
  private conn: { write(d: string): number; end(): void } | null = null;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private buffer = "";
  private authed = false;
  readonly token = "token-fixture-0000";

  constructor(
    private readonly socketPath: string,
    private readonly env: Record<string, string>,
    /** The channel every task claims to come from — the configured ledger channel. */
    readonly channelId: string,
    /**
     * The adapter instance every task claims to come from. Must match one of
     * `ATLAS_TRUSTED_ADAPTER_INSTANCES` or admission refuses the task (atlas#24)
     * — the harness models a real adapter, and a real adapter always sends this.
     */
    readonly adapterInstance: string = "adapter-shadow-0000",
    /** How this host answers `create_private_thread`. See {@link ThreadPolicy}. */
    public threadPolicy: ThreadPolicy = "refuse",
  ) {}

  /** task id → the channel that task's messages came from (and posts go to). */
  private readonly taskChannel = new Map<string, string>();
  /** task id → the thread it was retargeted into, once one exists. */
  private readonly retargeted = new Map<string, string>();
  /** Threads this host has opened, in order. Fixture ids only, never live. */
  readonly threadsOpened: Array<{ taskId: string; threadId: string; name: string }> = [];
  private threadSeq = 0;

  async start(): Promise<void> {
    const self = this;
    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        open(s) {
          self.conn = s as unknown as { write(d: string): number; end(): void };
        },
        data(_s, chunk) {
          self.buffer += new TextDecoder().decode(chunk);
          let idx = self.buffer.indexOf("\n");
          while (idx !== -1) {
            const line = self.buffer.slice(0, idx);
            self.buffer = self.buffer.slice(idx + 1);
            if (line.length > 0) self.onLine(line);
            idx = self.buffer.indexOf("\n");
          }
        },
        close() {
          self.conn = null;
        },
        error() {
          self.conn = null;
        },
      },
    });

    this.proc = Bun.spawn(["bun", MAIN], {
      env: this.env,
      cwd: PACK_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    void (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      const stream = this.proc!.stderr as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of stream) {
        pending += decoder.decode(chunk as Uint8Array, { stream: true });
        let idx = pending.indexOf("\n");
        while (idx !== -1) {
          const line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          if (line.length > 0) this.stderr.push(line);
          idx = pending.indexOf("\n");
        }
      }
      if (pending.length > 0) this.stderr.push(pending);
    })();
    await this.waitFor(() => this.authed, 15_000, "brain never authenticated");
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const obj = parsed as HostEffect;
    if (!this.authed) {
      if (obj.type !== "auth" || obj.token !== this.token) {
        throw new Error("shadow host: the brain's first line was not a valid auth proof");
      }
      this.authed = true;
      return;
    }
    if (obj.type === "post") {
      // The host, not the brain, decides where a post lands: the task's own
      // source channel, unless the task has been retargeted into a thread.
      const taskId = String(obj.task_id ?? "");
      obj.landedIn = this.retargeted.get(taskId) ?? this.taskChannel.get(taskId) ?? "";
    }
    this.effects.push(obj);
    if (obj.type === "create_private_thread") this.answerThreadRequest(obj);
  }

  /**
   * cortex#2206 + cortex#2248, modelled faithfully: on success the host FIRST
   * retargets the task's conversation into the new thread, and only then tells
   * the brain the thread exists — so a post the brain emits on hearing
   * `thread_created` can never race back into the parent channel. A refusal
   * reuses the existing `effect_rejected` event; there is no bespoke failure
   * shape.
   */
  private answerThreadRequest(effect: HostEffect): void {
    const taskId = String(effect.task_id ?? "");
    if (this.threadPolicy === "silent") return;
    if (this.threadPolicy === "refuse") {
      this.send({
        v: 1,
        type: "effect_rejected",
        task_id: taskId,
        effect: "create_private_thread",
        reason: {
          kind: "cant_do",
          detail: `agent "atlas" has no thread-capable surface binding configured`,
        },
      });
      return;
    }
    this.threadSeq += 1;
    const threadId = `thread-shadow-${this.threadSeq}`;
    this.threadsOpened.push({ taskId, threadId, name: String(effect.name ?? "") });
    this.retargeted.set(taskId, threadId);
    this.send({ v: 1, type: "thread_created", task_id: taskId, thread_id: threadId });
  }

  send(event: Record<string, unknown>): void {
    this.conn?.write(`${JSON.stringify(event)}\n`);
  }

  hello(): void {
    this.send({
      v: 1,
      type: "hello",
      persona: "(persona)",
      agent: "atlas",
      protocol: "cortex-brain/v1",
    });
  }

  /** Deliver a surface message exactly as `buildBrainTaskPayload` shapes it. */
  task(taskId: string, text: string, user: string, channel = this.channelId): void {
    // Remember where this task came from, so a `post` riding it can be
    // attributed to a channel the same way cortex attributes it.
    this.taskChannel.set(taskId, channel);
    this.send({
      v: 1,
      type: "task",
      task_id: taskId,
      capability: "atlas.plan.steward",
      payload: {
        text,
        scenario: text,
        user,
        response_routing: { surface: "discord", channel, thread: channel },
      },
      // `adapter_instance` is REQUIRED for admission since atlas#24. The real
      // Discord adapter always sends it — cortex's `InboundMessage.instanceId`
      // is a required string — so a harness that omitted it was not modelling
      // the wire, it was modelling a task no adapter actually produces. Same
      // class as the `revisedAt` fake that made the unit suite blind to #26: a
      // double that quietly disagrees with reality validates the disagreement.
      source: {
        surface: "discord",
        channel,
        thread: channel,
        user,
        adapter_instance: this.adapterInstance,
      },
    });
  }

  async awaitResult(taskId: string, ms = 60_000): Promise<HostEffect> {
    await this.waitFor(
      () => this.effects.some((e) => e.type === "result" && e.task_id === taskId),
      ms,
      `no result for ${taskId}`,
    );
    return this.effects.find((e) => e.type === "result" && e.task_id === taskId)!;
  }

  /** Send a task and wait for it to settle. The rehearsal's normal turn. */
  async turn(taskId: string, text: string, user: string, ms = 60_000): Promise<HostEffect> {
    this.task(taskId, text, user);
    return this.awaitResult(taskId, ms);
  }

  /**
   * A turn typed IN A THREAD (atlas#22). The shipped Discord adapter puts the
   * THREAD's own snowflake in `channelId` AND `threadId` for such a message —
   * there is no parent-channel signal on the wire at all
   * (`metafactory-cortex-adapter-discord/src/index.ts`) — so this is just an
   * ordinary task whose channel is the thread. That fidelity is the point:
   * the harness must not hand Atlas a signal the real adapter never sends.
   */
  async threadTurn(
    taskId: string,
    text: string,
    user: string,
    threadId: string,
    ms = 60_000,
  ): Promise<HostEffect> {
    this.task(taskId, text, user, threadId);
    return this.awaitResult(taskId, ms);
  }

  /** Every `post` that landed in one channel (or thread) — the room's view. */
  postsIn(channel: string): string[] {
    return this.effects
      .filter((e) => e.type === "post" && e.landedIn === channel)
      .map((e) => String(e.text));
  }

  /** Every `create_private_thread` the brain asked for. */
  threadRequests(): HostEffect[] {
    return this.effects.filter((e) => e.type === "create_private_thread");
  }

  postsFor(taskId: string): string[] {
    return this.effects
      .filter((e) => e.type === "post" && e.task_id === taskId)
      .map((e) => String(e.text));
  }

  /** Every `post` the host ever received — the whole shadow ledger channel. */
  allPosts(): string[] {
    return this.effects.filter((e) => e.type === "post").map((e) => String(e.text));
  }

  effectTypes(): string[] {
    return [...new Set(this.effects.map((e) => e.type))].sort();
  }

  stderrText(): string {
    return this.stderr.join("\n");
  }

  startupVerdict(): string {
    return this.stderr.find((l) => l.includes("GATE ARMED") || l.includes("GATE UNARMED")) ?? "";
  }

  async waitFor(pred: () => boolean, ms: number, message: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return;
      await Bun.sleep(25);
    }
    throw new Error(`${message}\n--- brain stderr ---\n${this.stderrText()}`);
  }

  async stop(): Promise<void> {
    try {
      this.proc?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    this.server?.stop(true);
    this.conn = null;
  }
}
