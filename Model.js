// Pure logic for the Agent Watcher bar widget. No QML imports: this file is
// loaded by BarWidget.qml/Panel.qml through `import "Model.js" as Model` and
// by the node test-suite through require(), so it stays ES5-style and ends
// with a module.exports guard (same convention as omarchy-stocks).

// Per-agent identity: display name, a brand-leaning color and a Nerd Font
// glyph (all present in the bar font). Colors: Anthropic orange, OpenAI green,
// Google blue, and a violet for OpenCode.
var AGENTS = [
  { id: "claude", name: "Claude Code", color: "#D97757", glyph: "\uDB81\uDEC4" },  // nf-md-asterisk
  { id: "codex", name: "Codex", color: "#10A37F", glyph: "\uF489" },               // nf-oct-terminal
  { id: "gemini", name: "Gemini CLI", color: "#4E8EF7", glyph: "\uDB82\uDE28" },   // nf-md-star-four-points
  { id: "opencode", name: "OpenCode", color: "#B180F0", glyph: "\uDB80\uDD69" }    // nf-md-code-braces
]
var STATES = ["working", "waiting", "done", "idle"]
var STATE_RANK = { waiting: 0, done: 1, working: 2, idle: 3 }
var BAR_ICON = "\uDB81\uDFAE" // nf-md-cctv (U+F07AE) — distinct from omarchy.agents' robot
var OTHER_GROUP_ID = -1

function trimString(value) {
  return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "")
}

function agentInfo(id) {
  for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].id === id) return AGENTS[i]
  return null
}

function agentName(id) {
  var a = agentInfo(id)
  return a ? a.name : (trimString(id) || "Agent")
}

// Unknown agents fall back to `fallback` (the caller passes the theme accent).
function agentColor(id, fallback) {
  var a = agentInfo(id)
  return a ? a.color : (fallback === undefined || fallback === null ? "" : fallback)
}

function agentGlyph(id) {
  var a = agentInfo(id)
  return a ? a.glyph : BAR_ICON
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
// only and get filled in by mergeSessions. Idle sessions are never listed:
// a row means activity (working, waiting for you, or a finished turn), not an
// open terminal waiting for input.
function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") return null
  var agent = trimString(raw.agent)
  var sessionId = trimString(raw.sessionId)
  var state = trimString(raw.state)
  if (agent === "" || sessionId === "" || STATES.indexOf(state) === -1) return null
  if (state === "idle") return null
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
    title: trimString(raw.title),
    seen: false,
    stateSince: 0
  }
}

// Output of `agent-watcher-hook dump` (a JSON array) -> { ok, sessions }.
// ok is false when the dump did not even produce an array (script killed, jq
// missing, truncated read): the caller should keep the sessions it has rather
// than treat that as "every session ended".
function parseSnapshotResult(text) {
  var parsed
  try { parsed = JSON.parse(String(text || "")) } catch (e) { return { ok: false, sessions: [] } }
  if (!Array.isArray(parsed)) return { ok: false, sessions: [] }
  var out = []
  for (var i = 0; i < parsed.length; i++) {
    var s = normalizeSession(parsed[i])
    if (s) out.push(s)
  }
  return { ok: true, sessions: out }
}

function parseSnapshot(text) {
  return parseSnapshotResult(text).sessions
}

function projectName(cwd) {
  var s = trimString(cwd).replace(/\/+$/, "")
  if (s === "") return trimString(cwd) === "/" ? "/" : "?"
  var idx = s.lastIndexOf("/")
  return idx >= 0 ? s.slice(idx + 1) : s
}

// Terminal titles from agents start with a status glyph (Claude Code's
// spinner ◐◓◑◒, ✳, ✶, a Nerd Font icon …). Strip only such decoration —
// arrows, geometric shapes, dingbats, braille spinners, private-use icons,
// bullets — so titles in any script survive intact.
var TITLE_DECORATION = /^(?:[\s\u00B7\u2022\u2190-\u21FF\u2500-\u27BF\u2800-\u28FF\u2B00-\u2BFF\uE000-\uF8FF*]|[\uDB80-\uDBBF][\uDC00-\uDFFF])+/
function cleanTitle(title) {
  return trimString(String(title === undefined || title === null ? "" : title).replace(TITLE_DECORATION, ""))
}

// "/home/u/dev/api" -> "~/dev/api" when `home` is that prefix.
function collapseHome(path, home) {
  var p = trimString(path)
  var h = trimString(home).replace(/\/+$/, "")
  if (h === "" || p === "") return p
  if (p === h) return "~"
  if (p.indexOf(h + "/") === 0) return "~" + p.slice(h.length)
  return p
}

// Window titles that carry no session information: the agent's own name, a
// bare terminal name, a shell prompt ("user@host: ~/x") or a plain path.
var TERMINAL_NAMES = ["foot", "alacritty", "kitty", "ghostty", "wezterm", "wezterm-gui", "terminal", "gnome-terminal", "konsole", "xterm", "bash", "zsh", "fish", "sh"]

function informativeTitle(title, agent) {
  var t = cleanTitle(title)
  if (t === "") return ""
  var lower = t.toLowerCase()
  if (lower === trimString(agent).toLowerCase() || lower === agentName(agent).toLowerCase()) return ""
  if (lower.replace(/\s+cli$/, "") === trimString(agent).toLowerCase()) return ""
  if (TERMINAL_NAMES.indexOf(lower) !== -1) return ""
  if (/^[^\s@]+@[^\s:]+:/.test(t)) return ""      // user@host: prompt titles
  if (/^(~|\/)/.test(t)) return ""                   // path-like titles
  return t
}

// Primary row label: the agent-supplied session name (OpenCode) beats the
// live window title (Claude Code writes its task summary there), which beats
// the project folder.
function sessionLabel(session, windowTitle, home) {
  if (session.title && trimString(session.title) !== "") return trimString(session.title)
  var t = informativeTitle(windowTitle, session.agent)
  if (t !== "") return t
  // A session started in $HOME would otherwise be labelled with the username.
  if (collapseHome(session.cwd, home) === "~") return "~"
  return projectName(session.cwd)
}

// Secondary row line: where the session lives, with $HOME shortened.
function sessionSubtitle(session, home) {
  var c = collapseHome(session.cwd, home)
  return c === "" ? "?" : c
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
// toplevel is born seen (the user was watching); working is never a blink.
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
      next.seen = focused || s.state === "working"
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

// A dismissed or acknowledged row keeps its true state label: only ever
// "working", "waiting" or "done" is shown, never a fake "idle".
function displayState(session) {
  return session.state
}

// The map without `key` (right-click dismiss of a done session). The state
// file is deleted through the hook; this only drops it from the view until
// the next dump confirms it.
function removeSession(map, key) {
  var out = {}
  for (var k in (map || {})) if (k !== key) out[k] = map[k]
  return out
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
// BarWidget.qml and the sizing label agree exactly: "󰞮 2 · 1".
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

if (typeof module !== "undefined") {
  module.exports = {
    AGENTS: AGENTS,
    STATES: STATES,
    STATE_RANK: STATE_RANK,
    BAR_ICON: BAR_ICON,
    OTHER_GROUP_ID: OTHER_GROUP_ID,
    agentName: agentName,
    agentColor: agentColor,
    agentGlyph: agentGlyph,
    boolSetting: boolSetting,
    normalizeAddress: normalizeAddress,
    sessionKey: sessionKey,
    normalizeSession: normalizeSession,
    parseSnapshotResult: parseSnapshotResult,
    parseSnapshot: parseSnapshot,
    projectName: projectName,
    collapseHome: collapseHome,
    informativeTitle: informativeTitle,
    sessionLabel: sessionLabel,
    sessionSubtitle: sessionSubtitle,
    cleanTitle: cleanTitle,
    formatElapsed: formatElapsed,
    normalizeColor: normalizeColor,
    parseThemeColor: parseThemeColor,
    pathFromUrl: pathFromUrl,
    mergeSessions: mergeSessions,
    markSeen: markSeen,
    sessionList: sessionList,
    displayState: displayState,
    removeSession: removeSession,
    needsAttention: needsAttention,
    barSummary: barSummary,
    barParts: barParts,
    barLabel: barLabel,
    verticalLabel: verticalLabel,
    summaryLine: summaryLine,
    sortSessions: sortSessions,
    groupByWorkspace: groupByWorkspace,
    HOOK_STATUSES: HOOK_STATUSES,
    parseHookStatus: parseHookStatus,
    hookStatusLabel: hookStatusLabel
  }
}
