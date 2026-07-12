#!/usr/bin/env bash
# Full live smoke suite for deployed Zylos infrastructure.
#
# Coverage model:
#   1. Run the existing e2e-live.sh suite for routing, queueing, DB delivery,
#      cold auto-start, scheduler/group/admin delivery, and memory isolation.
#   2. Run real Feishu roundtrip probes for the admin instance plus every enabled
#      user instance, with visible replies landing in the admin DM chat.
#
# This combines broad infra coverage with a reusable external-channel roundtrip
# check, while avoiding pings to real user chats.
#
# Usage:
#   bash test/full-smoke-live.sh
#   bash test/full-smoke-live.sh --instances admin,user-limh --skip-chat-readback
set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
pass() { echo -e "${GREEN}  PASS${RESET}: $*"; }
fail() { echo -e "${RED}  FAIL${RESET}: $*"; }
info() { echo -e "${CYAN}  INFO${RESET}: $*"; }
section() { echo; echo -e "${CYAN}=== $* ===${RESET}"; }

usage() {
  cat <<'EOF'
Usage:
  bash test/full-smoke-live.sh [options]

Options:
  --instances <csv>         Override roundtrip probe instances
  --chat-id <oc_xxx>        Admin/readback Feishu chat_id override
  --skip-chat-readback      Skip Lark chat verification inside roundtrip probes
  --skip-e2e                Skip the broader e2e-live.sh suite
  --help                    Show this help
EOF
}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZYLOS_DIR="${ZYLOS_DIR:-$HOME/zylos}"
INSTANCES_JSON="$ZYLOS_DIR/instances.json"
E2E_SCRIPT="$REPO_DIR/test/e2e-live.sh"
ROUNDTRIP_SCRIPT="$REPO_DIR/test/live-roundtrip-smoke.sh"

INSTANCES_CSV=""
CHAT_ID=""
SKIP_CHAT_READBACK=false
SKIP_E2E=false

while [ $# -gt 0 ]; do
  case "$1" in
    --instances)
      INSTANCES_CSV="${2:-}"
      shift 2
      ;;
    --chat-id)
      CHAT_ID="${2:-}"
      shift 2
      ;;
    --skip-chat-readback)
      SKIP_CHAT_READBACK=true
      shift
      ;;
    --skip-e2e)
      SKIP_E2E=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [ ! -f "$INSTANCES_JSON" ]; then
  fail "instances.json not found: $INSTANCES_JSON"
  exit 1
fi
if [ ! -f "$E2E_SCRIPT" ]; then
  fail "Missing script: $E2E_SCRIPT"
  exit 1
fi
if [ ! -f "$ROUNDTRIP_SCRIPT" ]; then
  fail "Missing script: $ROUNDTRIP_SCRIPT"
  exit 1
fi

if [ -z "$CHAT_ID" ]; then
  CHAT_ID=$(python3 - "$INSTANCES_JSON" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
chat_ids = cfg.get("instances", {}).get("admin", {}).get("chat_ids") or []
print(chat_ids[0] if chat_ids else "")
PY
)
fi

if [ -z "$CHAT_ID" ]; then
  fail "Could not determine admin chat_id; pass --chat-id explicitly"
  exit 1
fi

if [ -z "$INSTANCES_CSV" ]; then
  INSTANCES_CSV=$(python3 - "$INSTANCES_JSON" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
ids = []
for inst_id, inst in cfg.get("instances", {}).items():
    if not inst.get("enabled", True):
        continue
    if inst_id == "admin" or inst.get("type") == "user":
        ids.append(inst_id)
print(",".join(ids))
PY
)
fi

IFS=',' read -r -a ROUNDTRIP_INSTANCES <<<"$INSTANCES_CSV"
if [ "${#ROUNDTRIP_INSTANCES[@]}" -eq 0 ] || [ -z "${ROUNDTRIP_INSTANCES[0]}" ]; then
  fail "No roundtrip instances selected"
  exit 1
fi

PASS_COUNT=0
FAIL_COUNT=0

run_step() {
  local label="$1"
  shift
  section "$label"
  if "$@"; then
    PASS_COUNT=$((PASS_COUNT + 1))
    pass "$label"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    fail "$label"
  fi
}

section "Plan"
info "Admin/readback chat_id: $CHAT_ID"
info "Roundtrip probe instances: ${ROUNDTRIP_INSTANCES[*]}"
if [ "$SKIP_CHAT_READBACK" = true ]; then
  info "Roundtrip probes will skip Lark chat readback"
fi

if [ "$SKIP_E2E" = false ]; then
  run_step "E2E live smoke suite" bash "$E2E_SCRIPT"
else
  info "Skipping e2e-live.sh by request"
fi

for instance_id in "${ROUNDTRIP_INSTANCES[@]}"; do
  args=(bash "$ROUNDTRIP_SCRIPT" --instance "$instance_id" --chat-id "$CHAT_ID")
  if [ "$SKIP_CHAT_READBACK" = true ]; then
    args+=(--skip-chat-readback)
  fi
  run_step "Feishu roundtrip probe ($instance_id)" "${args[@]}"
done

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Results: ${GREEN}${PASS_COUNT} passed${RESET}  ${RED}${FAIL_COUNT} failed${RESET}  (${TOTAL} total)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

[ "$FAIL_COUNT" -eq 0 ]
