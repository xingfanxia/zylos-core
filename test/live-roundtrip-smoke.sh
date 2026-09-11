#!/usr/bin/env bash
# Reusable live roundtrip smoke probe for a single instance.
# Sends a synthetic Feishu DM through c4-receive, targets a specific instance,
# then verifies:
#   1. inbound message is delivered to the target instance
#   2. an outbound reply row is created with the expected token
#   3. the expected token is visible in the target Feishu chat via lark-cli
#
# Default behavior is intentionally safe for multi-session verification:
# the probe can target any instance, while the visible reply lands in the
# admin DM chat so real user chats are not disturbed.
#
# Usage:
#   bash test/live-roundtrip-smoke.sh --instance user-limh
#   bash test/live-roundtrip-smoke.sh --instance user-betty --cold-start
#   bash test/live-roundtrip-smoke.sh --instance admin --chat-id oc_xxx
set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*" >&2; }
info() { echo -e "${CYAN}INFO${RESET}: $*"; }
warn() { echo -e "${YELLOW}WARN${RESET}: $*"; }

usage() {
  cat <<'EOF'
Usage:
  bash test/live-roundtrip-smoke.sh --instance <instance-id> [options]

Options:
  --instance <id>           Target instance to probe (required)
  --chat-id <oc_xxx>        Feishu chat_id used for send/readback
  --endpoint <endpoint>     Full endpoint_id override (wins over --chat-id)
  --cold-start              Kill the target tmux session before sending
  --timeout <seconds>       Max wait for delivery/outbound rows (default: 90)
  --readback-timeout <sec>  Max wait for Lark chat readback (default: 30)
  --skip-chat-readback      Skip Lark chat verification step
  --probe-label <label>     Prefix for generated probe token
  --help                    Show this help

Notes:
  - If neither --chat-id nor --endpoint is provided, the script uses the first
    admin chat_id from ~/zylos/instances.json and builds a p2p endpoint from it.
  - Chat readback uses: lark-cli im +chat-messages-list --as user
EOF
}

INSTANCE_ID=""
CHAT_ID=""
ENDPOINT_ID=""
TIMEOUT=90
READBACK_TIMEOUT=30
COLD_START=false
SKIP_CHAT_READBACK=false
PROBE_LABEL="LIVEPROBE"

while [ $# -gt 0 ]; do
  case "$1" in
    --instance)
      INSTANCE_ID="${2:-}"
      shift 2
      ;;
    --chat-id)
      CHAT_ID="${2:-}"
      shift 2
      ;;
    --endpoint)
      ENDPOINT_ID="${2:-}"
      shift 2
      ;;
    --cold-start)
      COLD_START=true
      shift
      ;;
    --timeout)
      TIMEOUT="${2:-}"
      shift 2
      ;;
    --readback-timeout)
      READBACK_TIMEOUT="${2:-}"
      shift 2
      ;;
    --skip-chat-readback)
      SKIP_CHAT_READBACK=true
      shift
      ;;
    --probe-label)
      PROBE_LABEL="${2:-}"
      shift 2
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

if [ -z "$INSTANCE_ID" ]; then
  fail "--instance is required"
  usage
  exit 1
fi

ZYLOS_DIR="${ZYLOS_DIR:-$HOME/zylos}"
INSTANCES_JSON="$ZYLOS_DIR/instances.json"
C4_DB="$ZYLOS_DIR/comm-bridge/c4.db"
RECEIVE="$ZYLOS_DIR/.claude/skills/comm-bridge/scripts/c4-receive.js"

tmux_cmd() {
  env -u TMUX tmux "$@"
}

db_query() {
  local sql="$1"
  local result=""
  for _ in 1 2 3; do
    result=$(sqlite3 "$C4_DB" "$sql" 2>/dev/null || true)
    if [ -n "$result" ]; then
      printf '%s\n' "$result"
      return 0
    fi
    sleep 0.3
  done
  return 1
}

get_admin_chat_id() {
  python3 - "$INSTANCES_JSON" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
admin = cfg.get("instances", {}).get("admin", {})
chat_ids = admin.get("chat_ids") or []
print(chat_ids[0] if chat_ids else "")
PY
}

instance_exists() {
  python3 - "$INSTANCES_JSON" "$1" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
sys.exit(0 if sys.argv[2] in cfg.get("instances", {}) else 1)
PY
}

get_tmux_session() {
  python3 - "$INSTANCES_JSON" "$1" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
inst = cfg.get("instances", {}).get(sys.argv[2], {})
print(inst.get("tmux_session", ""))
PY
}

session_exists() {
  tmux_cmd has-session -t "$1" 2>/dev/null
}

wait_for_session_state() {
  local session="$1" desired="$2" timeout="$3"
  for _ in $(seq 1 "$timeout"); do
    if session_exists "$session"; then
      [ "$desired" = "present" ] && return 0
    else
      [ "$desired" = "absent" ] && return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_inbound_status() {
  local id="$1" expected="$2" timeout="$3"
  for _ in $(seq 1 "$timeout"); do
    local status
    status=$(sqlite3 "$C4_DB" "SELECT status FROM conversations WHERE id = $id;" 2>/dev/null || true)
    if [ "$status" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_outbound_token() {
  local token="$1" timeout="$2"
  local esc_token="${token//\'/\'\'}"
  for _ in $(seq 1 "$timeout"); do
    local row
    row=$(sqlite3 -separator '|' "$C4_DB" \
      "SELECT id, status, endpoint_id, timestamp FROM conversations WHERE direction = 'out' AND content = '$esc_token' ORDER BY id DESC LIMIT 1;" \
      2>/dev/null || true)
    if [ -n "$row" ]; then
      printf '%s\n' "$row"
      return 0
    fi
    sleep 1
  done
  return 1
}

chat_contains_token() {
  local chat_id="$1" token="$2"
  local output
  output=$(lark-cli im +chat-messages-list --as user --chat-id "$chat_id" --page-size 20 --sort desc --format json 2>/dev/null || true)
  [ -n "$output" ] || return 1
  python3 -c '
import json, sys
token = sys.argv[2]
try:
    data = json.loads(sys.argv[1])
except Exception:
    raise SystemExit(1)
if not data.get("ok"):
    raise SystemExit(1)
for msg in data.get("data", {}).get("messages", []):
    if msg.get("content") == token:
        print(msg.get("message_id", ""))
        raise SystemExit(0)
raise SystemExit(1)
' "$output" "$token"
}

wait_for_chat_readback() {
  local chat_id="$1" token="$2" timeout="$3"
  for _ in $(seq 1 "$timeout"); do
    local message_id
    if message_id=$(chat_contains_token "$chat_id" "$token"); then
      printf '%s\n' "$message_id"
      return 0
    fi
    sleep 1
  done
  return 1
}

if [ ! -f "$INSTANCES_JSON" ]; then
  fail "instances.json not found: $INSTANCES_JSON"
  exit 1
fi
if [ ! -f "$C4_DB" ]; then
  fail "c4.db not found: $C4_DB"
  exit 1
fi
if [ ! -f "$RECEIVE" ]; then
  fail "c4-receive.js not found: $RECEIVE"
  exit 1
fi

if ! instance_exists "$INSTANCE_ID"; then
  fail "Instance '$INSTANCE_ID' is not defined in $INSTANCES_JSON"
  exit 1
fi

if [ -z "$ENDPOINT_ID" ]; then
  if [ -z "$CHAT_ID" ]; then
    CHAT_ID=$(get_admin_chat_id)
  fi
  if [ -z "$CHAT_ID" ]; then
    fail "Could not determine admin chat_id; pass --chat-id or --endpoint"
    exit 1
  fi
  ENDPOINT_ID="${CHAT_ID}|type:p2p"
fi

if [ -z "$CHAT_ID" ]; then
  CHAT_ID="${ENDPOINT_ID%%|*}"
fi

if [ "$SKIP_CHAT_READBACK" = false ] && ! command -v lark-cli >/dev/null 2>&1; then
  fail "lark-cli is required unless --skip-chat-readback is set"
  exit 1
fi

SESSION_NAME=$(get_tmux_session "$INSTANCE_ID")
if [ -z "$SESSION_NAME" ]; then
  fail "No tmux_session configured for instance '$INSTANCE_ID'"
  exit 1
fi

if [ "$COLD_START" = true ] && [ "$INSTANCE_ID" = "admin" ]; then
  fail "--cold-start is not allowed for the primary admin instance"
  exit 1
fi

SAFE_INSTANCE=$(printf '%s' "$INSTANCE_ID" | tr -c '[:alnum:]' '_')
STAMP=$(date -u +%Y%m%d_%H%M%S)
PROBE_ID="${PROBE_LABEL}_${SAFE_INSTANCE}_${STAMP}_$$"
ACK_TOKEN="PROBE_ACK_${SAFE_INSTANCE}_${STAMP}_$$"

CONTENT=$(cat <<EOF
[Feishu DM] Xingfan said: <current-message>
${PROBE_ID}
Infrastructure verification only.
Target instance: ${INSTANCE_ID}
Reply exactly with: ${ACK_TOKEN}
</current-message>
EOF
)

info "Target instance: $INSTANCE_ID"
info "Reply endpoint: $ENDPOINT_ID"
info "Probe id: $PROBE_ID"
info "Expected reply: $ACK_TOKEN"

if [ "$COLD_START" = true ]; then
  if session_exists "$SESSION_NAME"; then
    info "Killing tmux session '$SESSION_NAME' before probe"
    tmux_cmd kill-session -t "$SESSION_NAME" 2>/dev/null || true
  else
    info "tmux session '$SESSION_NAME' is already stopped"
  fi
  if ! wait_for_session_state "$SESSION_NAME" absent 15; then
    fail "Failed to stop tmux session '$SESSION_NAME' before cold-start probe"
    exit 1
  fi
fi

QUEUE_JSON=$(node "$RECEIVE" \
  --channel feishu \
  --endpoint "$ENDPOINT_ID" \
  --target-instance "$INSTANCE_ID" \
  --json \
  --content "$CONTENT")

INBOUND_ID=$(python3 -c '
import json, sys
data = json.loads(sys.argv[1])
if not data.get("ok"):
    raise SystemExit(1)
print(data.get("id", ""))
' "$QUEUE_JSON")

if [ -z "$INBOUND_ID" ]; then
  fail "Probe was not queued correctly: $QUEUE_JSON"
  exit 1
fi

info "Queued inbound conversation id=$INBOUND_ID"

if [ "$COLD_START" = true ]; then
  if ! wait_for_session_state "$SESSION_NAME" present "$TIMEOUT"; then
    fail "tmux session '$SESSION_NAME' did not come back during cold-start probe"
    exit 1
  fi
  pass "Cold-start session '$SESSION_NAME' restarted"
fi

if ! wait_for_inbound_status "$INBOUND_ID" delivered "$TIMEOUT"; then
  LAST_STATUS=$(sqlite3 "$C4_DB" "SELECT status FROM conversations WHERE id = $INBOUND_ID;" 2>/dev/null || true)
  fail "Inbound conversation id=$INBOUND_ID did not reach status=delivered (final='${LAST_STATUS:-missing}')"
  exit 1
fi
pass "Inbound conversation id=$INBOUND_ID delivered to $INSTANCE_ID"

if ! OUTBOUND_ROW=$(wait_for_outbound_token "$ACK_TOKEN" "$TIMEOUT"); then
  fail "No outbound row found with expected token '$ACK_TOKEN'"
  exit 1
fi

IFS='|' read -r OUTBOUND_ID OUTBOUND_STATUS OUTBOUND_ENDPOINT OUTBOUND_TS <<<"$OUTBOUND_ROW"
if [ "$OUTBOUND_STATUS" != "delivered" ]; then
  fail "Outbound row id=$OUTBOUND_ID has unexpected status '$OUTBOUND_STATUS'"
  exit 1
fi
pass "Outbound row id=$OUTBOUND_ID created for expected reply token"

if [ "$SKIP_CHAT_READBACK" = false ]; then
  if ! READBACK_MSG_ID=$(wait_for_chat_readback "$CHAT_ID" "$ACK_TOKEN" "$READBACK_TIMEOUT"); then
    fail "Expected token '$ACK_TOKEN' was not observed in Feishu chat '$CHAT_ID'"
    exit 1
  fi
  pass "Feishu chat readback confirmed reply (message_id=$READBACK_MSG_ID)"
else
  warn "Skipping Feishu chat readback by request"
fi

echo
pass "Roundtrip smoke probe succeeded for instance '$INSTANCE_ID'"
echo "  inbound_id=$INBOUND_ID outbound_id=$OUTBOUND_ID endpoint=$OUTBOUND_ENDPOINT"
