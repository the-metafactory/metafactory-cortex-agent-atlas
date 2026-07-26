#!/usr/bin/env bash
# Lifecycle postinstall step 2: scaffold the agent's instance state — the
# OPTIONAL memory module declared in arc-manifest.yaml (`state:`).
#
# Delegates to the agent-state bundle's ScaffoldFolders workflow, which lays
# down ~/.config/cortex/agents/atlas/{state.sqlite, dashboard.md, context/,
# retros/, CLAUDE.md}. Idempotent — safe on reinstall and upgrade;
# operator-edited files are preserved. This is also the tree
# arc-manifest.yaml's `owns.state` names, so a clean `arc purge` depends on
# this scaffold and the running agent agreeing on the same path.
#
# Ordering invariant: runs LAST — state is additive; the agent must be
# registered (step 1) whether or not it remembers.
#
# Soft-skip: agents are stateless by default ("bring your own grounding") and
# this pack must install cleanly without the agent-state bundle. Missing bun
# or missing bundle → skip with a hint. A bundle that IS present but fails to
# scaffold is a real error.
set -euo pipefail

# Bundle-root resolution mirrors brain/state.ts's `defaultBundleDir()` and
# cortex's `resolveArcPackReposDir()` (cortex#2007): canonical XDG tree
# (`$XDG_DATA_HOME`, else `~/.local/share`) first, existence-gated fall back
# to the legacy pre-arc#287 `~/.config/metafactory/pkg/repos` tree, else the
# canonical path (a fresh host with no bundle installed at all — the
# "not installed" skip below then fires correctly). atlas#15/#19: the old
# unconditional legacy default meant this script (like the brain) resolved a
# stale April clone instead of the bundle arc actually installs today.
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CANONICAL_SCAFFOLD="$DATA_HOME/metafactory/arc/repos/agent-state/skill/scripts/scaffold.ts"
LEGACY_SCAFFOLD="$HOME/.config/metafactory/pkg/repos/agent-state/skill/scripts/scaffold.ts"

if [ -n "${AGENT_STATE_SCAFFOLD:-}" ]; then
  SCAFFOLD="$AGENT_STATE_SCAFFOLD"
elif [ -f "$CANONICAL_SCAFFOLD" ]; then
  SCAFFOLD="$CANONICAL_SCAFFOLD"
elif [ -f "$LEGACY_SCAFFOLD" ]; then
  SCAFFOLD="$LEGACY_SCAFFOLD"
else
  SCAFFOLD="$CANONICAL_SCAFFOLD"
fi
INSTANCE_DIR="${MF_INSTANCE_DIR:-$HOME/.config/cortex/agents/atlas}"

if ! command -v bun >/dev/null 2>&1; then
  echo "atlas postinstall: bun not on PATH — skipping state scaffold (the agent runs stateless; install bun and re-run scripts/scaffold-state.sh to opt in)"
  exit 0
fi

if [ ! -f "$SCAFFOLD" ]; then
  echo "atlas postinstall: agent-state bundle not installed — skipping state scaffold (the agent runs stateless; 'arc install agent-state' and re-run scripts/scaffold-state.sh to opt in)"
  exit 0
fi

if bun "$SCAFFOLD" "$INSTANCE_DIR" --host=cortex --agent=atlas; then
  echo "atlas postinstall: instance state scaffolded at $INSTANCE_DIR — ok"
else
  echo "atlas postinstall: state scaffold FAILED" >&2
  exit 1
fi
