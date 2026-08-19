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

test("agentColor/agentGlyph: every agent has a hex color and a glyph; unknown ids fall back", () => {
  for (const a of Model.AGENTS) {
    assert.match(Model.agentColor(a.id, "#000"), /^#[0-9a-fA-F]{6}$/)
    assert.equal(Model.agentGlyph(a.id).length > 0, true)
    assert.equal(Model.agentColor(a.id, "#000"), a.color)
    assert.equal(Model.agentGlyph(a.id), a.glyph)
  }
  assert.equal(Model.agentColor("aider", "#123456"), "#123456")
  assert.equal(Model.agentColor("aider"), "")
  assert.equal(Model.agentGlyph("aider"), Model.BAR_ICON)
  const colors = Model.AGENTS.map(a => a.color)
  assert.equal(new Set(colors).size, colors.length, "colors are distinct")
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
    title: "", seen: false, stateSince: 0
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

test("parseSnapshotResult: ok tells a failed dump apart from an empty one", () => {
  assert.deepEqual(Model.parseSnapshotResult("[]"), { ok: true, sessions: [] })
  assert.deepEqual(Model.parseSnapshotResult(""), { ok: false, sessions: [] })
  assert.deepEqual(Model.parseSnapshotResult("junk"), { ok: false, sessions: [] })
  assert.deepEqual(Model.parseSnapshotResult("{}"), { ok: false, sessions: [] })
  const res = Model.parseSnapshotResult(JSON.stringify([{ agent: "claude", sessionId: "a", state: "working" }]))
  assert.equal(res.ok, true)
  assert.deepEqual(res.sessions.map(s => s.key), ["claude-a"])
})

test("projectName: basename of cwd with sane fallbacks", () => {
  assert.equal(Model.projectName("/home/u/Proyects/omarchy-agent-watcher"), "omarchy-agent-watcher")
  assert.equal(Model.projectName("/home/u/proj/"), "proj")
  assert.equal(Model.projectName("/"), "/")
  assert.equal(Model.projectName(""), "?")
  assert.equal(Model.projectName("relative"), "relative")
})

test("collapseHome: shortens the home prefix only", () => {
  assert.equal(Model.collapseHome("/home/u/dev/api", "/home/u"), "~/dev/api")
  assert.equal(Model.collapseHome("/home/u", "/home/u/"), "~")
  assert.equal(Model.collapseHome("/home/uber/x", "/home/u"), "/home/uber/x")
  assert.equal(Model.collapseHome("/tmp/x", ""), "/tmp/x")
  assert.equal(Model.collapseHome("", "/home/u"), "")
})

test("informativeTitle: rejects agent names, terminal names, prompt and path titles", () => {
  assert.equal(Model.informativeTitle("◐ Create Omarchy plugin for AI agent session monitoring", "claude"), "Create Omarchy plugin for AI agent session monitoring")
  assert.equal(Model.informativeTitle("✳ Claude Code", "claude"), "")
  assert.equal(Model.informativeTitle("claude", "claude"), "")
  assert.equal(Model.informativeTitle("Gemini CLI", "gemini"), "")
  assert.equal(Model.informativeTitle("gemini cli", "gemini"), "")
  assert.equal(Model.informativeTitle("opencode", "opencode"), "")
  assert.equal(Model.informativeTitle("foot", "codex"), "")
  assert.equal(Model.informativeTitle("user@host: ~/proj", "codex"), "")
  assert.equal(Model.informativeTitle("~/proj — bash", "codex"), "")
  assert.equal(Model.informativeTitle("/usr/bin/zsh", "codex"), "")
  assert.equal(Model.informativeTitle("Fix the login bug", "codex"), "Fix the login bug")
  assert.equal(Model.informativeTitle("", "claude"), "")
})

test("sessionLabel: agent title > informative window title > project name", () => {
  const oc = { agent: "opencode", cwd: "/home/u", title: "New session" }
  assert.equal(Model.sessionLabel(oc, "opencode"), "New session")
  const cl = { agent: "claude", cwd: "/home/u/dev/webapp", title: "" }
  assert.equal(Model.sessionLabel(cl, "◑ Refactor the auth flow"), "Refactor the auth flow")
  assert.equal(Model.sessionLabel(cl, "✳ Claude Code"), "webapp")
  assert.equal(Model.sessionLabel(cl, ""), "webapp")
  const home = { agent: "codex", cwd: "/home/u", title: "" }
  assert.equal(Model.sessionLabel(home, "foot", "/home/u"), "~", "sessions in $HOME are labelled ~, not the username")
  assert.equal(Model.sessionLabel(home, "foot"), "u", "without a home hint the basename is used")
})

test("sessionSubtitle: home-collapsed cwd, '?' when unknown", () => {
  assert.equal(Model.sessionSubtitle({ cwd: "/home/u/dev/api" }, "/home/u"), "~/dev/api")
  assert.equal(Model.sessionSubtitle({ cwd: "/home/u" }, "/home/u"), "~")
  assert.equal(Model.sessionSubtitle({ cwd: "" }, "/home/u"), "?")
})

test("normalizeSession: keeps the optional title", () => {
  assert.equal(Model.normalizeSession({ agent: "opencode", sessionId: "a", state: "idle", title: " New session " }).title, "New session")
  assert.equal(Model.normalizeSession({ agent: "opencode", sessionId: "a", state: "idle" }).title, "")
})

test("cleanTitle: strips leading status glyphs and whitespace, keeps the text", () => {
  assert.equal(Model.cleanTitle("◐ Create Omarchy plugin for AI agent session monitoring"), "Create Omarchy plugin for AI agent session monitoring")
  assert.equal(Model.cleanTitle("✳ Claude Code"), "Claude Code")
  assert.equal(Model.cleanTitle("  ✶ ✻ fixing tests "), "fixing tests")
  assert.equal(Model.cleanTitle("~/proj — bash"), "~/proj — bash")
  assert.equal(Model.cleanTitle("/usr/bin/zsh"), "/usr/bin/zsh")
  assert.equal(Model.cleanTitle("编译中..."), "编译中...", "CJK titles survive")
  assert.equal(Model.cleanTitle("◐ Исправить ошибку входа"), "Исправить ошибку входа", "Cyrillic after a spinner survives")
  assert.equal(Model.cleanTitle("\uDB81\uDEC4 nerd-font prefixed task"), "nerd-font prefixed task", "private-use icon prefix stripped")
  assert.equal(Model.cleanTitle("⠋ braille spinner"), "braille spinner")
  assert.equal(Model.cleanTitle("* starred"), "starred")
  assert.equal(Model.cleanTitle("<b>bold</b> title"), "<b>bold</b> title", "markup is left for the renderer to neutralise")
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
