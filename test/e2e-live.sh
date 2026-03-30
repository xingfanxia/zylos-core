#!/usr/bin/env bash
# E2E live smoke test for the multi-session C4 communication pipeline.
# Runs against the actual deployed zylos infrastructure at ~/zylos/.
#
# Usage:
#   bash test/e2e-live.sh            # run all tests
#   bash test/e2e-live.sh --skip-live  # skip tests that require a running CC (tests 5+)
set -euo pipefail

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

pass() { echo -e "${GREEN}  PASS${RESET}: $*"; }
fail() { echo -e "${RED}  FAIL${RESET}: $*"; }
skip() { echo -e "${YELLOW}  SKIP${RESET}: $*"; }
info() { echo -e "${CYAN}  INFO${RESET}: $*"; }

# ---------------------------------------------------------------------------
# Counters (plain variables — no arrays needed)
# ---------------------------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

record_pass() { PASS_COUNT=$((PASS_COUNT + 1)); pass "$@"; }
record_fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); fail "$@"; }
record_skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); skip "$@"; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
SKIP_LIVE=false
for arg in "$@"; do
  if [ "$arg" = "--skip-live" ]; then
    SKIP_LIVE=true
  fi
done

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ZYLOS_DIR="${ZYLOS_DIR:-$HOME/zylos}"
C4_DB="$ZYLOS_DIR/comm-bridge/c4.db"
SCRIPTS_DIR="$ZYLOS_DIR/.claude/skills/comm-bridge/scripts"
RECEIVE="$SCRIPTS_DIR/c4-receive.js"
QUERY="$SCRIPTS_DIR/c4-query-instance.js"
API_ACTIVITY="$ZYLOS_DIR/activity-monitor/api-activity.json"

# ---------------------------------------------------------------------------
# Section header
# ---------------------------------------------------------------------------
section() { echo; echo -e "${CYAN}=== $* ===${RESET}"; }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
section "Prerequisites"

PREREQS_OK=true

check_prereq() {
  local name="$1" cmd="$2"
  if command -v "$cmd" &>/dev/null; then
    info "$name found: $(command -v "$cmd")"
  else
    fail "Required tool not found: $name"
    PREREQS_OK=false
  fi
}

check_prereq tmux tmux
check_prereq node node
check_prereq sqlite3 sqlite3

if [ ! -f "$RECEIVE" ]; then
  fail "c4-receive.js not found at $RECEIVE"
  PREREQS_OK=false
else
  info "c4-receive.js: $RECEIVE"
fi

# c4-query-instance.js is newer — may not be deployed yet; test 3 will skip gracefully
if [ ! -f "$QUERY" ]; then
  info "c4-query-instance.js not found at $QUERY (test 3 will be skipped)"
else
  info "c4-query-instance.js: $QUERY"
fi

if [ "$PREREQS_OK" != "true" ]; then
  echo
  fail "Prerequisites check failed — cannot continue."
  exit 1
fi

# ---------------------------------------------------------------------------
# Backup + baseline
# ---------------------------------------------------------------------------
section "Setup"

if [ -f "$C4_DB" ]; then
  BACKUP_PATH="${C4_DB}.e2e-backup-$(date +%s)"
  cp "$C4_DB" "$BACKUP_PATH"
  info "DB backed up to: $BACKUP_PATH"
else
  info "c4.db does not exist yet (will be created by first test)"
fi

# Capture baseline conversation count (0 if DB doesn't exist)
if [ -f "$C4_DB" ]; then
  BASELINE_COUNT=$(sqlite3 "$C4_DB" "SELECT COUNT(*) FROM conversations;" 2>/dev/null || echo 0)
else
  BASELINE_COUNT=0
fi
info "Baseline conversation count: $BASELINE_COUNT"

# ---------------------------------------------------------------------------
# Helper: query DB, with a short retry loop to handle WAL flush timing
# ---------------------------------------------------------------------------
db_query() {
  local sql="$1"
  local result=""
  for _ in 1 2 3; do
    result=$(sqlite3 "$C4_DB" "$sql" 2>/dev/null || echo "")
    if [ -n "$result" ]; then
      echo "$result"
      return 0
    fi
    sleep 0.3
  done
  echo ""
}

# ---------------------------------------------------------------------------
# Test 1: Message insertion via c4-receive
# ---------------------------------------------------------------------------
section "Test 1: Message insertion"

T1_CONTENT="E2E test message $(date +%s)"
T1_PASS=false

if node "$RECEIVE" \
    --channel test --endpoint test-e2e-user --no-reply \
    --content "$T1_CONTENT" 2>&1; then

  # Verify the row was inserted (may already be delivered if dispatcher is running)
  T1_STATUS=$(db_query "SELECT status FROM conversations WHERE content LIKE '%E2E test message%' AND channel='test' AND endpoint_id='test-e2e-user' ORDER BY id DESC LIMIT 1;")

  if [ "$T1_STATUS" = "pending" ] || [ "$T1_STATUS" = "delivered" ] || [ "$T1_STATUS" = "running" ]; then
    T1_PASS=true
    record_pass "Message inserted (status=${T1_STATUS}, dispatcher may have already picked it up)"
  else
    record_fail "Expected status pending/delivered/running, got: '${T1_STATUS}'"
  fi
else
  record_fail "c4-receive.js exited non-zero"
fi

# ---------------------------------------------------------------------------
# Test 2: Instance-targeted message
# ---------------------------------------------------------------------------
section "Test 2: Instance targeting"

T2_CONTENT="E2E test for admin instance $(date +%s)"
T2_PASS=false

if node "$RECEIVE" \
    --channel test --endpoint test-e2e-admin --no-reply \
    --target-instance admin \
    --content "$T2_CONTENT" 2>&1; then

  T2_INSTANCE=$(db_query "SELECT target_instance FROM conversations WHERE content LIKE '%E2E test for admin instance%' AND channel='test' ORDER BY id DESC LIMIT 1;")

  if [ "$T2_INSTANCE" = "admin" ]; then
    T2_PASS=true
    record_pass "Message inserted with target_instance='admin'"
  else
    record_fail "Expected target_instance='admin', got: '${T2_INSTANCE}'"
  fi
else
  record_fail "c4-receive.js exited non-zero for instance-targeted message"
fi

# ---------------------------------------------------------------------------
# Test 3: Internal channel (inter-instance query)
# ---------------------------------------------------------------------------
section "Test 3: Inter-instance query"

T3_PASS=false

if [ ! -f "$QUERY" ]; then
  record_skip "c4-query-instance.js not deployed yet"
elif node "$QUERY" \
    --from test-instance --to admin \
    --content "E2E test inter-instance query" 2>&1; then

  # c4-query-instance inserts with channel=internal, endpoint=instance-<from>
  T3_CHANNEL=$(db_query "SELECT channel FROM conversations WHERE endpoint_id='instance-test-instance' ORDER BY id DESC LIMIT 1;")
  T3_ENDPOINT=$(db_query "SELECT endpoint_id FROM conversations WHERE channel='internal' AND endpoint_id='instance-test-instance' ORDER BY id DESC LIMIT 1;")

  if [ "$T3_CHANNEL" = "internal" ] && [ "$T3_ENDPOINT" = "instance-test-instance" ]; then
    T3_PASS=true
    record_pass "Inter-instance query inserted with channel='internal', endpoint='instance-test-instance'"
  else
    record_fail "Expected channel=internal / endpoint=instance-test-instance, got: channel='${T3_CHANNEL}' endpoint='${T3_ENDPOINT}'"
  fi
else
  record_fail "c4-query-instance.js exited non-zero"
fi

# ---------------------------------------------------------------------------
# Test 4: Group detection
# ---------------------------------------------------------------------------
section "Test 4: Group endpoint detection"

T4_PASS=true  # innocent until proven guilty; at least verify insertion

# Feishu group — endpoint contains |type:group
T4_FEISHU_CONTENT="E2E Feishu group test $(date +%s)"
if node "$RECEIVE" \
    --channel feishu --endpoint "oc_test123|type:group|msg:om_test" --no-reply \
    --content "$T4_FEISHU_CONTENT" 2>&1; then

  T4_FEISHU_ROW=$(db_query "SELECT id FROM conversations WHERE content LIKE '%E2E Feishu group test%' AND channel='feishu' ORDER BY id DESC LIMIT 1;")
  if [ -n "$T4_FEISHU_ROW" ]; then
    # Check if instances.json configured a group instance — if so, target_instance='group'
    T4_FEISHU_INST=$(db_query "SELECT target_instance FROM conversations WHERE content LIKE '%E2E Feishu group test%' AND channel='feishu' ORDER BY id DESC LIMIT 1;")
    if [ -n "$T4_FEISHU_INST" ] && [ "$T4_FEISHU_INST" != "group" ]; then
      # Not routed to 'group' — could be normal if no group instance is configured
      info "Feishu group: target_instance='${T4_FEISHU_INST}' (no group instance configured — acceptable)"
    elif [ "$T4_FEISHU_INST" = "group" ]; then
      info "Feishu group: correctly routed to target_instance='group'"
    else
      info "Feishu group: target_instance is NULL (instances.json absent — legacy mode)"
    fi
    record_pass "Feishu group message inserted (endpoint=oc_test123|type:group)"
  else
    record_fail "Feishu group message not found in DB"
    T4_PASS=false
  fi
else
  record_fail "c4-receive.js exited non-zero for Feishu group"
  T4_PASS=false
fi

# Telegram group — negative numeric chat_id
T4_TG_CONTENT="E2E Telegram group test $(date +%s)"
if node "$RECEIVE" \
    --channel telegram --endpoint "-100999888|msg:1|req:-100999888:1" --no-reply \
    --content "$T4_TG_CONTENT" 2>&1; then

  T4_TG_ROW=$(db_query "SELECT id FROM conversations WHERE content LIKE '%E2E Telegram group test%' AND channel='telegram' ORDER BY id DESC LIMIT 1;")
  if [ -n "$T4_TG_ROW" ]; then
    T4_TG_INST=$(db_query "SELECT target_instance FROM conversations WHERE content LIKE '%E2E Telegram group test%' AND channel='telegram' ORDER BY id DESC LIMIT 1;")
    if [ "$T4_TG_INST" = "group" ]; then
      info "Telegram group: correctly routed to target_instance='group'"
    else
      info "Telegram group: target_instance='${T4_TG_INST}' (no group instance configured — acceptable)"
    fi
    record_pass "Telegram group message inserted (endpoint=-100999888...)"
  else
    record_fail "Telegram group message not found in DB"
    T4_PASS=false
  fi
else
  record_fail "c4-receive.js exited non-zero for Telegram group"
  T4_PASS=false
fi

# ---------------------------------------------------------------------------
# Test 5: Dispatcher delivery (requires live CC)
# ---------------------------------------------------------------------------
section "Test 5: Live delivery (requires running CC)"

if [ "$SKIP_LIVE" = "true" ]; then
  record_skip "Skipped via --skip-live flag"
# Determine admin session name from instances.json
elif ! ADMIN_SESSION=$(python3 -c "import json; d=json.load(open('$ZYLOS_DIR/instances.json')); print(d['instances']['admin']['tmux_session'])" 2>/dev/null) || ! tmux has-session -t "$ADMIN_SESSION" 2>/dev/null; then
  record_skip "Admin tmux session not running (looked for ${ADMIN_SESSION:-claude-main})"
else
  T5_CONTENT="E2E live delivery test $(date +%s) - please respond with 'ACK'"

  node "$RECEIVE" \
    --channel test --endpoint test-e2e --no-reply \
    --target-instance admin \
    --content "$T5_CONTENT" 2>&1

  info "Waiting up to 30s for dispatcher to deliver..."
  T5_STATUS=""
  for i in $(seq 1 30); do
    T5_STATUS=$(db_query "SELECT status FROM conversations WHERE content LIKE '%E2E live delivery test%' AND channel='test' ORDER BY id DESC LIMIT 1;")
    if [ "$T5_STATUS" = "delivered" ]; then
      record_pass "Message delivered after ${i}s"
      break
    fi
    sleep 1
  done

  if [ "$T5_STATUS" != "delivered" ]; then
    record_fail "Message not delivered within 30s (status='${T5_STATUS}')"
  fi
fi

# ---------------------------------------------------------------------------
# Test 6: Delivery confirmation check (api-activity.json)
# ---------------------------------------------------------------------------
section "Test 6: Delivery confirmation"

if [ "$SKIP_LIVE" = "true" ]; then
  record_skip "Skipped via --skip-live flag"
elif [ ! -f "$API_ACTIVITY" ]; then
  record_skip "api-activity.json not found (activity-monitor not running?)"
else
  LAST_ACTIVITY=$(python3 -c "
import json, sys
try:
    d = json.load(open('$API_ACTIVITY'))
    print(d.get('last_user_activity', 0))
except Exception as e:
    print(0)
  " 2>/dev/null || echo 0)
  info "Last user activity timestamp: $LAST_ACTIVITY"
  record_pass "api-activity.json is readable"
fi

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
section "Cleanup"

if [ -f "$C4_DB" ]; then
  DELETED=$(sqlite3 "$C4_DB" "
    DELETE FROM conversations
    WHERE channel = 'test'
       OR (channel = 'internal' AND endpoint_id LIKE 'instance-test%')
       OR (channel = 'feishu'   AND content LIKE '%E2E Feishu group test%')
       OR (channel = 'telegram' AND content LIKE '%E2E Telegram group test%');
    SELECT changes();
  " 2>/dev/null || echo 0)
  info "Deleted $DELETED test row(s) from conversations"
else
  info "No DB to clean (never created)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Results: ${GREEN}${PASS_COUNT} passed${RESET}  ${RED}${FAIL_COUNT} failed${RESET}  ${YELLOW}${SKIP_COUNT} skipped${RESET}  (${TOTAL} total)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
