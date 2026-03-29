#!/usr/bin/env bash
#
# Migrate memory/ from flat layout to multi-session layout.
#
# Creates shared/, instances/, groups/ directories and moves files
# to their new locations. Creates symlinks for backward compatibility.
#
# Safe to run multiple times (idempotent).
#
# Usage:
#   ZYLOS_DIR=~/zylos ./migrate-memory-layout.sh
#   # or just:
#   ./migrate-memory-layout.sh   (defaults to ~/zylos)

set -euo pipefail

ZYLOS_DIR="${ZYLOS_DIR:-$HOME/zylos}"
MEMORY_DIR="$ZYLOS_DIR/memory"
SHARED_DIR="$MEMORY_DIR/shared"
INSTANCES_DIR="$MEMORY_DIR/instances"
GROUPS_DIR="$MEMORY_DIR/groups"
INSTANCE_ID="${ZYLOS_INSTANCE_ID:-default}"

# Track what was done for summary
declare -a ACTIONS=()

log() {
  echo "[migrate] $*"
}

action() {
  ACTIONS+=("$1")
  log "$1"
}

# --- Pre-flight checks ---

if [ ! -d "$MEMORY_DIR" ]; then
  echo "Error: Memory directory not found at $MEMORY_DIR"
  echo "Set ZYLOS_DIR to your zylos installation directory."
  exit 1
fi

if [ -d "$SHARED_DIR" ]; then
  log "shared/ already exists -- migration was already run. Checking for completeness..."

  # Ensure instances dir exists
  if [ ! -d "$INSTANCES_DIR" ]; then
    mkdir -p "$INSTANCES_DIR"
    action "Created instances/"
  fi

  # Ensure groups dir exists
  if [ ! -d "$GROUPS_DIR" ]; then
    mkdir -p "$GROUPS_DIR"
    action "Created groups/"
  fi

  # Ensure default instance dir exists
  INST_DIR="$INSTANCES_DIR/$INSTANCE_ID"
  if [ ! -d "$INST_DIR" ]; then
    mkdir -p "$INST_DIR/sessions"
    action "Created instances/$INSTANCE_ID/"
  fi

  if [ ${#ACTIONS[@]} -eq 0 ]; then
    log "Nothing to do -- layout is already migrated."
  else
    log ""
    log "=== Migration Summary ==="
    for a in "${ACTIONS[@]}"; do
      log "  - $a"
    done
  fi
  exit 0
fi

# --- Create new directories ---

mkdir -p "$SHARED_DIR/reference"
action "Created shared/ and shared/reference/"

mkdir -p "$INSTANCES_DIR"
action "Created instances/"

mkdir -p "$GROUPS_DIR"
action "Created groups/"

INST_DIR="$INSTANCES_DIR/$INSTANCE_ID"
mkdir -p "$INST_DIR/sessions"
action "Created instances/$INSTANCE_ID/sessions/"

# --- Move shared files ---

# identity.md -> shared/identity.md
if [ -f "$MEMORY_DIR/identity.md" ] && [ ! -L "$MEMORY_DIR/identity.md" ]; then
  cp -p "$MEMORY_DIR/identity.md" "$SHARED_DIR/identity.md"
  rm "$MEMORY_DIR/identity.md"
  ln -s "shared/identity.md" "$MEMORY_DIR/identity.md"
  action "Moved identity.md -> shared/identity.md (symlink created)"
fi

# references.md -> shared/references.md
if [ -f "$MEMORY_DIR/references.md" ] && [ ! -L "$MEMORY_DIR/references.md" ]; then
  cp -p "$MEMORY_DIR/references.md" "$SHARED_DIR/references.md"
  rm "$MEMORY_DIR/references.md"
  ln -s "shared/references.md" "$MEMORY_DIR/references.md"
  action "Moved references.md -> shared/references.md (symlink created)"
fi

# reference/ -> shared/reference/
if [ -d "$MEMORY_DIR/reference" ] && [ ! -L "$MEMORY_DIR/reference" ]; then
  # Copy all files from reference/ to shared/reference/
  for f in "$MEMORY_DIR/reference/"*; do
    [ -e "$f" ] || continue
    cp -rp "$f" "$SHARED_DIR/reference/"
  done
  rm -rf "$MEMORY_DIR/reference"
  ln -s "shared/reference" "$MEMORY_DIR/reference"
  action "Moved reference/ -> shared/reference/ (symlink created)"
fi

# --- Move instance files ---

# state.md -> instances/<id>/state.md
if [ -f "$MEMORY_DIR/state.md" ] && [ ! -L "$MEMORY_DIR/state.md" ]; then
  cp -p "$MEMORY_DIR/state.md" "$INST_DIR/state.md"
  rm "$MEMORY_DIR/state.md"
  ln -s "instances/$INSTANCE_ID/state.md" "$MEMORY_DIR/state.md"
  action "Moved state.md -> instances/$INSTANCE_ID/state.md (symlink created)"
fi

# sessions/ -> instances/<id>/sessions/
if [ -d "$MEMORY_DIR/sessions" ] && [ ! -L "$MEMORY_DIR/sessions" ]; then
  # Copy all session files
  for f in "$MEMORY_DIR/sessions/"*; do
    [ -e "$f" ] || continue
    cp -rp "$f" "$INST_DIR/sessions/"
  done
  rm -rf "$MEMORY_DIR/sessions"
  ln -s "instances/$INSTANCE_ID/sessions" "$MEMORY_DIR/sessions"
  action "Moved sessions/ -> instances/$INSTANCE_ID/sessions/ (symlink created)"
fi

# --- Summary ---

log ""
log "=== Migration Summary ==="
log "Memory directory: $MEMORY_DIR"
log "Instance ID: $INSTANCE_ID"
log ""
for a in "${ACTIONS[@]}"; do
  log "  - $a"
done
log ""
log "Directories kept in place: users/, archive/"
log "Symlinks created for backward compatibility."
log ""
log "New layout:"
log "  $MEMORY_DIR/"
log "  +-- shared/identity.md"
log "  +-- shared/references.md"
log "  +-- shared/reference/{decisions,projects,preferences,ideas}.md"
log "  +-- instances/$INSTANCE_ID/state.md"
log "  +-- instances/$INSTANCE_ID/sessions/current.md"
log "  +-- groups/ (empty, created on demand)"
log "  +-- users/ (unchanged)"
log "  +-- archive/ (unchanged)"
log ""
log "Migration complete."
