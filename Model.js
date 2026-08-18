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
