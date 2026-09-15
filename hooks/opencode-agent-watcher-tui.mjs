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
// synced store diffs every session and forwards each transition to the hook.
// The session this window is showing is reported with its terminal (click to
// focus); all other busy or waiting sessions are reported windowless and land
// under Other. A finished session keeps its row for a grace period so the
// blink is visible, then it drops out until it works again. Sessions that are
// simply idle are never announced: a row appears only once a session works,
// waits, or finishes a turn.
//
// The ctx shapes below were verified against opencode 2.0.3 (data.session.*),
// with fallbacks for the documented TuiPluginApi surface (state.session.*).
import { spawn } from "node:child_process"

const HOOK = "__HOOK_PATH__"
const HOOK_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 1000
// How long a windowless session that finished keeps its row before the
// watcher retires it (the blink needs time to be noticed).
const DONE_GRACE_MS = 10 * 60 * 1000

// Same discipline as the v1 bridge: every send is a separate process and
// transitions can land in the same millisecond, so run them one at a time --
// the state file must end up holding the last event OpenCode reported, not
// whichever process happened to finish last.
let queue = Promise.resolve()

function send(event, sessionId, cwd, title, windowless) {
  const payload = { session_id: sessionId, cwd: cwd, title: title || "" }
  if (windowless) payload.windowless = true
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
            child.stdin.end(JSON.stringify(payload))
          } catch (e) {
            finish() // never let a watcher failure surface inside the agent
          }
        }),
    )
    .catch(() => {})
  return queue
}

const store = (ctx) => ctx?.data?.session ?? ctx?.state?.session
// permission/form are `list(sid)` maps at runtime (form holds question-tool
// prompts: the session waits on the user's answer) but plain functions in the
// documented API. `pending` is deliberately NOT a blocker: it holds input the
// user queued while the agent was busy, which does not wait on the user.
function pending(storeObj, key, sessionId) {
  const v = storeObj?.[key]
  try {
    return (typeof v === "function" ? v(sessionId) : v?.list?.(sessionId)) || []
  } catch (e) {
    return []
  }
}

const BLOCKERS = ["permission", "form"]

// The tracked slice of one session. state: working | waiting | done -- waiting
// means a permission, question, or other user-input request is pending, on
// this session or on any of its subagent children (a blocked child stalls the
// parent's turn, so the parent row must show attention); anything but idle
// (running, retry, ...) counts as working because the turn is still going.
// Returns null for anything this window should not track (child sessions,
// unknown ids).
export function snapshot(ctx, sessionId, childIds) {
  const ds = store(ctx)
  if (!ds) return null
  const s = ds.get?.(sessionId)
  if (!s || s.parentID) return null
  const blocked = (id) => BLOCKERS.some((k) => pending(ds, k, id).length > 0)
  const waiting = blocked(sessionId) || (childIds || []).some(blocked)
  let status
  try {
    status = typeof ds.status === "function" ? ds.status(sessionId) : undefined
  } catch (e) {}
  const kind = typeof status === "string" ? status : status?.type
  let state = "done"
  if (waiting) state = "waiting"
  else if (kind && kind !== "idle") state = "working"
  // Titles are model-generated and occasionally multiline or padded; the bar
  // renders one line, so collapse whitespace here.
  const title = (s.title || "").replace(/\s+/g, " ").trim()
  return { sessionId, cwd: s.location?.directory || s.directory || "", title, state }
}

// Pure diff between the previously reported snapshot and the current one;
// returns the hook events to send, in order. null on either side means the
// session was not / is no longer tracked.
export function transitions(prev, next) {
  if (!prev && !next) return []
  if (!prev) {
    // Re-announcement after an ownership flip (the shown window changed). A
    // fresh session must not blink green: "done" is only ever sent for a turn
    // that actually finished, and idle sessions are never announced at all.
    if (next.state === "done") return ["done"]
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
    // sessionId -> { prev, windowed, doneSince }
    const tracked = new Map()
    const retire = (sid, t) => {
      const cur = t.prev
      send("session-end", sid, cur?.cwd || "", cur?.title || "", !t.windowed)
    }
    const tick = () => {
      try {
        const ds = store(ctx)
        if (!ds) return
        const shown = selectedSessionId(ctx)
        const sessions = typeof ds.list === "function" ? ds.list() || [] : []
        const ids = new Set()
        const children = new Map()
        for (const s of sessions) {
          if (!s?.id) continue
          if (s.parentID) {
            const arr = children.get(s.parentID)
            if (arr) arr.push(s.id)
            else children.set(s.parentID, [s.id])
            continue
          }
          ids.add(s.id)
        }
        if (shown) ids.add(shown)
        for (const [sid, t] of [...tracked]) {
          if (!ids.has(sid)) {
            retire(sid, t)
            tracked.delete(sid)
          }
        }
        const now = Date.now()
        for (const sid of ids) {
          const windowed = sid === shown
          const next = snapshot(ctx, sid, children.get(sid))
          let t = tracked.get(sid)
          if (!t) {
            // Idle sessions are not watched: no row until something happens.
            if (!next || next.state === "done") continue
            t = { prev: null, windowed, doneSince: 0 }
            tracked.set(sid, t)
          } else if (t.windowed !== windowed) {
            // This window started or stopped showing it. Leaving a finished
            // session retires the row; otherwise re-announce so the row's
            // window attribution follows the real owner.
            t.windowed = windowed
            if (!windowed && (!next || next.state === "done")) {
              retire(sid, t)
              tracked.delete(sid)
              continue
            }
            t.prev = null
          }
          for (const event of transitions(t.prev, next)) {
            const cur = next || t.prev
            send(event, sid, cur?.cwd || "", cur?.title || "", !windowed)
          }
          if (next && next.state === "done" && !windowed) {
            if (!t.doneSince) t.doneSince = now
            else if (now - t.doneSince > DONE_GRACE_MS) {
              retire(sid, t)
              tracked.delete(sid)
              continue
            }
          } else {
            t.doneSince = 0
          }
          t.prev = next
        }
      } catch (e) {
        // never let a watcher failure surface inside the TUI
      }
    }
    tick()
    const timer = setInterval(tick, POLL_INTERVAL_MS)
    ctx?.lifecycle?.onDispose?.(() => clearInterval(timer))
  },
}
