// Agent Watcher bridge for OpenCode v2. `agent-watcher-setup install opencode`
// drops this file into ~/.config/opencode/plugins/agent-watcher/src/tui.js
// with __HOOK_PATH__ replaced by the absolute path of bin/agent-watcher-hook.
// The TUI plugin runs inside the per-terminal client process, so the hook's
// parent chain reaches the terminal window like every other agent's hooks (a
// server plugin would hang off the shared background service and never find
// a window).
//
// OpenCode v2 runs sessions in a shared service and the TUI is only a client,
// so there is no per-session hook to ride: instead a 1 s poll of the TUI's own
// data store (selected session + status/permission/question state) is diffed
// and every transition is forwarded to the hook. Only the session this TUI
// window is currently showing is reported -- switching sessions in the TUI
// hands the row (and its window) over, and closing the TUI prunes it via the
// usual dead-process checks.
//
// The ctx shapes below were verified against opencode 2.0.3 (data.session.*),
// with fallbacks for the documented TuiPluginApi surface (state.session.*).
import { spawn } from "node:child_process"

const HOOK = "__HOOK_PATH__"
const HOOK_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 1000

// Same discipline as the v1 bridge: every send is a separate process and
// transitions can land in the same millisecond, so run them one at a time --
// the state file must end up holding the last event OpenCode reported, not
// whichever process happened to finish last.
let queue = Promise.resolve()

function send(event, sessionId, cwd, title) {
  queue = queue
    .then(
      () =>
        new Promise((resolve) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve()
          }
          // A wedged hook must never stall every later event.
          const timer = setTimeout(finish, HOOK_TIMEOUT_MS)
          if (timer.unref) timer.unref()
          try {
            const child = spawn(HOOK, ["opencode", event], { stdio: ["pipe", "ignore", "ignore"] })
            child.on("error", finish)
            child.on("close", finish)
            child.stdin.on("error", () => {})
            child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: cwd, title: title || "" }))
          } catch (e) {
            finish() // never let a watcher failure surface inside the agent
          }
        }),
    )
    .catch(() => {})
  return queue
}

const store = (ctx) => ctx?.data?.session ?? ctx?.state?.session
// permission/pending are `list(sid)` maps at runtime but plain functions in
// the documented API.
function pending(storeObj, key, sessionId) {
  const v = storeObj?.[key]
  try {
    return (typeof v === "function" ? v(sessionId) : v?.list?.(sessionId)) || []
  } catch (e) {
    return []
  }
}

// The tracked slice of one session. state: working | waiting | done -- waiting
// means a permission or question is pending; anything but idle (running,
// retry, ...) counts as working because the turn is still going. Returns null
// for anything this window should not track (child sessions, unknown ids).
export function snapshot(ctx, sessionId) {
  const ds = store(ctx)
  if (!ds) return null
  const s = ds.get?.(sessionId)
  if (!s || s.parentID) return null
  const waiting = pending(ds, "permission", sessionId).length > 0 || pending(ds, "pending", sessionId).length > 0
  let status
  try {
    status = typeof ds.status === "function" ? ds.status(sessionId) : undefined
  } catch (e) {}
  const kind = typeof status === "string" ? status : status?.type
  let state = "done"
  if (waiting) state = "waiting"
  else if (kind && kind !== "idle") state = "working"
  return { sessionId, cwd: s.location?.directory || s.directory || "", title: s.title || "", state }
}

// Pure diff between the previously reported snapshot and the current one;
// returns the hook events to send, in order. null on either side means the
// session was not / is no longer tracked.
export function transitions(prev, next) {
  if (!prev && !next) return []
  if (!prev) {
    // A fresh session must not blink green: "done" is only ever sent for a
    // turn that actually finished, so idle-at-creation sends nothing extra.
    const out = ["session-start"]
    if (next.state === "working") out.push("prompt")
    if (next.state === "waiting") out.push("waiting")
    return out
  }
  if (!next) return ["session-end"]
  if (prev.state === next.state) {
    return prev.title !== next.title ? ["rename"] : []
  }
  const out = []
  if (next.state === "waiting") out.push("waiting")
  else if (next.state === "working") out.push(prev.state === "waiting" ? "tool-done" : "prompt")
  else out.push("done")
  // The state event already carries the new title; rename is reserved for
  // title-only edits (the hook ignores unknown sessions for rename, so this
  // also keeps a rename from resurrecting an ended session).
  return out
}

// The session this TUI window is currently showing, or "" for none.
export function selectedSessionId(ctx) {
  let cur
  try {
    cur = ctx?.ui?.router?.current?.()
  } catch (e) {
    return ""
  }
  const sid = cur?.sessionID ?? cur?.params?.sessionID
  const onSession = cur?.type === "session" || cur?.name === "session"
  return onSession && typeof sid === "string" ? sid : ""
}

export default {
  id: "agent-watcher-tui",
  setup: async (ctx) => {
    let tracked = null // session id reported for this window, "" when none
    let prev = null // last snapshot sent for it
    const tick = () => {
      try {
        const sid = selectedSessionId(ctx)
        if (sid !== tracked) {
          if (tracked && prev) send("session-end", tracked, prev.cwd, prev.title)
          tracked = sid
          prev = null
        }
        if (!sid) return
        const next = snapshot(ctx, sid)
        for (const event of transitions(prev, next)) {
          const cur = next || prev
          send(event, cur.sessionId, cur.cwd, cur.title)
        }
        // The selected id stays tracked even while unreadable (child session
        // selected, state lag): prev is cleared either way, so one bad tick
        // cannot re-send session-end on every poll.
        prev = next
      } catch (e) {
        // never let a watcher failure surface inside the TUI
      }
    }
    tick()
    const timer = setInterval(tick, POLL_INTERVAL_MS)
    ctx?.lifecycle?.onDispose?.(() => clearInterval(timer))
  },
}
