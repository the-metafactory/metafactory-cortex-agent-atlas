# metafactory-cortex-agent-atlas

Atlas — the Factory's product-manager agent (plan steward). A cortex agent bundle that stewards the metafactory iteration plan: intake proposals, hold a strict ratification gate, and keep the plan's ledger current.

- Design spec: https://github.com/the-metafactory/vision/issues/9
- Implementation epic: https://github.com/the-metafactory/metafactory-cortex-agent-atlas/issues/8

## Running it

`brain/main.ts` is the daemon entrypoint. cortex spawns it
(`runtime.brain.run`), it connects back on the assigned unix socket, and it
serves events until the host says stop. It is not run by hand — invoked
directly it exits 2 and says why.

### Configuration reaches the brain through `runtime.brain.secrets`

cortex spawns an exec brain with a **minimal environment**: `PATH`, `HOME`,
`LANG`, `TMPDIR`, the socket vars, and *nothing else* except the names declared
under `runtime.brain.secrets` in `agent.yaml`. Those names are read from the
**cortex daemon's own environment** and injected verbatim. Exporting a variable
without declaring it there has no effect on the brain whatsoever.

Every `ATLAS_*` name is declared (see the annotated block in `agent.yaml`).
A second, pack-owned route exists for operators who would rather not put this
configuration into the daemon's environment:

```
~/.config/metafactory/atlas/.env      # or $ATLAS_ENV_FILE
```

It fills **absent keys only** — anything the host injected always wins.

### The startup line

Every boot emits exactly one line saying whether the ratification gate is
**ARMED** or **UNARMED**, which configuration produced that verdict, and the
two standing wiring limits. Identifiers are masked; the plan `owner/repo#issue`
is not, because it is the field that answers "is this pointed at the right
plan?".

```
atlas: GATE ARMED — ratifier principal pi••re(len21) (1 platform id(s); 1 self id(s)) · effects: plan=owner/repo#4 channel=ch••00(len16) base=main docPRs=disabled · state=durable · ledger=host-effect(…) · env=…
```

A misconfigured Atlas **runs and refuses audibly**; it never exits and burns
`maxRestarts`. Read the line: `GATE UNARMED` means every `RATIFY`/`DECLINE`
will be ignored.

### Two wiring limits worth knowing

1. **Ledger posts ride a live task.** `cortex-brain/v1` has no free-standing
   post effect, so the completion watcher and the reconcile loop can only
   *announce* while a task is in flight. Both still run on their intervals
   (detection and convergence are most of their value) and record nothing when
   they cannot post; the next inbound message carries the catch-up out.
2. **There is no channel read-back.** The protocol offers no way to read a
   channel, so post receipts are local ids and `reconcile.ts`'s deleted-post
   detector is inert by construction (it makes no claim without a reader).

License: MIT
