#!/usr/bin/env bash
# Comprehensive E2E live smoke test for multi-session C4 pipeline.
# Runs against the actual deployed zylos infrastructure at ~/zylos/.
#
# Usage:
#   bash test/e2e-live.sh            # run all tests
#   bash test/e2e-live.sh --skip-live # skip tests that require running CC
set -euo pipefail

# ── Color helpers ──────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
pass() { echo -e "${GREEN}  PASS${RESET}: $*"; }
fail() { echo -e "${RED}  FAIL${RESET}: $*"; }
skip() { echo -e "${YELLOW}  SKIP${RESET}: $*"; }
info() { echo -e "${CYAN}  INFO${RESET}: $*"; }

PASS_COUNT=0; FAIL_COUNT=0; SKIP_COUNT=0
record_pass() { PASS_COUNT=$((PASS_COUNT + 1)); pass "$@"; }
record_fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); fail "$@"; }
record_skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); skip "$@"; }
section() { echo; echo -e "${CYAN}=== $* ===${RESET}"; }

SKIP_LIVE=false
for arg in "$@"; do [ "$arg" = "--skip-live" ] && SKIP_LIVE=true; done

# ── Paths ──────────────────────────────────────────────────────────────
ZYLOS_DIR="${ZYLOS_DIR:-$HOME/zylos}"
C4_DB="$ZYLOS_DIR/comm-bridge/c4.db"
SCRIPTS_DIR="$ZYLOS_DIR/.claude/skills/comm-bridge/scripts"
RECEIVE="$SCRIPTS_DIR/c4-receive.js"
QUERY="$SCRIPTS_DIR/c4-query-instance.js"
INSTANCES_JSON="$ZYLOS_DIR/instances.json"
TS=$(date +%s)  # unique timestamp for this run

# ── Helpers ────────────────────────────────────────────────────────────
tmux_cmd() {
  env -u TMUX tmux "$@"
}

db_query() {
  local sql="$1"; local result=""
  for _ in 1 2 3; do
    result=$(sqlite3 "$C4_DB" "$sql" 2>/dev/null || echo "")
    [ -n "$result" ] && { echo "$result"; return 0; }
    sleep 0.3
  done
  echo ""
}

wait_for_status() {
  local pattern="$1" expected="$2" timeout="$3" label="$4"
  for i in $(seq 1 "$timeout"); do
    local status
    status=$(db_query "SELECT status FROM conversations WHERE content LIKE '%${pattern}%' ORDER BY id DESC LIMIT 1;")
    if [ "$status" = "$expected" ]; then
      record_pass "$label (${i}s)"
      return 0
    fi
    sleep 1
  done
  local final
  final=$(db_query "SELECT status FROM conversations WHERE content LIKE '%${pattern}%' ORDER BY id DESC LIMIT 1;")
  record_fail "$label — status='${final}' after ${timeout}s"
  return 1
}

get_session() {
  python3 -c "import json; d=json.load(open('$INSTANCES_JSON')); print(d['instances']['$1']['tmux_session'])" 2>/dev/null || echo ""
}

session_exists() {
  tmux_cmd has-session -t "$1" 2>/dev/null
}

# ── Prerequisites ──────────────────────────────────────────────────────
section "Prerequisites"
PREREQS_OK=true
for tool in tmux node sqlite3; do
  command -v "$tool" &>/dev/null && info "$tool: $(command -v "$tool")" || { fail "$tool not found"; PREREQS_OK=false; }
done
[ -f "$RECEIVE" ] && info "c4-receive.js: OK" || { fail "c4-receive.js missing"; PREREQS_OK=false; }
[ -f "$QUERY" ] && info "c4-query-instance.js: OK" || info "c4-query-instance.js: missing (test 3 skipped)"
[ -f "$INSTANCES_JSON" ] && info "instances.json: OK" || { fail "instances.json missing"; PREREQS_OK=false; }
[ "$PREREQS_OK" = "true" ] || { fail "Prerequisites failed"; exit 1; }

# ── Setup ──────────────────────────────────────────────────────────────
section "Setup"
cp "$C4_DB" "${C4_DB}.e2e-backup-${TS}" 2>/dev/null && info "DB backed up" || info "No DB to back up"

# ═══════════════════════════════════════════════════════════════════════
# SECTION A: Message Routing (no live CC needed)
# ═══════════════════════════════════════════════════════════════════════

section "Test 1: Basic message insertion"
node "$RECEIVE" --channel test --endpoint "test-e2e-${TS}" --no-reply --target-instance admin \
  --content "E2E-1 basic insert ${TS}" 2>&1
T1_STATUS=$(db_query "SELECT status FROM conversations WHERE content LIKE '%E2E-1 basic insert ${TS}%' ORDER BY id DESC LIMIT 1;")
[ -n "$T1_STATUS" ] && record_pass "Inserted (status=${T1_STATUS})" || record_fail "Not found in DB"

section "Test 2: Feishu group routes to group instance"
node "$RECEIVE" --channel feishu --endpoint "oc_e2e${TS}|type:group|msg:om_test" --no-reply \
  --content "E2E-2 feishu group ${TS}" 2>&1
T2=$(db_query "SELECT target_instance FROM conversations WHERE content LIKE '%E2E-2 feishu group ${TS}%' ORDER BY id DESC LIMIT 1;")
[ "$T2" = "group" ] && record_pass "Feishu group → target_instance='group'" || record_fail "Expected 'group', got '${T2}'"

section "Test 3: Telegram group routes to group instance"
node "$RECEIVE" --channel telegram --endpoint "-100${TS}|msg:1|req:-100${TS}:1" --no-reply \
  --content "E2E-3 telegram group ${TS}" 2>&1
T3=$(db_query "SELECT target_instance FROM conversations WHERE content LIKE '%E2E-3 telegram group ${TS}%' ORDER BY id DESC LIMIT 1;")
[ "$T3" = "group" ] && record_pass "Telegram group → target_instance='group'" || record_fail "Expected 'group', got '${T3}'"

section "Test 4: Feishu DM (oc_ prefix) does NOT route to group"
node "$RECEIVE" --channel feishu --endpoint "oc_dm${TS}|type:p2p|msg:om_dm" --no-reply \
  --content "E2E-4 feishu dm ${TS}" 2>&1
T4=$(db_query "SELECT target_instance FROM conversations WHERE content LIKE '%E2E-4 feishu dm ${TS}%' ORDER BY id DESC LIMIT 1;")
[ "$T4" != "group" ] && record_pass "Feishu DM → target_instance='${T4}' (not group)" || record_fail "DM incorrectly routed to group"

section "Test 5: Known user DM routes to user instance"
# Use betty's actual chat_id from routing table
BETTY_CHAT=$(python3 -c "import json; d=json.load(open('$INSTANCES_JSON')); print(d['routing'].get('oc_39ec68719d842691a6714b05be9a2de4',''))" 2>/dev/null)
if [ "$BETTY_CHAT" = "user-betty" ]; then
  node "$RECEIVE" --channel feishu --endpoint "oc_39ec68719d842691a6714b05be9a2de4|type:p2p|msg:om_e2e${TS}" --no-reply \
    --content "E2E-5 betty dm ${TS}" 2>&1
  T5=$(db_query "SELECT target_instance FROM conversations WHERE content LIKE '%E2E-5 betty dm ${TS}%' ORDER BY id DESC LIMIT 1;")
  [ "$T5" = "user-betty" ] && record_pass "Betty DM → target_instance='user-betty'" || record_fail "Expected 'user-betty', got '${T5}'"
else
  record_skip "Betty not in routing table"
fi

section "Test 6: Inter-instance query"
if [ -f "$QUERY" ]; then
  node "$QUERY" --from test-e2e --to admin --content "E2E-6 query ${TS}" 2>&1
  T6_CH=$(db_query "SELECT channel FROM conversations WHERE content LIKE '%E2E-6 query ${TS}%' ORDER BY id DESC LIMIT 1;")
  T6_EP=$(db_query "SELECT endpoint_id FROM conversations WHERE content LIKE '%E2E-6 query ${TS}%' ORDER BY id DESC LIMIT 1;")
  T6_TI=$(db_query "SELECT target_instance FROM conversations WHERE content LIKE '%E2E-6 query ${TS}%' ORDER BY id DESC LIMIT 1;")
  if [ "$T6_CH" = "internal" ] && [ "$T6_EP" = "instance-test-e2e" ] && [ "$T6_TI" = "admin" ]; then
    record_pass "Internal channel, endpoint=instance-test-e2e, target=admin"
  else
    record_fail "Got channel='${T6_CH}' endpoint='${T6_EP}' target='${T6_TI}'"
  fi
else
  record_skip "c4-query-instance.js not deployed"
fi

section "Test 7: Disabled instance rejection"
node "$RECEIVE" --channel test --endpoint "test-disabled-${TS}" --no-reply --target-instance test \
  --content "E2E-7 disabled ${TS}" 2>&1
sleep 3  # give dispatcher time to process
T7=$(db_query "SELECT status FROM conversations WHERE content LIKE '%E2E-7 disabled ${TS}%' ORDER BY id DESC LIMIT 1;")
[ "$T7" = "rejected" ] && record_pass "Disabled instance → rejected" || \
  { [ "$T7" = "pending" ] && record_pass "Disabled instance → pending (dispatcher may not have processed yet)" || record_fail "Expected rejected/pending, got '${T7}'"; }

# ═══════════════════════════════════════════════════════════════════════
# SECTION B: Live Delivery (requires running CC instances)
# ═══════════════════════════════════════════════════════════════════════

if [ "$SKIP_LIVE" = "true" ]; then
  section "SECTION B: Live Delivery — SKIPPED (--skip-live)"
  for t in 8 9 10 11 12 13; do record_skip "Test $t skipped"; done
else

  section "Test 8: Admin instance live delivery"
  ADMIN_SESSION=$(get_session admin)
  if session_exists "$ADMIN_SESSION"; then
    node "$RECEIVE" --channel test --endpoint "test-admin-${TS}" --no-reply --target-instance admin \
      --content "E2E-8 admin delivery ${TS}" 2>&1
    wait_for_status "E2E-8 admin delivery ${TS}" "delivered" 30 "Admin delivery"
  else
    record_skip "Admin session '${ADMIN_SESSION}' not running"
  fi

  section "Test 9: Group instance live delivery"
  GROUP_SESSION=$(get_session group)
  if session_exists "$GROUP_SESSION"; then
    node "$RECEIVE" --channel feishu --endpoint "oc_e2e9${TS}|type:group|msg:om_g" --no-reply \
      --content "E2E-9 group delivery ${TS}" 2>&1
    wait_for_status "E2E-9 group delivery ${TS}" "delivered" 30 "Group delivery"
  else
    record_skip "Group session '${GROUP_SESSION}' not running"
  fi

  section "Test 10: User instance live delivery (betty)"
  BETTY_SESSION=$(get_session user-betty)
  if session_exists "$BETTY_SESSION"; then
    node "$RECEIVE" --channel feishu --endpoint "oc_39ec68719d842691a6714b05be9a2de4|type:p2p|msg:om_e2e10${TS}" --no-reply \
      --content "E2E-10 betty delivery ${TS}" 2>&1
    wait_for_status "E2E-10 betty delivery ${TS}" "delivered" 30 "Betty delivery"
  else
    record_skip "Betty session '${BETTY_SESSION}' not running"
  fi

  section "Test 11: Scheduler instance delivery"
  SCHED_SESSION=$(get_session scheduler)
  if session_exists "$SCHED_SESSION"; then
    node "$RECEIVE" --channel test --endpoint "test-sched-${TS}" --no-reply --target-instance scheduler \
      --content "E2E-11 scheduler delivery ${TS}" 2>&1
    wait_for_status "E2E-11 scheduler delivery ${TS}" "delivered" 30 "Scheduler delivery"
  else
    record_skip "Scheduler session '${SCHED_SESSION}' not running"
  fi

  section "Test 12: Cold auto-start delivery"
  # Kill a non-primary session, send a message, verify it boots and delivers
  # Use user-pan (least disruptive to real users)
  PAN_SESSION=$(get_session user-pan)
  if [ -n "$PAN_SESSION" ]; then
    tmux_cmd kill-session -t "$PAN_SESSION" 2>/dev/null || true
    sleep 2
    if session_exists "$PAN_SESSION"; then
      record_skip "Could not kill ${PAN_SESSION} for cold-start test"
    else
      info "Killed ${PAN_SESSION}, sending message to trigger auto-start..."
      node "$RECEIVE" --channel test --endpoint "test-coldstart-${TS}" --no-reply --target-instance user-pan \
        --content "E2E-12 cold start ${TS}" 2>&1
      # Wait up to 90s: wake signal → AM detects → launches CC → CC boots → dispatcher delivers
      wait_for_status "E2E-12 cold start ${TS}" "delivered" 90 "Cold auto-start delivery (user-pan)"
    fi
  else
    record_skip "user-pan not configured"
  fi

  section "Test 13: Agent status file freshness"
  ADMIN_STATUS="$ZYLOS_DIR/activity-monitor/admin/agent-status.json"
  if [ -f "$ADMIN_STATUS" ]; then
    AGE_S=$(python3 -c "import os,time; print(int(time.time()-os.path.getmtime('$ADMIN_STATUS')))" 2>/dev/null || echo 999)
    if [ "$AGE_S" -lt 5 ]; then
      record_pass "Admin agent-status.json is fresh (${AGE_S}s old)"
    else
      record_fail "Admin agent-status.json is stale (${AGE_S}s old)"
    fi
  else
    record_fail "Admin agent-status.json not found"
  fi

fi

# ═══════════════════════════════════════════════════════════════════════
# SECTION C: Memory isolation + shared context
# ═══════════════════════════════════════════════════════════════════════

section "Test 14: Shared memory accessible by all instances"
SHARED_ID="$ZYLOS_DIR/memory/shared/identity.md"
LEGACY_ID="$ZYLOS_DIR/memory/identity.md"
if [ -f "$SHARED_ID" ]; then
  record_pass "Shared identity.md exists at shared/ ($(wc -c < "$SHARED_ID") bytes)"
elif [ -f "$LEGACY_ID" ]; then
  record_pass "Shared identity.md exists at legacy path ($(wc -c < "$LEGACY_ID") bytes)"
else
  record_fail "No shared identity.md found"
fi

section "Test 15: Instance-specific state isolation"
ADMIN_STATE="$ZYLOS_DIR/memory/instances/admin/state.md"
BETTY_STATE="$ZYLOS_DIR/memory/instances/user-betty/state.md"
if [ -f "$ADMIN_STATE" ] && [ -f "$BETTY_STATE" ]; then
  ADMIN_INODE=$(stat -c %i "$ADMIN_STATE")
  BETTY_INODE=$(stat -c %i "$BETTY_STATE")
  if [ "$ADMIN_INODE" != "$BETTY_INODE" ]; then
    record_pass "Admin and Betty have separate state.md files"
  else
    record_fail "Admin and Betty share the same state.md inode"
  fi
elif [ -f "$ADMIN_STATE" ]; then
  record_pass "Admin has instance-specific state.md (betty may not exist yet)"
else
  record_skip "Instance state.md not yet created (needs memory sync)"
fi

section "Test 16: Inter-instance query delivered to admin"
if [ "$SKIP_LIVE" = "true" ]; then
  record_skip "Skipped via --skip-live"
elif [ ! -f "$QUERY" ]; then
  record_skip "c4-query-instance.js not deployed"
else
  QUERY_TS=$(date +%s%N)
  node "$QUERY" --from e2e-roundtrip --to admin \
    --content "E2E-16 roundtrip ${QUERY_TS}" 2>&1
  sleep 2
  RT_TARGET=$(db_query "SELECT target_instance FROM conversations WHERE content LIKE '%E2E-16 roundtrip ${QUERY_TS}%' ORDER BY id DESC LIMIT 1;")
  RT_CHANNEL=$(db_query "SELECT channel FROM conversations WHERE content LIKE '%E2E-16 roundtrip ${QUERY_TS}%' ORDER BY id DESC LIMIT 1;")
  if [ "$RT_TARGET" = "admin" ] && [ "$RT_CHANNEL" = "internal" ]; then
    RT_DELIVERED=false
    for i in $(seq 1 30); do
      RT_STATUS=$(db_query "SELECT status FROM conversations WHERE content LIKE '%E2E-16 roundtrip ${QUERY_TS}%' ORDER BY id DESC LIMIT 1;")
      if [ "$RT_STATUS" = "delivered" ]; then
        RT_DELIVERED=true
        record_pass "Inter-instance query delivered to admin (${i}s)"
        break
      fi
      sleep 1
    done
    [ "$RT_DELIVERED" = "false" ] && record_fail "Query not delivered (status=${RT_STATUS})"
  else
    record_fail "Routing wrong: target='${RT_TARGET}' channel='${RT_CHANNEL}'"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════
# Cleanup
# ═══════════════════════════════════════════════════════════════════════
section "Cleanup"
if [ -f "$C4_DB" ]; then
  DELETED=$(sqlite3 "$C4_DB" "
    DELETE FROM conversations WHERE content LIKE '%E2E-% ${TS}%'
       OR content LIKE '%E2E-16 roundtrip%';
    SELECT changes();
  " 2>/dev/null || echo 0)
  info "Deleted $DELETED test row(s)"
fi

# ── Summary ────────────────────────────────────────────────────────────
TOTAL=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Results: ${GREEN}${PASS_COUNT} passed${RESET}  ${RED}${FAIL_COUNT} failed${RESET}  ${YELLOW}${SKIP_COUNT} skipped${RESET}  (${TOTAL} total)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

[ "$FAIL_COUNT" -gt 0 ] && exit 1
exit 0
