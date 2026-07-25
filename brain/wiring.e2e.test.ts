/**
 * The IGNITION suite — a real `bun brain/main.ts` subprocess, a real unix
 * socket, a real handshake.
 *
 * Everything else in this repo tests Atlas's judgement. This file tests the one
 * thing none of those can: that the daemon actually STARTS, connects, speaks
 * `cortex-brain/v1` correctly, and serves events — the failure epic #5 names
 * ("cortex spawns it, the process exits non-zero, `maxRestarts: 3` is
 * exhausted, the brain never starts").
 *
 * ── The host double mirrors cortex, it does not simplify it ────────────────
 * `FakeCortexHost` below binds a unix socket, spawns the brain with an env
 * built by {@link buildBrainEnv} — a faithful re-implementation of cortex's
 * `buildEnv` (`src/brain/exec-brain-runner.ts`) plus `collectBrainSecrets`
 * (`src/runner/brain-consumer-boot.ts`), including the minimal PATH/HOME/LANG/
 * TMPDIR baseline — REQUIRES the auth line first, and then speaks the same
 * events cortex speaks. Simplifying any of that would test a host that does
 * not exist.
 *
 * ── The secrets declaration is proven, not assumed ─────────────────────────
 * The declared-secret list is READ OUT OF `agent.yaml` at test time and used as
 * the filter, exactly as cortex does. That is the point: the config names only
 * reach the brain because they appear in `runtime.brain.secrets`, and a name
 * deleted from that block makes these tests fail rather than the deployment.
 *
 * ── `gh` is faked on PATH, not stubbed in code ─────────────────────────────
 * `GhCliReadOnly` and `GhCliPlanWriter` spawn the real `gh` binary through
 * PATH lookup. A shim at the front of PATH keeps the suite hermetic while
 * leaving both adapters — and their argv chokepoint — completely real.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAIN = join(PACK_ROOT, "brain", "main.ts");

// ── Fixtures (placeholder ids only — this repo is public) ───────────────────

const PRINCIPAL_ID = "plan-steward";
const PRINCIPAL_PLATFORM_ID = "pid-principal-fixture";
const ATLAS_PLATFORM_ID = "pid-atlas-self-fixture";
const PROPOSER_PLATFORM_ID = "pid-proposer-fixture";
const CHANNEL_ID = "chan-fixture-0000";
const OTHER_CHANNEL = "chan-fixture-9999";
const PLAN_REPO = "acme/widgets";
const PLAN_ISSUE = "4";
const NEW_URL = "https://github.com/acme/widgets/issues/12";

const PLAN_BODY = ["# Iteration 1", "", "## Backend", "", "- [ ] see below", ""].join("\n");

/**
 * cortex's `RUNNER_OWNED_ENV_KEYS` — the baseline a declared secret may not
 * shadow (the runner THROWS on a collision, taking the agent down at boot).
 * Mirrored here so the declaration test can assert Atlas never trips it.
 */
const RUNNER_OWNED_ENV_KEYS = new Set(["PATH", "HOME", "LANG", "TMPDIR"]);

/** The names `agent.yaml` declares under `runtime.brain.secrets`. */
function declaredSecrets(): string[] {
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
    break; // dedented out of the list
  }
  return out;
}

/**
 * cortex's `collectBrainSecrets` + `buildEnv`, faithfully: the brain sees the
 * four runner-owned keys, the socket vars, and NOTHING except the DECLARED
 * names that are present in the host's own environment.
 */
function buildBrainEnv(opts: {
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

/** A `gh` shim: enough canned truth for one ADD → RATIFY round trip. */
function writeGhShim(binDir: string, statePath: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = `#!/bin/sh
# Fake gh for the ignition suite. Reads/writes a single JSON-free body file so
# an 'issue edit' is observable by the test.
STATE="${statePath}"
case "$1 $2" in
  "issue view")
    BODY=$(cat "$STATE")
    printf '{"body":%s,"updatedAt":"2026-07-26T00:00:01Z","url":"https://github.com/${PLAN_REPO}/issues/${PLAN_ISSUE}"}' "$(printf '%s' "$BODY" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | awk '{printf "%s\\\\n", $0}' | sed 's/^/"/; s/$/"/' | tr -d '\\n')"
    exit 0
    ;;
  "issue edit")
    cat > "$STATE"
    exit 0
    ;;
esac
# gh api <path> [--jq <expr>]
case "$*" in
  *"/issues/12"*) printf '{"state":"open","title":"A new item","closed_at":null}'; exit 0 ;;
  *"--jq"*) cat "$STATE"; exit 0 ;;
esac
exit 1
`;
  const p = join(binDir, "gh");
  writeFileSync(p, script, "utf8");
  chmodSync(p, 0o755);
}

// ── The host double ─────────────────────────────────────────────────────────

interface HostEffect {
  type: string;
  [k: string]: unknown;
}

class FakeCortexHost {
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
  ) {}

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
    // Stream stderr INCREMENTALLY. `new Response(stream).text()` only resolves
    // at process exit, which would make every "did it log X yet?" assertion a
    // guaranteed timeout — and the startup line is emitted seconds before the
    // brain ever exits.
    void (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      // Bun's ReadableStream is async-iterable at runtime; the DOM lib type
      // does not model that, so the iteration source is widened here.
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
    await this.waitFor(() => this.authed, 8_000, "brain never authenticated");
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
      // The auth proof MUST be first, and MUST carry the per-spawn token.
      expect(obj.type).toBe("auth");
      expect(obj.token).toBe(this.token);
      this.authed = true;
      return;
    }
    this.effects.push(obj);
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
  task(taskId: string, text: string, user: string, channel = CHANNEL_ID): void {
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
      source: { surface: "discord", channel, thread: channel, user },
    });
  }

  /** Resolve once a `result` for `taskId` has come back. */
  async awaitResult(taskId: string, ms = 8_000): Promise<HostEffect> {
    await this.waitFor(
      () => this.effects.some((e) => e.type === "result" && e.task_id === taskId),
      ms,
      `no result for ${taskId}`,
    );
    return this.effects.find((e) => e.type === "result" && e.task_id === taskId)!;
  }

  postsFor(taskId: string): string[] {
    return this.effects
      .filter((e) => e.type === "post" && e.task_id === taskId)
      .map((e) => String(e.text));
  }

  stderrText(): string {
    return this.stderr.join("\n");
  }

  async waitFor(pred: () => boolean, ms: number, message: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return;
      await Bun.sleep(15);
    }
    throw new Error(`${message}\n--- brain stderr ---\n${this.stderrText()}`);
  }

  exited(): Promise<number> {
    return this.proc!.exited;
  }

  signal(sig: NodeJS.Signals): void {
    this.proc?.kill(sig);
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

// ── Harness ─────────────────────────────────────────────────────────────────

let dir: string;
let host: FakeCortexHost | null;
let planFile: string;

/** The env an operator would export on the cortex daemon for a live Atlas. */
function armedHostEnv(): Record<string, string> {
  return {
    ATLAS_RATIFIER_PRINCIPAL: PRINCIPAL_ID,
    ATLAS_RATIFIER_PLATFORM_IDS: `discord:${PRINCIPAL_PLATFORM_ID}`,
    ATLAS_SELF_PLATFORM_IDS: `discord:${ATLAS_PLATFORM_ID}`,
    ATLAS_PLAN_REPO: PLAN_REPO,
    ATLAS_PLAN_ISSUE: PLAN_ISSUE,
    ATLAS_CHANNEL_ID: CHANNEL_ID,
    ATLAS_STATE_DIR: join(dir, "state"),
  };
}

async function boot(hostEnv: Record<string, string>): Promise<FakeCortexHost> {
  const socketPath = join(dir, "brain.sock");
  const binDir = join(dir, "bin");
  writeGhShim(binDir, planFile);
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "scratch"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  const h = new FakeCortexHost(
    socketPath,
    buildBrainEnv({
      hostEnv,
      socketPath,
      token: "token-fixture-0000",
      scratchDir: join(dir, "scratch"),
      // The shim FIRST, then the real PATH so `bun` itself resolves.
      path: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      // A temp HOME so the developer's own ~/.config overlay can never leak in.
      home: join(dir, "home"),
    }),
  );
  await h.start();
  host = h;
  return h;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-e2e-"));
  planFile = join(dir, "plan-body.txt");
  writeFileSync(planFile, PLAN_BODY, "utf8");
  host = null;
});

afterEach(async () => {
  await host?.stop();
  rmSync(dir, { recursive: true, force: true });
});

// ── The declaration itself ──────────────────────────────────────────────────

describe("agent.yaml declares the env contract", () => {
  test("every name the brain reads is declared under runtime.brain.secrets", () => {
    const declared = new Set(declaredSecrets());
    // Exactly the names read by effects/config.ts, identity.ts, state.ts,
    // watch.ts, reconcile.ts and env.ts. Without the declaration, cortex's
    // minimal env means every one of them is undefined in the brain process.
    for (const required of [
      "ATLAS_RATIFIER_PRINCIPAL",
      "ATLAS_RATIFIER_PLATFORM_IDS",
      "ATLAS_SELF_PLATFORM_IDS",
      "ATLAS_PLAN_REPO",
      "ATLAS_PLAN_ISSUE",
      "ATLAS_CHANNEL_ID",
      "ATLAS_PLAN_BASE_BRANCH",
      "ATLAS_PLAN_CHECKOUT",
      "ATLAS_WATCH_INTERVAL_MS",
      "ATLAS_RECONCILE_INTERVAL_MS",
      "ATLAS_STATE_DIR",
      "ATLAS_AGENT_STATE_DIR",
      "ATLAS_ENV_FILE",
    ]) {
      expect(declared).toContain(required);
    }
  });

  test("no declared name collides with cortex's runner-owned keys", () => {
    // A collision makes cortex's `buildEnv` THROW, which kills the agent at
    // boot rather than at first use.
    for (const name of declaredSecrets()) {
      expect(RUNNER_OWNED_ENV_KEYS.has(name.toUpperCase())).toBe(false);
    }
  });
});

// ── Ignition ────────────────────────────────────────────────────────────────

describe("the daemon starts and stays up", () => {
  test("connects, authenticates, and reports the gate ARMED in one line", async () => {
    const h = await boot(armedHostEnv());
    h.hello();
    await h.waitFor(() => h.stderrText().includes("connected"), 5_000, "never logged connected");

    const armedLines = h.stderr.filter((l) => l.includes("GATE ARMED") || l.includes("GATE UNARMED"));
    expect(armedLines).toHaveLength(1);
    expect(armedLines[0]).toContain("GATE ARMED");
    expect(armedLines[0]).toContain(`plan=${PLAN_REPO}#${PLAN_ISSUE}`);
    expect(armedLines[0]).toContain("state=durable");
    // Ids are masked — the raw principal id and channel snowflake never appear.
    expect(armedLines[0]).not.toContain(PRINCIPAL_ID);
    expect(armedLines[0]).not.toContain(CHANNEL_ID);
  });

  test("an UNARMED config refuses audibly and still stays up", async () => {
    const env = armedHostEnv();
    delete env.ATLAS_SELF_PLATFORM_IDS;
    const h = await boot(env);
    h.hello();
    await h.waitFor(() => h.stderrText().includes("connected"), 5_000, "never connected");

    const line = h.stderr.find((l) => l.includes("GATE UNARMED"));
    expect(line).toBeDefined();
    expect(line).toContain("no-usable-self-platform-ids");
    expect(line).toContain("IGNORED");

    // The proof that it did not crash-loop: it still serves a task.
    h.task("t-unarmed", "RATIFY 1", PRINCIPAL_PLATFORM_ID);
    const result = await h.awaitResult("t-unarmed");
    expect(result.status).toBe("complete");
    expect(h.postsFor("t-unarmed")).toEqual([]);
  });

  test("an unknown event type is dropped, not fatal", async () => {
    const h = await boot(armedHostEnv());
    h.hello();
    h.send({ v: 1, type: "quantum_entangle", task_id: "t-x" });
    h.send({ v: 1, type: "task" }); // known type, invalid shape
    h.task("t-after", "still here?", PROPOSER_PLATFORM_ID);
    const result = await h.awaitResult("t-after");
    expect(result.status).toBe("complete");
  });
});

// ── The loop, end to end ────────────────────────────────────────────────────

describe("the full loop over a real socket", () => {
  test("ADD surfaces a proposal, RATIFY applies it and the ledger post leaves", async () => {
    const h = await boot(armedHostEnv());
    h.hello();

    h.task("t-add", `ADD: ${NEW_URL} — [Backend] worth doing`, PROPOSER_PLATFORM_ID);
    await h.awaitResult("t-add");
    const surfaced = h.postsFor("t-add");
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toContain("Proposal #1 — ADD:");
    // Nothing has changed on the plan yet — the gate has not been through.
    expect(readFileSync(planFile, "utf8")).not.toContain(NEW_URL);

    h.task("t-ratify", "RATIFY 1", PRINCIPAL_PLATFORM_ID);
    await h.awaitResult("t-ratify");
    // The map moved…
    expect(readFileSync(planFile, "utf8")).toContain(NEW_URL);
    // …and the ➕ ledger entry left through the host protocol, on that task.
    const ledger = h.postsFor("t-ratify").filter((t) => t.startsWith("➕"));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toContain(NEW_URL);
    expect(ledger[0]).toContain("Atlas · plan steward");
  }, 20_000);

  test("a non-principal's RATIFY changes nothing", async () => {
    const h = await boot(armedHostEnv());
    h.hello();
    h.task("t-add", `ADD: ${NEW_URL} — [Backend] worth doing`, PROPOSER_PLATFORM_ID);
    await h.awaitResult("t-add");
    h.task("t-bad", "RATIFY 1", PROPOSER_PLATFORM_ID);
    await h.awaitResult("t-bad");
    expect(readFileSync(planFile, "utf8")).not.toContain(NEW_URL);
    expect(h.postsFor("t-bad")).toEqual([]);
  }, 20_000);

  test("a task from a channel Atlas is not bound to is ignored in silence", async () => {
    const h = await boot(armedHostEnv());
    h.hello();
    h.task("t-elsewhere", `ADD: ${NEW_URL} — [Backend] why`, PROPOSER_PLATFORM_ID, OTHER_CHANNEL);
    const result = await h.awaitResult("t-elsewhere");
    expect(result.status).toBe("complete");
    expect(result.summary).toBe("not-admitted");
    expect(h.postsFor("t-elsewhere")).toEqual([]);
  });
});

// ── Shutdown ────────────────────────────────────────────────────────────────

describe("shutdown", () => {
  test("the protocol shutdown event drains and exits 0", async () => {
    const h = await boot(armedHostEnv());
    h.hello();
    h.send({ v: 1, type: "shutdown", deadline_ms: 200 });
    expect(await h.exited()).toBe(0);
  }, 15_000);

  test("SIGTERM drains and exits 0 — an in-flight transition is not orphaned", async () => {
    const h = await boot(armedHostEnv());
    h.hello();
    h.task("t-drain", `ADD: ${NEW_URL} — [Backend] why`, PROPOSER_PLATFORM_ID);
    await h.awaitResult("t-drain");
    h.signal("SIGTERM");
    expect(await h.exited()).toBe(0);
  }, 20_000);
});

// ── The direct-run guard ────────────────────────────────────────────────────

describe("run outside the host", () => {
  test("exits 2 with an explanation rather than crash-looping", async () => {
    const proc = Bun.spawn(["bun", MAIN], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(dir, "home") },
      cwd: PACK_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(err).toContain("CORTEX_BRAIN_SOCKET");
    expect(err).toContain("not run directly");
  }, 15_000);
});
