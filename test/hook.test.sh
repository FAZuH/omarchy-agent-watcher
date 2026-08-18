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
# ancestor of every hook run below); omarchy-shell just logs. Setting
# HYPRCTL_STUB_EMPTY=1 makes hyprctl report no windows at all, so tests can
# exercise the unresolved-window path.
cat > "$TMP/bin/hyprctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$TMP/hyprctl.log"
if [ "\${HYPRCTL_STUB_EMPTY:-0}" = 1 ]; then
  echo '[]'
else
  echo '[{"pid": $$, "address": "0xABC123"}]'
fi
EOF
cat > "$TMP/bin/omarchy-shell" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$TMP/shell.log"
EOF
# Fake agents: a process whose cmdline matches the agent pattern, running the
# hook as a child (so the PPID walk finds them, like a real claude/codex...).
# Each wrapper records its own PID before invoking the hook, so tests can
# assert the hook resolved *that* ancestor (not itself, not some other pid).
for a in claude codex gemini opencode; do
  cat > "$TMP/bin/$a" <<EOF
#!/usr/bin/env bash
echo \$\$ > "$TMP/agent.pid"
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
rm -f "$TMP/agent.pid"
out=$(run_agent claude session-start '{"session_id":"s1","cwd":"/tmp/proj","hook_event_name":"SessionStart"}'); rc=$?
WRAPPER_PID=$(cat "$TMP/agent.pid" 2>/dev/null)
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
[ -n "$WRAPPER_PID" ] && ok || ko "fake claude wrapper pid was not recorded"
assert_eq "$(field "$F" .agentPid)" "$WRAPPER_PID" "agentPid resolved from the fake claude ancestor, not the hook's own pid"
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

echo "== hook: an agent whose own cmdline mentions agent-watcher"
# Only our own wrapper (bin/agent-watcher-hook) may be skipped during the PPID
# walk. A real agent that merely carries "agent-watcher" in its argv -- e.g. a
# prompt about this very plugin -- must still be recognised as the agent.
reset_logs
rm -f "$TMP/agent.pid"
printf '%s' '{"session_id":"aw1","cwd":"/tmp/proj"}' |
  "$TMP/bin/claude" prompt "touch /tmp/agent-watcher-perm-test" >/dev/null
WRAPPER_PID=$(cat "$TMP/agent.pid" 2>/dev/null)
FAW="$AGENT_WATCHER_STATE_DIR/claude-aw1.json"
[ -n "$WRAPPER_PID" ] && ok || ko "fake claude wrapper pid was not recorded"
assert_eq "$(field "$FAW" .agentPid)" "$WRAPPER_PID" \
  "agent whose argv mentions agent-watcher is still resolved as the agent"

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

echo "== hook: unresolved window (hyprctl reports no windows)"
reset_logs
export HYPRCTL_STUB_EMPTY=1
FNW="$AGENT_WATCHER_STATE_DIR/claude-nowin.json"
run_agent claude session-start '{"session_id":"nowin","cwd":"/tmp/nowin"}' >/dev/null
assert_eq "$(field "$FNW" .windowAddress)" "" "windowAddress empty when hyprctl resolves no window"
run_agent claude prompt '{"session_id":"nowin"}' >/dev/null
assert_eq "$(field "$FNW" .windowAddress)" "" "windowAddress stays empty across a second event (never wrongly cached)"
assert_eq "$(field "$FNW" .cwd)" /tmp/nowin "cwd survives a payload without cwd, even with an unresolved window"
run_agent claude done '{"session_id":"nowin","cwd":"/tmp/nowin"}' >/dev/null
assert_eq "$(field "$FNW" .state)" done "a later event still updates state when the window stays unresolved"
unset HYPRCTL_STUB_EMPTY

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

echo "== setup: claude merge / idempotence / remove"
export AGENT_WATCHER_CLAUDE_SETTINGS="$TMP/cfg/claude/settings.json"
export AGENT_WATCHER_CODEX_HOOKS="$TMP/cfg/codex/hooks.json"
export AGENT_WATCHER_GEMINI_SETTINGS="$TMP/cfg/gemini/settings.json"
export AGENT_WATCHER_OPENCODE_PLUGIN="$TMP/cfg/opencode/plugins/agent-watcher.js"
mkdir -p "$TMP/cfg/claude" "$TMP/cfg/codex" "$TMP/cfg/gemini" "$TMP/cfg/opencode"
cat > "$AGENT_WATCHER_CLAUDE_SETTINGS" <<'EOF'
{
  "model": "opus",
  "hooks": {
    "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "notify-send done" } ] } ]
  }
}
EOF
assert_eq "$("$SETUP" status claude)" "claude not-installed" "status before install"
"$SETUP" install claude; rc=$?
assert_eq "$rc" 0 "install claude exits 0"
assert_file "$AGENT_WATCHER_CLAUDE_SETTINGS.agent-watcher.bak" "backup written"
assert_eq "$(jq -r '.model' "$AGENT_WATCHER_CLAUDE_SETTINGS")" opus "unrelated keys preserved"
assert_eq "$(jq -r '[.hooks.Stop[].hooks[].command] | map(select(. == "notify-send done")) | length' "$AGENT_WATCHER_CLAUDE_SETTINGS")" 1 "foreign Stop hook preserved"
assert_eq "$(jq -r '[.hooks.Stop[].hooks[].command] | map(select(contains("agent-watcher-hook claude done"))) | length' "$AGENT_WATCHER_CLAUDE_SETTINGS")" 1 "our Stop hook added"
for ev in SessionStart UserPromptSubmit PermissionRequest Notification PostToolUse Stop SessionEnd; do
  n=$(jq -r --arg ev "$ev" '[.hooks[$ev][]?.hooks[]?.command // "" | select(contains("agent-watcher-hook"))] | length' "$AGENT_WATCHER_CLAUDE_SETTINGS")
  assert_eq "$n" 1 "claude $ev has exactly one of our hooks"
done
assert_eq "$(jq -r '.hooks.Notification[0].matcher' "$AGENT_WATCHER_CLAUDE_SETTINGS")" permission_prompt "Notification matcher"
assert_eq "$(jq -r '.hooks.Stop[-1].hooks[0].command' "$AGENT_WATCHER_CLAUDE_SETTINGS")" "$ROOT/bin/agent-watcher-hook claude done" "absolute hook path"
assert_eq "$(jq -r '.hooks.Stop[-1].hooks[0].timeout' "$AGENT_WATCHER_CLAUDE_SETTINGS")" 5 "claude timeout in seconds"
assert_eq "$("$SETUP" status claude)" "claude installed" "status after install"
"$SETUP" install claude >/dev/null
assert_eq "$(jq -r '[.hooks.Stop[].hooks[].command | select(contains("agent-watcher-hook"))] | length' "$AGENT_WATCHER_CLAUDE_SETTINGS")" 1 "second install does not duplicate"
"$SETUP" remove claude; rc=$?
assert_eq "$rc" 0 "remove exits 0"
assert_eq "$(jq -r '[.hooks[][]?.hooks[]?.command // "" | select(contains("agent-watcher"))] | length' "$AGENT_WATCHER_CLAUDE_SETTINGS")" 0 "remove strips all our hooks"
assert_eq "$(jq -r '.hooks.Stop[0].hooks[0].command' "$AGENT_WATCHER_CLAUDE_SETTINGS")" "notify-send done" "foreign hook survives remove"
assert_eq "$(jq -r '.hooks | keys | join(",")' "$AGENT_WATCHER_CLAUDE_SETTINGS")" Stop "emptied events are dropped"
assert_eq "$("$SETUP" status claude)" "claude not-installed" "status after remove"

echo "== setup: invalid json is refused"
printf '{ nope' > "$AGENT_WATCHER_CLAUDE_SETTINGS"
err=$("$SETUP" install claude 2>&1 >/dev/null); rc=$?
assert_eq "$rc" 1 "install on invalid JSON exits 1"
case "$err" in error:*) ok ;; *) ko "error message on stderr (got '$err')" ;; esac
assert_eq "$(cat "$AGENT_WATCHER_CLAUDE_SETTINGS")" "{ nope" "invalid file left untouched"

echo "== setup: codex / gemini / opencode"
"$SETUP" install codex >/dev/null; rc=$?
assert_eq "$rc" 0 "codex install creates hooks.json"
assert_eq "$(jq -r '.hooks.Stop[0].hooks[0].command' "$AGENT_WATCHER_CODEX_HOOKS")" "$ROOT/bin/agent-watcher-hook codex done" "codex Stop hook"
assert_eq "$(jq -r '.hooks | keys | sort | join(",")' "$AGENT_WATCHER_CODEX_HOOKS")" "PermissionRequest,PostToolUse,SessionEnd,SessionStart,Stop,UserPromptSubmit" "codex events"
assert_eq "$("$SETUP" status codex)" "codex installed" "codex status"
"$SETUP" remove codex >/dev/null
assert_eq "$("$SETUP" status codex)" "codex not-installed" "codex removed"

"$SETUP" install gemini >/dev/null; rc=$?
assert_eq "$rc" 0 "gemini install"
assert_eq "$(jq -r '.hooks | keys | sort | join(",")' "$AGENT_WATCHER_GEMINI_SETTINGS")" "AfterAgent,AfterTool,BeforeAgent,Notification,SessionEnd,SessionStart" "gemini events"
assert_eq "$(jq -r '.hooks.AfterAgent[0].hooks[0].timeout' "$AGENT_WATCHER_GEMINI_SETTINGS")" 5000 "gemini timeout in milliseconds"
assert_eq "$(jq -r '.hooks.AfterAgent[0].hooks[0].command' "$AGENT_WATCHER_GEMINI_SETTINGS")" "$ROOT/bin/agent-watcher-hook gemini done" "gemini AfterAgent -> done"
assert_eq "$("$SETUP" status gemini)" "gemini installed" "gemini status"

"$SETUP" install opencode >/dev/null; rc=$?
assert_eq "$rc" 0 "opencode install"
assert_file "$AGENT_WATCHER_OPENCODE_PLUGIN" "opencode plugin file created"
grep -q "\"$ROOT/bin/agent-watcher-hook\"" "$AGENT_WATCHER_OPENCODE_PLUGIN" && ok || ko "opencode plugin has the hook path substituted"
grep -q "__HOOK_PATH__" "$AGENT_WATCHER_OPENCODE_PLUGIN" && ko "placeholder left in opencode plugin" || ok
node --input-type=module -e "import('file://$AGENT_WATCHER_OPENCODE_PLUGIN').then(m => { if (typeof m.AgentWatcher !== 'function') process.exit(1) })" && ok || ko "opencode plugin is importable ESM exporting AgentWatcher"
assert_eq "$("$SETUP" status opencode)" "opencode installed" "opencode status"
"$SETUP" remove opencode >/dev/null
assert_nofile "$AGENT_WATCHER_OPENCODE_PLUGIN" "opencode remove deletes the plugin"

echo "== setup: status all / agent-missing / usage"
assert_eq "$("$SETUP" status all | wc -l)" 4 "status all prints four lines"
assert_eq "$(PATH="$TMP/emptybin:/usr/bin:/bin" AGENT_WATCHER_CODEX_HOOKS="$TMP/nowhere/codex/hooks.json" "$SETUP" status codex)" "codex agent-missing" "no binary and no config dir -> agent-missing"
assert_eq "$(PATH="$TMP/emptybin:/usr/bin:/bin" "$SETUP" status gemini)" "gemini installed" "installed wins even without the binary on PATH"
"$SETUP" frobnicate claude >/dev/null 2>&1; rc=$?
assert_eq "$rc" 2 "usage error exits 2"

echo "== opencode plugin: event order survives concurrent events"
# OpenCode emits a redundant "busy" status in the same millisecond as
# session.idle. Each send is a separate process, so without serialisation the
# slower "prompt" lands after "done" and the session sticks at working.
if command -v node >/dev/null 2>&1; then
  OCDIR="$TMP/oc"; mkdir -p "$OCDIR"
  OCLOG="$OCDIR/events.log"
  cat > "$OCDIR/fake-hook" <<EOF
#!/usr/bin/env bash
cat >/dev/null
case "\$2" in prompt) sleep 0.4 ;; done) sleep 0.05 ;; esac
echo "\$2" >> "$OCLOG"
EOF
  chmod +x "$OCDIR/fake-hook"
  sed "s|__HOOK_PATH__|$OCDIR/fake-hook|g" "$ROOT/hooks/opencode-agent-watcher.js" > "$OCDIR/plugin.mjs"
  node --input-type=module -e "
    const { AgentWatcher } = await import('$OCDIR/plugin.mjs')
    const h = await AgentWatcher({ directory: '/tmp/proj' })
    const fire = (type, properties) => h.event({ event: { type, properties } })
    await fire('session.created', { info: { id: 's1', directory: '/tmp/proj' } })
    await fire('session.status', { sessionID: 's1', status: { type: 'busy' } })
    await fire('session.status', { sessionID: 's1', status: { type: 'busy' } })
    await fire('session.idle', { sessionID: 's1' })
    await new Promise((r) => setTimeout(r, 3000))
  " 2>/dev/null
  assert_eq "$(tail -1 "$OCLOG" 2>/dev/null)" done "the last hook to run is the last event OpenCode reported"
  assert_eq "$(grep -c '^prompt$' "$OCLOG" 2>/dev/null)" 1 "a repeated busy status does not re-send prompt"
  assert_eq "$(tr '\n' ' ' < "$OCLOG" 2>/dev/null)" "session-start prompt done " "events run in the order OpenCode emitted them"
else
  echo "  (skipped: node not on PATH)"
fi

echo
echo "hook tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
