/**
 * Env-file overlay loader — fills `process.env` from a principal-owned file,
 * ABSENT KEYS ONLY (a host-injected value always wins).
 *
 * ── Why this file has to exist ──────────────────────────────────────────────
 * cortex spawns an exec brain with a deliberately MINIMAL environment: `PATH`,
 * `HOME`, `LANG`, `TMPDIR`, the socket vars, and nothing else except the keys
 * the agent declared under `runtime.brain.secrets` (cortex
 * `src/brain/exec-brain-runner.ts` `buildEnv`). Atlas's `agent.yaml` declares
 * `secrets: []` — on purpose, it holds no credential of its own — so NONE of
 * `ATLAS_RATIFIER_PRINCIPAL`, `ATLAS_SELF_PLATFORM_IDS`, `ATLAS_PLAN_REPO`,
 * `ATLAS_CHANNEL_ID` reaches the brain from the daemon's own environment.
 *
 * That is precisely the "silently dead gate" epic #5 names: without an overlay
 * every deployment would boot UNARMED, and the only signal would be a stderr
 * line nobody reads. So the brain reads its own operator-owned overlay, and
 * `main.ts` states the resulting armed/unarmed verdict in one line at startup.
 *
 * Resolution order (first EXISTING file wins):
 *   1. `ATLAS_ENV_FILE`                        — explicit path
 *   2. `~/.config/metafactory/atlas/.env`      — the PRINCIPAL-owned overlay
 *   3. `<pack>/.env`                           — dev/local default
 *
 * The principal-owned path is the important one: it lets an operator set their
 * own knobs WITHOUT editing the installed pack, so `arc upgrade` and clean
 * reinstalls never clobber them. All three are gitignored.
 *
 * Minimal `KEY=VALUE` parsing: no interpolation, no `export`, `#` comments and
 * blank lines skipped, surrounding quotes stripped. A missing file is a no-op,
 * not an error — an operator may legitimately inject everything host-side.
 *
 * VALUES ARE NEVER LOGGED. The stderr line names the path and a COUNT, because
 * this file is the one place where a principal id, a snowflake and a bot-owned
 * repo all pass through at once.
 *
 * Lineage: `metafactory-cortex-agent-escort`'s `brain/env.ts`, which solved the
 * same minimal-env problem first. Kept deliberately close to it — two packs
 * with the same shape are easier to reason about than two clever ones.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Pack root = the dir above `brain/` (where `agent.yaml` + `persona.md` live). */
export function packRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** The principal-owned config dir: `~/.config/metafactory/atlas/`. */
export function principalConfigDir(): string {
  return join(homedir(), ".config", "metafactory", "atlas");
}

/** Parse `KEY=VALUE` lines. Total; never throws on odd input, just skips it. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/** First existing env-file path in resolution order, or `null`. */
export function resolveEnvFilePath(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = env.ATLAS_ENV_FILE;
  if (explicit !== undefined && explicit.length > 0) {
    // An explicit path that does not exist is NOT silently replaced by a
    // fallback: the operator named a file, and quietly reading a different one
    // is how a deployment ends up armed with the wrong identity.
    return existsSync(explicit) ? explicit : null;
  }
  const principal = join(principalConfigDir(), ".env");
  if (existsSync(principal)) return principal;
  const packLocal = join(packRoot(), ".env");
  if (existsSync(packLocal)) return packLocal;
  return null;
}

/** What `loadBrainEnv` did — returned so the startup line can state it. */
export interface BrainEnvLoad {
  /** The file actually read, or `null` when none existed / it could not be read. */
  readonly path: string | null;
  /** How many keys this load FILLED (absent-only; already-set keys are untouched). */
  readonly filled: number;
}

/**
 * Load the resolved env file into `process.env`, absent keys only. Never
 * throws: an unreadable file is reported and treated as "no overlay", because
 * the correct response to a broken overlay is an UNARMED-but-running brain
 * that says so, not a crash-loop against `maxRestarts`.
 */
export function loadBrainEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrainEnvLoad {
  const path = resolveEnvFilePath(env);
  if (path === null) return { path: null, filled: 0 };
  let filled = 0;
  try {
    const parsed = parseEnvFile(readFileSync(path, "utf-8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined || env[key] === "") {
        env[key] = value;
        filled += 1;
      }
    }
  } catch (err) {
    process.stderr.write(
      `atlas: env: could not read ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { path: null, filled: 0 };
  }
  return { path, filled };
}
