# Atlas cutover runbook

Bringing Atlas up on a real cortex stack, against a real Discord channel.

**Read the whole thing once before starting.** Two steps produce failures that look like a dead bot rather than a misconfiguration, and both are cheap to avoid and expensive to debug.

> **Atlas would be the first `kind: exec` brain running in this deployment.**
> `grep -rln "kind: exec" ~/.config/cortex/*/agents.d/` returns nothing today — every other agent is in-process. Atlas's brain is well proven against a faithful host double (the shadow rehearsal, 32 live assertions), but the real `DaemonBrainHost` path — spawn a subprocess, unix socket, `hello`, auth frame within 2s — has never carried a live agent here.
> **Stage it.** Point Atlas at a throwaway channel and a throwaway plan issue first. The config shape is identical, and nothing community-visible breaks if the first boot misbehaves.

---

## 0. What you need before you start

| | |
|---|---|
| A cortex stack | this runbook assumes the **config-split** layout: `~/.config/cortex/<stack>/` with its own `agents.d/`, `personas/` |
| A Discord application for Atlas | its **own** bot — not shared with another agent |
| A target channel | throwaway for the first run |
| A target plan issue | throwaway for the first run |
| GitHub credentials | Atlas edits the plan issue body and opens PRs |

---

## 1. Create the Discord application

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → name it.
2. **Bot** → **Reset Token** → copy it. **You only ever see it once.** Do not paste it into a chat, an issue, or any file in a repo.
3. **Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT.**
4. **Bot → Public Bot: off**, so only you can install it.
5. **OAuth2 → URL Generator** → scope `bot` → permissions:
   - View Channels
   - Send Messages
   - Read Message History
   - *(optional, for later)* Create Private Threads, Send Messages in Threads
6. Open the generated URL and authorise it into the guild.
7. If the target channel is permission-scoped, **add Atlas to that channel explicitly** — a channel override beats the server-wide grant.

> ### ⚠️ MESSAGE CONTENT INTENT is the silent one
> The adapter requests `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages` (`adapter-discord/src/client.ts:102-107`). `MessageContent` is **privileged**. Without it Atlas connects, shows **online**, receives every message with **empty text**, and answers nothing — indistinguishable from a crashed bot, with no error anywhere.

### Collect three ids

Enable **Settings → Advanced → Developer Mode**, then right-click to copy:

| Id | Used as |
|---|---|
| **Atlas's own user id** (right-click the bot in the member list) | `ATLAS_SELF_PLATFORM_IDS` |
| **Your user id** | `ATLAS_RATIFIER_PLATFORM_IDS` |
| **The channel id** | `ATLAS_CHANNEL_ID` and the fragment's `agentChannelId` |

Both user ids are supplied as `discord:<id>` pairs.

**Atlas's own id is the one people forget.** A *missing* value fails loudly (`no-usable-self-platform-ids`, gate not armed). A *stale* one does not — constitution rule 3 ("Atlas can never ratify Atlas") quietly stops covering Atlas's real identity, and nothing complains. Re-check it whenever the bot is recreated. (cortex#2471 proposes having the host supply this so it cannot go stale.)

---

## 2. Install the bundle onto the stack

**Target the stack's config dir explicitly.** On a host with more than one cortex config tree, the default resolution can land the fragment somewhere the running daemon never reads — and the symptom is simply that Atlas never appears.

```bash
arc install <atlas-source> --config-dir ~/.config/cortex/<stack>
```

Verify what actually landed:

```bash
ls ~/.config/cortex/<stack>/agents.d/atlas.yaml
ls ~/.config/cortex/<stack>/personas/atlas.md
arc files metafactory-cortex-agent-atlas
```

> **Known issue — arc#380.** `arc purge`/`remove` computes the unlink path from the **package name** while the installer wrote it under the agent **`id:`**. For this bundle those differ (`metafactory-cortex-agent-atlas` vs `atlas`), so an uninstall reports success and leaves `agents.d/atlas.yaml`, `personas/atlas.md`, NATS key material and `provision.json` behind. Remove those by hand until it lands, and treat a "successful" purge as unverified.

---

## 3. Provide the bot token

The token is **not** stored in any config file. Atlas's fragment declares a placeholder:

```yaml
presence:
  discord:
    token: __ATLAS_BOT_TOKEN__      # resolved at cortex load, from the daemon env
```

cortex resolves `__ENV__` placeholders **in surface fields only** — the token plus `guildId` / `agentChannelId` / `logChannelId` / `worklogChannelId`. The module is explicit that the value is *never stored in this file*.

```bash
arc secrets set metafactory-cortex-agent-atlas ATLAS_BOT_TOKEN
```

> ### ⚠️ Use the PACKAGE name, not the agent id
> `arc secrets` resolves its first argument against the **installed package name** (`arc/src/cli.ts:1578`, `getSkill(db, agent)`). cortex's own remediation hint prints the **agent id** — e.g. `arc secrets set vega VEGA_BOT_TOKEN` — so for any bundle where the two differ, **the command cortex tells you to run will fail** with `No installed package named 'atlas'`. Same name-vs-id root cause as arc#380.

The guild and channel ids are surface fields too, so they can go through the same mechanism rather than being pasted into config — which keeps real snowflakes out of any file that might drift toward a repo.

**If the token is missing, the failure is loud and scoped** — the daemon logs `discord surface for agent "<id>" DISABLED — … declares placeholder __X__ but env var X is unset`, disables that one surface, and names the fix. That is the good failure mode; do not confuse it with the silent ones.

---

## 4. Configure the brain

The seven `ATLAS_*` values go in the env-file overlay, **not** the stack config:

```
~/.config/metafactory/atlas/.env     # mode 600, inside a 700 directory
```

The brain is spawned with a **minimal environment** — `PATH`, `HOME`, `LANG`, `TMPDIR`, the socket vars, and nothing else except the names listed in `runtime.brain.secrets`. A variable that is not declared there will not reach the brain no matter where you put it.

Required (all fail closed):

| Variable | Notes |
|---|---|
| `ATLAS_RATIFIER_PRINCIPAL` | must match a `policy.principals[].id` in the stack config |
| `ATLAS_RATIFIER_PLATFORM_IDS` | `discord:<your id>` — compared with `===`, never normalised |
| `ATLAS_SELF_PLATFORM_IDS` | `discord:<atlas bot id>` — constitution rule 3 |
| `ATLAS_PLAN_REPO` | `owner/repo` |
| `ATLAS_PLAN_ISSUE` | positive integer |
| `ATLAS_CHANNEL_ID` | the one channel the ledger posts to |
| `ATLAS_TRUSTED_ADAPTER_INSTANCES` | **cannot be known yet — see step 5** |

Leave threads off. `ATLAS_THREAD_CONVERSATION` unset is both the default and the only working setting today: `create_private_thread` is wired only for `openOnboarding` agents, so on current cortex the effect is refused `cant_do`.

---

## 5. First boot — read the adapter instance

**This value cannot be derived. It must be observed.**

It has three shapes depending on topology:

| Topology | Shape |
|---|---|
| Per-stack (non-gateway) | `<agent-name>-discord-<guildId>` |
| Gateway, multi-guild token group | `discord:token:<sha256(token,stack)[0:12]>` |
| Gateway, single-guild | `discord:<guildId>` |

and cortex **throws** if a per-stack adapter is handed the gateway form. A wrong value means **100% of traffic silently refused**.

So:

1. Start the stack with `ATLAS_TRUSTED_ADAPTER_INSTANCES` deliberately unset or wrong.
2. Post a message mentioning Atlas in the target channel.
3. Read the real `adapter_instance` off the delivered task (stack logs).
4. Put that exact string in `.env`.
5. Restart the stack.

The boot line now prints the trusted-instance **count**, so a mismatch is visible rather than invisible — but the count cannot tell you the value is *right*, only that one is configured.

---

## 6. Verify the boot line

```
atlas: GATE ARMED — ratifier principal ••••(len N) (1 platform id(s); 1 self id(s)) ·
  effects: plan=<owner/repo>#<n> channel=••••(len N) adapterInstances=1 base=main
  docPRs=disabled · state=durable
```

**`GATE ARMED` is the only acceptable state.** Anything else names its own cause:

| Boot line says | Meaning |
|---|---|
| `GATE UNARMED (missing-ratifier-principal)` | no principal configured |
| `GATE UNARMED (ratifier-principal-unmapped)` | principal id maps to nobody in the stack config |
| `GATE UNARMED (no-usable-self-platform-ids)` | Atlas does not know its own identity — rule 3 cannot hold |
| `GATE UNARMED (unreachable:…)` | no effect target — messages are refused *before* the gate sees them |
| `missing-adapter-instances` | step 5 not done |
| `state=degraded` | durable store unavailable — Atlas will not open threads and owns nothing |

`docPRs=disabled` is expected unless `ATLAS_PLAN_CHECKOUT` is set. That is fail-closed by design, not a fault.

---

## 7. Smoke test, in order

Against the **throwaway** channel and plan issue:

1. `@atlas ADD: <issue-url> — testing` → a numbered proposal appears. Nothing on the plan yet.
2. Have someone else `RATIFY 1` → **silence**. (If you have no second account, skip; it is proven in the rehearsal.)
3. You `RATIFY 1` → the plan issue body is edited **and** a `➕` ledger entry posts, credited to the proposer.
4. Close a linked issue → a `✅` appears on the next watch pass.
5. Comment on the plan issue → **no `✋`**. (Regression check for #26/#34: ordinary discussion must not read as drift.)

Steps 3 and 5 are the ones worth watching. Step 3 is the whole constitution in one action; step 5 is the failure mode that would have made the ledger untrustworthy.

Then repoint `ATLAS_PLAN_*` and `ATLAS_CHANNEL_ID` at the real targets and restart.

---

## 8. Rollback

Atlas holds no credential of its own and every write leaves through the host effect protocol, so backing out is cheap:

1. Set `enabled: false` on the fragment's `presence.discord`, or stop the stack.
2. `arc remove metafactory-cortex-agent-atlas` — **then check by hand** for the arc#380 residue listed in step 2.
3. Instance state lives in `~/.config/cortex/agents/atlas`. Deleting it makes Atlas forget every proposal, every announced completion, and every accounted-for plan revision — so on the next start it may re-announce closures and report its own past edits as drift. **Keep it unless you intend a clean slate.**

Nothing Atlas does is destructive to the plan: it never merges, never force-pushes, and never rewrites ledger history.

---

## Appendix — silence has several causes, and they look identical

When Atlas does not answer:

1. **It never arrived** — no `@atlas` mention. cortex only delivers mentions; a bare `ADD:` line is not refused, it is never sent.
2. **Not admitted** — wrong channel, a thread Atlas does not own, or an untrusted `adapter_instance`. Refused in silence, by design.
3. **Not parsed** — the verb must be the first thing on the line.
4. **Empty content** — `MESSAGE CONTENT INTENT` off (step 1).
5. **Surface disabled** — token placeholder unresolved (step 3). This one *is* logged.

Only (5) announces itself. That asymmetry is why steps 1, 3 and 5 have warnings attached.
