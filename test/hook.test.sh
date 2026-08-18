#!/usr/bin/env bash
# Tests for bin/agent-watcher-hook and bin/agent-watcher-setup.
# Run: bash test/hook.test.sh   (exit 0 when everything passes)
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export AGENT_WATCHER_STATE_DIR="$TMP/state"
export HOME="$TMP/home"
mkdir -p "$HOME" "$TMP/bin" "$TMP/emptybin"

# Stubs on PATH: hyprctl reports one window owned by THIS test process (an
# ancestor of every hook run below); omarchy-shell just logs.
cat > "$TMP/bin/hyprctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$TMP/hyprctl.log"
echo '[{"pid": $$, "address": "0xABC123"}]'
EOF
cat > "$TMP/bin/omarchy-shell" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$TMP/shell.log"
EOF
# Fake agents: a process whose cmdline matches the agent pattern, running the
# hook as a child (so the PPID walk finds them, like a real claude/codex...).
for a in claude codex gemini opencode; do
  cat > "$TMP/bin/$a" <<EOF
#!/usr/bin/env bash
"$ROOT/bin/agent-watcher-hook" $a "\$@"
EOF
done
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"

HOOK="$ROOT/bin/agent-watcher-hook"
SETUP="$ROOT/bin/agent-watcher-setup"
pass=0; fail=0
ok() { pass=$((pass+1)); }
ko() { fail=$((fail+1)); echo "FAIL: $*"; }
assert_eq() { if [ "$1" = "$2" ]; then ok; else ko "$3 (got '$1', want '$2')"; fi; }
assert_file() { if [ -e "$1" ]; then ok; else ko "$2 (missing $1)"; fi; }
assert_nofile() { if [ ! -e "$1" ]; then ok; else ko "$2 (unexpected $1)"; fi; }
field() { jq -r "$2" "$1"; }
shell_pings() { [ -f "$TMP/shell.log" ] && wc -l < "$TMP/shell.log" || echo 0; }
hyprctl_calls() { [ -f "$TMP/hyprctl.log" ] && wc -l < "$TMP/hyprctl.log" || echo 0; }
reset_logs() { rm -f "$TMP/shell.log" "$TMP/hyprctl.log"; rm -rf "$AGENT_WATCHER_STATE_DIR"; }
run_agent() { # run_agent <agent> <event> <json>  -> stdout of the hook
  printf '%s' "$3" | "$TMP/bin/$1" "$2"
}

echo "== hook: session lifecycle"
reset_logs
out=$(run_agent claude session-start '{"session_id":"s1","cwd":"/tmp/proj","hook_event_name":"SessionStart"}'); rc=$?
F="$AGENT_WATCHER_STATE_DIR/claude-s1.json"
assert_eq "$rc" 0 "exit code is 0"
assert_eq "$out" "" "nothing on stdout"
assert_file "$F" "state file written"
assert_eq "$(field "$F" .agent)" claude "agent"
assert_eq "$(field "$F" .sessionId)" s1 "sessionId"
assert_eq "$(field "$F" .state)" idle "session-start -> idle"
assert_eq "$(field "$F" .cwd)" /tmp/proj "cwd"
assert_eq "$(field "$F" .lastEvent)" session-start "lastEvent"
assert_eq "$(field "$F" .windowAddress)" abc123 "window resolved from hyprctl, 0x stripped, lower-cased"
[ "$(field "$F" .agentPid)" -gt 0 ] && ok || ko "agentPid resolved from the fake claude ancestor"
[ "$(field "$F" .updatedAt)" -gt 1700000000 ] && ok || ko "updatedAt is epoch seconds"
assert_eq "$(shell_pings)" 1 "one shell ping"
assert_eq "$(hyprctl_calls)" 1 "one hyprctl call"

run_agent claude prompt '{"session_id":"s1","cwd":"/tmp/proj"}' >/dev/null
assert_eq "$(field "$F" .state)" working "prompt -> working"
assert_eq "$(hyprctl_calls)" 1 "window cached: no second hyprctl call"
run_agent claude waiting '{"session_id":"s1","cwd":"/tmp/proj"}' >/dev/null
assert_eq "$(field "$F" .state)" waiting "waiting -> waiting"
pings=$(shell_pings)
run_agent claude tool-done '{"session_id":"s1","cwd":"/tmp/proj"}' >/dev/null
assert_eq "$(field "$F" .state)" working "tool-done while waiting -> working"
assert_eq "$(shell_pings)" $((pings+1)) "tool-done while waiting pings"
pings=$(shell_pings)
run_agent claude tool-done '{"session_id":"s1","cwd":"/tmp/proj"}' >/dev/null
assert_eq "$(field "$F" .state)" working "tool-done while working is a no-op"
assert_eq "$(shell_pings)" "$pings" "no-op tool-done does not ping"
run_agent claude done '{"session_id":"s1","cwd":"/tmp/proj"}' >/dev/null
assert_eq "$(field "$F" .state)" done "done -> done"
run_agent claude prompt '{"session_id":"s1"}' >/dev/null
assert_eq "$(field "$F" .cwd)" /tmp/proj "missing cwd keeps the previous one"
run_agent claude session-end '{"session_id":"s1","cwd":"/tmp/proj"}' >/dev/null
assert_nofile "$F" "session-end removes the file"

echo "== hook: other agents and edge cases"
reset_logs
run_agent codex prompt '{"session_id":"c1","cwd":"/tmp/x"}' >/dev/null
assert_eq "$(field "$AGENT_WATCHER_STATE_DIR/codex-c1.json" .state)" working "codex prompt"
run_agent opencode done '{"session_id":"o1","cwd":"/tmp/x"}' >/dev/null
assert_eq "$(field "$AGENT_WATCHER_STATE_DIR/opencode-o1.json" .state)" done "opencode done"
run_agent gemini waiting '{"session_id":"g1","cwd":"/tmp/x","notification_type":"Info"}' >/dev/null
assert_nofile "$AGENT_WATCHER_STATE_DIR/gemini-g1.json" "gemini non-permission notification ignored"
run_agent gemini waiting '{"session_id":"g1","cwd":"/tmp/x","notification_type":"ToolPermission"}' >/dev/null
assert_eq "$(field "$AGENT_WATCHER_STATE_DIR/gemini-g1.json" .state)" waiting "gemini ToolPermission -> waiting"
run_agent claude prompt '{"session_id":"a/b c","cwd":"/tmp/x"}' >/dev/null
assert_file "$AGENT_WATCHER_STATE_DIR/claude-a_b_c.json" "session id sanitized for the file name"
out=$(printf 'not json at all' | "$TMP/bin/claude" prompt); rc=$?
assert_eq "$rc" 0 "garbage stdin exits 0"
assert_eq "$out" "" "garbage stdin prints nothing"
ls "$AGENT_WATCHER_STATE_DIR"/claude-pid*.json >/dev/null 2>&1 && ok || ko "garbage stdin falls back to a pid-based session id"
out=$("$HOOK" claude bogus-event </dev/null); rc=$?
assert_eq "$rc" 0 "unknown event exits 0"
out=$("$HOOK" aider prompt </dev/null); rc=$?
assert_eq "$rc" 0 "unknown agent exits 0"
out=$("$HOOK" </dev/null); rc=$?
assert_eq "$rc" 0 "no args exits 0"

echo "== hook: dump and prune"
reset_logs
mkdir -p "$AGENT_WATCHER_STATE_DIR"
# A fake agent that stays alive during the dump: argv[0] "claude" matches the pattern.
( exec -a claude sleep 60 ) & LIVE_PID=$!
sleep 0.2
printf '{"agent":"claude","sessionId":"live","state":"working","cwd":"/l","agentPid":%s,"windowAddress":"","updatedAt":1,"lastEvent":"prompt"}' "$LIVE_PID" > "$AGENT_WATCHER_STATE_DIR/claude-live.json"
printf '{"agent":"claude","sessionId":"dead","state":"done","cwd":"/d","agentPid":4194304,"windowAddress":"","updatedAt":1,"lastEvent":"done"}' > "$AGENT_WATCHER_STATE_DIR/claude-dead.json"
printf '{"agent":"codex","sessionId":"nopid","state":"idle","cwd":"/n","agentPid":0,"windowAddress":"","updatedAt":1,"lastEvent":"session-start"}' > "$AGENT_WATCHER_STATE_DIR/codex-nopid.json"
printf '{ broken' > "$AGENT_WATCHER_STATE_DIR/claude-broken.json"
dump=$("$HOOK" dump); rc=$?
assert_eq "$rc" 0 "dump exits 0"
assert_eq "$(printf '%s' "$dump" | jq -r 'map(.sessionId) | sort | join(",")')" "live,nopid" "dump lists live + pid-less sessions only"
assert_nofile "$AGENT_WATCHER_STATE_DIR/claude-dead.json" "dead pid pruned"
assert_nofile "$AGENT_WATCHER_STATE_DIR/claude-broken.json" "unparsable file pruned"
assert_file "$AGENT_WATCHER_STATE_DIR/codex-nopid.json" "pid-less session kept"
kill "$LIVE_PID" 2>/dev/null; wait "$LIVE_PID" 2>/dev/null
assert_eq "$("$HOOK" dump | jq -r 'map(.sessionId) | join(",")')" "nopid" "live session pruned once its process is gone"
rm -rf "$AGENT_WATCHER_STATE_DIR"
assert_eq "$("$HOOK" dump)" "[]" "dump on a missing dir prints []"
# The live fake agent process is gone by now (it exited after the hook), so
# the next dump prunes it: pid liveness is checked against the cmdline pattern.
run_agent claude prompt '{"session_id":"live2","cwd":"/tmp/x"}' >/dev/null
assert_eq "$("$HOOK" dump | jq 'length')" 0 "session whose agent process exited is pruned"

echo
echo "hook tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
