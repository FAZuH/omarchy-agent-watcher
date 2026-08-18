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
