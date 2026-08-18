# Agent Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Omarchy bar-widget plugin that lists every Claude Code / Codex / Gemini CLI / OpenCode session grouped by Hyprland workspace and blinks the bar pill when a session finished or waits for the user in a window that is not focused.

**Architecture:** Each agent's native hook system calls one bash script (`bin/agent-watcher-hook`) that writes a per-session JSON file under `$XDG_RUNTIME_DIR/omarchy-agent-watcher/` and pings the shell over IPC. `BarWidget.qml` owns the session state (reads the files through `agent-watcher-hook dump`, prunes dead PIDs, marks sessions seen when their window is focused via `Quickshell.Hyprland`), `Panel.qml` renders groups/rows/hook setup, and all decisions live in `Model.js` (pure, node-tested). `bin/agent-watcher-setup` installs/removes the hooks in each agent's config.

**Tech Stack:** Quickshell QML (Omarchy 4.0 shell, `qs.Ui` / `qs.Commons`, `Quickshell.Hyprland`, `Quickshell.Io`), ES5 JavaScript (`Model.js`, `node --test`), bash + jq (`bin/`), one ESM JS file for OpenCode.

**Spec:** `docs/superpowers/specs/2026-08-18-agent-watcher-design.md`

## Global Constraints

- Plugin id `io.github.5d0tal1gat0r.agent-watcher`, display name **Agent Watcher**, kind `bar-widget`, MIT.
- Repo `~/Proyects/omarchy-plugins-dev/omarchy-agent-watcher/` (`main`); commit as `5d0tal1gat0r <117541848+5d0tal1gat0r@users.noreply.github.com>` (already set repo-locally). No real names, emails or `/home/<user>` paths in any tracked file (docs included: write `~/…`).
- State dir: `${AGENT_WATCHER_STATE_DIR:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/omarchy-agent-watcher}`; one file per session `<agent>-<sessionId>.json` with keys `agent, sessionId, state, cwd, agentPid, windowAddress, updatedAt, lastEvent`.
- States: `working | waiting | done | idle`. Normalized events: `session-start | prompt | waiting | tool-done | done | session-end`.
- Hook script: never writes to stdout, always exits 0, ≤ 1 `hyprctl` call per session.
- QML never polls `hyprctl`; addresses are bare lowercase hex (no `0x`).
- `Model.js` stays ES5 (no `const`/`let`/arrow/template strings — QML's engine and the `import "Model.js" as Model` path) and ends with the `module.exports` guard.
- Settings: `blinkOnDone` (default true), `blinkOnWaiting` (default true), read with `setting()` and tolerant of `"true"`/`"false"` strings.
- Dev loop (no QML hot reload on this Quickshell): `rsync -a --delete --exclude .git ./ ~/.config/omarchy/plugins/io.github.5d0tal1gat0r.agent-watcher/ && omarchy restart shell`, then wait for `omarchy-shell shell ping` + ~5 s before IPC/screenshots.
- Verify commands: `node --test test/model.test.js`, `bash test/hook.test.sh`, `omarchy plugin validate .`, `qmllint -I /usr/share/omarchy/shell <file>` (qmllint exits 255 silently on any file containing an `IpcHandler` and on files named `BarWidget.qml`; lint a renamed copy with the IpcHandler block removed).

---

## File structure

| File | Responsibility |
|---|---|
| `manifest.json` | plugin identity, bar-widget entry, setting defaults |
| `Model.js` | pure logic: session parsing, merge/seen, attention & summary, grouping, formatting, hook-status parsing |
| `BarWidget.qml` | pill + blink, IPC target, dump/prune process, focus watcher, loads Panel |
| `Panel.qml` | popup: header, workspace groups, rows, hooks section |
| `bin/agent-watcher-hook` | hook entry point (`<agent> <event>` / `dump`) |
| `bin/agent-watcher-setup` | `install|remove|status <agent|all>` |
| `hooks/opencode-agent-watcher.js` | OpenCode plugin template (`__HOOK_PATH__` placeholder) |
| `test/model.test.js` | node tests for Model.js |
| `test/hook.test.sh` | bash tests for both scripts (stubbed `hyprctl`/`omarchy-shell`, temp HOME) |
| `README.md`, `LICENSE`, `preview.png` | docs / marketplace |

---

### Task 1: Scaffold the plugin repo

**Files:**
- Create: `manifest.json`, `LICENSE`, `README.md` (stub), `bin/.gitkeep`-free (bin created in Task 5)

**Interfaces:**
- Produces: plugin id and settings keys used by every later task.

- [ ] **Step 1: Write manifest.json**

```json
{
  "schemaVersion": 1,
  "id": "io.github.5d0tal1gat0r.agent-watcher",
  "name": "Agent Watcher",
  "version": "0.1.0",
  "author": "5d0tal1gat0r",
  "license": "MIT",
  "description": "Every Claude Code, Codex, Gemini CLI and OpenCode session across your workspaces in one bar pill — it blinks when an agent finishes or waits for you.",
  "kinds": ["bar-widget"],
  "entryPoints": {
    "barWidget": "BarWidget.qml"
  },
  "barWidget": {
    "displayName": "Agent Watcher",
    "description": "AI agent sessions per workspace, with an attention blink",
    "category": "AI",
    "allowMultiple": false,
    "defaultSection": "right",
    "defaults": {
      "blinkOnDone": true,
      "blinkOnWaiting": true
    }
  }
}
```

- [ ] **Step 2: Write LICENSE** — MIT, `Copyright (c) 2026 5d0tal1gat0r` (copy the text from `~/Proyects/omarchy-plugins-dev/omarchy-stocks/LICENSE`, it is the standard MIT text with that copyright line).

- [ ] **Step 3: Write a README stub** (Task 10 writes the real one)

```markdown
# Agent Watcher for Omarchy

Bar widget that lists every Claude Code, Codex, Gemini CLI and OpenCode session
across your Hyprland workspaces and blinks when one finishes or waits for you.

Work in progress — see `docs/superpowers/specs/2026-08-18-agent-watcher-design.md`.
```

- [ ] **Step 4: Validate the manifest** (validator needs the entry point to exist — create an empty placeholder that Task 7 replaces)

Run: `printf 'import QtQuick\nItem {}\n' > BarWidget.qml && omarchy plugin validate . && echo VALID`
Expected: `VALID` (validator is silent on success).

- [ ] **Step 5: Commit**

```bash
git add manifest.json LICENSE README.md BarWidget.qml
git commit -m "chore: scaffold agent-watcher plugin"
```

---

### Task 2: Model.js — session parsing and formatting

**Files:**
- Create: `Model.js`
- Create: `test/model.test.js`

**Interfaces:**
- Produces (used by Tasks 3, 4, 7, 8):
  - `AGENTS: [{id, name}]`, `STATES`, `BAR_ICON`, `OTHER_GROUP_ID = -1`
  - `agentName(id) -> string`
  - `boolSetting(value, fallback) -> boolean`
  - `normalizeAddress(value) -> string` (bare lowercase hex, `""` if invalid)
  - `sessionKey(agent, sessionId) -> "agent-sessionId"`
  - `normalizeSession(raw) -> session|null` — session = `{key, agent, sessionId, state, cwd, agentPid, windowAddress, updatedAt, lastEvent, seen:false, stateSince:0}`
  - `parseSnapshot(text) -> session[]`
  - `projectName(cwd) -> string`, `cleanTitle(title) -> string`, `formatElapsed(sinceSec, nowSec) -> string`
  - `normalizeColor(value)`, `parseThemeColor(tomlText, key)`, `pathFromUrl(url)`

- [ ] **Step 1: Write the failing tests**

`test/model.test.js`:

```js
const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("../Model.js")

// ---- Task 2: parsing & formatting

test("agentName: known ids map to display names, unknown ids pass through", () => {
  assert.equal(Model.agentName("claude"), "Claude Code")
  assert.equal(Model.agentName("codex"), "Codex")
  assert.equal(Model.agentName("gemini"), "Gemini CLI")
  assert.equal(Model.agentName("opencode"), "OpenCode")
  assert.equal(Model.agentName("aider"), "aider")
  assert.equal(Model.agentName(""), "Agent")
})

test("boolSetting: accepts booleans and common string spellings, else fallback", () => {
  assert.equal(Model.boolSetting(true, false), true)
  assert.equal(Model.boolSetting(false, true), false)
  assert.equal(Model.boolSetting("false", true), false)
  assert.equal(Model.boolSetting("TRUE", false), true)
  assert.equal(Model.boolSetting("0", true), false)
  assert.equal(Model.boolSetting("on", false), true)
  assert.equal(Model.boolSetting(undefined, true), true)
  assert.equal(Model.boolSetting("maybe", false), false)
})

test("normalizeAddress: strips 0x, lower-cases, rejects junk", () => {
  assert.equal(Model.normalizeAddress("0x55C153BDE310"), "55c153bde310")
  assert.equal(Model.normalizeAddress(" 55c153bde310 "), "55c153bde310")
  assert.equal(Model.normalizeAddress("nope"), "")
  assert.equal(Model.normalizeAddress(""), "")
  assert.equal(Model.normalizeAddress(null), "")
})

test("normalizeSession: valid file becomes a session with shell-side defaults", () => {
  const s = Model.normalizeSession({
    agent: "claude", sessionId: "abc", state: "done", cwd: "/home/u/proj",
    agentPid: "4242", windowAddress: "0xABC", updatedAt: 1755500000, lastEvent: "done"
  })
  assert.deepEqual(s, {
    key: "claude-abc", agent: "claude", sessionId: "abc", state: "done", cwd: "/home/u/proj",
    agentPid: 4242, windowAddress: "abc", updatedAt: 1755500000, lastEvent: "done",
    seen: false, stateSince: 0
  })
})

test("normalizeSession: rejects missing agent/id, unknown state, non-objects", () => {
  assert.equal(Model.normalizeSession(null), null)
  assert.equal(Model.normalizeSession("x"), null)
  assert.equal(Model.normalizeSession({ agent: "", sessionId: "a", state: "idle" }), null)
  assert.equal(Model.normalizeSession({ agent: "claude", sessionId: "", state: "idle" }), null)
  assert.equal(Model.normalizeSession({ agent: "claude", sessionId: "a", state: "sleeping" }), null)
  const s = Model.normalizeSession({ agent: "codex", sessionId: "a", state: "idle" })
  assert.equal(s.cwd, "")
  assert.equal(s.agentPid, 0)
  assert.equal(s.windowAddress, "")
  assert.equal(s.updatedAt, 0)
})

test("parseSnapshot: tolerant of bad JSON, non-arrays and junk entries", () => {
  assert.deepEqual(Model.parseSnapshot("not json"), [])
  assert.deepEqual(Model.parseSnapshot('{"agent":"claude"}'), [])
  assert.deepEqual(Model.parseSnapshot(""), [])
  const list = Model.parseSnapshot(JSON.stringify([
    { agent: "claude", sessionId: "a", state: "working" },
    { agent: "claude", sessionId: "b", state: "bogus" },
    42,
    { agent: "gemini", sessionId: "c", state: "idle", windowAddress: "0xFF" }
  ]))
  assert.deepEqual(list.map(s => s.key), ["claude-a", "gemini-c"])
  assert.equal(list[1].windowAddress, "ff")
})

test("projectName: basename of cwd with sane fallbacks", () => {
  assert.equal(Model.projectName("/home/u/Proyects/omarchy-agent-watcher"), "omarchy-agent-watcher")
  assert.equal(Model.projectName("/home/u/proj/"), "proj")
  assert.equal(Model.projectName("/"), "/")
  assert.equal(Model.projectName(""), "?")
  assert.equal(Model.projectName("relative"), "relative")
})

test("cleanTitle: strips leading status glyphs and whitespace, keeps the text", () => {
  assert.equal(Model.cleanTitle("◐ Create Omarchy plugin for AI agent session monitoring"), "Create Omarchy plugin for AI agent session monitoring")
  assert.equal(Model.cleanTitle("✳ Claude Code"), "Claude Code")
  assert.equal(Model.cleanTitle("  ✶ ✻ fixing tests "), "fixing tests")
  assert.equal(Model.cleanTitle("~/proj — bash"), "~/proj — bash")
  assert.equal(Model.cleanTitle("/usr/bin/zsh"), "/usr/bin/zsh")
  assert.equal(Model.cleanTitle(""), "")
  assert.equal(Model.cleanTitle(null), "")
})

test("formatElapsed: seconds, minutes, hours(+minutes), days; empty when unknown", () => {
  const now = 1000000
  assert.equal(Model.formatElapsed(0, now), "")
  assert.equal(Model.formatElapsed(now - 12, now), "12s")
  assert.equal(Model.formatElapsed(now - 240, now), "4m")
  assert.equal(Model.formatElapsed(now - 3600, now), "1h")
  assert.equal(Model.formatElapsed(now - 4320, now), "1h 12m")
  assert.equal(Model.formatElapsed(now - 200000, now), "2d")
  assert.equal(Model.formatElapsed(now + 50, now), "0s")
})

test("parseThemeColor: reads a colors.toml key, ignores junk", () => {
  const toml = 'mode = "dark"\ngreen = "#a9b665"\nyellow = "#d8a657"\nred = "nope"\n'
  assert.equal(Model.parseThemeColor(toml, "green"), "#a9b665")
  assert.equal(Model.parseThemeColor(toml, "yellow"), "#d8a657")
  assert.equal(Model.parseThemeColor(toml, "red"), "")
  assert.equal(Model.parseThemeColor(toml, "blue"), "")
  assert.equal(Model.parseThemeColor("", "green"), "")
})

test("pathFromUrl: file URL to a plain decoded path", () => {
  assert.equal(Model.pathFromUrl("file:///home/u/.config/omarchy/plugins/x/bin/hook"), "/home/u/.config/omarchy/plugins/x/bin/hook")
  assert.equal(Model.pathFromUrl("file:///home/u/my%20plugins/bin/hook"), "/home/u/my plugins/bin/hook")
  assert.equal(Model.pathFromUrl("/already/a/path"), "/already/a/path")
  assert.equal(Model.pathFromUrl(""), "")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/model.test.js`
Expected: FAIL — `Cannot find module '../Model.js'`.

- [ ] **Step 3: Write Model.js (part 1)**

```js
// Pure logic for the Agent Watcher bar widget. No QML imports: this file is
// loaded by BarWidget.qml/Panel.qml through `import "Model.js" as Model` and
// by the node test-suite through require(), so it stays ES5-style and ends
// with a module.exports guard (same convention as omarchy-stocks).

var AGENTS = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "opencode", name: "OpenCode" }
]
var STATES = ["working", "waiting", "done", "idle"]
var STATE_RANK = { waiting: 0, done: 1, working: 2, idle: 3 }
var BAR_ICON = "\uDB81\uDEA9" // nf-md-robot (U+F06A9)
var OTHER_GROUP_ID = -1

function trimString(value) {
  return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "")
}

function agentName(id) {
  for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].id === id) return AGENTS[i].name
  return trimString(id) || "Agent"
}

// Settings arrive as real booleans from shell.json, but `omarchy bar set`
// without --json stores strings.
function boolSetting(value, fallback) {
  if (value === true || value === false) return value
  var s = trimString(value).toLowerCase()
  if (s === "true" || s === "1" || s === "on" || s === "yes") return true
  if (s === "false" || s === "0" || s === "off" || s === "no") return false
  return fallback
}

// hyprctl prints "0x55c1…", Quickshell's HyprlandToplevel.address is bare
// hex; everything inside the model uses the bare lowercase form.
function normalizeAddress(value) {
  var s = trimString(value).toLowerCase()
  if (s.indexOf("0x") === 0) s = s.slice(2)
  return /^[0-9a-f]+$/.test(s) ? s : ""
}

function toInt(value, fallback) {
  var n = parseInt(String(value), 10)
  return isNaN(n) ? fallback : n
}

function sessionKey(agent, sessionId) {
  return agent + "-" + sessionId
}

// One state file as written by bin/agent-watcher-hook -> a session record,
// or null when the object is not usable. `seen` / `stateSince` are shell-side
// only and get filled in by mergeSessions.
function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") return null
  var agent = trimString(raw.agent)
  var sessionId = trimString(raw.sessionId)
  var state = trimString(raw.state)
  if (agent === "" || sessionId === "" || STATES.indexOf(state) === -1) return null
  return {
    key: sessionKey(agent, sessionId),
    agent: agent,
    sessionId: sessionId,
    state: state,
    cwd: trimString(raw.cwd),
    agentPid: Math.max(0, toInt(raw.agentPid, 0)),
    windowAddress: normalizeAddress(raw.windowAddress),
    updatedAt: Math.max(0, toInt(raw.updatedAt, 0)),
    lastEvent: trimString(raw.lastEvent),
    seen: false,
    stateSince: 0
  }
}

// Output of `agent-watcher-hook dump` (a JSON array) -> sessions.
function parseSnapshot(text) {
  var parsed
  try { parsed = JSON.parse(String(text || "")) } catch (e) { return [] }
  if (!Array.isArray(parsed)) return []
  var out = []
  for (var i = 0; i < parsed.length; i++) {
    var s = normalizeSession(parsed[i])
    if (s) out.push(s)
  }
  return out
}

function projectName(cwd) {
  var s = trimString(cwd).replace(/\/+$/, "")
  if (s === "") return trimString(cwd) === "/" ? "/" : "?"
  var idx = s.lastIndexOf("/")
  return idx >= 0 ? s.slice(idx + 1) : s
}

// Terminal titles from agents start with a status glyph (Claude Code's
// spinner ◐◓◑◒, ✳, ✶ …). Keep the human part.
function cleanTitle(title) {
  return trimString(String(title === undefined || title === null ? "" : title).replace(/^[^A-Za-z0-9~\/._"'`(\[{<$@]+/, ""))
}

function formatElapsed(sinceSec, nowSec) {
  if (!sinceSec) return ""
  var d = Math.max(0, Math.floor((nowSec || 0) - sinceSec))
  if (d < 60) return d + "s"
  if (d < 3600) return Math.floor(d / 60) + "m"
  if (d < 86400) {
    var h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60)
    return m > 0 ? h + "h " + m + "m" : h + "h"
  }
  return Math.floor(d / 86400) + "d"
}

function normalizeColor(value) {
  var s = trimString(value).toLowerCase()
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s) ? s : ""
}

function parseThemeColor(tomlText, key) {
  var lines = String(tomlText || "").split("\n")
  var pattern = new RegExp("^\\s*" + key + "\\s*=\\s*[\"']([^\"']*)[\"']")
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(pattern)
    if (m) return normalizeColor(m[1])
  }
  return ""
}

// Qt.resolvedUrl("bin/x") -> "/abs/path/bin/x"
function pathFromUrl(url) {
  var s = String(url === undefined || url === null ? "" : url)
  if (s.indexOf("file://") === 0) s = s.slice(7)
  try { return decodeURIComponent(s) } catch (e) { return s }
}

if (typeof module !== "undefined") {
  module.exports = {
    AGENTS: AGENTS,
    STATES: STATES,
    STATE_RANK: STATE_RANK,
    BAR_ICON: BAR_ICON,
    OTHER_GROUP_ID: OTHER_GROUP_ID,
    agentName: agentName,
    boolSetting: boolSetting,
    normalizeAddress: normalizeAddress,
    sessionKey: sessionKey,
    normalizeSession: normalizeSession,
    parseSnapshot: parseSnapshot,
    projectName: projectName,
    cleanTitle: cleanTitle,
    formatElapsed: formatElapsed,
    normalizeColor: normalizeColor,
    parseThemeColor: parseThemeColor,
    pathFromUrl: pathFromUrl
  }
}
```

Note: `projectName("/")` — the trailing-slash strip turns `/` into `""`; the code returns `/` for that case and `?` for a truly empty cwd.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/model.test.js`
Expected: all pass (11 tests).

- [ ] **Step 5: Commit**

```bash
git add Model.js test/model.test.js
git commit -m "feat(model): session parsing and formatting helpers"
```

---

### Task 3: Model.js — merge, seen, attention, bar summary

**Files:**
- Modify: `Model.js` (append functions before the export guard, extend exports)
- Modify: `test/model.test.js` (append)

**Interfaces:**
- Consumes: Task 2 (`normalizeAddress`, `boolSetting`, `BAR_ICON`).
- Produces (used by Tasks 4, 7, 8):
  - `mergeSessions(prevMap, snapshot, activeAddress, nowSec) -> map` (key → session; adds `seen`, `stateSince`)
  - `markSeen(map, activeAddress) -> map`
  - `sessionList(map) -> session[]`
  - `displayState(session) -> "working"|"waiting"|"done"|"idle"`
  - `needsAttention(session, settings) -> boolean` (settings = `{blinkOnDone, blinkOnWaiting}`)
  - `barSummary(list, settings) -> {total, working, waiting, done, attention, level:"waiting"|"done"|"none", blink}`
  - `barParts(summary) -> {icon, working, dot, attention}` (strings, already spaced), `barLabel(summary) -> string`, `verticalLabel(summary) -> string`, `summaryLine(summary) -> string`

- [ ] **Step 1: Write the failing tests** (append to `test/model.test.js`)

```js
// ---- Task 3: merge / seen / attention / summary

function snap(list) { return Model.parseSnapshot(JSON.stringify(list)) }
const F = (over) => Object.assign({ agent: "claude", sessionId: "s1", state: "done", cwd: "/p", agentPid: 10, windowAddress: "aaa", updatedAt: 100, lastEvent: "done" }, over)

test("mergeSessions: done/waiting born unseen unless the window is focused; working/idle are always seen", () => {
  const m1 = Model.mergeSessions({}, snap([F({ state: "done" })]), "bbb", 100)
  assert.equal(m1["claude-s1"].seen, false)
  const m2 = Model.mergeSessions({}, snap([F({ state: "done" })]), "0xAAA", 100)
  assert.equal(m2["claude-s1"].seen, true)
  const m3 = Model.mergeSessions({}, snap([F({ state: "waiting" })]), "bbb", 100)
  assert.equal(m3["claude-s1"].seen, false)
  const m4 = Model.mergeSessions({}, snap([F({ state: "working" })]), "", 100)
  assert.equal(m4["claude-s1"].seen, true)
  const m5 = Model.mergeSessions({}, snap([F({ state: "idle", windowAddress: "" })]), "", 100)
  assert.equal(m5["claude-s1"].seen, true)
})

test("mergeSessions: unchanged event keeps seen and stateSince; new event recomputes seen", () => {
  let m = Model.mergeSessions({}, snap([F({ state: "done", updatedAt: 100 })]), "bbb", 100)
  m = Model.markSeen(m, "aaa")
  assert.equal(m["claude-s1"].seen, true)
  const same = Model.mergeSessions(m, snap([F({ state: "done", updatedAt: 100 })]), "bbb", 200)
  assert.equal(same["claude-s1"].seen, true)
  assert.equal(same["claude-s1"].stateSince, 100)
  const again = Model.mergeSessions(m, snap([F({ state: "done", updatedAt: 150 })]), "bbb", 200)
  assert.equal(again["claude-s1"].seen, false)
})

test("mergeSessions: stateSince follows state changes, not every event", () => {
  let m = Model.mergeSessions({}, snap([F({ state: "working", lastEvent: "prompt", updatedAt: 100 })]), "", 100)
  assert.equal(m["claude-s1"].stateSince, 100)
  m = Model.mergeSessions(m, snap([F({ state: "working", lastEvent: "prompt", updatedAt: 130 })]), "", 130)
  assert.equal(m["claude-s1"].stateSince, 100, "same state keeps the original start")
  m = Model.mergeSessions(m, snap([F({ state: "done", lastEvent: "done", updatedAt: 160 })]), "", 160)
  assert.equal(m["claude-s1"].stateSince, 160)
  const noStamp = Model.mergeSessions({}, snap([F({ updatedAt: 0 })]), "", 777)
  assert.equal(noStamp["claude-s1"].stateSince, 777, "missing updatedAt falls back to now")
})

test("mergeSessions: sessions missing from the snapshot are dropped", () => {
  let m = Model.mergeSessions({}, snap([F({ sessionId: "a" }), F({ sessionId: "b" })]), "", 1)
  assert.deepEqual(Object.keys(m).sort(), ["claude-a", "claude-b"])
  m = Model.mergeSessions(m, snap([F({ sessionId: "b" })]), "", 2)
  assert.deepEqual(Object.keys(m), ["claude-b"])
})

test("markSeen: only sessions on the focused window flip; others untouched", () => {
  const m = Model.mergeSessions({}, snap([F({ sessionId: "a", windowAddress: "aaa" }), F({ sessionId: "b", windowAddress: "bbb" })]), "", 1)
  const after = Model.markSeen(m, "0xAAA")
  assert.equal(after["claude-a"].seen, true)
  assert.equal(after["claude-b"].seen, false)
  assert.equal(Model.markSeen(m, "")["claude-a"].seen, false)
})

test("displayState: a seen done reads as idle, everything else as-is", () => {
  assert.equal(Model.displayState({ state: "done", seen: true }), "idle")
  assert.equal(Model.displayState({ state: "done", seen: false }), "done")
  assert.equal(Model.displayState({ state: "waiting", seen: true }), "waiting")
  assert.equal(Model.displayState({ state: "working", seen: true }), "working")
})

test("needsAttention: unseen done/waiting, gated by the blink settings", () => {
  const on = { blinkOnDone: true, blinkOnWaiting: true }
  assert.equal(Model.needsAttention({ state: "done", seen: false }, on), true)
  assert.equal(Model.needsAttention({ state: "waiting", seen: false }, on), true)
  assert.equal(Model.needsAttention({ state: "done", seen: true }, on), false)
  assert.equal(Model.needsAttention({ state: "working", seen: false }, on), false)
  assert.equal(Model.needsAttention({ state: "done", seen: false }, { blinkOnDone: false, blinkOnWaiting: true }), false)
  assert.equal(Model.needsAttention({ state: "waiting", seen: false }, { blinkOnDone: true, blinkOnWaiting: "false" }), false)
  assert.equal(Model.needsAttention({ state: "done", seen: false }, {}), true, "defaults are on")
})

test("barSummary: counts, level priority (waiting beats done) and blink", () => {
  const list = [
    { state: "working", seen: true }, { state: "working", seen: true },
    { state: "done", seen: false }, { state: "done", seen: true },
    { state: "waiting", seen: false }, { state: "idle", seen: true }
  ]
  const s = Model.barSummary(list, {})
  assert.deepEqual(s, { total: 6, working: 2, waiting: 1, done: 1, attention: 2, level: "waiting", blink: true })
  const d = Model.barSummary([{ state: "done", seen: false }], {})
  assert.equal(d.level, "done")
  const none = Model.barSummary([{ state: "working", seen: true }], {})
  assert.deepEqual([none.level, none.blink, none.attention], ["none", false, 0])
  assert.equal(Model.barSummary([{ state: "waiting", seen: false }], { blinkOnWaiting: false }).attention, 0)
})

test("barParts/barLabel/verticalLabel: icon, working, dot, attention", () => {
  const both = Model.barSummary([{ state: "working", seen: true }, { state: "working", seen: true }, { state: "done", seen: false }], {})
  assert.deepEqual(Model.barParts(both), { icon: Model.BAR_ICON, working: " 2", dot: " ·", attention: " 1" })
  assert.equal(Model.barLabel(both), Model.BAR_ICON + " 2 · 1")
  const onlyWork = Model.barSummary([{ state: "working", seen: true }], {})
  assert.equal(Model.barLabel(onlyWork), Model.BAR_ICON + " 1")
  const onlyAttn = Model.barSummary([{ state: "waiting", seen: false }], {})
  assert.equal(Model.barLabel(onlyAttn), Model.BAR_ICON + " 1")
  assert.deepEqual(Model.barParts(onlyAttn), { icon: Model.BAR_ICON, working: "", dot: "", attention: " 1" })
  assert.equal(Model.barLabel(Model.barSummary([], {})), Model.BAR_ICON)
  assert.equal(Model.verticalLabel(both), Model.BAR_ICON + "\n2\n1")
  assert.equal(Model.verticalLabel(Model.barSummary([], {})), Model.BAR_ICON)
})

test("summaryLine: human header line", () => {
  assert.equal(Model.summaryLine(Model.barSummary([], {})), "No sessions")
  assert.equal(Model.summaryLine(Model.barSummary([{ state: "idle", seen: true }], {})), "1 session")
  const s = Model.barSummary([{ state: "working", seen: true }, { state: "waiting", seen: false }, { state: "done", seen: false }], {})
  assert.equal(Model.summaryLine(s), "3 sessions · 1 working · 1 waiting · 1 done")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/model.test.js`
Expected: the new tests FAIL with `Model.mergeSessions is not a function` (and similar).

- [ ] **Step 3: Implement (append to Model.js before the export guard)**

```js
function isSameEvent(prev, next) {
  return !!prev && prev.updatedAt === next.updatedAt && prev.state === next.state && prev.lastEvent === next.lastEvent
}

function copySession(s) {
  var out = {}
  for (var k in s) out[k] = s[k]
  return out
}

// Merge a fresh snapshot into the previous session map. `seen` and
// `stateSince` are shell-side only, so they carry over from `prev` unless the
// file shows a new event. A new done/waiting event whose window is the active
// toplevel is born seen (the user was watching); working/idle never blink.
function mergeSessions(prevMap, snapshot, activeAddress, nowSec) {
  var prev = prevMap || {}
  var active = normalizeAddress(activeAddress)
  var out = {}
  for (var i = 0; i < snapshot.length; i++) {
    var s = snapshot[i]
    var old = prev[s.key]
    var next = copySession(s)
    if (isSameEvent(old, s)) {
      next.seen = old.seen
      next.stateSince = old.stateSince
    } else {
      var focused = s.windowAddress !== "" && s.windowAddress === active
      next.seen = focused || s.state === "working" || s.state === "idle"
      next.stateSince = old && old.state === s.state ? old.stateSince : (s.updatedAt || nowSec || 0)
    }
    out[s.key] = next
  }
  return out
}

// The window with `activeAddress` just got focus: its sessions are seen.
function markSeen(map, activeAddress) {
  var active = normalizeAddress(activeAddress)
  var out = {}
  for (var key in map) {
    var s = map[key]
    if (active !== "" && s.windowAddress === active && !s.seen) {
      var copy = copySession(s)
      copy.seen = true
      out[key] = copy
    } else {
      out[key] = s
    }
  }
  return out
}

function sessionList(map) {
  var out = []
  for (var key in map) out.push(map[key])
  return out
}

function displayState(session) {
  return session.state === "done" && session.seen ? "idle" : session.state
}

function needsAttention(session, settings) {
  var opts = settings || {}
  if (session.seen) return false
  if (session.state === "done") return boolSetting(opts.blinkOnDone, true)
  if (session.state === "waiting") return boolSetting(opts.blinkOnWaiting, true)
  return false
}

function barSummary(list, settings) {
  var working = 0, waiting = 0, done = 0
  for (var i = 0; i < list.length; i++) {
    var s = list[i]
    if (s.state === "working") working++
    if (needsAttention(s, settings)) {
      if (s.state === "waiting") waiting++
      else done++
    }
  }
  var attention = waiting + done
  return {
    total: list.length,
    working: working,
    waiting: waiting,
    done: done,
    attention: attention,
    level: waiting > 0 ? "waiting" : (done > 0 ? "done" : "none"),
    blink: attention > 0
  }
}

// Pieces of the pill text, pre-spaced so the colored overlay Row in
// BarWidget.qml and the sizing label agree exactly: "󱚣 2 · 1".
function barParts(summary) {
  var s = summary || { working: 0, attention: 0 }
  return {
    icon: BAR_ICON,
    working: s.working > 0 ? " " + s.working : "",
    dot: s.working > 0 && s.attention > 0 ? " ·" : "",
    attention: s.attention > 0 ? " " + s.attention : ""
  }
}

function barLabel(summary) {
  var p = barParts(summary)
  return p.icon + p.working + p.dot + p.attention
}

function verticalLabel(summary) {
  var s = summary || { working: 0, attention: 0 }
  var lines = [BAR_ICON]
  if (s.working > 0) lines.push(String(s.working))
  if (s.attention > 0) lines.push(String(s.attention))
  return lines.join("\n")
}

function summaryLine(summary) {
  if (!summary || summary.total === 0) return "No sessions"
  var bits = [summary.total + (summary.total === 1 ? " session" : " sessions")]
  if (summary.working > 0) bits.push(summary.working + " working")
  if (summary.waiting > 0) bits.push(summary.waiting + " waiting")
  if (summary.done > 0) bits.push(summary.done + " done")
  return bits.join(" · ")
}
```

Add to `module.exports`: `mergeSessions, markSeen, sessionList, displayState, needsAttention, barSummary, barParts, barLabel, verticalLabel, summaryLine`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/model.test.js`
Expected: all pass (21 tests).

- [ ] **Step 5: Commit**

```bash
git add Model.js test/model.test.js
git commit -m "feat(model): session merge, seen tracking and bar summary"
```

---

### Task 4: Model.js — sorting, workspace grouping, hook status

**Files:**
- Modify: `Model.js`, `test/model.test.js`

**Interfaces:**
- Consumes: Task 3 (`needsAttention`, `displayState`, `STATE_RANK`).
- Produces (used by Task 8):
  - `sortSessions(list, settings) -> session[]` (attention first, then waiting/done/working/idle, then newest `stateSince`)
  - `groupByWorkspace(list, lookup, focusedWorkspaceId, settings) -> [{id, label, current, sessions}]` where `lookup = { address: {workspaceId, title} }`
  - `HOOK_STATUSES`, `parseHookStatus(text) -> {agent: status}`, `hookStatusLabel(status) -> string`

- [ ] **Step 1: Write the failing tests** (append)

```js
// ---- Task 4: sorting, grouping, hook status

test("sortSessions: attention first, then waiting/done/working/idle, then newest", () => {
  const list = [
    { key: "a", state: "idle", seen: true, stateSince: 50 },
    { key: "b", state: "working", seen: true, stateSince: 10 },
    { key: "c", state: "done", seen: false, stateSince: 20 },
    { key: "d", state: "waiting", seen: false, stateSince: 5 },
    { key: "e", state: "done", seen: true, stateSince: 90 },   // displays as idle
    { key: "f", state: "working", seen: true, stateSince: 40 },
    { key: "g", state: "waiting", seen: true, stateSince: 1 }   // seen waiting: no attention, still ranks as waiting
  ]
  assert.deepEqual(Model.sortSessions(list, {}).map(s => s.key), ["d", "c", "g", "f", "b", "e", "a"])
  assert.deepEqual(Model.sortSessions(list, { blinkOnDone: false }).map(s => s.key), ["d", "g", "c", "f", "b", "e", "a"])
  assert.equal(list[0].key, "a", "input is not mutated")
})

test("groupByWorkspace: groups by the live window's workspace, Other last, current flagged, sorted inside", () => {
  const list = [
    { key: "a", state: "idle", seen: true, stateSince: 1, windowAddress: "w1" },
    { key: "b", state: "done", seen: false, stateSince: 2, windowAddress: "w1" },
    { key: "c", state: "working", seen: true, stateSince: 3, windowAddress: "w2" },
    { key: "d", state: "working", seen: true, stateSince: 4, windowAddress: "" },
    { key: "e", state: "idle", seen: true, stateSince: 5, windowAddress: "gone" }
  ]
  const lookup = { w1: { workspaceId: 5, title: "x" }, w2: { workspaceId: 2, title: "y" } }
  const groups = Model.groupByWorkspace(list, lookup, 5, {})
  assert.deepEqual(groups.map(g => [g.id, g.label, g.current, g.sessions.map(s => s.key)]), [
    [2, "Workspace 2", false, ["c"]],
    [5, "Workspace 5", true, ["b", "a"]],
    [Model.OTHER_GROUP_ID, "Other", false, ["d", "e"]]
  ])
  assert.deepEqual(Model.groupByWorkspace([], lookup, 1, {}), [])
  assert.equal(Model.groupByWorkspace(list.slice(0, 1), null, 1, {})[0].label, "Other")
})

test("parseHookStatus / hookStatusLabel", () => {
  assert.deepEqual(Model.parseHookStatus("claude installed\ncodex agent-missing\ngemini not-installed\nbogus line\nopencode weird\n"),
    { claude: "installed", codex: "agent-missing", gemini: "not-installed" })
  assert.deepEqual(Model.parseHookStatus(""), {})
  assert.equal(Model.hookStatusLabel("installed"), "hooks installed")
  assert.equal(Model.hookStatusLabel("not-installed"), "not installed")
  assert.equal(Model.hookStatusLabel("agent-missing"), "not found")
  assert.equal(Model.hookStatusLabel(undefined), "checking…")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/model.test.js`
Expected: new tests FAIL (`sortSessions is not a function`).

- [ ] **Step 3: Implement (append before the export guard)**

```js
function compareSessions(a, b, settings) {
  var aa = needsAttention(a, settings) ? 0 : 1
  var ab = needsAttention(b, settings) ? 0 : 1
  if (aa !== ab) return aa - ab
  var ra = STATE_RANK[displayState(a)], rb = STATE_RANK[displayState(b)]
  if (ra !== rb) return ra - rb
  if (a.stateSince !== b.stateSince) return b.stateSince - a.stateSince // newest first
  return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0)
}

function sortSessions(list, settings) {
  var copy = list.slice()
  copy.sort(function(a, b) { return compareSessions(a, b, settings) })
  return copy
}

// `lookup` maps a bare window address to { workspaceId, title } (built by
// Panel.qml from Hyprland.toplevels). Sessions without a live window go to
// "Other".
function groupByWorkspace(list, lookup, focusedWorkspaceId, settings) {
  var table = lookup || {}
  var groups = {}
  var other = []
  for (var i = 0; i < list.length; i++) {
    var s = list[i]
    var win = s.windowAddress !== "" ? table[s.windowAddress] : null
    var wsId = win && typeof win.workspaceId === "number" && win.workspaceId > 0 ? win.workspaceId : null
    if (wsId === null) { other.push(s); continue }
    if (!groups[wsId]) groups[wsId] = []
    groups[wsId].push(s)
  }
  var ids = []
  for (var id in groups) ids.push(parseInt(id, 10))
  ids.sort(function(a, b) { return a - b })
  var out = []
  for (var j = 0; j < ids.length; j++) {
    out.push({
      id: ids[j],
      label: "Workspace " + ids[j],
      current: ids[j] === focusedWorkspaceId,
      sessions: sortSessions(groups[ids[j]], settings)
    })
  }
  if (other.length) out.push({ id: OTHER_GROUP_ID, label: "Other", current: false, sessions: sortSessions(other, settings) })
  return out
}

// Output of `agent-watcher-setup status all`: one "<agent> <status>" per line.
var HOOK_STATUSES = ["installed", "not-installed", "agent-missing"]

function parseHookStatus(text) {
  var out = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*([a-z]+)\s+([a-z-]+)\s*$/)
    if (m && HOOK_STATUSES.indexOf(m[2]) !== -1) out[m[1]] = m[2]
  }
  return out
}

function hookStatusLabel(status) {
  if (status === "installed") return "hooks installed"
  if (status === "not-installed") return "not installed"
  if (status === "agent-missing") return "not found"
  return "checking…"
}
```

Add to exports: `sortSessions, groupByWorkspace, HOOK_STATUSES, parseHookStatus, hookStatusLabel`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/model.test.js`
Expected: all pass (24 tests).

- [ ] **Step 5: Commit**

```bash
git add Model.js test/model.test.js
git commit -m "feat(model): sorting, workspace grouping and hook status parsing"
```

---

### Task 5: `bin/agent-watcher-hook` (events → state files, dump/prune)

**Files:**
- Create: `bin/agent-watcher-hook` (executable)
- Create: `test/hook.test.sh` (executable)

**Interfaces:**
- Consumes: nothing from other tasks (state-file schema per Global Constraints).
- Produces (used by Tasks 6, 7): CLI `agent-watcher-hook <agent> <event>` (stdin JSON) and `agent-watcher-hook dump` (stdout JSON array of state files after pruning). Env `AGENT_WATCHER_STATE_DIR` overrides the state dir; `AGENT_WATCHER_DEBUG=1` keeps stderr.

- [ ] **Step 1: Write the failing tests**

`test/hook.test.sh`:

```bash
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
```

Note on the last checks: `( exec -a claude sleep 60 ) &` gives a process whose cmdline is `claude 60` (matches the agent pattern) and stays alive; the fake `claude` wrapper used by `run_agent` exits right after the hook returns, so its PID is dead by the time `dump` runs — the prune must treat that as gone.

- [ ] **Step 2: Run to verify it fails**

Run: `bash test/hook.test.sh`
Expected: many `FAIL:` lines (hook script missing) and non-zero exit.

- [ ] **Step 3: Write `bin/agent-watcher-hook`**

```bash
#!/usr/bin/env bash
# Agent Watcher hook: turns one agent hook invocation into a state-file update
# plus a shell ping, or dumps the current state for the shell.
#
#   agent-watcher-hook <agent> <event>     stdin: the agent's hook JSON
#   agent-watcher-hook dump                prune dead sessions, print JSON array
#
#   agent: claude | codex | gemini | opencode
#   event: session-start | prompt | waiting | tool-done | done | session-end
#
# Silent and always exit 0 on the hook path: agents treat exit codes and
# stdout as control signals. Set AGENT_WATCHER_DEBUG=1 to keep stderr.

STATE_DIR="${AGENT_WATCHER_STATE_DIR:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/omarchy-agent-watcher}"
PLUGIN_ID="io.github.5d0tal1gat0r.agent-watcher"

agent_pattern() { # ERE matched against an ancestor's cmdline (NULs -> spaces)
  case "$1" in
    claude)   printf '%s' '(^|[/ ])claude([ -]|$)' ;;
    codex)    printf '%s' '(^|[/ ])codex([ -]|$)' ;;
    gemini)   printf '%s' 'gemini' ;;
    opencode) printf '%s' '(^|[/ ])opencode([ -]|$)' ;;
    *)        printf '%s' '^$' ;;
  esac
}

cmdline_of() { tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null; }

alive() { # alive <pid> <agent>: process exists and still looks like that agent
  [ -n "$1" ] && [ "$1" -gt 0 ] 2>/dev/null && [ -d "/proc/$1" ] || return 1
  cmdline_of "$1" | grep -Eq "$(agent_pattern "$2")"
}

# Walk the parent chain. Sets AGENT_PID (first ancestor whose cmdline matches
# the agent, skipping our own wrappers) and, when need_window=1,
# WINDOW_ADDRESS (first ancestor that owns a Hyprland client, bare hex).
resolve_ancestry() { # resolve_ancestry <agent> <need_window:0|1>
  local agent="$1" need_window="$2" pid=$$ pattern clients="" cmd
  pattern=$(agent_pattern "$agent")
  AGENT_PID=0
  WINDOW_ADDRESS=""
  if [ "$need_window" = 1 ]; then
    clients=$(hyprctl clients -j 2>/dev/null | jq -r '.[] | "\(.pid) \(.address)"' 2>/dev/null)
  fi
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    cmd=$(cmdline_of "$pid")
    if [ "$AGENT_PID" = 0 ] && [ "${cmd#*agent-watcher}" = "$cmd" ] && printf '%s' "$cmd" | grep -Eq "$pattern"; then
      AGENT_PID=$pid
    fi
    if [ -n "$clients" ] && [ -z "$WINDOW_ADDRESS" ]; then
      WINDOW_ADDRESS=$(printf '%s\n' "$clients" | awk -v p="$pid" '$1 == p { sub(/^0x/, "", $2); print tolower($2); exit }')
    fi
    if [ "$AGENT_PID" != 0 ] && { [ "$need_window" != 1 ] || [ -n "$WINDOW_ADDRESS" ]; }; then break; fi
    pid=$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)
  done
}

ping_shell() {
  local cli
  cli=$(command -v omarchy-shell 2>/dev/null)
  [ -n "$cli" ] || cli=/usr/share/omarchy/bin/omarchy-shell
  [ -x "$cli" ] || return 0
  OMARCHY_PATH="${OMARCHY_PATH:-/usr/share/omarchy}" "$cli" -q "$PLUGIN_ID" refresh >/dev/null 2>&1 || true
}

dump() {
  mkdir -p "$STATE_DIR" 2>/dev/null
  local f agent pid any=0
  for f in "$STATE_DIR"/*.json; do
    [ -e "$f" ] || continue
    if ! agent=$(jq -er '.agent' "$f" 2>/dev/null); then rm -f "$f"; continue; fi
    pid=$(jq -r '.agentPid // 0' "$f" 2>/dev/null)
    if [ "${pid:-0}" -gt 0 ] 2>/dev/null && ! alive "$pid" "$agent"; then rm -f "$f"; continue; fi
    any=1
  done
  if [ "$any" = 1 ]; then
    jq -s 'map(select(type == "object"))' "$STATE_DIR"/*.json 2>/dev/null || printf '[]'
  else
    printf '[]'
  fi
}

if [ "${1:-}" = dump ]; then
  dump
  exit 0
fi

# ---- hook path: from here on nothing reaches stdout, and we always exit 0.
exec 1>/dev/null
[ "${AGENT_WATCHER_DEBUG:-0}" = 1 ] || exec 2>/dev/null

AGENT="${1:-}"
EVENT="${2:-}"
case "$AGENT" in claude|codex|gemini|opencode) ;; *) exit 0 ;; esac
case "$EVENT" in
  session-start) STATE=idle ;;
  prompt)        STATE=working ;;
  waiting)       STATE=waiting ;;
  tool-done)     STATE=working ;;
  done)          STATE=done ;;
  session-end)   STATE="" ;;
  *) exit 0 ;;
esac

INPUT=$(cat 2>/dev/null)
printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1 || INPUT='{}'
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionID // .sessionId // empty' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // .directory // empty' 2>/dev/null)

# Gemini fires Notification for more than permissions; only ToolPermission blocks.
if [ "$AGENT" = gemini ] && [ "$EVENT" = waiting ]; then
  nt=$(printf '%s' "$INPUT" | jq -r '.notification_type // empty' 2>/dev/null)
  [ -z "$nt" ] || [ "$nt" = ToolPermission ] || exit 0
fi

AGENT_PID=0
WINDOW_ADDRESS=""
if [ -z "$SESSION_ID" ]; then
  resolve_ancestry "$AGENT" 0
  SESSION_ID="pid$AGENT_PID"
fi
SAFE_ID=$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')
FILE="$STATE_DIR/$AGENT-$SAFE_ID.json"

if [ "$EVENT" = session-end ]; then
  rm -f "$FILE"
  ping_shell
  exit 0
fi

PREV_STATE=""; PREV_WINDOW=""; PREV_PID=0; PREV_CWD=""
if [ -f "$FILE" ]; then
  IFS=$'\t' read -r PREV_STATE PREV_WINDOW PREV_PID PREV_CWD < <(
    jq -r '[(.state // ""), (.windowAddress // ""), ((.agentPid // 0) | tostring), (.cwd // "")] | @tsv' "$FILE" 2>/dev/null)
fi
# tool-done only matters while blocked on a permission.
if [ "$EVENT" = tool-done ] && [ "$PREV_STATE" != waiting ]; then exit 0; fi

# The window is resolved once per session (hyprctl is the expensive part).
if [ -n "$PREV_WINDOW" ]; then
  resolve_ancestry "$AGENT" 0
  WINDOW_ADDRESS="$PREV_WINDOW"
else
  resolve_ancestry "$AGENT" 1
fi
[ "$AGENT_PID" != 0 ] || AGENT_PID="${PREV_PID:-0}"
[ -n "$CWD" ] || CWD="$PREV_CWD"

mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
NOW=$(date +%s)
TMP="$FILE.tmp.$$"
if jq -n --arg agent "$AGENT" --arg sessionId "$SESSION_ID" --arg state "$STATE" --arg cwd "$CWD" \
      --argjson agentPid "${AGENT_PID:-0}" --arg windowAddress "$WINDOW_ADDRESS" \
      --argjson updatedAt "$NOW" --arg lastEvent "$EVENT" \
      '{agent: $agent, sessionId: $sessionId, state: $state, cwd: $cwd, agentPid: $agentPid,
        windowAddress: $windowAddress, updatedAt: $updatedAt, lastEvent: $lastEvent}' > "$TMP" 2>/dev/null; then
  mv -f "$TMP" "$FILE" 2>/dev/null
fi
rm -f "$TMP" 2>/dev/null
ping_shell
exit 0
```

Then: `chmod +x bin/agent-watcher-hook test/hook.test.sh`.

- [ ] **Step 4: Run the tests**

Run: `bash test/hook.test.sh`
Expected: `hook tests: N passed, 0 failed`, exit 0. If `agentPid resolved…` fails, the cmdline of the fake agent is `/usr/bin/bash /tmp/…/bin/claude prompt` — check `agent_pattern` still matches `/claude ` (slash before, space after).

- [ ] **Step 5: Manual smoke test from this terminal** (real hyprctl, real shell — the ping is best-effort so a missing plugin target is fine)

Run: `printf '{"session_id":"smoke","cwd":"/tmp"}' | AGENT_WATCHER_DEBUG=1 bin/agent-watcher-hook claude prompt; cat "$XDG_RUNTIME_DIR/omarchy-agent-watcher/claude-smoke.json"; bin/agent-watcher-hook dump; rm -f "$XDG_RUNTIME_DIR/omarchy-agent-watcher/claude-smoke.json"`
Expected: a JSON object with `windowAddress` equal to this terminal's Hyprland address (bare hex) when run inside a Claude Code session, `agentPid` > 0; then `dump` prints an array containing it.

- [ ] **Step 6: Commit**

```bash
git add bin/agent-watcher-hook test/hook.test.sh
git commit -m "feat(hook): agent event -> state file bridge with dump/prune"
```

---

### Task 6: `bin/agent-watcher-setup` + OpenCode plugin template

**Files:**
- Create: `bin/agent-watcher-setup` (executable)
- Create: `hooks/opencode-agent-watcher.js`
- Modify: `test/hook.test.sh` (append setup tests before the final summary lines)

**Interfaces:**
- Consumes: Task 5 (`bin/agent-watcher-hook` path is `$HERE/agent-watcher-hook`).
- Produces (used by Task 8): CLI `agent-watcher-setup status <agent|all>` → lines `<agent> installed|not-installed|agent-missing`; `install <agent>` / `remove <agent>` (exit 0 on success, 1 with `error: …` on stderr when a config file is not valid JSON, 2 on usage). Env overrides for tests: `AGENT_WATCHER_CLAUDE_SETTINGS`, `AGENT_WATCHER_CODEX_HOOKS`, `AGENT_WATCHER_GEMINI_SETTINGS`, `AGENT_WATCHER_OPENCODE_PLUGIN`.

- [ ] **Step 1: Write the failing tests** (insert into `test/hook.test.sh` right before the `echo` / `echo "hook tests: …"` summary lines)

```bash
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash test/hook.test.sh`
Expected: hook tests still pass; setup tests FAIL (script missing).

- [ ] **Step 3: Write `hooks/opencode-agent-watcher.js`**

```js
// Agent Watcher bridge for OpenCode. `agent-watcher-setup install opencode`
// copies this file to ~/.config/opencode/plugins/agent-watcher.js with
// __HOOK_PATH__ replaced by the absolute path of bin/agent-watcher-hook.
// Runs inside the OpenCode process, so the hook's parent chain reaches the
// terminal window like every other agent's hooks.
import { spawn } from "node:child_process"

const HOOK = "__HOOK_PATH__"

function send(event, sessionId, cwd) {
  try {
    const child = spawn(HOOK, ["opencode", event], { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => {})
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: cwd }))
  } catch (e) {
    // never let a watcher failure surface inside the agent
  }
}

export const AgentWatcher = async ({ directory }) => {
  const dirs = new Map()      // main session id -> its directory
  const children = new Set()  // sub-agent sessions (have parentID): ignored
  const cwdOf = (id) => dirs.get(id) || directory
  return {
    event: async ({ event }) => {
      const p = (event && event.properties) || {}
      switch (event && event.type) {
        case "session.created":
          if (!p.info) break
          if (p.info.parentID) { children.add(p.info.id); break }
          dirs.set(p.info.id, p.info.directory || directory)
          send("session-start", p.info.id, cwdOf(p.info.id))
          break
        case "session.status":
          if (children.has(p.sessionID)) break
          if (p.status && p.status.type === "busy") send("prompt", p.sessionID, cwdOf(p.sessionID))
          break
        case "permission.asked":
          if (!children.has(p.sessionID)) send("waiting", p.sessionID, cwdOf(p.sessionID))
          break
        case "permission.replied":
          if (!children.has(p.sessionID)) send("tool-done", p.sessionID, cwdOf(p.sessionID))
          break
        case "session.idle":
          if (!children.has(p.sessionID)) send("done", p.sessionID, cwdOf(p.sessionID))
          break
        case "session.deleted":
          if (p.info && !children.has(p.info.id)) { send("session-end", p.info.id, cwdOf(p.info.id)); dirs.delete(p.info.id) }
          break
        default:
          break
      }
    }
  }
}
```

(Event shapes verified against `@opencode-ai/sdk` 1.2.27 `dist/v2/gen/types.gen.d.ts`: `session.created {info: Session{id, directory, parentID?}}`, `session.status {sessionID, status:{type:"idle"|"busy"|"retry"}}`, `session.idle {sessionID}`, `permission.asked` = `PermissionRequest{id, sessionID, …}`, `permission.replied {sessionID, requestID, reply}`.)

- [ ] **Step 4: Write `bin/agent-watcher-setup`**

```bash
#!/usr/bin/env bash
# Agent Watcher hook installer.
#
#   agent-watcher-setup status  <agent|all>   -> "<agent> installed|not-installed|agent-missing"
#   agent-watcher-setup install <agent>
#   agent-watcher-setup remove  <agent>
#
#   agent: claude | codex | gemini | opencode
#
# Only entries whose command contains "agent-watcher-hook" are ever added or
# removed; everything else in the agent's config is left alone. A backup
# <file>.agent-watcher.bak is written before each modification.
set -u

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
HOOK="$HERE/agent-watcher-hook"
TEMPLATE="$(dirname "$HERE")/hooks/opencode-agent-watcher.js"
MARK="agent-watcher-hook"

CLAUDE_SETTINGS="${AGENT_WATCHER_CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
CODEX_HOOKS="${AGENT_WATCHER_CODEX_HOOKS:-$HOME/.codex/hooks.json}"
GEMINI_SETTINGS="${AGENT_WATCHER_GEMINI_SETTINGS:-$HOME/.gemini/settings.json}"
OPENCODE_PLUGIN="${AGENT_WATCHER_OPENCODE_PLUGIN:-$HOME/.config/opencode/plugins/agent-watcher.js}"

die() { echo "error: $*" >&2; exit 1; }
usage() { echo "usage: agent-watcher-setup status <agent|all> | install <agent> | remove <agent>" >&2; exit 2; }

config_file() {
  case "$1" in
    claude) printf '%s' "$CLAUDE_SETTINGS" ;;
    codex) printf '%s' "$CODEX_HOOKS" ;;
    gemini) printf '%s' "$GEMINI_SETTINGS" ;;
    opencode) printf '%s' "$OPENCODE_PLUGIN" ;;
    *) return 1 ;;
  esac
}

# Our hook groups per agent, as { EventName: [ {matcher?, hooks:[...]} ] }.
# Claude Code / Codex timeouts are seconds, Gemini's are milliseconds.
hook_groups() {
  case "$1" in
    claude) jq -n --arg h "$HOOK" '{
      SessionStart:      [{hooks: [{type: "command", command: ($h + " claude session-start"), timeout: 5}]}],
      UserPromptSubmit:  [{hooks: [{type: "command", command: ($h + " claude prompt"), timeout: 5}]}],
      PermissionRequest: [{hooks: [{type: "command", command: ($h + " claude waiting"), timeout: 5}]}],
      Notification:      [{matcher: "permission_prompt", hooks: [{type: "command", command: ($h + " claude waiting"), timeout: 5}]}],
      PostToolUse:       [{hooks: [{type: "command", command: ($h + " claude tool-done"), timeout: 5}]}],
      Stop:              [{hooks: [{type: "command", command: ($h + " claude done"), timeout: 5}]}],
      SessionEnd:        [{hooks: [{type: "command", command: ($h + " claude session-end"), timeout: 5}]}]
    }' ;;
    codex) jq -n --arg h "$HOOK" '{
      SessionStart:      [{hooks: [{type: "command", command: ($h + " codex session-start"), timeout: 5}]}],
      UserPromptSubmit:  [{hooks: [{type: "command", command: ($h + " codex prompt"), timeout: 5}]}],
      PermissionRequest: [{hooks: [{type: "command", command: ($h + " codex waiting"), timeout: 5}]}],
      PostToolUse:       [{hooks: [{type: "command", command: ($h + " codex tool-done"), timeout: 5}]}],
      Stop:              [{hooks: [{type: "command", command: ($h + " codex done"), timeout: 5}]}],
      SessionEnd:        [{hooks: [{type: "command", command: ($h + " codex session-end"), timeout: 5}]}]
    }' ;;
    gemini) jq -n --arg h "$HOOK" '{
      SessionStart: [{hooks: [{name: "agent-watcher", type: "command", command: ($h + " gemini session-start"), timeout: 5000}]}],
      BeforeAgent:  [{hooks: [{name: "agent-watcher", type: "command", command: ($h + " gemini prompt"), timeout: 5000}]}],
      Notification: [{hooks: [{name: "agent-watcher", type: "command", command: ($h + " gemini waiting"), timeout: 5000}]}],
      AfterTool:    [{hooks: [{name: "agent-watcher", type: "command", command: ($h + " gemini tool-done"), timeout: 5000}]}],
      AfterAgent:   [{hooks: [{name: "agent-watcher", type: "command", command: ($h + " gemini done"), timeout: 5000}]}],
      SessionEnd:   [{hooks: [{name: "agent-watcher", type: "command", command: ($h + " gemini session-end"), timeout: 5000}]}]
    }' ;;
  esac
}

# jq: drop our hooks from every group, then drop empty groups and empty events.
JQ_STRIP='
  def strip_ours($mark):
    (.hooks // {})
    | with_entries(.value |= (map(.hooks |= map(select(((.command // "") | contains($mark)) | not))) | map(select((.hooks | length) > 0))))
    | with_entries(select((.value | length) > 0));
'

valid_json_object() { [ -f "$1" ] && jq -e 'type == "object"' "$1" >/dev/null 2>&1; }

backup() { [ -f "$1" ] && cp -f "$1" "$1.agent-watcher.bak"; }

merge_hooks() { # merge_hooks <file> <groupsJson>
  local file="$1" ours="$2" tmp="$1.tmp.$$"
  if [ -f "$file" ]; then
    valid_json_object "$file" || die "$file is not valid JSON"
    backup "$file"
  else
    mkdir -p "$(dirname "$file")" || die "cannot create $(dirname "$file")"
    printf '{}\n' > "$file"
  fi
  jq --arg mark "$MARK" --argjson ours "$ours" "$JQ_STRIP"'
    .hooks = (strip_ours($mark) as $clean
      | reduce ($ours | to_entries[]) as $e ($clean; .[$e.key] = ((.[$e.key] // []) + $e.value)))
  ' "$file" > "$tmp" && mv -f "$tmp" "$file"
  local rc=$?
  rm -f "$tmp"
  return $rc
}

remove_hooks() { # remove_hooks <file>
  local file="$1" tmp="$1.tmp.$$"
  [ -f "$file" ] || return 0
  valid_json_object "$file" || die "$file is not valid JSON"
  backup "$file"
  jq --arg mark "$MARK" "$JQ_STRIP"'
    if has("hooks") then .hooks = strip_ours($mark) else . end
    | if (.hooks | type) == "object" and (.hooks | length) == 0 then del(.hooks) else . end
  ' "$file" > "$tmp" && mv -f "$tmp" "$file"
  local rc=$?
  rm -f "$tmp"
  return $rc
}

has_hooks() { # has_hooks <file>
  [ -f "$1" ] && jq -e --arg mark "$MARK" '[(.hooks // {})[][]?.hooks[]?.command // ""] | any(contains($mark))' "$1" >/dev/null 2>&1
}

agent_present() { # binary on PATH or its config dir exists
  local file
  file=$(config_file "$1") || return 1
  case "$1" in
    opencode) command -v opencode >/dev/null 2>&1 || [ -d "$(dirname "$(dirname "$file")")" ] ;;
    *) command -v "$1" >/dev/null 2>&1 || [ -d "$(dirname "$file")" ] ;;
  esac
}

status_of() {
  local agent="$1" installed=1
  case "$agent" in
    claude|codex|gemini) has_hooks "$(config_file "$agent")" && installed=0 ;;
    opencode) [ -f "$OPENCODE_PLUGIN" ] && grep -q "$MARK" "$OPENCODE_PLUGIN" 2>/dev/null && installed=0 ;;
    *) return 1 ;;
  esac
  if [ "$installed" = 0 ]; then printf 'installed'
  elif agent_present "$agent"; then printf 'not-installed'
  else printf 'agent-missing'
  fi
}

install_agent() {
  case "$1" in
    claude|codex|gemini) merge_hooks "$(config_file "$1")" "$(hook_groups "$1")" || die "could not update $(config_file "$1")" ;;
    opencode)
      [ -f "$TEMPLATE" ] || die "missing template $TEMPLATE"
      mkdir -p "$(dirname "$OPENCODE_PLUGIN")" || die "cannot create $(dirname "$OPENCODE_PLUGIN")"
      sed "s|__HOOK_PATH__|$HOOK|g" "$TEMPLATE" > "$OPENCODE_PLUGIN" || die "could not write $OPENCODE_PLUGIN" ;;
    *) usage ;;
  esac
  [ "$1" = codex ] && echo "note: run /hooks inside Codex once to trust the new hooks"
  return 0
}

remove_agent() {
  case "$1" in
    claude|codex|gemini) remove_hooks "$(config_file "$1")" || die "could not update $(config_file "$1")" ;;
    opencode) rm -f "$OPENCODE_PLUGIN" ;;
    *) usage ;;
  esac
}

cmd="${1:-}"
agent="${2:-}"
case "$cmd" in
  status)
    if [ -z "$agent" ] || [ "$agent" = all ]; then
      for a in claude codex gemini opencode; do echo "$a $(status_of "$a")"; done
    else
      s=$(status_of "$agent") || usage
      echo "$agent $s"
    fi ;;
  install) [ -n "$agent" ] || usage; install_agent "$agent" ;;
  remove) [ -n "$agent" ] || usage; remove_agent "$agent" ;;
  *) usage ;;
esac
```

Then `chmod +x bin/agent-watcher-setup`.

- [ ] **Step 5: Run the tests**

Run: `bash test/hook.test.sh`
Expected: `hook tests: N passed, 0 failed`, exit 0. Common pitfalls: the `has_hooks` jq path (`.hooks[][]?.hooks[]?`) must tolerate non-array event values; `merge_hooks` on a fresh file must produce `{"hooks": {...}}`.

- [ ] **Step 6: Commit**

```bash
git add bin/agent-watcher-setup hooks/opencode-agent-watcher.js test/hook.test.sh
git commit -m "feat(setup): install/remove/status of hooks for claude, codex, gemini, opencode"
```

---

### Task 7: `BarWidget.qml` — pill, blink, IPC, state loading

**Files:**
- Create: `BarWidget.qml` (replaces the Task 1 placeholder)
- Create: `Panel.qml` placeholder (Task 8 fills it) — required because BarWidget loads it

**Interfaces:**
- Consumes: Model (Tasks 2–4), `bin/agent-watcher-hook dump` (Task 5).
- Produces (used by Panel in Task 8, injected as `host`): properties `sessions` (map), `sessionList`, `summary`, `blinkSettings`, `doneColor`, `waitingColor`, `hookScript`, `setupScript`; functions `requestDump()`, `focusSession(session)`, `acknowledgeFocused()`, `open()/close()/togglePanel()`.

- [ ] **Step 1: Write the Panel placeholder** (`Panel.qml`)

```qml
import QtQuick
import qs.Ui

Panel {
  id: root
  moduleName: "io.github.5d0tal1gat0r.agent-watcher"
  manageIpc: false
  property var anchorItem: null
  property var hostWidget: null
  property var host: null
  function open() { root.controller.show() }
  function close() { root.controller.hide() }
  function toggle() { root.opened ? close() : open() }
}
```

- [ ] **Step 2: Write `BarWidget.qml`**

```qml
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar entry for Agent Watcher: robot icon + working/attention counts that
// blink while a session finished or waits for you in a window you are not
// looking at. Owns all session state (Panel.qml only renders it), the IPC
// target, the dump/prune process and the focus watcher. Panel plumbing
// follows omarchy-stocks / omarchy.weather.
BarWidget {
  id: root
  moduleName: "io.github.5d0tal1gat0r.agent-watcher"

  // ---- Settings (inline on this widget's shell.json entry).
  readonly property bool blinkOnDone: Model.boolSetting(setting("blinkOnDone", true), true)
  readonly property bool blinkOnWaiting: Model.boolSetting(setting("blinkOnWaiting", true), true)
  readonly property var blinkSettings: ({ blinkOnDone: blinkOnDone, blinkOnWaiting: blinkOnWaiting })

  // ---- Session state: key -> session (Model.normalizeSession + seen/stateSince).
  property var sessions: ({})
  readonly property var sessionList: Model.sessionList(sessions)
  readonly property var summary: Model.barSummary(sessionList, blinkSettings)
  readonly property var parts: Model.barParts(summary)
  readonly property string hookScript: Model.pathFromUrl(Qt.resolvedUrl("bin/agent-watcher-hook"))
  readonly property string setupScript: Model.pathFromUrl(Qt.resolvedUrl("bin/agent-watcher-setup"))
  property bool dumpPending: false

  // ---- Colors: theme palette (colors.toml) with fallbacks.
  property string themeGreen: ""
  property string themeYellow: ""
  readonly property color doneColor: themeGreen !== "" ? themeGreen : "#5fbf6f"
  readonly property color waitingColor: themeYellow !== "" ? themeYellow : "#d8a657"
  readonly property color attentionColor: summary.level === "waiting" ? waitingColor : doneColor

  // ---- Blink: opacity pulse on the icon and the attention count.
  property real pulse: 1
  SequentialAnimation on pulse {
    running: root.summary.blink
    loops: Animation.Infinite
    NumberAnimation { to: 0.3; duration: 500; easing.type: Easing.InOutSine }
    NumberAnimation { to: 1.0; duration: 500; easing.type: Easing.InOutSine }
    onStopped: root.pulse = 1
  }

  function activeAddress() {
    var t = Hyprland.activeToplevel
    return t ? Model.normalizeAddress(t.address) : ""
  }

  function requestDump() {
    Hyprland.refreshToplevels()
    if (dumpProc.running) { dumpPending = true; return }
    dumpProc.running = true
  }

  function applySnapshot(text) {
    var now = Math.floor(Date.now() / 1000)
    sessions = Model.mergeSessions(sessions, Model.parseSnapshot(text), activeAddress(), now)
  }

  function acknowledgeFocused() {
    var addr = activeAddress()
    if (addr === "") return
    sessions = Model.markSeen(sessions, addr)
  }

  function focusSession(session) {
    if (!session || session.windowAddress === "") return
    Hyprland.dispatch("focuswindow address:0x" + session.windowAddress)
  }

  // ---- Panel plumbing (open/close/opened contract for shell.summon|hide|toggle).
  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("host" in target) target.host = root
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.open) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()
  Component.onCompleted: Qt.callLater(root.requestDump)

  // One piece of the pill overlay (inline components must live at the root).
  component Piece: Text {
    font.family: button.fontFamily
    font.pixelSize: button.fontSize
    renderType: Text.NativeRendering
    color: button.foreground
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "io.github.5d0tal1gat0r.agent-watcher"

    function refresh(): void { root.broadcast("requestDump") }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
  }

  Connections {
    target: Hyprland
    function onActiveToplevelChanged() { root.acknowledgeFocused() }
  }

  Process {
    id: dumpProc
    command: [root.hookScript, "dump"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.applySnapshot(text)
        if (root.dumpPending) {
          root.dumpPending = false
          Qt.callLater(root.requestDump)
        }
      }
    }
  }

  // Liveness: prune dead agents even when no hook ever fires again.
  Timer {
    interval: 15000
    running: true
    repeat: true
    onTriggered: root.requestDump()
  }

  FileView {
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      root.themeGreen = Model.parseThemeColor(text(), "green")
      root.themeYellow = Model.parseThemeColor(text(), "yellow")
    }
    onLoadFailed: {
      root.themeGreen = ""
      root.themeYellow = ""
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // The (hidden) label sizes the pill and is what vertical bars show; the
    // colored overlay below is the horizontal rendering.
    text: root.vertical ? Model.verticalLabel(root.summary) : Model.barLabel(root.summary)
    labelVisible: root.vertical
    hasVisualContent: true
    dimmed: root.summary.total === 0
    foreground: root.vertical && root.summary.blink ? root.attentionColor : (root.bar ? root.bar.barForeground : Color.foreground)
    tooltipText: ""

    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.requestDump()
      else root.togglePanel()
    }

    Row {
      visible: !root.vertical
      anchors.centerIn: parent
      spacing: 0

      Piece {
        text: root.parts.icon
        color: root.summary.blink ? root.attentionColor : button.foreground
        opacity: root.pulse
      }
      Piece { text: root.parts.working }
      Piece {
        text: root.parts.dot
        color: Qt.darker(button.foreground, 1.6)
      }
      Piece {
        text: root.parts.attention
        color: root.attentionColor
        opacity: root.pulse
      }
    }
  }
}
```

- [ ] **Step 3: Lint** (renamed copy without the IpcHandler block — the qmllint quirk)

Run:
```bash
sed '/^  IpcHandler {/,/^  }/d' BarWidget.qml > /tmp/claude-1000/-home-al1gat0r-Proyects-omarchy-plugins-dev/888da9a8-6535-46fc-8332-bb6444c8a2b3/scratchpad/AwBar.qml && cp Model.js Panel.qml /tmp/claude-1000/-home-al1gat0r-Proyects-omarchy-plugins-dev/888da9a8-6535-46fc-8332-bb6444c8a2b3/scratchpad/ && qmllint -I /usr/share/omarchy/shell /tmp/claude-1000/-home-al1gat0r-Proyects-omarchy-plugins-dev/888da9a8-6535-46fc-8332-bb6444c8a2b3/scratchpad/AwBar.qml; echo "qmllint exit $?"
```
Expected: exit 0 with at most "unqualified access"-style warnings; fix real errors (unknown property/type) before continuing. `omarchy plugin validate .` must also print nothing.

- [ ] **Step 4: Install the plugin into the shell and mount it**

```bash
git clone -q ~/Proyects/omarchy-plugins-dev/omarchy-agent-watcher ~/.config/omarchy/plugins/io.github.5d0tal1gat0r.agent-watcher 2>/dev/null || true
rsync -a --delete --exclude .git ./ ~/.config/omarchy/plugins/io.github.5d0tal1gat0r.agent-watcher/
omarchy-shell shell rescanPlugins; omarchy plugin enable io.github.5d0tal1gat0r.agent-watcher; omarchy bar put io.github.5d0tal1gat0r.agent-watcher --section right
omarchy restart shell; sleep 6; omarchy-shell shell ping
```
Expected: `pong`-style reply; the bar shows a dimmed robot glyph on the right (no sessions yet).

- [ ] **Step 5: Drive it with fake state and look**

```bash
D="$XDG_RUNTIME_DIR/omarchy-agent-watcher"; mkdir -p "$D"; now=$(date +%s)
printf '{"agent":"claude","sessionId":"demo1","state":"working","cwd":"/tmp/alpha","agentPid":0,"windowAddress":"","updatedAt":%s,"lastEvent":"prompt"}' "$now" > "$D/claude-demo1.json"
printf '{"agent":"codex","sessionId":"demo2","state":"done","cwd":"/tmp/beta","agentPid":0,"windowAddress":"","updatedAt":%s,"lastEvent":"done"}' "$now" > "$D/codex-demo2.json"
omarchy-shell io.github.5d0tal1gat0r.agent-watcher refresh; sleep 1
grim -o eDP-1 /tmp/claude-1000/-home-al1gat0r-Proyects-omarchy-plugins-dev/888da9a8-6535-46fc-8332-bb6444c8a2b3/scratchpad/bar.png
```
Read the PNG (crop the bar's right end with `magick bar.png -crop 600x40+<W-600>+0 crop.png`, monitor width from `hyprctl monitors -j | jq '.[0].width'`). Expected: `󱚣 1 · 1` with the trailing `1` and the icon in theme green, visibly pulsing between two consecutive screenshots ~0.5 s apart. Then `printf ... "state":"waiting"` into `codex-demo2.json` + refresh → yellow. Then `rm "$D"/*.json` + refresh → dimmed icon only.

- [ ] **Step 6: Commit**

```bash
git add BarWidget.qml Panel.qml
git commit -m "feat(bar): agent watcher pill with attention blink and state loading"
```

---

### Task 8: `Panel.qml` — groups, rows, click-to-focus, hooks section

**Files:**
- Modify: `Panel.qml` (replace the placeholder)

**Interfaces:**
- Consumes: `host` (Task 7 BarWidget), Model (Tasks 2–4), `bin/agent-watcher-setup` (Task 6).
- Produces: `open()/close()/toggle()/opened`, `refreshHookStatus()`.

- [ ] **Step 1: Write `Panel.qml`**

```qml
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Popup for Agent Watcher: sessions grouped by workspace, click-to-focus, and
// per-agent hook setup. All session state lives on `host` (BarWidget.qml).
Panel {
  id: root
  moduleName: "io.github.5d0tal1gat0r.agent-watcher"
  // The bar entry (BarWidget.qml) owns the IPC target; see its IpcHandler.
  manageIpc: false

  property var anchorItem: null
  // The bar identifies a panel by the widget mounted in its slot, not by this
  // nested item, so popout switching and the open-panel indicator use it.
  property var hostWidget: null
  property var host: null
  readonly property var barIdentity: hostWidget || root

  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color mutedForeground: Qt.darker(barForeground, 1.5)
  readonly property color doneColor: host ? host.doneColor : "#5fbf6f"
  readonly property color waitingColor: host ? host.waitingColor : "#d8a657"
  readonly property var blinkSettings: host ? host.blinkSettings : ({})
  readonly property var sessionList: host ? host.sessionList : []
  readonly property var summary: host ? host.summary : Model.barSummary([], {})

  // Re-evaluated every second while open (elapsed times, workspace moves).
  property int nowSec: Math.floor(Date.now() / 1000)
  property int tick: 0

  Timer {
    interval: 1000
    running: root.opened
    repeat: true
    onTriggered: {
      root.nowSec = Math.floor(Date.now() / 1000)
      root.tick++
    }
  }

  // address -> { workspaceId, title } from the live toplevels.
  function windowLookup() {
    var dep = root.tick
    var out = {}
    var values = Hyprland.toplevels.values
    for (var i = 0; i < values.length; i++) {
      var tl = values[i]
      var addr = Model.normalizeAddress(tl.address)
      if (addr === "") continue
      out[addr] = { workspaceId: tl.workspace ? tl.workspace.id : -1, title: tl.title || "" }
    }
    return out
  }

  readonly property var lookup: windowLookup()
  readonly property int focusedWorkspaceId: {
    var dep = root.tick
    if (Hyprland.focusedWorkspace) return Hyprland.focusedWorkspace.id
    if (Hyprland.focusedMonitor && Hyprland.focusedMonitor.activeWorkspace) return Hyprland.focusedMonitor.activeWorkspace.id
    return -1
  }
  readonly property var groups: Model.groupByWorkspace(sessionList, lookup, focusedWorkspaceId, blinkSettings)

  // ---- Hook setup state.
  property var hookStatus: ({})
  property string busyAgent: ""
  readonly property bool anyHooksInstalled: {
    for (var k in hookStatus) if (hookStatus[k] === "installed") return true
    return false
  }

  function stateColor(session) {
    var ds = Model.displayState(session)
    if (ds === "waiting") return root.waitingColor
    if (ds === "done") return root.doneColor
    if (ds === "working") return root.barForeground
    return root.mutedForeground
  }

  function titleFor(session) {
    var win = session.windowAddress !== "" ? root.lookup[session.windowAddress] : null
    var title = win ? Model.cleanTitle(win.title) : ""
    return title !== "" ? title : session.cwd
  }

  function focusRow(session) {
    if (root.host) root.host.focusSession(session)
    root.close()
  }

  function refreshHookStatus() {
    if (!root.host || statusProc.running) return
    statusProc.command = [root.host.setupScript, "status", "all"]
    statusProc.running = true
  }

  function runSetup(action, agent) {
    if (!root.host || setupProc.running) return
    root.busyAgent = agent
    setupProc.command = [root.host.setupScript, action, agent]
    setupProc.running = true
  }

  function open() {
    root.controller.show()
    refreshHookStatus()
    if (root.host) root.host.requestDump()
  }

  function close() {
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) close()
    else open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  Process {
    id: statusProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.hookStatus = Model.parseHookStatus(text)
    }
  }

  Process {
    id: setupProc
    onExited: function(code, status) {
      root.busyAgent = ""
      root.refreshHookStatus()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(440))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onReturnRequested: if (root.host) root.host.requestDump()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(8)

        // ---- Header: title + summary.
        Item {
          width: parent.width
          height: headerTitle.implicitHeight

          Text {
            id: headerTitle
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: "Agent sessions"
            color: root.barForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.subtitle
            font.bold: true
          }

          Text {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: Model.summaryLine(root.summary)
            color: root.mutedForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        PanelSeparator { foreground: root.barForeground }

        // ---- Empty state.
        Text {
          visible: root.sessionList.length === 0
          width: parent.width
          leftPadding: Style.space(8)
          rightPadding: Style.space(8)
          wrapMode: Text.WordWrap
          text: root.anyHooksInstalled
            ? "No sessions yet — start an agent in a terminal."
            : "Install hooks below to start tracking."
          color: root.mutedForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.italic: true
        }

        // ---- One block per workspace.
        Repeater {
          model: root.groups

          Column {
            id: group
            required property var modelData
            width: content.width
            spacing: 0

            Item {
              width: parent.width
              height: groupLabel.implicitHeight + Style.space(6)

              Text {
                id: groupLabel
                anchors.left: parent.left
                anchors.leftMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                text: group.modelData.label + (group.modelData.current ? "  · current" : "")
                color: root.mutedForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }
            }

            Repeater {
              model: group.modelData.sessions

              Rectangle {
                id: row
                required property var modelData
                readonly property bool attention: Model.needsAttention(modelData, root.blinkSettings)
                readonly property bool focusable: modelData.windowAddress !== ""
                width: content.width
                height: line1.implicitHeight + line2.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: rowMouse.containsMouse && row.focusable
                  ? Style.hoverFillFor(root.barForeground, Color.accent)
                  : (row.attention ? Style.selectedFillFor(root.barForeground, Color.accent) : "transparent")

                Rectangle {
                  id: dot
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(8)
                  height: width
                  radius: width / 2
                  color: root.stateColor(row.modelData)
                }

                Row {
                  id: line1
                  anchors.left: dot.right
                  anchors.leftMargin: Style.space(8)
                  anchors.right: elapsed.left
                  anchors.rightMargin: Style.space(8)
                  anchors.top: parent.top
                  anchors.topMargin: Style.space(6)
                  spacing: Style.space(6)

                  Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: agentTag.implicitWidth + Style.space(8)
                    height: agentTag.implicitHeight + Style.space(2)
                    radius: Style.cornerRadius
                    color: Style.selectedFillFor(root.barForeground, Color.accent)

                    Text {
                      id: agentTag
                      anchors.centerIn: parent
                      text: row.modelData.agent
                      color: root.mutedForeground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: Model.projectName(row.modelData.cwd)
                    color: root.barForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                    elide: Text.ElideRight
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: Model.displayState(row.modelData)
                    color: root.stateColor(row.modelData)
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: row.attention
                  }
                }

                Text {
                  id: elapsed
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: line1.verticalCenter
                  text: Model.formatElapsed(row.modelData.stateSince, root.nowSec)
                  color: root.mutedForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Text {
                  id: line2
                  anchors.left: line1.left
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(8)
                  anchors.top: line1.bottom
                  anchors.topMargin: Style.space(2)
                  text: root.titleFor(row.modelData)
                  color: root.mutedForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideMiddle
                }

                MouseArea {
                  id: rowMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: row.focusable ? Qt.PointingHandCursor : Qt.ArrowCursor
                  onClicked: if (row.focusable) root.focusRow(row.modelData)
                }
              }
            }
          }
        }

        PanelSeparator { foreground: root.barForeground }

        // ---- Hooks: one line per agent with Install / Remove.
        Text {
          leftPadding: Style.space(8)
          text: "Hooks"
          color: root.mutedForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }

        Repeater {
          model: Model.AGENTS

          Item {
            id: hookRow
            required property var modelData
            readonly property string status: root.hookStatus[modelData.id] || ""
            readonly property bool installed: status === "installed"
            readonly property bool missing: status === "agent-missing"
            readonly property bool busy: root.busyAgent === modelData.id
            width: content.width
            height: hookName.implicitHeight + Style.space(10)

            Text {
              id: hookName
              anchors.left: parent.left
              anchors.leftMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              text: hookRow.modelData.name
              color: hookRow.missing ? root.mutedForeground : root.barForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              anchors.left: hookName.right
              anchors.leftMargin: Style.space(10)
              anchors.verticalCenter: parent.verticalCenter
              text: (hookRow.busy ? "working…" : Model.hookStatusLabel(hookRow.status))
                + (hookRow.installed && hookRow.modelData.id === "codex" ? "  (run /hooks in Codex once to trust)" : "")
              color: hookRow.installed ? root.doneColor : root.mutedForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Rectangle {
              id: actionChip
              visible: !hookRow.missing && hookRow.status !== ""
              anchors.right: parent.right
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              width: actionText.implicitWidth + Style.space(12)
              height: actionText.implicitHeight + Style.space(6)
              radius: Style.cornerRadius
              color: actionMouse.containsMouse
                ? Style.hoverFillFor(root.barForeground, Color.accent)
                : Style.selectedFillFor(root.barForeground, Color.accent)

              Text {
                id: actionText
                anchors.centerIn: parent
                text: hookRow.installed ? "Remove" : "Install"
                color: root.barForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              MouseArea {
                id: actionMouse
                anchors.fill: parent
                hoverEnabled: true
                enabled: !hookRow.busy
                cursorShape: Qt.PointingHandCursor
                onClicked: root.runSetup(hookRow.installed ? "remove" : "install", hookRow.modelData.id)
              }
            }
          }
        }

        PanelSeparator { foreground: root.barForeground }

        Text {
          width: parent.width
          leftPadding: Style.space(8)
          rightPadding: Style.space(8)
          wrapMode: Text.WordWrap
          text: "Click a session to focus its window · Middle-click the pill to refresh · Hooks apply to newly started agents"
          color: root.mutedForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
```

- [ ] **Step 2: Lint**

Run: `cp Panel.qml Model.js /tmp/claude-1000/-home-al1gat0r-Proyects-omarchy-plugins-dev/888da9a8-6535-46fc-8332-bb6444c8a2b3/scratchpad/ && qmllint -I /usr/share/omarchy/shell /tmp/claude-1000/-home-al1gat0r-Proyects-omarchy-plugins-dev/888da9a8-6535-46fc-8332-bb6444c8a2b3/scratchpad/Panel.qml; echo "exit $?"`
Expected: exit 0 (warnings about unqualified access are fine).

- [ ] **Step 3: Install, restart, open the panel with fake state and screenshot**

```bash
rsync -a --delete --exclude .git ./ ~/.config/omarchy/plugins/io.github.5d0tal1gat0r.agent-watcher/ && omarchy restart shell; sleep 6; omarchy-shell shell ping
D="$XDG_RUNTIME_DIR/omarchy-agent-watcher"; mkdir -p "$D"; now=$(date +%s)
# a real window for the workspace grouping: this terminal's own address
ADDR=$(hyprctl activewindow -j | jq -r '.address' | sed 's/^0x//')
printf '{"agent":"claude","sessionId":"demo1","state":"working","cwd":"/tmp/alpha","agentPid":0,"windowAddress":"%s","updatedAt":%s,"lastEvent":"prompt"}' "$ADDR" "$now" > "$D/claude-demo1.json"
printf '{"agent":"gemini","sessionId":"demo2","state":"done","cwd":"/tmp/beta","agentPid":0,"windowAddress":"","updatedAt":%s,"lastEvent":"done"}' "$now" > "$D/gemini-demo2.json"
omarchy-shell io.github.5d0tal1gat0r.agent-watcher refresh; sleep 1
omarchy-shell shell summon io.github.5d0tal1gat0r.agent-watcher '{}'; sleep 1
grim -o eDP-1 /tmp/claude-1000/-home-al1gat0r-Proyects-omarchy-plugins-dev/888da9a8-6535-46fc-8332-bb6444c8a2b3/scratchpad/panel.png
```
Read the PNG. Expected: header "Agent sessions" + "2 sessions · 1 working · 1 done"; a "Workspace N · current" group with the claude row (dot in foreground color, tag `claude`, project `alpha`, state `working`, this terminal's title as subtitle); an "Other" group with the gemini row (`done` in green, highlighted); a Hooks section with four agents, statuses (Claude Code/Codex/Gemini/OpenCode all "not installed" with Install chips — the config dirs exist on this machine); footer hint. Click the claude row (or `hyprctl dispatch focuswindow address:0x$ADDR`) → panel closes. Clean up: `rm "$D"/*.json; omarchy-shell io.github.5d0tal1gat0r.agent-watcher refresh`.

- [ ] **Step 4: Commit**

```bash
git add Panel.qml
git commit -m "feat(panel): sessions grouped by workspace, click-to-focus, hook setup"
```

---

### Task 9: Live end-to-end verification with real agents

**Files:** none new (fix-ups in whichever file misbehaves, each with its own test where logic is involved).

- [ ] **Step 1: Install Claude Code hooks from the panel** — open the panel, click **Install** on Claude Code. Verify: `jq '.hooks.Stop' ~/.claude/settings.json` shows the `agent-watcher-hook claude done` entry and `~/.claude/settings.json.agent-watcher.bak` exists. (Hooks load at Claude Code startup: sessions already running — including the one driving this plan — will not report until restarted.)

- [ ] **Step 2: Two Claude Code windows on two workspaces** — open a terminal on workspace 6, `cd /tmp && claude`, and another on workspace 7. Send a trivial prompt in the workspace-6 one, immediately switch to workspace 7. Expected: pill shows `󱚣 1` (working) while it runs, then `󱚣 1` blinking green when it finishes; open the panel: "Workspace 6" group has the session as `done`. Switch to workspace 6 → blink stops within a second, panel row now `idle`. Ask for something that triggers a permission prompt (e.g. "run `touch /tmp/aw-perm-test`" with default permissions) and switch away → yellow blink; go back → blink stops but the row still says `waiting`; approve → row turns `working` then `done`/`idle`.

- [ ] **Step 3: Kill and restart** — close one terminal window outright (`hyprctl dispatch killactive` on it). Expected: its session disappears from the panel within 15 s. Run `omarchy restart shell` while the other session is idle → after the restart the pill/panel still list it (state files survive).

- [ ] **Step 4: Codex** — Install from the panel; start `codex` in a terminal, run `/hooks`, trust the hooks (Codex requires that once); prompt something and switch away → same behaviour. If Codex never writes a state file, run `AGENT_WATCHER_DEBUG=1` by editing the installed command temporarily and check `~/.codex/log/` for hook errors.

- [ ] **Step 5: Gemini CLI** — Install; `gemini` in a terminal; prompt; switch away → blink. Confirm the `Notification` filter: no `waiting` state appears for ordinary notifications.

- [ ] **Step 6: OpenCode** — Install; `opencode` in a terminal (fresh start so the plugin loads); prompt; expected `working` → `done`. `ls ~/.config/opencode/plugins/agent-watcher.js`.

- [ ] **Step 7: Record findings** — for every deviation found, fix it (add a node/bash test when logic is involved), re-run `node --test test/model.test.js && bash test/hook.test.sh`, `rsync … && omarchy restart shell`, re-check, and commit each fix separately (`fix(hook): …`, `fix(panel): …`).

- [ ] **Step 8: Remove the test hooks you no longer want** — leave Claude Code (and any other) hooks installed only if the user wants them; otherwise `bin/agent-watcher-setup remove <agent>`.

---

### Task 10: README, preview screenshot, final validation

**Files:**
- Modify: `README.md`
- Create: `preview.png`

- [ ] **Step 1: Write README.md**

```markdown
# Agent Watcher for Omarchy

One bar pill for every AI-agent session on your desktop. Claude Code, Codex,
Gemini CLI and OpenCode sessions are listed per Hyprland workspace with their
state — **working**, **waiting** for you, **done**, idle — and the pill blinks
(green = finished, yellow = needs a permission) whenever that happens in a
window you are not looking at. Focus the window and the blink stops; click a
row in the panel to jump straight to it.

![preview](preview.png)

## Install

```sh
omarchy plugin add https://github.com/5d0tal1gat0r/omarchy-agent-watcher.git --enable
```

Then open the panel (click the robot) and press **Install** next to each agent
you use. That adds a few hook entries to the agent's own config:

| agent | what gets written | note |
|-------|-------------------|------|
| Claude Code | `~/.claude/settings.json` → `hooks` (SessionStart, UserPromptSubmit, PermissionRequest, Notification, PostToolUse, Stop, SessionEnd) | applies to sessions started afterwards |
| Codex | `~/.codex/hooks.json` | run `/hooks` inside Codex once to trust them |
| Gemini CLI | `~/.gemini/settings.json` → `hooks` | |
| OpenCode | `~/.config/opencode/plugins/agent-watcher.js` | |

A backup `<file>.agent-watcher.bak` is written before every change, only
entries pointing at `agent-watcher-hook` are ever added or removed, and
**Remove** undoes it. The same works from a shell:

```sh
~/.config/omarchy/plugins/io.github.5d0tal1gat0r.agent-watcher/bin/agent-watcher-setup status all
~/.config/omarchy/plugins/io.github.5d0tal1gat0r.agent-watcher/bin/agent-watcher-setup install claude
```

## Usage

| where | action | effect |
|-------|--------|--------|
| pill | left click | open / close the panel (Esc closes, Tab switches panels, Enter refreshes) |
| pill | middle click | refresh now |
| panel | click a session | focus its window (switches workspace) |
| panel | Install / Remove | manage that agent's hooks |

Pill: `󱚣 2 · 1` = 2 sessions working, 1 needs attention. Dimmed icon = no
sessions. Blink colors come from your theme (`green` / `yellow`).

IPC (for keybindings): `omarchy-shell io.github.5d0tal1gat0r.agent-watcher toggle|open|close|refresh`

## Configure

```sh
omarchy bar set io.github.5d0tal1gat0r.agent-watcher blinkOnDone false --json
omarchy bar set io.github.5d0tal1gat0r.agent-watcher blinkOnWaiting false --json
```

| key | default | meaning |
|-----|---------|---------|
| `blinkOnDone` | `true` | blink (green) when an agent finishes responding in an unfocused window |
| `blinkOnWaiting` | `true` | blink (yellow) when an agent is blocked on a permission prompt |

## How it works

Each agent's native hook calls `bin/agent-watcher-hook`, which writes a tiny
JSON file per session under `$XDG_RUNTIME_DIR/omarchy-agent-watcher/` and pings
the shell. The hook finds its own terminal window by walking up the process
tree, so the panel knows the workspace and can focus it; the shell reads live
window titles and focus from Hyprland. Sessions vanish on `SessionEnd` or when
their process is gone (checked every 15 s). Nothing leaves your machine.

Sessions inside tmux/screen or over SSH still appear, under **Other**, without
click-to-focus.

## Develop

```sh
node --test test/model.test.js
bash test/hook.test.sh
omarchy plugin validate .
```

MIT — see LICENSE.
```

- [ ] **Step 2: Preview screenshot** — with two or three real sessions in different states, open the panel and take `grim -o eDP-1 full.png`; crop to the bar strip + panel only (`magick full.png -crop WxH+X+Y preview.png`), check with Read that no personal info (usernames, real paths beyond `/tmp/...`, private window titles) is visible; keep it under ~300 KB (`magick preview.png -resize 1200x\> preview.png` if needed).

- [ ] **Step 3: Final checks**

Run: `node --test test/model.test.js && bash test/hook.test.sh && omarchy plugin validate . && grep -rn "al1gat0r\|/home/" --exclude-dir=.git . ; echo "grep exit $? (1 = clean)"`
Expected: tests pass, validate silent, grep finds nothing (exit 1).

- [ ] **Step 4: Commit**

```bash
git add README.md preview.png
git commit -m "docs: README and preview"
```

---

### Task 11: Publish (only after the user says go)

- [ ] **Step 1: Confirm with the user** that the live verification (Task 9) is satisfactory and they want it published under `5d0tal1gat0r/omarchy-agent-watcher`.
- [ ] **Step 2: Create the GitHub repo and push**

```bash
gh repo create 5d0tal1gat0r/omarchy-agent-watcher --public --source . --remote origin --description "Omarchy bar widget: every AI agent session per workspace, with an attention blink" --push
gh repo edit 5d0tal1gat0r/omarchy-agent-watcher --add-topic omarchy --add-topic omarchy-plugin --add-topic quickshell --add-topic claude-code --add-topic codex
```
- [ ] **Step 3: Re-point the installed copy at GitHub** (so `omarchy plugin update` works): `git -C ~/.config/omarchy/plugins/io.github.5d0tal1gat0r.agent-watcher remote set-url origin https://github.com/5d0tal1gat0r/omarchy-agent-watcher.git && omarchy plugin update io.github.5d0tal1gat0r.agent-watcher`.
- [ ] **Step 4: Marketplace submission** — file the issue on `HANCORE-linux/omarchy-plugin-marketplace` the same way as the stocks plugin (category Widgets, tags bar + quickshell + ai), and note the issue number in the memory file for continuity.
