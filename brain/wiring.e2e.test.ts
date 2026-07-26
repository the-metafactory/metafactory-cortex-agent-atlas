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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Read back through Atlas's OWN store, not raw SQL: "durable state is coherent"
// is a claim about what the next boot will see, and the next boot reads it
// through exactly this class.
import { AtlasStateStore, type ProposalRecord } from "./state";

const PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAIN = join(PACK_ROOT, "brain", "main.ts");

// ── Fixtures (placeholder ids only — this repo is public) ───────────────────

const PRINCIPAL_ID = "plan-steward";
const PRINCIPAL_PLATFORM_ID = "pid-principal-fixture";
const ATLAS_PLATFORM_ID = "pid-atlas-self-fixture";
const PROPOSER_PLATFORM_ID = "pid-proposer-fixture";
const CHANNEL_ID = "chan-fixture-0000";
// atlas#24 — the adapter-instance id a genuine live-surface task carries.
const ADAPTER_INSTANCE_ID = "discord:instance-fixture-0000";
const UNTRUSTED_ADAPTER_INSTANCE_ID = "discord:instance-fixture-forged";
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
 * The names `arc-manifest.yaml` declares under `capabilities.secrets` — the
 * installer-visible surface an operator reviews BEFORE consenting to install
 * (atlas#19: "capability honesty matters more than usual"). Same shape as
 * {@link declaredSecrets} one indent level shallower (2-space `secrets:` under
 * `capabilities:`, 4-space list items) — arc-manifest.yaml's own YAML, so a
 * name silently added to agent.yaml's `runtime.brain.secrets` without a
 * matching manifest declaration is caught here rather than shipping as an
 * under-declared capability.
 */
function manifestDeclaredSecrets(): string[] {
  const yaml = readFileSync(join(PACK_ROOT, "arc-manifest.yaml"), "utf8");
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^\s{2}secrets:\s*$/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s{4}-\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:#.*)?$/.exec(line);
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

/**
 * Make `gh issue edit` SLOW, and announce the moment it starts.
 *
 * This is what makes a shutdown test non-vacuous. `applyRatified` is a chain of
 * network calls (read body → write body → read receipt → post ledger → record),
 * and "in flight" means the signal arrives while the process is inside one of
 * them. A stall on the WRITE puts the signal in the worst place in the chain:
 * after the plan issue has been handed an edit and before Atlas has recorded a
 * single thing about it.
 */
interface EditStall {
  /** Touched the instant `issue edit` begins, so a test can wait for it. */
  readonly marker: string;
  /** How long the edit takes. `sh`'s `sleep` accepts fractions on macOS/Linux. */
  readonly seconds: number;
}

/** A `gh` shim: enough canned truth for one ADD → RATIFY round trip. */
function writeGhShim(binDir: string, statePath: string, stall: EditStall | null = null): void {
  mkdirSync(binDir, { recursive: true });
  const stallPreamble =
    stall === null ? "" : `    : > "${stall.marker}"\n    sleep ${stall.seconds}\n`;
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
${stallPreamble}    cat > "$STATE"
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

  /**
   * Deliver a surface message exactly as `buildBrainTaskPayload` shapes it.
   *
   * `adapterInstance` defaults to the fixture id `armedHostEnv()` trusts, so
   * every existing call site keeps exercising a genuinely-admitted task.
   * Passing `null` explicitly reproduces atlas#24's bus-forged shape — the
   * wire-e2e's own fixture used to omit the field entirely and still be
   * admitted. (`null`, not `undefined`: a default PARAMETER value still
   * applies when a caller explicitly passes `undefined`, so `undefined` could
   * not double as an explicit "omit it" signal here.)
   */
  task(
    taskId: string,
    text: string,
    user: string,
    channel = CHANNEL_ID,
    adapterInstance: string | null = ADAPTER_INSTANCE_ID,
  ): void {
    const routing: Record<string, unknown> = { surface: "discord", channel, thread: channel };
    const source: Record<string, unknown> = { surface: "discord", channel, thread: channel, user };
    if (adapterInstance !== null) {
      routing.adapter_instance = adapterInstance;
      source.adapter_instance = adapterInstance;
    }
    this.send({
      v: 1,
      type: "task",
      task_id: taskId,
      capability: "atlas.plan.steward",
      payload: { text, scenario: text, user, response_routing: routing },
      source,
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

  /** The host goes away without asking: the brain's `close` path, not `shutdown`. */
  dropConnection(): void {
    try {
      this.conn?.end();
    } catch {
      /* already gone */
    }
    this.server?.stop(true);
    this.conn = null;
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
    ATLAS_TRUSTED_ADAPTER_INSTANCES: ADAPTER_INSTANCE_ID,
    ATLAS_STATE_DIR: join(dir, "state"),
  };
}

async function boot(
  hostEnv: Record<string, string>,
  opts: { editStall?: EditStall } = {},
): Promise<FakeCortexHost> {
  const socketPath = join(dir, "brain.sock");
  const binDir = join(dir, "bin");
  writeGhShim(binDir, planFile, opts.editStall ?? null);
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

/**
 * Exactly the names read by effects/config.ts, identity.ts, state.ts,
 * watch.ts, reconcile.ts and env.ts. Without the `agent.yaml` declaration,
 * cortex's minimal env means every one of them is undefined in the brain
 * process — and without a README mention, an operator provisioning from the
 * docs has no way to know a name exists at all (atlas#24 B2: this happened
 * for `ATLAS_TRUSTED_ADAPTER_INSTANCES`, which shipped in code and in
 * `agent.yaml` but not in the operator-facing README).
 */
const REQUIRED_ENV_NAMES = [
  "ATLAS_RATIFIER_PRINCIPAL",
  "ATLAS_RATIFIER_PLATFORM_IDS",
  "ATLAS_SELF_PLATFORM_IDS",
  "ATLAS_PLAN_REPO",
  "ATLAS_PLAN_ISSUE",
  "ATLAS_CHANNEL_ID",
  "ATLAS_TRUSTED_ADAPTER_INSTANCES",
  "ATLAS_PLAN_BASE_BRANCH",
  "ATLAS_PLAN_CHECKOUT",
  "ATLAS_WATCH_INTERVAL_MS",
  "ATLAS_RECONCILE_INTERVAL_MS",
  "ATLAS_STATE_DIR",
  "ATLAS_AGENT_STATE_DIR",
  "ATLAS_ENV_FILE",
];

describe("agent.yaml declares the env contract", () => {
  test("every name the brain reads is declared under runtime.brain.secrets", () => {
    const declared = new Set(declaredSecrets());
    for (const required of REQUIRED_ENV_NAMES) {
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

  test("arc-manifest.yaml's capabilities.secrets agrees with agent.yaml's runtime.brain.secrets (atlas#19)", () => {
    // The installer-visible declaration (arc-manifest.yaml) must name EVERY
    // env var the brain actually reaches for at runtime (agent.yaml's
    // runtime.brain.secrets, itself proven complete by the test above) — an
    // operator reviewing capabilities before consenting to install must see
    // the whole surface, not a subset. Caught two real gaps during atlas#19's
    // honesty pass: ATLAS_RECONCILE_INTERVAL_MS and ATLAS_ENV_FILE were
    // declared in agent.yaml (and documented in README) but silently absent
    // from arc-manifest.yaml's capabilities.secrets.
    const manifestDeclared = new Set(manifestDeclaredSecrets());
    for (const name of declaredSecrets()) {
      expect(manifestDeclared).toContain(name);
    }
  });

  test("every declared name is operator-documented in README.md (atlas#19)", () => {
    // Same class of gap, third file: agent.yaml and arc-manifest.yaml can
    // agree with each other and STILL leave an operator with no idea what a
    // name does or defaults to if README's Configuration tables never mention
    // it. Caught the same two names undocumented here as in the manifest
    // check above — this closes the third of the three files, not just two.
    const readme = readFileSync(join(PACK_ROOT, "README.md"), "utf8");
    for (const name of declaredSecrets()) {
      expect(readme).toContain(`\`${name}\``);
    }
  });
});

describe("README declares the env contract too (atlas#24 B2)", () => {
  // Pins the OPERATOR-facing doc against the same list `agent.yaml`'s
  // declaration is checked against above, so a name added to the code and to
  // `agent.yaml` without also touching README fails HERE instead of shipping
  // deaf a second time. Every REQUIRED name (the ratification gate and the
  // effect universe) must be mentioned; the optional/defaulted ones are
  // documented too today but are not load-bearing for this guard.
  test("every REQUIRED env var name is mentioned in README.md", () => {
    const readme = readFileSync(join(PACK_ROOT, "README.md"), "utf8");
    const REQUIRED_FOR_README = [
      "ATLAS_RATIFIER_PRINCIPAL",
      "ATLAS_RATIFIER_PLATFORM_IDS",
      "ATLAS_SELF_PLATFORM_IDS",
      "ATLAS_PLAN_REPO",
      "ATLAS_PLAN_ISSUE",
      "ATLAS_CHANNEL_ID",
      "ATLAS_TRUSTED_ADAPTER_INSTANCES",
    ];
    for (const name of REQUIRED_FOR_README) {
      expect(readme).toContain(name);
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

  test("a gate no message can REACH is UNARMED — verdict prefix, not a sub-clause", async () => {
    // atlas#20. Identity loads and state is durable, so the old arming
    // condition (`identityOk && stateDurable`) printed GATE ARMED — while
    // `serveTask` short-circuited every message to `no-effect-layer` before
    // intake or the gate ever saw it. ARMED is read as the promise that
    // RATIFY/DECLINE will NOT be ignored, because the UNARMED branch says so
    // explicitly; printing it here was epic #5's silently-dead gate.
    //
    // The assertion is deliberately on the VERDICT PREFIX. The suite already
    // drove this exact configuration and asserted only `effects: NONE`, which
    // is how the bug got through review — exercised, and asserted around.
    const env = armedHostEnv();
    delete env.ATLAS_CHANNEL_ID;
    const h = await boot(env);
    h.hello();
    await h.waitFor(() => h.stderrText().includes("connected"), 5_000, "never connected");

    const verdict = h.stderr.find((l) => l.includes("GATE ARMED") || l.includes("GATE UNARMED"));
    expect(verdict).toBeDefined();
    expect(verdict).toContain("GATE UNARMED");
    expect(verdict).not.toContain("GATE ARMED");
    expect(verdict).toContain("unreachable:missing-channel-id");
    expect(verdict).toContain("IGNORED");

    // …and the line's promise is the runtime's behaviour: the principal's
    // RATIFY is discarded, exactly as UNARMED says it will be.
    h.task("t-unreachable", "RATIFY 1", PRINCIPAL_PLATFORM_ID);
    const result = await h.awaitResult("t-unreachable");
    expect(result.summary).toBe("no-effect-layer");
    expect(h.postsFor("t-unreachable")).toEqual([]);
  }, 20_000);

  test("no trusted adapter instance is UNARMED too (atlas#24) — same unreachable shape", async () => {
    // Same failure family as the missing-channel-id case above: the SECOND
    // admission check (`runtime.ts`) is just as capable of making the gate
    // unreachable, and the startup line must say so rather than printing
    // ARMED over a message that will never get past `serveTask`.
    const env = armedHostEnv();
    delete env.ATLAS_TRUSTED_ADAPTER_INSTANCES;
    const h = await boot(env);
    h.hello();
    await h.waitFor(() => h.stderrText().includes("connected"), 5_000, "never connected");

    const verdict = h.stderr.find((l) => l.includes("GATE ARMED") || l.includes("GATE UNARMED"));
    expect(verdict).toBeDefined();
    expect(verdict).toContain("GATE UNARMED");
    expect(verdict).not.toContain("GATE ARMED");
    expect(verdict).toContain("unreachable:missing-adapter-instances");
    expect(verdict).toContain("IGNORED");

    h.task("t-unreachable-adapter", "RATIFY 1", PRINCIPAL_PLATFORM_ID);
    const result = await h.awaitResult("t-unreachable-adapter");
    expect(result.summary).toBe("no-effect-layer");
    expect(h.postsFor("t-unreachable-adapter")).toEqual([]);
  }, 20_000);

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

  // atlas#24 — the exact gap the independent adversarial review of PR #16
  // found: a `task` event published straight onto the bus (bypassing every
  // real adapter) can carry the RIGHT channel and an authenticated-LOOKING
  // author id while omitting `adapter_instance` entirely, because cortex's own
  // consumer builds `source` from an arbitrary envelope with no origin check.
  // These two cases prove that shape can no longer ratify — the mutation
  // guard is: revert the `trustedAdapterInstances` check in `runtime.ts`'s
  // `serveTask` and BOTH of these must start ratifying again.
  test("a RATIFY with no adapter_instance is ignored — the bus-forged shape cannot ratify", async () => {
    const h = await boot(armedHostEnv());
    h.hello();
    h.task("t-add", `ADD: ${NEW_URL} — [Backend] why`, PROPOSER_PLATFORM_ID);
    await h.awaitResult("t-add");

    h.task("t-forged", "RATIFY 1", PRINCIPAL_PLATFORM_ID, CHANNEL_ID, null);
    const result = await h.awaitResult("t-forged");
    expect(result.status).toBe("complete");
    expect(result.summary).toBe("not-admitted");
    expect(readFileSync(planFile, "utf8")).not.toContain(NEW_URL);
    expect(h.postsFor("t-forged")).toEqual([]);
  }, 20_000);

  test("a RATIFY from an untrusted adapter_instance is ignored — cannot ratify", async () => {
    const h = await boot(armedHostEnv());
    h.hello();
    h.task("t-add", `ADD: ${NEW_URL} — [Backend] why`, PROPOSER_PLATFORM_ID);
    await h.awaitResult("t-add");

    h.task(
      "t-forged2",
      "RATIFY 1",
      PRINCIPAL_PLATFORM_ID,
      CHANNEL_ID,
      UNTRUSTED_ADAPTER_INSTANCE_ID,
    );
    const result = await h.awaitResult("t-forged2");
    expect(result.status).toBe("complete");
    expect(result.summary).toBe("not-admitted");
    expect(readFileSync(planFile, "utf8")).not.toContain(NEW_URL);
    expect(h.postsFor("t-forged2")).toEqual([]);
  }, 20_000);
});

// ── Shutdown ────────────────────────────────────────────────────────────────

describe("shutdown", () => {
  test("the protocol shutdown event drains and exits 0", async () => {
    const h = await boot(armedHostEnv());
    h.hello();
    h.send({ v: 1, type: "shutdown", deadline_ms: 200 });
    expect(await h.exited()).toBe(0);
  }, 15_000);

  /**
   * Drive an ADD → RATIFY up to the moment `gh issue edit` is running, and
   * return with the apply GENUINELY in flight.
   *
   * The old test at this spot awaited the result BEFORE signalling, so the task
   * was fully settled and nothing was in flight — it proved SIGTERM → exit 0,
   * which is half its own name (atlas#21). Waiting on the shim's marker file is
   * what makes the difference: it is written by `gh` itself, from inside the
   * write, so its existence is proof the process is mid-effect.
   */
  async function ratifyInFlight(stallSeconds: number): Promise<FakeCortexHost> {
    const marker = join(dir, "edit-started");
    const h = await boot(armedHostEnv(), { editStall: { marker, seconds: stallSeconds } });
    h.hello();
    h.task("t-add", `ADD: ${NEW_URL} — [Backend] why`, PROPOSER_PLATFORM_ID);
    await h.awaitResult("t-add");
    // Deliberately NOT awaited: this is the task we interrupt.
    h.task("t-ratify", "RATIFY 1", PRINCIPAL_PLATFORM_ID);
    await h.waitFor(() => existsSync(marker), 10_000, "the plan edit never started");
    return h;
  }

  /** Read Atlas's durable state the way the next boot would. */
  function durableRecord(id: string): ProposalRecord | null {
    const store = AtlasStateStore.open({ dir: join(dir, "state") });
    expect(store).not.toBeNull();
    try {
      return store!.get(id);
    } finally {
      store!.close();
    }
  }

  test("shutdown DURING an in-flight apply waits for it — map, ledger and memory all move", async () => {
    // The demonstrated failure (atlas#21): `deadline_ms: 100` against a stalled
    // `gh issue edit` exited 0 mid-`applyRatified`. The orphaned child finished
    // the edit, so the plan body moved, no ➕ ledger entry was ever posted, and
    // no apply record landed — the map ahead of both the ledger and Atlas's own
    // memory, through the shutdown path instead of the one the atomic pair
    // guards.
    const h = await ratifyInFlight(1.5);
    h.send({ v: 1, type: "shutdown", deadline_ms: 50 });
    expect(await h.exited()).toBe(0);

    // (a) the map moved…
    expect(readFileSync(planFile, "utf8")).toContain(NEW_URL);
    // (b) …the ledger entry left, on the task that was in flight…
    const ledger = h.postsFor("t-ratify").filter((t) => t.startsWith("➕"));
    expect(ledger).toHaveLength(1);
    // (c) …and Atlas remembers BOTH. A record parked in `ratified` with no
    // applied receipt is the split this test exists to forbid.
    const rec = durableRecord("t-add");
    expect(rec?.phase).toBe("posted");
    expect(rec?.applied).not.toBeNull();
    expect(rec?.posted).not.toBeNull();
    // The deadline was 50ms and the edit took ~1.5s: Atlas said out loud that
    // it was overrunning rather than doing it quietly.
    expect(h.stderrText()).toContain("expired with a transition still in flight");
  }, 30_000);

  test("SIGTERM during an in-flight apply drains it too", async () => {
    const h = await ratifyInFlight(1.5);
    h.signal("SIGTERM");
    expect(await h.exited()).toBe(0);
    expect(readFileSync(planFile, "utf8")).toContain(NEW_URL);
    expect(h.postsFor("t-ratify").filter((t) => t.startsWith("➕"))).toHaveLength(1);
    expect(durableRecord("t-add")?.phase).toBe("posted");
  }, 30_000);

  test("past the drain cap the transition is abandoned WHOLE, never half-recorded", async () => {
    // The deliberate decision at the cap, pinned so it cannot drift into
    // something quieter: Atlas gives up, says so, and leaves the store alone.
    // Durable state is then a whole number of transitions behind reality —
    // still `ratified`, no applied receipt, nothing torn — which is ordinary
    // drift with a named owner (reconcile's "plan body revised outside Atlas").
    const h = await ratifyInFlight(9);
    h.send({ v: 1, type: "shutdown", deadline_ms: 50 });
    expect(await h.exited()).toBe(0);
    expect(h.stderrText()).toContain("ABANDONING an in-flight transition");

    const rec = durableRecord("t-add");
    expect(rec?.phase).toBe("ratified");
    expect(rec?.applied).toBeNull();
    expect(rec?.posted).toBeNull();
    // And no ledger entry was minted for a change Atlas never recorded.
    expect(h.postsFor("t-ratify").filter((t) => t.startsWith("➕"))).toEqual([]);
  }, 40_000);

  test("losing the socket mid-apply drains before exiting, and exits non-zero", async () => {
    // `close()` used to call `state.close()` and exit with NO drain at all —
    // the same half-applied split as the deadline path, reached by a route the
    // host does not even choose.
    const h = await ratifyInFlight(1.5);
    h.dropConnection();
    expect(await h.exited()).toBe(1); // not an orderly shutdown; the host should see that
    expect(h.stderrText()).toContain("socket closed by host — draining");
    expect(durableRecord("t-add")?.phase).toBe("posted");
  }, 30_000);
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
