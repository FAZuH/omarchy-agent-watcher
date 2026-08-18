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
    pathFromUrl: pathFromUrl,
    mergeSessions: mergeSessions,
    markSeen: markSeen,
    sessionList: sessionList,
    displayState: displayState,
    needsAttention: needsAttention,
    barSummary: barSummary,
    barParts: barParts,
    barLabel: barLabel,
    verticalLabel: verticalLabel,
    summaryLine: summaryLine
  }
}
