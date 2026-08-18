# Agent Watcher — design

Omarchy shell (Quickshell) bar-widget plugin that lists every running AI-agent
session (Claude Code, Codex CLI, Gemini CLI, OpenCode) across all Hyprland
workspaces and blinks the bar icon when an agent finishes responding or is
waiting on the user in a window that is not focused.

- Plugin id: `io.github.5d0tal1gat0r.agent-watcher`
- Display name: **Agent Watcher**
- Kind: `bar-widget` (bar pill + popup panel)
- License: MIT
- Repo: `~/Proyects/omarchy-plugins-dev/omarchy-agent-watcher/` (source of truth, `main`);
  installed copy is a git clone at `~/.config/omarchy/plugins/io.github.5d0tal1gat0r.agent-watcher/`.

The shell's built-in `omarchy.agents` plugin shows usage / rate limits; this
plugin is about live sessions and attention, so the two complement each other.

## 1. Goals and non-goals

Goals

- One place in the bar that shows every agent session, grouped by workspace,
  with its state (working / waiting / done / idle) and how long it has been there.
- Blink the bar icon (attention color) when a session finishes responding or is
  blocked on a permission prompt while its window is not the focused window.
- Blink clears automatically when the user focuses that window; clicking a
  session row focuses the window.
- Exact events from each agent's native hook system — no guessing from titles
  or CPU.
- One-click hook install / remove per agent from the panel.
- State survives `omarchy restart shell`.

Non-goals (v1)

- Desktop notifications, sounds (the user chose blink only).
- Discovering sessions that have no hooks installed (approach C was rejected).
- Usage / cost / rate-limit data (covered by `omarchy.agents`).
- Remote / SSH sessions and multiplexers beyond "list them under *Other*".

## 2. Architecture and data flow

```
agent (claude | codex | gemini | opencode)
  └─ native hook fires ──▶ bin/agent-watcher-hook <agent> <event>   (stdin: agent's JSON)
                             ├─ normalize event
                             ├─ walk /proc PPID chain → agentPid, terminal PID, Hyprland windowAddress
                             ├─ atomically write $XDG_RUNTIME_DIR/omarchy-agent-watcher/<agent>-<sessionId>.json
                             └─ omarchy-shell -q io.github.5d0tal1gat0r.agent-watcher refresh
                                                        │
Quickshell plugin ◀─────────────────────────────────────┘
  BarWidget.qml  IpcHandler.refresh() → reload state dir (one Process) → Model.js session list
                 Quickshell.Hyprland toplevels: live workspace / title / activated per windowAddress
                 Timer 15 s: prune sessions whose agentPid is dead (one `kill -0` batch Process)
  Panel.qml      grouped list, click-to-focus, hooks setup section
```

Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `bin/agent-watcher-hook` | Turn one agent hook invocation into a state file update + shell ping | bash, jq, hyprctl, omarchy-shell |
| `bin/agent-watcher-setup` | install / remove / status of hooks per agent | bash, jq (or node) |
| `hooks/opencode-agent-watcher.js` | OpenCode plugin that forwards events to the hook script | OpenCode plugin API |
| `Model.js` | Pure logic: normalization, state machine, grouping, bar summary, formatting | none (node-testable, `module.exports` guard) |
| `BarWidget.qml` | Pill, blink animation, IPC handler, state loading, prune timer, focus watcher | Quickshell, Quickshell.Hyprland, Model.js |
| `Panel.qml` | Popup: header, workspace groups, rows, hooks section | Model.js, BarWidget state |

Design decisions

- **State files are the source of truth.** One JSON per session in
  `$XDG_RUNTIME_DIR/omarchy-agent-watcher/` (tmpfs → nothing survives a reboot).
  The shell re-reads the directory on every ping and at startup, so state
  survives `omarchy restart shell`; hooks never fail when the shell is down
  (`omarchy-shell -q` is best-effort).
- **QML never polls hyprctl.** Workspace, title and focus come from
  `Hyprland.toplevels` / `Hyprland.activeToplevel` (verified working on this
  Quickshell build; note Quickshell addresses have no `0x` prefix, hyprctl's
  do — normalize to bare hex). The hook script is the only place that calls
  `hyprctl clients -j`, once per event, to resolve the window address.
- **All logic in `Model.js`** so it is unit-testable; QML files stay thin.

State file schema (`<agent>-<sessionId>.json`):

```json
{
  "agent": "claude",
  "sessionId": "abc123",
  "state": "done",
  "cwd": "/home/user/proj",
  "agentPid": 66333,
  "windowAddress": "55c153bde310",
  "updatedAt": 1755500000,
  "lastEvent": "done"
}
```

`windowAddress` and `agentPid` may be empty strings / 0 when the PPID walk
finds nothing (tmux, remote); the session still tracks.

## 3. Session states and event mapping

States

| State | Meaning | Bar effect |
|---|---|---|
| `working` | agent is processing a prompt | counted as working |
| `waiting` | blocked on the user (tool permission / question) | blink (waiting color) until seen; badge stays "waiting" |
| `done` | finished responding, user has not looked yet | blink (done color) until seen; seen ⇒ shown as `idle` |
| `idle` | at the prompt, nothing pending | counted as idle |
| *(removed)* | session ended or process died | disappears |

Each session also carries `seen` (bool, shell-side only, not in the state
file). Blink = (`state` is `done` or `waiting`) and not `seen`. `seen` is set
when the session's window is / becomes the active toplevel and cleared by every
new event from the hook script.

Transitions

- `session-start` → `idle`
- `prompt` → `working`
- `waiting` → `waiting`
- `tool-done` → `working` **only if** the session is currently `waiting`
  (the permission was answered and the agent resumed); otherwise ignored.
  The hook script short-circuits this case without writing or pinging, so the
  many `PostToolUse` calls of a normal turn cost almost nothing.
- `done` → `done`; if the session's window is `Hyprland.activeToplevel` at
  that moment the shell marks it `seen` immediately (user was watching — no
  blink) and it is displayed as `idle`. This focus check lives in the
  QML/Model layer, not the hook script, because only the shell knows focus
  reliably.
- Acknowledge-on-focus: when the session's window becomes the active
  toplevel, `seen` = true → blink stops. A seen `done` is displayed as `idle`;
  a seen `waiting` keeps its "waiting" badge (the agent is still blocked)
  until `tool-done` / `prompt` / `done` moves it on.
- `session-end` → removed (file deleted by the hook script).
- Prune: `agentPid` no longer alive → removed (file deleted by the plugin).
- An event for an unknown session (hooks installed mid-session, no
  `session-start` seen) creates the session directly in the resulting state.
- Claude Code `SubagentStop` and `Notification` `idle_prompt` are ignored:
  only the main `Stop` means "finished responding".

Per-agent hook → normalized event

| Normalized | Claude Code (`~/.claude/settings.json` hooks) | Codex (`~/.codex/hooks.json`) | Gemini CLI (`~/.gemini/settings.json` hooks) | OpenCode (plugin `.js`) |
|---|---|---|---|---|
| `session-start` | `SessionStart` | `SessionStart` | `SessionStart` | `session.created` |
| `prompt` | `UserPromptSubmit` | `UserPromptSubmit` | `BeforeAgent` | `session.status` = busy |
| `waiting` | `PermissionRequest`, `Notification` matcher `permission_prompt` | `PermissionRequest` | `Notification` with `notification_type` = ToolPermission | `permission.asked` |
| `tool-done` | `PostToolUse` | `PostToolUse` | `AfterTool` | `permission.replied` |
| `done` | `Stop` | `Stop` | `AfterAgent` | `session.idle` |
| `session-end` | `SessionEnd` | `SessionEnd` | `SessionEnd` | *(none — prune)* |

Session id = the agent's `session_id` (OpenCode: `session.id`); cwd from the
payload's `cwd`. Missing id → fall back to `agentPid`.

Versions verified on the dev machine (2026-08-18): Claude Code 2.1.233,
codex-cli 0.147.0 (has `hooks.json` with the events above), gemini-cli 0.55.1
(hooks: SessionStart/BeforeAgent/AfterAgent/Notification/SessionEnd),
opencode 1.2.27 (events `session.created`, `session.status`,
`permission.asked`, `session.idle`).

## 4. Bar widget

- Pill in the same style as clock / weather / stocks. Content:
  `<agent icon> <working count> · <attention count>` where attention =
  unseen `waiting` + unseen `done` (subject to the two blink settings). Zero
  groups are hidden. With zero sessions the pill collapses
  to a dimmed icon only.
- Blink: while attention count > 0 (and the corresponding setting is on), the
  icon and the attention count pulse opacity 1 → 0.35 → 1 in a ~1 s
  `SequentialAnimation` loop. Stops the instant attention count is 0.
- Color priority: any `waiting` → theme yellow/orange; else `done` → theme
  green. Colors read from `~/.local/state/omarchy/current/theme/colors.toml`
  via `Color.currentThemePath` (same helper as stocks).
- Click toggles the panel.
- Settings (manifest schema): `blinkOnDone` (bool, default true),
  `blinkOnWaiting` (bool, default true). Turning one off removes that state
  from the attention count/blink; the panel still shows the state badge.
- `IpcHandler` target `io.github.5d0tal1gat0r.agent-watcher` with
  `refresh()`, `open()`, `close()`, `toggle()`.
- Startup: load state dir; on every `refresh()`: reload + prune; Timer 15 s:
  prune. Focus watcher: on `Hyprland.activeToplevel` change, mark the matching
  session `seen`. `seen` is kept in QML memory keyed by session id, so a
  reload of the state files does not resurrect a blink the user already
  cleared (a genuinely new event rewrites `updatedAt`, which resets `seen`).

## 5. Panel

- Header "Agent sessions" + summary ("3 sessions · 2 working · 1 waiting").
- Groups: **Workspace N** sorted by id, focused workspace tagged "current".
  Sessions whose `windowAddress` is empty or not present in
  `Hyprland.toplevels` go into **Other** at the end.
- Row: agent icon (per-agent SVG in `assets/`), project = basename of `cwd`,
  state badge (colored dot + label), time in current state ("4m"), subtitle =
  live window title from the toplevel with leading spinner glyphs
  (`◐◓◑◒✳✶✻✽` etc.) stripped — for Claude Code this is the task summary.
  Attention rows float to the top of their group; then working, then idle.
- Click row → `Hyprland.dispatch("focuswindow address:0x<addr>")`, panel
  closes; the resulting focus change clears the blink through the normal
  acknowledge path.
- **Hooks section** at the bottom: one line per agent —
  `Claude Code ✓ installed` / `Gemini not installed [Install]` /
  `Codex not found` (greyed, `agent-missing`). Install / Remove buttons run
  `bin/agent-watcher-setup` and refresh the status line.
- Empty state: "No sessions yet — start an agent in a terminal", or when no
  hooks are installed: "Install hooks below to start tracking."

## 6. Tracker script `bin/agent-watcher-hook <agent> <event>`

bash; deps `jq`, `hyprctl`, `omarchy-shell` (all present on Omarchy).

1. Read stdin JSON; extract `sessionId` and `cwd` with per-agent jq paths.
2. Walk `/proc/<pid>/status` PPid upward from `$PPID`:
   - first ancestor whose `comm` matches the agent binary name → `agentPid`;
   - first ancestor whose PID appears in `hyprctl clients -j` → `windowAddress`
     (strip `0x`).
   Either may be empty; continue anyway.
3. Map `<event>` to the state per §3 and atomically write the state file
   (write `.tmp`, `mv`). `session-end` deletes the file instead.
   Short-circuits: `tool-done` when the existing file is not `waiting` → exit
   without writing or pinging; step 2's `hyprctl` lookup is skipped when the
   existing file already has a `windowAddress` (it is resolved once per
   session, on the first event that finds a window).
4. `omarchy-shell -q io.github.5d0tal1gat0r.agent-watcher refresh`.
5. Always exit 0, never write to stdout (Claude Code treats hook exit code 2 /
   stdout JSON as control signals; the script must be inert). Target runtime
   well under 100 ms; `hyprctl` is invoked at most once per session.

## 7. Setup script `bin/agent-watcher-setup <install|remove|status> <agent>`

- `claude`: merge into `~/.claude/settings.json` → `hooks` entries for
  `SessionStart`, `UserPromptSubmit`, `PermissionRequest`,
  `Notification` (matcher `permission_prompt`), `PostToolUse`, `Stop`,
  `SessionEnd`; each
  `{"type":"command","command":"<abs>/bin/agent-watcher-hook claude <event>"}`.
- `codex`: same shape into `~/.codex/hooks.json` (created if absent).
- `gemini`: same into `~/.gemini/settings.json` → `hooks` for `SessionStart`,
  `BeforeAgent`, `Notification`, `AfterTool`, `AfterAgent`, `SessionEnd`.
- `opencode`: copy `hooks/opencode-agent-watcher.js` into
  `~/.config/opencode/plugin/`; the plugin subscribes to `session.created`,
  `session.status`, `permission.asked`, `permission.replied`, `session.idle`
  and spawns the hook script with a synthetic `{"session_id","cwd"}` payload.
- Idempotent: our entries are recognised by the command containing
  `agent-watcher-hook`; install replaces them, remove deletes only them, other
  hooks are untouched. Backup `<file>.agent-watcher.bak` written before every
  modification.
- Absolute command path (`~/.config/omarchy/plugins/io.github.5d0tal1gat0r.agent-watcher/bin/agent-watcher-hook`,
  derived from the script's own location) so hooks work from any cwd.
- `status` prints exactly one of `installed`, `not-installed`,
  `agent-missing` (binary not on PATH and config dir absent) for the panel.

## 8. Error handling

- Malformed / partial state file → skipped, retried next refresh.
- Missing runtime dir → zero sessions; the hook script creates it.
- Prune (every 15 s and on every refresh) deletes files whose `agentPid` is
  dead so nothing leaks when `SessionEnd` never fires (terminal killed).
- `windowAddress` no longer in `Hyprland.toplevels` but PID alive → *Other*
  group (window closed, agent alive under tmux/nohup).
- Hook script failures (no jq, no hyprctl) are swallowed; exit 0 always.
- Setup script refuses to write if the target JSON does not parse (prints
  `error: <file> is not valid JSON` on stderr, exit 1) rather than clobbering.

## 9. Testing

Unit — `node --test test/model.test.js` (Model.js pure JS):

- event normalization per agent (each row of the §3 table → normalized event,
  session id, cwd extraction);
- state transitions incl. done-while-focused → seen/idle, acknowledge-on-focus
  (`seen`), `tool-done` only acting on `waiting`, seen-waiting keeps its badge,
  new event resets `seen`, removal on end/prune;
- grouping by workspace, *Other* bucket, attention-first ordering, focused tag;
- bar summary: counts, blink on/off, color priority, settings toggles;
- title glyph stripping, elapsed-time formatting, address normalization.

Script — `test/hook.test.sh` (plain bash, stubbed `hyprctl` / `omarchy-shell`
on `PATH`, temp `HOME` / `XDG_RUNTIME_DIR`): state file contents per event,
atomic write, `session-end` deletion, `tool-done` no-op unless waiting,
`hyprctl` stub called once per session, silence on stdout, exit 0 on garbage
input; setup install / status / remove round-trips on temp config files,
idempotence, backup created, foreign hooks untouched, invalid JSON refused.

Static — `qmllint -I /usr/share/omarchy/shell` on a renamed copy without the
`IpcHandler` block; `omarchy plugin validate <dir>`.

Live (rsync + `omarchy restart shell`):

1. Install Claude Code hooks from the panel; two Claude Code windows on
   different workspaces; prompt one, switch away → green blink `· 1`; switch
   back → stops.
2. Trigger a permission prompt → yellow blink; approve → clears.
3. Kill a terminal outright → session gone within 15 s.
4. `omarchy restart shell` mid-session → sessions reappear.
5. `grim` screenshot of bar strip + panel for `preview.png` (no personal info).

## 10. Repository layout

```
omarchy-agent-watcher/
  manifest.json
  BarWidget.qml
  Panel.qml
  Model.js
  bin/agent-watcher-hook
  bin/agent-watcher-setup
  hooks/opencode-agent-watcher.js
  assets/{claude,codex,gemini,opencode}.svg
  test/model.test.js
  test/hook.test.sh
  README.md  LICENSE  preview.png
  docs/superpowers/specs/  docs/superpowers/plans/
```

Privacy: commits under `5d0tal1gat0r <117541848+5d0tal1gat0r@users.noreply.github.com>`;
no real names, emails or `/home/<user>` paths in files, docs or history.
